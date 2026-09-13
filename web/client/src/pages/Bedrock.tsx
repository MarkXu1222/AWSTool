/**
 * Bedrock 工具页 —— 从桌面版 Bedrock Profile Manager 迁移。
 * Tab：Profiles 管理 / 批量创建 / 模型测试 / 模型列表 / 模型开通(FTU) / 数据共享 / IAM 用户 / 交付表格。
 * ⚠️ Tag 纪律：创建/打 Tag 的 tags 必须每次显式输入，前后端都不提供默认值。
 */
import React, { useState, useEffect } from 'react';
import {
  Card, Tabs, Select, Button, Table, Tag, Input, Space, message, Modal, Form,
  Checkbox, Alert, Tooltip, Popconfirm, InputNumber, Typography,
} from 'antd';
import { ReloadOutlined, PlusOutlined, DeleteOutlined, TagsOutlined, ThunderboltOutlined, DownloadOutlined, UserAddOutlined } from '@ant-design/icons';
import { api } from '../api';

const BEDROCK_REGIONS = [
  'us-east-1', 'us-west-2', 'us-east-2', 'us-west-1',
  'eu-west-1', 'eu-west-2', 'eu-central-1',
  'ap-northeast-1', 'ap-southeast-1', 'ap-southeast-2',
];
const REGION_OPTS = BEDROCK_REGIONS.map(r => ({ label: r, value: r }));

