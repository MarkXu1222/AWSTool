/**
 * POC Cash —— 商机创建与提交。
 *
 * admin-only（菜单与后端双重拦截）。这里创建的是**真实商机**并提交给
 * AWS 审核，不是草稿，所以提交前有二次确认。
 *
 * 金额联动（docs/poc-cash-guide.md 第 4 节，81 条实操记录 100% 吻合）：
 *   ARR = MRR × 12 ；POC 可申请 = ARR / 10
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Card, Form, Input, InputNumber, Select, Button, Space, Radio, Alert,
  Descriptions, Typography, Divider, message, Modal, Tag, DatePicker, Result,
} from 'antd';
import { RocketOutlined, CopyOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '../api';

const { TextArea } = Input;
const { Text, Paragraph } = Typography;

interface Meta {
  configured: boolean;
  partners: { key: string; label: string; defaultSolutionId: string }[];
  useCases: string[];
  industries: string[];
}
interface Solution { id: string; name: string; category: string; status: string }
interface CreateResult {
  opportunityId: string; arn?: string; title: string;
  stage?: string; reviewStatus?: string;
  solutionId?: string; solutionAssociated: boolean;
  submitted: boolean; engagementId?: string; taskStatus?: string;
  amounts: { mrrUsd: number; arrUsd: number; pocUsd: number };
  warnings: string[];
}

const MYR_RATE = 4.27;   // 实测 114 条记录，USD→MYR 比值集中在 4.24~4.36
const HOURLY_MYR = 339;  // 标准人时单价
const POC_CAP_USD = 9900; // 实测上限，114 条无一超过

const PocCashPage: React.FC = () => {
  const [form] = Form.useForm();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [solutions, setSolutions] = useState<Solution[]>([]);
  const [titleMode, setTitleMode] = useState<'auto' | 'manual'>('auto');
  const [autoTitle, setAutoTitle] = useState('');
  const [mrr, setMrr] = useState<number | null>(null);
  const [people, setPeople] = useState(2);
  const [days, setDays] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);

  useEffect(() => {
    api.pocCashMeta().then((m: Meta) => {
      setMeta(m);
      if (m.partners[0]) form.setFieldValue('partnerKey', m.partners[0].key);
      if (m.configured) {
        api.pocCashSolutions()
          .then((r: any) => setSolutions(r.solutions || []))
          .catch(() => { /* 凭证问题已由 configured 提示，不重复报错 */ });
      }
    }).catch((e: any) => message.error(e.message || '加载失败'));
  }, []);

  // 标题预览：自动模式下随客户名/项目名实时更新（防抖，避免每次按键都打后端）
  const companyName = Form.useWatch('companyName', form);
  const projectName = Form.useWatch('projectName', form);
  const partnerKey = Form.useWatch('partnerKey', form);
  useEffect(() => {
    if (titleMode !== 'auto' || !partnerKey || !companyName || !projectName) {
      setAutoTitle('');
      return;
    }
    const t = setTimeout(() => {
      api.pocCashPreviewTitle({ partnerKey, companyName, projectName })
        .then((r: any) => setAutoTitle(r.title))
        .catch(() => setAutoTitle(''));
    }, 250);
    return () => clearTimeout(t);
  }, [titleMode, partnerKey, companyName, projectName]);

  // 所有金额由 MRR 单向推导，避免手工换算出错
  const amounts = useMemo(() => {
    if (!mrr || mrr <= 0) return null;
    const arr = mrr * 12;
    const poc = Math.round(arr / 10);
    const requestMyr = poc * MYR_RATE;
    const totalMyr = HOURLY_MYR * 8 * people * days;
    const partnerMyr = totalMyr - requestMyr;
    return {
      arr, poc, requestMyr, totalMyr, partnerMyr,
      partnerPct: totalMyr > 0 ? (partnerMyr / totalMyr) * 100 : 0,
    };
  }, [mrr, people, days]);

  const doSubmit = (values: any) => {
    const willSubmit = values.submit !== false;
    const finalTitle = titleMode === 'manual' ? values.titleOverride : autoTitle;
    const payload = {
      ...values,
      targetCloseDate: (values.targetCloseDate as Dayjs).format('YYYY-MM-DD'),
      titleOverride: titleMode === 'manual' ? values.titleOverride : undefined,
    };

    Modal.confirm({
      title: '确认创建商机？',
      width: 580,
      content: (
        <div style={{ lineHeight: 1.9 }}>
          <Text strong>{finalTitle}</Text>
          <div style={{ marginTop: 8 }}>客户：{values.companyName}</div>
          <div>
            MRR：{Number(values.mrrUsd).toLocaleString()} USD/月
            {amounts && <Text type="secondary">
              （ARR {amounts.arr.toLocaleString()}，POC 可申请 {amounts.poc.toLocaleString()} USD）
            </Text>}
          </div>
          <Alert style={{ marginTop: 12 }} type="warning" showIcon
            message={willSubmit
              ? '将创建真实商机并提交 AWS 审核。提交后商机被锁定，直到审批完成才能修改。'
              : '将创建商机但不提交，之后可在控制台手动提交。'} />
        </div>
      ),
      okText: willSubmit ? '创建并提交' : '创建（不提交）',
      cancelText: '再检查一下',
      onOk: async () => {
        setSubmitting(true);
        try {
          const r = await api.pocCashCreate(payload);
          setResult(r);
          if (r.warnings?.length) {
            message.warning(`商机 ${r.opportunityId} 已创建，但有 ${r.warnings.length} 条警告`);
          } else {
            message.success(`商机 ${r.opportunityId} ${r.submitted ? '已提交' : '已创建'}`);
          }
        } catch (e: any) {
          message.error(e.message || '创建失败');
        } finally {
          setSubmitting(false);
        }
      },
    });
  };

  const resetAll = () => {
    setResult(null); form.resetFields(); setMrr(null); setAutoTitle('');
    setTitleMode('auto'); setPeople(2); setDays(5);
    if (meta?.partners[0]) form.setFieldValue('partnerKey', meta.partners[0].key);
  };

  if (result) {
    return (
      <Card>
        <Result
          status={result.warnings.length ? 'warning' : 'success'}
          title={`商机 ${result.opportunityId} ${result.submitted ? '已提交' : '已创建'}`}
          subTitle={result.title}
          extra={[
            <Button key="new" type="primary" onClick={resetAll}>再建一个</Button>,
            <Button key="copy" icon={<CopyOutlined />} onClick={() => {
              navigator.clipboard.writeText(result.opportunityId);
              message.success('已复制商机 ID');
            }}>复制 ID</Button>,
          ]}
        />
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="Opportunity ID">{result.opportunityId}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={result.reviewStatus === 'Submitted' ? 'processing' : 'default'}>
              {result.stage} / {result.reviewStatus}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Solution">
            {result.solutionAssociated
              ? <Tag color="success">{result.solutionId}</Tag>
              : <Tag color="error">未关联</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="Engagement">{result.engagementId || '—'}</Descriptions.Item>
          <Descriptions.Item label="MRR">
            {result.amounts.mrrUsd.toLocaleString()} USD/月</Descriptions.Item>
          <Descriptions.Item label="ARR">
            {result.amounts.arrUsd.toLocaleString()} USD</Descriptions.Item>
          <Descriptions.Item label="POC 可申请" span={2}>
            <Text strong>{result.amounts.pocUsd.toLocaleString()} USD</Text>
            <Text type="secondary">
              {' '}≈ {(result.amounts.pocUsd * MYR_RATE).toLocaleString(undefined,
                { maximumFractionDigits: 2 })} MYR
            </Text>
          </Descriptions.Item>
          {result.arn && (
            <Descriptions.Item label="ARN" span={2}>
              <Text copyable style={{ fontSize: 12 }}>{result.arn}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>

        {result.warnings.length > 0 && (
          <Alert style={{ marginTop: 16 }} type="warning" showIcon
            message="以下步骤未成功，但商机本身已创建"
            description={<ul style={{ margin: 0, paddingLeft: 18 }}>
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>} />
        )}

        <Alert style={{ marginTop: 16 }} type="info" showIcon message="下一步"
          description={`等 AWS 审批通过（ReviewStatus 变为 Approved）后才能把阶段推到 `
            + `Technical Validation，然后做定价计算器（目标 ARR `
            + `${result.amounts.arrUsd.toLocaleString()} USD）并提交 POC 资金申请。`} />
      </Card>
    );
  }

  const renderAmounts = () => (
    <>
      <Divider orientation="left">金额</Divider>
      <Space align="start" wrap size="large">
        <Form.Item name="mrrUsd" label="MRR（USD/月）" rules={[{ required: true }]}
          extra="ARR 与 POC 额度由它推导">
          <InputNumber style={{ width: 180 }} min={1} step={100}
            onChange={v => setMrr(typeof v === 'number' ? v : null)} />
        </Form.Item>
        <Form.Item label="POC 人数" extra="影响 Total Cost">
          <InputNumber style={{ width: 110 }} min={1} value={people}
            onChange={v => setPeople(typeof v === 'number' ? v : 1)} />
        </Form.Item>
        <Form.Item label="POC 天数" extra="实操中位数 4 天">
          <InputNumber style={{ width: 110 }} min={1} value={days}
            onChange={v => setDays(typeof v === 'number' ? v : 1)} />
        </Form.Item>
      </Space>

      {amounts && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="info"
          message="金额联动预览"
          description={
            <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
              <Descriptions.Item label="ARR（定价计算器目标）">
                {amounts.arr.toLocaleString()} USD</Descriptions.Item>
              <Descriptions.Item label="POC 可申请">
                <Text strong>{amounts.poc.toLocaleString()} USD</Text></Descriptions.Item>
              <Descriptions.Item label="Total Cost of Activity">
                {amounts.totalMyr.toLocaleString()} MYR
                <Text type="secondary"> （339×8×{people}人×{days}天）</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Partner Contribution">
                {amounts.partnerMyr.toLocaleString(undefined, { maximumFractionDigits: 2 })} MYR
                <Text type={amounts.partnerPct < 10 ? 'danger' : 'secondary'}>
                  {' '}（{amounts.partnerPct.toFixed(1)}%）</Text>
              </Descriptions.Item>
              <Descriptions.Item label="实际申请额" span={2}>
                {amounts.requestMyr.toLocaleString(undefined, { maximumFractionDigits: 2 })} MYR
                <Text type="secondary"> （汇率 {MYR_RATE}）</Text>
              </Descriptions.Item>
            </Descriptions>
          } />
      )}
      {amounts && amounts.partnerMyr < 0 && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="error" showIcon
          message="Partner Contribution 为负"
          description="总成本不够覆盖申请额，请增加人天或降低 MRR。" />
      )}
      {amounts && amounts.partnerMyr >= 0 && amounts.partnerPct < 10 && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="warning" showIcon
          message={`Partner 投入仅占 ${amounts.partnerPct.toFixed(1)}%`}
          description="低于 10% 容易被质疑，建议增加人天。" />
      )}
      {amounts && amounts.poc > POC_CAP_USD && (
        <Alert style={{ maxWidth: 900, marginBottom: 16 }} type="warning" showIcon
          message={`POC 申请额 ${amounts.poc.toLocaleString()} USD 超过经验上限`}
          description={`实测 114 条记录中申请额无一超过 ${POC_CAP_USD.toLocaleString()} USD，`
            + `超过可能需走别的审批通道。`} />
      )}
    </>
  );

  const renderSubmitSection = () => (
    <>
      <Divider orientation="left">提交</Divider>
      <Form.Item name="submit" label="创建后是否提交给 AWS 审核">
        <Radio.Group optionType="button" buttonStyle="solid">
          <Radio.Button value={true}>创建并提交</Radio.Button>
          <Radio.Button value={false}>只创建，暂不提交</Radio.Button>
        </Radio.Group>
      </Form.Item>
      <Paragraph type="secondary" style={{ maxWidth: 900 }}>
        提交会先建 Engagement 再提交（AWS 要求，不能直接 Submit）。提交后商机进入
        {' '}<Text code>Submitted</Text> 并被锁定，直到 AWS 审批完成；
        审批通过后才能把阶段推到 Technical Validation 并申请 POC 资金。
      </Paragraph>
      <Form.Item>
        <Button type="primary" htmlType="submit" size="large" loading={submitting}
          disabled={!meta?.configured} icon={<RocketOutlined />}>
          创建商机
        </Button>
      </Form.Item>
    </>
  );

  return (
    <Card title={<Space><RocketOutlined />POC Cash — 创建商机</Space>}>
      {meta && !meta.configured && (
        <Alert style={{ marginBottom: 16 }} type="error" showIcon
          message="Partner Central 未配置"
          description="请先用 scripts/setup_partner_central_role.py 在 APN 账户创建信任中心账户的 role，再在 config.json 填 partnerCentral { roleArn, externalId }（或设环境变量 PARTNERCENTRAL_ROLE_ARN / PARTNERCENTRAL_EXTERNAL_ID）。" />
      )}

      <Form form={form} layout="vertical" onFinish={doSubmit}
        initialValues={{
          countryCode: 'MY', submit: true, marketingSource: 'Marketing Activity',
          customerUseCase: 'Migration / Database Migration',
        }}>

        <Divider orientation="left">Partner</Divider>
        <Form.Item name="partnerKey" label="Partner 主体" rules={[{ required: true }]}
          extra="目前仅开放 Webby；其他主体的发票信息与 Solution 不同，需逐个核对后再放开">
          <Select style={{ maxWidth: 320 }}
            options={(meta?.partners || []).map(p => ({ value: p.key, label: p.label }))} />
        </Form.Item>

        <Divider orientation="left">客户</Divider>
        <Space align="start" wrap size="large">
          <Form.Item name="companyName" label="客户公司全称" rules={[{ required: true }]}>
            <Input style={{ width: 360 }} placeholder="Korea Wallpaper (KL) Sdn Bhd" />
          </Form.Item>
          <Form.Item name="industry" label="行业" rules={[{ required: true }]}>
            <Select style={{ width: 220 }} showSearch placeholder="选择行业"
              options={(meta?.industries || []).map(v => ({ value: v, label: v }))} />
          </Form.Item>
          <Form.Item name="websiteUrl" label="客户网址" rules={[{ required: true }]}>
            <Input style={{ width: 240 }} placeholder="https://example.com/" />
          </Form.Item>
          <Form.Item name="countryCode" label="国家"
            rules={[{ required: true, pattern: /^[A-Za-z]{2}$/, message: '2 位字母' }]}>
            <Input style={{ width: 90 }} maxLength={2} placeholder="MY" />
          </Form.Item>
          <Form.Item name="postalCode" label="邮编">
            <Input style={{ width: 120 }} placeholder="47170" />
          </Form.Item>
        </Space>

        <Divider orientation="left">项目</Divider>
        <Form.Item label="商机名称" required>
          <Radio.Group value={titleMode} onChange={e => setTitleMode(e.target.value)}
            optionType="button" buttonStyle="solid" style={{ marginBottom: 12 }}>
            <Radio.Button value="auto">自动生成</Radio.Button>
            <Radio.Button value="manual">手动输入</Radio.Button>
          </Radio.Group>

          {titleMode === 'auto' ? (
            <>
              <Form.Item name="projectName" noStyle
                rules={[{ required: titleMode === 'auto', message: '项目名称必填' }]}>
                <Input style={{ maxWidth: 520, display: 'block' }}
                  placeholder="项目描述，如 Application Service Migration" />
              </Form.Item>
              <div style={{ marginTop: 8 }}>
                {autoTitle
                  ? <Text code style={{ fontSize: 13 }}>{autoTitle}</Text>
                  : <Text type="secondary">填完客户名和项目描述后显示预览</Text>}
              </div>
            </>
          ) : (
            <Form.Item name="titleOverride" noStyle
              rules={[{ required: titleMode === 'manual', message: '标题必填' }]}>
              <Input style={{ maxWidth: 640 }}
                placeholder="Webby - Korea Wallpaper Application Service Migration #ADPL" />
            </Form.Item>
          )}
        </Form.Item>

        <Form.Item name="customerUseCase" label="Use Case" rules={[{ required: true }]}
          extra="必须用 AWS 的完整字面量，写简写（如 Migration）会被拒">
          <Select style={{ maxWidth: 480 }} showSearch
            options={(meta?.useCases || []).map(v => ({ value: v, label: v }))} />
        </Form.Item>

        <Form.Item name="customerBusinessProblem" label="业务描述"
          rules={[{ required: true, min: 50, message: '至少 50 字 —— AWS 会看描述是否具体' }]}
          extra="写清楚客户现状、要迁什么、partner 做哪些事、用到哪些 AWS 服务">
          <TextArea rows={6} style={{ maxWidth: 900 }} showCount />
        </Form.Item>

        <Space align="start" wrap size="large">
          <Form.Item name="solutionId" label="关联 Solution"
            extra={solutions.length ? undefined : '未加载（凭证未配置或查询失败）'}>
            <Select style={{ width: 400 }} allowClear showSearch optionFilterProp="label"
              placeholder="默认 S-0070517 Migration services"
              options={solutions.map(s => ({ value: s.id, label: `${s.id} — ${s.name}` }))} />
          </Form.Item>
          <Form.Item name="targetCloseDate" label="预计成交日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: 180 }}
              disabledDate={d => !!d && d < dayjs().endOf('day')} />
          </Form.Item>
          <Form.Item name="marketingSource" label="Marketing Source">
            <Select style={{ width: 200 }} options={[
              { value: 'Marketing Activity', label: 'Marketing Activity' },
              { value: 'None', label: 'None' },
            ]} />
          </Form.Item>
        </Space>
        {renderAmounts()}
        {renderSubmitSection()}
      </Form>
    </Card>
  );
};

export default PocCashPage;