/** Tag 输入组件：key/value 都必填，无默认值 */
const TagInputs: React.FC<{
  tags: { key: string; value: string }[];
  onChange: (tags: { key: string; value: string }[]) => void;
}> = ({ tags, onChange }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    {tags.map((t, i) => (
      <Space key={i}>
        <Input size="small" placeholder="Tag Key（必填，如 map-migrated）" style={{ width: 220 }} value={t.key}
          onChange={e => onChange(tags.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
        <Input size="small" placeholder="Tag Value（必填）" style={{ width: 200 }} value={t.value}
          onChange={e => onChange(tags.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
        {tags.length > 1 && <Button size="small" danger type="text" onClick={() => onChange(tags.filter((_, j) => j !== i))}>删除</Button>}
      </Space>
    ))}
    <Button size="small" type="dashed" onClick={() => onChange([...tags, { key: '', value: '' }])} style={{ width: 120 }}>+ 添加 Tag</Button>
  </div>
);

function validTags(tags: { key: string; value: string }[]): boolean {
  return tags.length > 0 && tags.every(t => t.key.trim() && t.value.trim());
}

// ===== Tab 1: Profiles 管理 =====
const ProfilesTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [regions, setRegions] = useState<string[]>(['us-east-1', 'us-west-2']);
  const [rows, setRows] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [search, setSearch] = useState('');
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [tagInputs, setTagInputs] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [acting, setActing] = useState(false);

  const load = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    if (!regions.length) { message.warning('请至少勾选一个区域'); return; }
    setLoading(true);
    try {
      const res = await api.bedrockListProfiles(accountId, regions);
      if (res.success) {
        setRows(res.data.rows || []);
        setErrors(res.data.errors || []);
        setSelectedKeys([]);
      } else message.error(res.error || '加载失败');
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  const filtered = rows.filter(r => {
    if (!search.trim()) return true;
    const hay = `${r.name} ${r.arn} ${r.region} ${r.scope} ${r.backendModels} ${(r.tags || []).map((t: any) => `${t.key}=${t.value}`).join(' ')}`.toLowerCase();
    return search.toLowerCase().split(/\s+/).every(tok => hay.includes(tok));
  });
  const selectedRows = filtered.filter(r => selectedKeys.includes(r.arn));

  // 批量操作按区域分组执行（后端接口一次一个区域）
  const byRegion = (list: any[]) => {
    const m = new Map<string, string[]>();
    for (const r of list) {
      if (!m.has(r.region)) m.set(r.region, []);
      m.get(r.region)!.push(r.arn);
    }
    return m;
  };

  const doDelete = async () => {
    setActing(true);
    try {
      let ok = 0, fail = 0;
      for (const [region, arns] of byRegion(selectedRows)) {
        const res = await api.bedrockDeleteProfiles({ accountId, region, arns });
        if (res.success) { ok += res.data.filter((r: any) => r.ok).length; fail += res.data.filter((r: any) => !r.ok).length; }
        else fail += arns.length;
      }
      message[fail ? 'warning' : 'success'](`删除完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`);
      load();
    } catch (e: any) { message.error(e.message); } finally { setActing(false); }
  };

  const doTag = async () => {
    if (!validTags(tagInputs)) { message.warning('Tag 的 key 和 value 都必须填写（无默认值）'); return; }
    setActing(true);
    try {
      let ok = 0, fail = 0;
      for (const [region, arns] of byRegion(selectedRows)) {
        const res = await api.bedrockTagProfiles({ accountId, region, arns, tags: tagInputs.map(t => ({ key: t.key.trim(), value: t.value.trim() })) });
        if (res.success) { ok += res.data.filter((r: any) => r.ok).length; fail += res.data.filter((r: any) => !r.ok).length; }
        else { fail += arns.length; if (res.error) message.error(res.error); }
      }
      message[fail ? 'warning' : 'success'](`打 Tag 完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`);
      setTagModalOpen(false);
      setTagInputs([{ key: '', value: '' }]);
      load();
    } catch (e: any) { message.error(e.message); } finally { setActing(false); }
  };

  return (
    <ProfilesTabView {...{ regions, setRegions, load, loading, search, setSearch, filtered, selectedKeys, setSelectedKeys, errors, doDelete, doTag, acting, tagModalOpen, setTagModalOpen, tagInputs, setTagInputs }} />
  );
};

const ProfilesTabView: React.FC<any> = ({
  regions, setRegions, load, loading, search: _s, setSearch, filtered, selectedKeys, setSelectedKeys,
  errors, doDelete, doTag, acting, tagModalOpen, setTagModalOpen, tagInputs, setTagInputs,
}) => (
  <div style={{ paddingTop: 12 }}>
    <Space wrap style={{ marginBottom: 12 }}>
      <Select mode="multiple" size="small" style={{ minWidth: 320 }} value={regions} onChange={setRegions}
        options={REGION_OPTS} placeholder="选择区域" maxTagCount={4} />
      <Button size="small" type="primary" icon={<ReloadOutlined />} loading={loading} onClick={load}>加载 Profiles</Button>
      <Input.Search size="small" placeholder="筛选：名称 / ARN / Tag / 模型" allowClear style={{ width: 260 }}
        onChange={e => setSearch(e.target.value)} />
      <span style={{ fontSize: 12, color: '#8a94a6' }}>已选 {selectedKeys.length} / {filtered.length}</span>
      <Button size="small" icon={<TagsOutlined />} disabled={!selectedKeys.length} onClick={() => setTagModalOpen(true)}>批量打 Tag</Button>
      <Popconfirm title={`确认删除选中的 ${selectedKeys.length} 个 Profile？`} okText="删除" okButtonProps={{ danger: true }} onConfirm={doDelete}>
        <Button size="small" danger icon={<DeleteOutlined />} disabled={!selectedKeys.length} loading={acting}>批量删除</Button>
      </Popconfirm>
    </Space>
    {errors.length > 0 && (
      <Alert type="warning" showIcon style={{ marginBottom: 8 }}
        message={`部分区域查询失败：${errors.map((e: any) => `${e.region}(${e.message})`).join('；')}`} />
    )}
    <Table size="small" rowKey="arn" dataSource={filtered} loading={loading}
      rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
      pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t: number) => `共 ${t} 条` }}
      columns={[
        { title: 'Region', dataIndex: 'region', width: 110, sorter: (a: any, b: any) => a.region.localeCompare(b.region) },
        { title: 'Name', dataIndex: 'name', width: 240, sorter: (a: any, b: any) => (a.name || '').localeCompare(b.name || '') },
        { title: 'Scope', dataIndex: 'scope', width: 80, render: (s: string) => <Tag color={s === 'Global' ? 'blue' : 'green'}>{s}</Tag> },
        { title: 'Status', dataIndex: 'status', width: 90 },
        { title: '后端模型', dataIndex: 'backendModels', ellipsis: true },
        {
          title: 'Tags', dataIndex: 'tags', width: 240,
          render: (tags: any[]) => (tags || []).map(t => <Tag key={t.key} style={{ marginBottom: 2 }}>{t.key}={t.value}</Tag>),
        },
        { title: 'ARN', dataIndex: 'arn', ellipsis: true, render: (a: string) => <Typography.Text copyable={{ text: a }} style={{ fontSize: 12 }}>{a}</Typography.Text> },
      ]} />
    <Modal title={`批量打 Tag（${selectedKeys.length} 个 Profile）`} open={tagModalOpen}
      onCancel={() => setTagModalOpen(false)} onOk={doTag} okText="打 Tag" confirmLoading={acting}
      okButtonProps={{ disabled: !validTags(tagInputs) }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Tag 必须每次显式输入，平台不提供默认值，请确认与该账户所属 MAP 协议一致。" />
      <TagInputs tags={tagInputs} onChange={setTagInputs} />
    </Modal>
  </div>
);

// ===== Tab 2: 批量创建 =====
const CreateTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [region, setRegion] = useState('us-east-1');
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState('All');
  const [kw, setKw] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [prefix, setPrefix] = useState('');
  const [tagInputs, setTagInputs] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [creating, setCreating] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const loadModels = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    setLoading(true);
    try {
      const res = await api.bedrockListModels(accountId, region);
      if (res.success) { setModels(res.data || []); setSelectedKeys((res.data || []).map((m: any) => m.modelId)); }
      else message.error(res.error || '加载失败');
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  const providers = ['All', ...new Set(models.map(m => m.provider))];
  const filtered = models.filter(m =>
    (provider === 'All' || m.provider === provider) &&
    (!kw.trim() || `${m.name} ${m.modelId} ${m.scope}`.toLowerCase().includes(kw.toLowerCase())));

  const buildName = (m: any) => {
    if (!prefix.trim()) return m.name;
    const parts = String(m.modelId).split('.');
    const short = parts.length >= 3 ? parts.slice(2).join('.') : m.modelId.replace(/\./g, '-');
    const scopeTag = parts.length >= 2 ? parts[0] : '';
    return scopeTag ? `${prefix.trim()}-${scopeTag}-${short}` : `${prefix.trim()}-${short}`;
  };

  const doCreate = async () => {
    const sel = filtered.filter(m => selectedKeys.includes(m.modelId));
    if (!sel.length) { message.warning('请勾选模型'); return; }
    if (!validTags(tagInputs)) { message.warning('必须填写 Tag（key/value 均必填，平台不提供默认值）'); return; }
    setCreating(true);
    setLog([`开始创建 ${sel.length} 个 Profile...`]);
    try {
      const res = await api.bedrockCreateProfiles({
        accountId, region,
        items: sel.map(m => ({ modelId: m.modelId, name: buildName(m) })),
        tags: tagInputs.map(t => ({ key: t.key.trim(), value: t.value.trim() })),
      });
      if (res.success) {
        const lines = res.data.map((r: any) => r.ok ? `[OK] ${r.name}` : `[ERR] ${r.name}: ${r.error}`);
        const ok = res.data.filter((r: any) => r.ok).length;
        setLog(prev => [...prev, ...lines, `完成：成功 ${ok} / 失败 ${res.data.length - ok}`]);
        message[ok === res.data.length ? 'success' : 'warning'](`创建完成：成功 ${ok}/${res.data.length}`);
      } else {
        setLog(prev => [...prev, `[ERR] ${res.error}`]);
        message.error(res.error || '创建失败');
      }
    } catch (e: any) { message.error(e.message); } finally { setCreating(false); }
  };

  return (
    <div style={{ paddingTop: 12 }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Select size="small" style={{ width: 150 }} value={region} onChange={setRegion} options={REGION_OPTS} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={loadModels}>刷新模型</Button>
        <Select size="small" style={{ width: 130 }} value={provider} onChange={setProvider}
          options={providers.map(p => ({ label: p, value: p }))} />
        <Input size="small" placeholder="筛选模型名" allowClear style={{ width: 180 }} value={kw} onChange={e => setKw(e.target.value)} />
        <Input size="small" placeholder="命名前缀（留空用模型原名）" style={{ width: 240 }} value={prefix} onChange={e => setPrefix(e.target.value)} />
      </Space>
      <Alert type="warning" showIcon style={{ marginBottom: 8 }}
        message="Tag 必填且每次都要手动输入（如 map-migrated = migXXXXXXX）。平台不记忆、不提供默认值——请核对与该账户所属 MAP 协议一致后再创建。" />
      <div style={{ marginBottom: 12 }}>
        <TagInputs tags={tagInputs} onChange={setTagInputs} />
      </div>
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" type="primary" icon={<PlusOutlined />} loading={creating}
          disabled={!selectedKeys.length || !validTags(tagInputs)} onClick={doCreate}>
          创建勾选（{selectedKeys.length}）
        </Button>
        {!validTags(tagInputs) && <span style={{ fontSize: 12, color: '#cf1322' }}>请先填写完整 Tag</span>}
      </Space>
      <Table size="small" rowKey="modelId" dataSource={filtered} loading={loading}
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
        pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }}
        columns={[
          { title: 'Provider', dataIndex: 'provider', width: 110 },
          { title: 'Name', dataIndex: 'name', width: 280 },
          { title: 'Model ID', dataIndex: 'modelId', ellipsis: true },
          { title: 'Scope', dataIndex: 'scope', width: 90, render: (s: string) => <Tag color={s === 'Global' ? 'blue' : 'green'}>{s}</Tag> },
          { title: '创建后名称', key: 'preview', ellipsis: true, render: (_: any, m: any) => <span style={{ color: '#8a94a6' }}>{buildName(m)}</span> },
        ]} />
      {log.length > 0 && (
        <pre style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
          {log.join('\n')}
        </pre>
      )}
    </div>
  );
};

// ===== Tab 3: 模型测试 =====
const InvokeTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [region, setRegion] = useState('us-east-1');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('Hello, please reply with one short sentence.');
  const [maxTokens, setMaxTokens] = useState(1024);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    if (!modelId.trim() || !prompt.trim()) { message.warning('请填写 Model ID / Profile ARN 和 Prompt'); return; }
    setRunning(true); setOutput('调用中...');
    try {
      const res = await api.bedrockInvoke({ accountId, region, modelId: modelId.trim(), prompt, maxTokens });
      setOutput(res.success ? res.data.text : `[ERR] ${res.error}`);
    } catch (e: any) { setOutput(`[ERR] ${e.message}`); } finally { setRunning(false); }
  };

  return (
    <div style={{ paddingTop: 12, maxWidth: 900 }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Select size="small" style={{ width: 150 }} value={region} onChange={setRegion} options={REGION_OPTS} />
        <Input size="small" placeholder="Model ID 或 Inference Profile ARN" style={{ width: 460 }}
          value={modelId} onChange={e => setModelId(e.target.value)} />
        <InputNumber size="small" min={1} max={4096} value={maxTokens} onChange={v => setMaxTokens(v || 1024)} addonBefore="maxTokens" style={{ width: 180 }} />
      </Space>
      <Input.TextArea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Prompt" style={{ marginBottom: 8 }} />
      <Button type="primary" size="small" icon={<ThunderboltOutlined />} loading={running} onClick={run}>发送测试</Button>
      {output && (
        <pre style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
          {output}
        </pre>
      )}
    </div>
  );
};

// ===== Tab 4: 模型列表 =====
const ModelsTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [region, setRegion] = useState('us-east-1');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [kw, setKw] = useState('');

  const load = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    setLoading(true);
    try {
      const res = await api.bedrockListFoundationModels(accountId, region);
      if (res.success) setRows(res.data || []);
      else message.error(res.error || '加载失败');
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  const filtered = rows.filter(r => !kw.trim() || `${r.modelId} ${r.provider} ${r.name}`.toLowerCase().includes(kw.toLowerCase()));

  return (
    <div style={{ paddingTop: 12 }}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select size="small" style={{ width: 150 }} value={region} onChange={setRegion} options={REGION_OPTS} />
        <Button size="small" type="primary" icon={<ReloadOutlined />} loading={loading} onClick={load}>加载模型</Button>
        <Input.Search size="small" placeholder="筛选" allowClear style={{ width: 220 }} onChange={e => setKw(e.target.value)} />
        <span style={{ fontSize: 12, color: '#8a94a6' }}>{filtered.length} 个模型</span>
      </Space>
      <Table size="small" rowKey="modelId" dataSource={filtered} loading={loading}
        pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }}
        columns={[
          { title: 'Provider', dataIndex: 'provider', width: 110, sorter: (a: any, b: any) => a.provider.localeCompare(b.provider) },
          { title: 'Name', dataIndex: 'name', width: 260 },
          { title: 'Model ID', dataIndex: 'modelId', ellipsis: true, render: (v: string) => <Typography.Text copyable={{ text: v }} style={{ fontSize: 12 }}>{v}</Typography.Text> },
          { title: '推理类型', dataIndex: 'inferenceTypes', width: 200 },
          { title: 'Streaming', dataIndex: 'streaming', width: 90 },
          { title: 'Status', dataIndex: 'status', width: 90 },
        ]} />
    </div>
  );
};

// ===== Tab 5: FTU 模型开通 =====
const FtuTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [form] = Form.useForm();
  const [region, setRegion] = useState('us-east-1');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState('');

  const submit = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    const values = await form.validateFields();
    setSubmitting(true); setResult('提交中...');
    try {
      const res = await api.bedrockSubmitFtu({ accountId, region, form: values });
      if (res.success) { setResult(`[OK] 提交成功 — ${region}`); message.success('FTU 表单提交成功'); }
      else setResult(`[ERR] ${res.error}`);
    } catch (e: any) { setResult(`[ERR] ${e.message}`); } finally { setSubmitting(false); }
  };

  return (
    <div style={{ paddingTop: 12, maxWidth: 720 }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="Claude 模型首次使用（FTU）表单 — put_use_case_for_model_access。intendedUsers: 1=外部用户 2=内部用户；industryOption 参考: Technology / Finance / Healthcare / Education / Retail / Media / Government / Other" />
      <Form form={form} layout="vertical" size="small" initialValues={{ intendedUsers: '1', companyWebsite: 'https://' }}>
        <Form.Item name="companyName" label="公司名称 (companyName)" rules={[{ required: true, message: '必填' }]}><Input /></Form.Item>
        <Form.Item name="companyWebsite" label="公司网站 (companyWebsite)"><Input /></Form.Item>
        <Form.Item name="intendedUsers" label="目标用户 (intendedUsers)"><Input /></Form.Item>
        <Form.Item name="industryOption" label="行业选项 (industryOption)"><Input /></Form.Item>
        <Form.Item name="otherIndustryOption" label="其他行业 (otherIndustryOption)"><Input /></Form.Item>
        <Form.Item name="useCases" label="使用场景 (useCases)" rules={[{ required: true, message: '必填' }]}><Input.TextArea rows={3} /></Form.Item>
      </Form>
      <Space>
        <Select size="small" style={{ width: 150 }} value={region} onChange={setRegion} options={REGION_OPTS} />
        <Button type="primary" size="small" loading={submitting} onClick={submit}>提交申请</Button>
      </Space>
      {result && <pre style={{ marginTop: 12, padding: 12, background: '#fafafa', borderRadius: 6, fontSize: 12 }}>{result}</pre>}
    </div>
  );
};

// ===== Tab 6: 数据共享（Fable 5） =====
const DataShareTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [regions, setRegions] = useState<string[]>(['us-east-1', 'us-west-2']);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [enabling, setEnabling] = useState(false);

  const load = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    if (!regions.length) { message.warning('请至少选择一个区域'); return; }
    setLoading(true);
    try {
      const res = await api.bedrockGetDataRetention(accountId, regions);
      if (res.success) setRows(res.data || []);
      else message.error(res.error || '查询失败');
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  const enable = async () => {
    setEnabling(true);
    try {
      const res = await api.bedrockEnableDataShare({ accountId, regions });
      if (res.success) {
        setRows(res.data || []);
        const ok = res.data.filter((r: any) => r.ok).length;
        message[ok === res.data.length ? 'success' : 'warning'](`数据共享设置完成：成功 ${ok}/${res.data.length}`);
      } else message.error(res.error || '开启失败');
    } catch (e: any) { message.error(e.message); } finally { setEnabling(false); }
  };

  return (
    <div style={{ paddingTop: 12, maxWidth: 900 }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="Fable 5 需要将 Bedrock data retention 设为 provider_data_share。开启为写操作，仅 admin（实时校验）可执行并写审计。" />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select mode="multiple" size="small" style={{ minWidth: 320 }} value={regions} onChange={setRegions}
          options={REGION_OPTS} maxTagCount={4} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>查看状态</Button>
        <Popconfirm title={`确认为 ${regions.length} 个区域开启 provider_data_share？`} okText="开启" onConfirm={enable}>
          <Button size="small" type="primary" loading={enabling} disabled={!regions.length}>开启选中区域共享</Button>
        </Popconfirm>
      </Space>
      <Table size="small" rowKey="region" dataSource={rows} loading={loading} pagination={false}
        columns={[
          { title: 'Region', dataIndex: 'region', width: 160 },
          { title: '状态', dataIndex: 'ok', width: 90, render: (ok: boolean) => ok ? <Tag color="green">OK</Tag> : <Tag color="red">失败</Tag> },
          { title: 'Data Retention Mode / 详情', dataIndex: 'mode', ellipsis: true },
        ]} />
    </div>
  );
};

// ===== Tab 7: IAM 用户 =====
const IamTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [userName, setUserName] = useState('');
  const [withConsole, setWithConsole] = useState(true);
  const [withKey, setWithKey] = useState(true);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<any>(null);

  const load = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    setLoading(true);
    try {
      const res = await api.bedrockListIamUsers(accountId);
      if (res.success) setRows(res.data || []);
      else message.error(res.error || '加载失败');
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  const doCreate = async () => {
    if (!userName.trim()) { message.warning('请输入用户名'); return; }
    setCreating(true);
    try {
      const res = await api.bedrockCreateAdminUser({ accountId, userName: userName.trim(), createConsoleLogin: withConsole, createAccessKey: withKey });
      if (res.success) { setCreated(res.data); message.success('创建成功，请立即保存凭证（只显示一次）'); load(); }
      else message.error(res.error || '创建失败');
    } catch (e: any) { message.error(e.message); } finally { setCreating(false); }
  };

  return (
    <div style={{ paddingTop: 12 }}>
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" type="primary" icon={<ReloadOutlined />} loading={loading} onClick={load}>加载用户</Button>
        <Button size="small" icon={<UserAddOutlined />} onClick={() => { setCreated(null); setUserName(''); setCreateOpen(true); }}>创建 Admin 用户</Button>
      </Space>
      <Table size="small" rowKey="username" dataSource={rows} loading={loading}
        pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条` }}
        columns={[
          { title: '用户名', dataIndex: 'username', width: 200 },
          { title: 'Admin', dataIndex: 'administrator', width: 80, render: (v: boolean) => v ? <Tag color="red">Yes</Tag> : 'No' },
          { title: 'Console', dataIndex: 'consoleLogin', width: 90, render: (v: boolean) => v ? 'Yes' : 'No' },
          { title: '活跃 Key', dataIndex: 'activeKeys', width: 90 },
          { title: 'Key IDs', dataIndex: 'keyIds', ellipsis: true },
          { title: '创建时间', dataIndex: 'createdAt', width: 180, render: (v: string) => v ? v.slice(0, 19).replace('T', ' ') : '' },
        ]} />
      <Modal title="创建 AdministratorAccess IAM 用户" open={createOpen} onCancel={() => setCreateOpen(false)}
        footer={created ? [<Button key="close" onClick={() => setCreateOpen(false)}>关闭</Button>] : undefined}
        onOk={doCreate} okText="创建" confirmLoading={creating}>
        {!created ? (
          <>
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="将创建挂 AdministratorAccess 的 IAM 用户，仅 admin（实时校验）可执行并写审计。" />
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input placeholder="IAM 用户名" value={userName} onChange={e => setUserName(e.target.value)} />
              <Checkbox checked={withConsole} onChange={e => setWithConsole(e.target.checked)}>创建 Console 登录密码</Checkbox>
              <Checkbox checked={withKey} onChange={e => setWithKey(e.target.checked)}>创建 Access Key</Checkbox>
            </Space>
          </>
        ) : (
          <div>
            <Alert type="success" showIcon style={{ marginBottom: 12 }} message="创建成功。以下凭证只显示这一次，请立即复制保存。" />
            <p><b>用户名：</b><Typography.Text copyable>{created.user.userName}</Typography.Text></p>
            {created.consolePassword && <p><b>Console 密码：</b><Typography.Text copyable code>{created.consolePassword}</Typography.Text></p>}
            {created.accessKey && (
              <>
                <p><b>AccessKeyId：</b><Typography.Text copyable code>{created.accessKey.accessKeyId}</Typography.Text></p>
                <p><b>SecretAccessKey：</b><Typography.Text copyable code>{created.accessKey.secretAccessKey}</Typography.Text></p>
              </>
            )}
            <p><b>Console URL：</b><Typography.Text copyable>{`https://${accountId}.signin.aws.amazon.com/console`}</Typography.Text></p>
          </div>
        )}
      </Modal>
    </div>
  );
};

// ===== Tab 8: 交付表格 =====
const DeliveryTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [regions, setRegions] = useState<string[]>(['us-east-1', 'us-west-2']);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [iamUser, setIamUser] = useState('');
  const [iamPassword, setIamPassword] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    setLoading(true);
    try {
      const res = await api.bedrockListProfiles(accountId, regions);
      if (res.success) {
        setRows(res.data.rows || []);
        if (res.data.errors?.length) message.warning(`部分区域失败：${res.data.errors.map((e: any) => e.region).join(', ')}`);
      } else message.error(res.error || '加载失败');
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  const doExport = async () => {
    if (!rows.length) { message.warning('请先加载 Profiles'); return; }
    if (!iamUser.trim() || !iamPassword) { message.warning('请填写 IAM 用户名和密码'); return; }
    setExporting(true);
    try {
      const blob = await api.bedrockDeliveryExport({
        rows: rows.map(r => ({ name: r.name, arn: r.arn, region: r.region, tags: r.tags || [] })),
        iamUser: iamUser.trim(), iamPassword,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${accountId}-delivery.xlsx`; a.click();
      URL.revokeObjectURL(url);
      message.success('交付表格已下载');
    } catch (e: any) { message.error(e.message); } finally { setExporting(false); }
  };

  return (
    <div style={{ paddingTop: 12, maxWidth: 1000 }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="生成客户交付 Excel：账户信息 + ARN List（按区域分组）+ 使用须知。服务端强校验：所有 Profile 必须同属一个账户、且都带同一个 map-migrated Tag（无 Tag 或 Tag 不一致会拒绝生成）。" />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select mode="multiple" size="small" style={{ minWidth: 280 }} value={regions} onChange={setRegions}
          options={REGION_OPTS} maxTagCount={4} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>加载 Profiles（{rows.length}）</Button>
        <Input size="small" placeholder="交付 IAM 用户名" style={{ width: 200 }} value={iamUser} onChange={e => setIamUser(e.target.value)} />
        <Input.Password size="small" placeholder="交付 IAM 密码" style={{ width: 220 }} value={iamPassword} onChange={e => setIamPassword(e.target.value)} />
        <Button size="small" type="primary" icon={<DownloadOutlined />} loading={exporting}
          disabled={!rows.length || !iamUser.trim() || !iamPassword} onClick={doExport}>生成交付表格</Button>
      </Space>
      <Table size="small" rowKey="arn" dataSource={rows} loading={loading}
        pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条` }}
        columns={[
          { title: 'Region', dataIndex: 'region', width: 110 },
          { title: 'Name', dataIndex: 'name', width: 260 },
          { title: 'map-migrated', key: 'mig', width: 160, render: (_: any, r: any) => {
            const t = (r.tags || []).find((x: any) => x.key === 'map-migrated');
            return t ? <Tag color="green">{t.value}</Tag> : <Tag color="red">缺失</Tag>;
          } },
          { title: 'ARN', dataIndex: 'arn', ellipsis: true },
        ]} />
    </div>
  );
};

const BedrockPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [activeTab, setActiveTab] = useState('profiles');

  useEffect(() => {
    api.listAccounts().then((res: any) => {
      if (res.success) setAccounts(res.data || []);
    }).catch(() => undefined);
  }, []);

  const accountOptions = (() => {
    const grouped: Record<string, any[]> = {};
    accounts.forEach(a => { const p = a._payer || 'other'; if (!grouped[p]) grouped[p] = []; grouped[p].push(a); });
    return Object.entries(grouped).map(([payer, accts]) => ({
      label: payer,
      options: accts.map(a => ({ label: `${a.Name} (${a.Id})`, value: a.Id })),
    }));
  })();

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">Bedrock 工具</h2>
          <p className="page-header-subtitle">Inference Profile 管理、批量创建、模型开通、数据共享与交付表格</p>
        </div>
      </div>

      <div className="filter-bar">
        <Select placeholder="选择账户" style={{ width: 260 }} value={selectedAccount || undefined}
          onChange={setSelectedAccount} showSearch optionFilterProp="label" size="small" options={accountOptions} />
        {!selectedAccount && <span style={{ fontSize: 12, color: '#d46b08' }}>所有操作走 Admin 凭证，请先选择账户</span>}
      </div>

      <Card size="small" bodyStyle={{ padding: '0 16px 16px' }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          { key: 'profiles', label: 'Profiles 管理', children: <ProfilesTab accountId={selectedAccount} /> },
          { key: 'create', label: '批量创建', children: <CreateTab accountId={selectedAccount} /> },
          { key: 'invoke', label: '模型测试', children: <InvokeTab accountId={selectedAccount} /> },
          { key: 'models', label: '模型列表', children: <ModelsTab accountId={selectedAccount} /> },
          { key: 'ftu', label: '模型开通', children: <FtuTab accountId={selectedAccount} /> },
          { key: 'datashare', label: '数据共享', children: <DataShareTab accountId={selectedAccount} /> },
          { key: 'iam', label: 'IAM 用户', children: <IamTab accountId={selectedAccount} /> },
          { key: 'delivery', label: '交付表格', children: <DeliveryTab accountId={selectedAccount} /> },
        ]} />
      </Card>
    </div>
  );
};

export default BedrockPage;
