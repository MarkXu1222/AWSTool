/**
 * Bedrock 工具页 —— 从桌面版 Bedrock Profile Manager 迁移。
 * Tab：Profiles 管理 / 批量创建 / 模型测试 / 模型列表 / 模型开通(FTU) / 数据共享 / IAM 用户 / 交付表格。
 * ⚠️ Tag 纪律：创建/打 Tag 的 tags 必须每次显式输入，前后端都不提供默认值。
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  Card, Tabs, Select, Button, Table, Tag, Input, Space, message, Modal, Form,
  Checkbox, Alert, Tooltip, Popconfirm, InputNumber, Typography, AutoComplete,
} from 'antd';
import { ReloadOutlined, PlusOutlined, DeleteOutlined, TagsOutlined, ThunderboltOutlined, DownloadOutlined, UserAddOutlined, CopyOutlined, LoadingOutlined } from '@ant-design/icons';
import { api } from '../api';
import { REGIONS } from '../constants/regions';

/**
 * 复制到剪贴板。navigator.clipboard 在非 HTTPS / 旧 WebView 下可能不存在，
 * 这里显式兜底提示，避免点了没反应又不报错。
 */
async function copyText(text: string, label = '内容') {
  if (!navigator.clipboard?.writeText) {
    message.error('当前浏览器不允许写剪贴板，请手动选中复制');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    message.success(`已复制${label}`);
  } catch {
    message.error('复制失败，请手动选中复制');
  }
}

/**
 * Bedrock 可用区域全集，与 Quotas.tsx 的 BEDROCK_REGIONS 保持一致。
 * 之前这里只写了 10 个区域，ap-southeast-5（马来西亚）、ap-southeast-7（泰国）、
 * ap-east-2（台北）、eu-south-*、mx-central-1 等全都选不到，
 * 导致这些区域的 Profile / 配额 / 数据共享在页面上完全不可达。
 * 未开通或暂不支持 Bedrock 的区域会由后端作为部分失败返回，不影响其它区域。
 */
const BEDROCK_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1',
  'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3',
  'ap-east-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-south-1', 'ap-south-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'af-south-1', 'sa-east-1', 'mx-central-1',
];
// 中文名复用配额页的 REGIONS（含国家/地区 + 城市），搜「巴西」「美国」也能命中，避免两份列表漂移
const REGION_LABEL = new Map(REGIONS.filter(r => r.value).map(r => [r.value, r.label]));
const REGION_OPTS = BEDROCK_REGIONS.map(r => ({
  label: REGION_LABEL.get(r) || r,
  value: r,
}));
// 后端 /profiles 单次最多 12 个区域，「全选」按钮据此取前 12 个高频区域，
// 避免点了就 400。需要更多区域时手动多选或分批查询。
const PROFILE_REGION_LIMIT = 12;

// 常见 Provider（未加载模型前也可选；加载后与实际数据合并去重）
// 须与后端 bedrock-tools.ts 的 PROVIDER_HINTS 规范名一致，否则加载后会出现两个同名不同写法的选项
const KNOWN_PROVIDERS = [
  'Anthropic', 'Amazon', 'OpenAI', 'Meta', 'Mistral', 'Cohere', 'AI21', 'Stability', 'DeepSeek', 'Qwen',
  'xAI', 'Moonshot', 'TwelveLabs', 'Writer', 'Google', 'MiniMax', 'NVIDIA', 'Z.ai', 'Luma',
];

// Tag key 固定用 map-migrated（业务纪律）；value 每次必须手动输入，无默认值
const FIXED_TAG_KEY = 'map-migrated';

/**
 * Tag 输入组件：第一行 key 固定为 map-migrated（只读），value 每次必填；
 * 追加行可自定义 key（少数场景需要额外 tag）。
 */
const TagInputs: React.FC<{
  tags: { key: string; value: string }[];
  onChange: (tags: { key: string; value: string }[]) => void;
}> = ({ tags, onChange }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    {tags.map((t, i) => (
      <Space key={i}>
        <Input size="small" style={{ width: 220 }} value={t.key} disabled={i === 0}
          placeholder="Tag Key（必填）"
          onChange={e => onChange(tags.map((x, j) => j === i ? { ...x, key: e.target.value } : x))} />
        <Input size="small" placeholder={i === 0 ? 'Tag Value（每次必填，如 migXXXXXXX）' : 'Tag Value（必填）'} style={{ width: 260 }} value={t.value}
          onChange={e => onChange(tags.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
        {i > 0 && <Button size="small" danger type="text" onClick={() => onChange(tags.filter((_, j) => j !== i))}>删除</Button>}
      </Space>
    ))}
    <Button size="small" type="dashed" onClick={() => onChange([...tags, { key: '', value: '' }])} style={{ width: 140 }}>+ 添加额外 Tag</Button>
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
  const [tagInputs, setTagInputs] = useState<{ key: string; value: string }[]>([{ key: FIXED_TAG_KEY, value: '' }]);
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
      setTagInputs([{ key: FIXED_TAG_KEY, value: '' }]);
      load();
    } catch (e: any) { message.error(e.message); } finally { setActing(false); }
  };

  return (
    <ProfilesTabView {...{
      regions, setRegions, load, loading, search, setSearch, filtered,
      selectedKeys, setSelectedKeys, errors, doDelete, doTag, acting,
      tagModalOpen, setTagModalOpen, tagInputs, setTagInputs,
      visibleSelectedCount: selectedRows.length,
      // 复制用「当前可见且被选中」的 ARN：与删除/打 Tag 的口径一致，
      // 避免复制到被搜索框过滤掉、用户其实看不见的行。
      selectedArns: selectedRows.map(r => r.arn),
    }} />
  );
};

const ProfilesTabView: React.FC<any> = ({
  regions, setRegions, load, loading, search: _s, setSearch, filtered, selectedKeys, setSelectedKeys,
  errors, doDelete, doTag, acting, tagModalOpen, setTagModalOpen, tagInputs, setTagInputs, visibleSelectedCount,
  selectedArns,
}) => (
  <div style={{ paddingTop: 12 }}>
    <Space wrap style={{ marginBottom: 12 }}>
      {/* maxCount=12：后端 /profiles 单次上限，超了会直接 400 */}
      <Select mode="multiple" size="small" style={{ minWidth: 320 }} value={regions} onChange={setRegions}
        showSearch optionFilterProp="label" maxCount={PROFILE_REGION_LIMIT}
        options={REGION_OPTS} placeholder={`选择区域（最多 ${PROFILE_REGION_LIMIT} 个）`} maxTagCount={4} />
      <Button size="small" type="primary" icon={<ReloadOutlined />} loading={loading} onClick={load}>加载 Profiles</Button>
      <Input.Search size="small" placeholder="筛选：名称 / ARN / Tag / 模型" allowClear style={{ width: 260 }}
        onChange={e => setSearch(e.target.value)} />
      <span style={{ fontSize: 12, color: '#8a94a6' }}>已选 {visibleSelectedCount} / {filtered.length}</span>
      <Tooltip title="把选中行的 ARN 按每行一条复制到剪贴板">
        <Button size="small" icon={<CopyOutlined />} disabled={!visibleSelectedCount}
          onClick={() => copyText(selectedArns.join('\n'), `${selectedArns.length} 条 ARN`)}>
          复制选中 ARN
        </Button>
      </Tooltip>
      <Tooltip title="把当前筛选结果的全部 ARN 复制到剪贴板">
        <Button size="small" icon={<CopyOutlined />} disabled={!filtered.length}
          onClick={() => copyText(filtered.map((r: any) => r.arn).join('\n'), `${filtered.length} 条 ARN`)}>
          复制全部 ARN
        </Button>
      </Tooltip>
      <Button size="small" icon={<TagsOutlined />} disabled={!visibleSelectedCount} onClick={() => setTagModalOpen(true)}>批量打 Tag</Button>
      <Popconfirm title={`确认删除选中的 ${visibleSelectedCount} 个 Profile？`} okText="删除" okButtonProps={{ danger: true }} onConfirm={doDelete}>
        <Button size="small" danger icon={<DeleteOutlined />} disabled={!visibleSelectedCount} loading={acting}>批量删除</Button>
      </Popconfirm>
    </Space>
    {errors.length > 0 && (
      <Alert type="warning" showIcon style={{ marginBottom: 8 }}
        message={`部分区域查询失败：${errors.map((e: any) => `${e.region}(${e.message})`).join('；')}`} />
    )}
    <Table size="small" rowKey="arn" dataSource={filtered} loading={loading}
      rowSelection={{
        selectedRowKeys: selectedKeys, onChange: setSelectedKeys,
        // 下拉里提供跨页全选/清空/反选（表头 checkbox 只管当前页）
        selections: [Table.SELECTION_ALL, Table.SELECTION_NONE, Table.SELECTION_INVERT],
      }}
      // ARN 列完整展示后总宽超屏，交给表格自身横向滚动，避免挤压其它列
      scroll={{ x: 1400 }}
      pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t: number) => `共 ${t} 条` }}
      columns={[
        { title: 'Region', dataIndex: 'region', width: 110, sorter: (a: any, b: any) => a.region.localeCompare(b.region) },
        { title: 'Name', dataIndex: 'name', width: 240, sorter: (a: any, b: any) => (a.name || '').localeCompare(b.name || '') },
        { title: 'Scope', dataIndex: 'scope', width: 80, render: (s: string) => <Tag color={s === 'Global' ? 'blue' : 'green'}>{s}</Tag> },
        { title: 'Status', dataIndex: 'status', width: 90 },
        { title: '后端模型', dataIndex: 'backendModels', ellipsis: true, width: 200 },
        {
          title: 'Tags', dataIndex: 'tags', width: 200,
          render: (tags: any[]) => (tags || []).map(t => <Tag key={t.key} style={{ marginBottom: 2 }}>{t.key}={t.value}</Tag>),
        },
        {
          // ARN 是拿去测试/交付要逐字用的，之前 ellipsis 截断后根本看不全。
          // 这里不截断、允许换行完整显示，并带独立复制按钮。
          title: 'ARN', dataIndex: 'arn', width: 460,
          render: (a: string) => (
            <Space size={4} align="start">
              <Typography.Text
                style={{ fontSize: 12, fontFamily: 'SFMono-Regular, Consolas, Menlo, monospace', wordBreak: 'break-all' }}
              >{a}</Typography.Text>
              <Tooltip title="复制 ARN">
                <Button type="text" size="small" icon={<CopyOutlined />}
                  onClick={() => copyText(a, 'ARN')} />
              </Tooltip>
            </Space>
          ),
        },
      ]} />
    <Modal title={`批量打 Tag（${visibleSelectedCount} 个 Profile）`} open={tagModalOpen}
      onCancel={() => setTagModalOpen(false)} onOk={doTag} okText="打 Tag" confirmLoading={acting}
      okButtonProps={{ disabled: !validTags(tagInputs) }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Tag 必须每次显式输入，平台不提供默认值，请确认与该账户所属 MAP 协议一致。" />
      <TagInputs tags={tagInputs} onChange={setTagInputs} />
    </Modal>
  </div>
);

// ===== Tab 2: 批量创建 =====
const CreateTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  // 支持多区域：模型列表从第一个区域加载（SYSTEM_DEFINED profiles 各商业区域基本一致），
  // 创建时对每个选中区域分别执行
  const [regions, setRegions] = useState<string[]>(['us-east-1']);
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState('All');
  // Scope 多选筛选（Checkbox 按钮组）；空数组 = 不过滤（显示全部）
  const [scopeFilter, setScopeFilter] = useState<string[]>([]);
  const [kw, setKw] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [prefix, setPrefix] = useState('');
  const [tagInputs, setTagInputs] = useState<{ key: string; value: string }[]>([{ key: FIXED_TAG_KEY, value: '' }]);
  const [creating, setCreating] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const loadModels = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    if (!regions.length) { message.warning('请至少选择一个区域'); return; }
    setLoading(true);
    try {
      const res = await api.bedrockListModels(accountId, regions[0]);
      if (res.success) { setModels(res.data || []); setSelectedKeys((res.data || []).map((m: any) => m.modelId)); }
      else message.error(res.error || '加载失败');
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  // 未加载模型时也有完整 Provider 可选；加载后与实际数据合并去重
  const providers = ['All', ...new Set([...KNOWN_PROVIDERS, ...models.map(m => m.provider)])];
  // Scope 选项按实际数据出（Global / US / EU / APAC...），保持稳定排序
  const scopeOrder = ['Global', 'US', 'EU', 'APAC', 'AP'];
  const scopes = [...new Set(models.map(m => m.scope).filter(Boolean))]
    .sort((a, b) => (scopeOrder.indexOf(a) + 99 * +(scopeOrder.indexOf(a) < 0)) - (scopeOrder.indexOf(b) + 99 * +(scopeOrder.indexOf(b) < 0)));
  const filtered = models.filter(m =>
    (provider === 'All' || m.provider === provider) &&
    (scopeFilter.length === 0 || scopeFilter.includes(m.scope)) &&
    (!kw.trim() || `${m.name} ${m.modelId} ${m.scope}`.toLowerCase().includes(kw.toLowerCase())));

  const buildName = (m: any) => {
    if (!prefix.trim()) return m.name;
    const parts = String(m.modelId).split('.');
    const short = parts.length >= 3 ? parts.slice(2).join('.') : m.modelId.replace(/\./g, '-');
    const scopeTag = parts.length >= 2 ? parts[0] : '';
    return scopeTag ? `${prefix.trim()}-${scopeTag}-${short}` : `${prefix.trim()}-${short}`;
  };

  // ⚠️ 勾选计数必须只算「当前筛选可见」的选中行——selectedKeys 里可能残留被
  // Provider/Scope/关键词过滤隐藏的 key（默认全选后再筛选就会出现），
  // 之前直接用 selectedKeys.length 导致「只选 1 个却显示 8 个」。
  const visibleSelected = filtered.filter(m => selectedKeys.includes(m.modelId));

  const doCreate = async () => {
    const sel = visibleSelected;
    if (!sel.length) { message.warning('请勾选模型'); return; }
    if (!validTags(tagInputs)) { message.warning('必须填写 Tag（key/value 均必填，平台不提供默认值）'); return; }
    setCreating(true);
    setLog([`开始创建：${sel.length} 个模型 × ${regions.length} 个区域...`]);
    try {
      let totalOk = 0, totalFail = 0;
      // 多区域批量：逐区域串行执行（同桌面版语义；后端一次一个区域）
      for (const rgn of regions) {
        const res = await api.bedrockCreateProfiles({
          accountId, region: rgn,
          items: sel.map(m => ({ modelId: m.modelId, name: buildName(m) })),
          tags: tagInputs.map(t => ({ key: t.key.trim(), value: t.value.trim() })),
        });
        if (res.success) {
          const lines = res.data.map((r: any) => r.ok ? `[OK] [${rgn}] ${r.name}` : `[ERR] [${rgn}] ${r.name}: ${r.error}`);
          const ok = res.data.filter((r: any) => r.ok).length;
          totalOk += ok; totalFail += res.data.length - ok;
          setLog(prev => [...prev, ...lines]);
        } else {
          totalFail += sel.length;
          setLog(prev => [...prev, `[ERR] [${rgn}] ${res.error}`]);
        }
      }
      setLog(prev => [...prev, `全部完成：成功 ${totalOk} / 失败 ${totalFail}`]);
      message[totalFail ? 'warning' : 'success'](`创建完成：成功 ${totalOk}${totalFail ? `，失败 ${totalFail}` : ''}`);
    } catch (e: any) { message.error(e.message); } finally { setCreating(false); }
  };

  return (
    <div style={{ paddingTop: 12 }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Select mode="multiple" size="small" style={{ minWidth: 260 }} value={regions} onChange={setRegions}
          showSearch optionFilterProp="label"
          options={REGION_OPTS} placeholder="创建到哪些区域（可多选）" maxTagCount={3} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={loadModels}>刷新模型</Button>
        <Select size="small" style={{ width: 130 }} value={provider} onChange={setProvider}
          options={providers.map(p => ({ label: p, value: p }))} />
        <Input size="small" placeholder="筛选模型名" allowClear style={{ width: 180 }} value={kw} onChange={e => setKw(e.target.value)} />
        <Input size="small" placeholder="命名前缀（留空用模型原名）" style={{ width: 240 }} value={prefix} onChange={e => setPrefix(e.target.value)} />
        {scopes.length > 0 && (
          <Space size={4}>
            <span style={{ fontSize: 12, color: '#8a94a6' }}>Scope:</span>
            {scopes.map(s => (
              <Button key={s} size="small"
                type={scopeFilter.includes(s) ? 'primary' : 'default'}
                onClick={() => setScopeFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}>
                {s}
              </Button>
            ))}
            {scopeFilter.length > 0 && <Button size="small" type="text" onClick={() => setScopeFilter([])}>清除</Button>}
          </Space>
        )}
      </Space>
      <Alert type="warning" showIcon style={{ marginBottom: 8 }}
        message="Tag Key 固定为 map-migrated，Value 每次必须手动输入（migXXXXXXX）。平台不记忆、不提供默认值——请核对与该账户所属 MAP 协议一致后再创建。" />
      <div style={{ marginBottom: 12 }}>
        <TagInputs tags={tagInputs} onChange={setTagInputs} />
      </div>
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" type="primary" icon={<PlusOutlined />} loading={creating}
          disabled={!visibleSelected.length || !regions.length || !validTags(tagInputs)} onClick={doCreate}>
          创建勾选（{visibleSelected.length} 个模型 × {regions.length} 区域）
        </Button>
        {/* 表头 checkbox 只作用于当前页（antd 默认），这两个按钮跨全部页 */}
        <Button size="small" onClick={() => setSelectedKeys(filtered.map(m => m.modelId))}>全选（{filtered.length}）</Button>
        <Button size="small" onClick={() => setSelectedKeys([])}>清空选择</Button>
        {!validTags(tagInputs) && <span style={{ fontSize: 12, color: '#cf1322' }}>请先填写完整 Tag</span>}
      </Space>
      <Table size="small" rowKey="modelId" dataSource={filtered} loading={loading}
        rowSelection={{
          selectedRowKeys: selectedKeys, onChange: setSelectedKeys,
          selections: [Table.SELECTION_ALL, Table.SELECTION_NONE, Table.SELECTION_INVERT],
        }}
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
type ProfileOption = { value: string; label: React.ReactNode; searchText: string };

const profileOptionLabel = (name: string, id: string) => (
  <div className="invoke-profile-option">
    <span>{name}</span>
    <span className="invoke-profile-option-id">{id}</span>
  </div>
);

const InvokeTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [region, setRegion] = useState('us-east-1');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('Hello, please reply with one short sentence.');
  const [maxTokens, setMaxTokens] = useState(1024);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  // 下拉候选：本区域的 Application Profile（值=ARN）+ SYSTEM_DEFINED Profile（值=profile ID）。
  // 只是候选，输入框仍可自由填写任意 Model ID / ARN。
  const [appOptions, setAppOptions] = useState<ProfileOption[]>([]);
  const [systemOptions, setSystemOptions] = useState<ProfileOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  // 切账户/区域时旧请求可能晚到，按序号丢弃过期结果，避免把别的区域的 ARN 塞进下拉
  const loadSeq = useRef(0);

  const loadOptions = async (acct: string, rgn: string) => {
    const seq = ++loadSeq.current;
    setAppOptions([]); setSystemOptions([]); setOptionsError('');
    // 之前的请求在过期检查处直接返回、不会复位 loading，这里必须显式关掉
    if (!acct) { setOptionsLoading(false); return; }
    setOptionsLoading(true);
    const [appRes, sysRes] = await Promise.allSettled([
      api.bedrockListProfiles(acct, [rgn]),
      api.bedrockListModels(acct, rgn),
    ]);
    if (seq !== loadSeq.current) return;
    const errs: string[] = [];
    if (appRes.status === 'fulfilled' && appRes.value.success) {
      const rows = (appRes.value.data?.rows || []) as any[];
      setAppOptions(rows
        .filter(r => r.arn)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        .map(r => ({
          value: r.arn,
          label: profileOptionLabel(r.name || r.arn, r.arn),
          searchText: `${r.name || ''} ${r.backendModels || ''} ${r.arn}`.toLowerCase(),
        })));
      for (const e of appRes.value.data?.errors || []) errs.push(`Application Profiles：${e.message}`);
    } else {
      errs.push(`Application Profiles：${appRes.status === 'fulfilled' ? appRes.value.error || '加载失败' : appRes.reason?.message || '加载失败'}`);
    }
    if (sysRes.status === 'fulfilled' && sysRes.value.success) {
      const models = (sysRes.value.data || []) as any[];
      setSystemOptions(models
        .filter(m => m.modelId)
        .sort((a, b) => String(a.provider).localeCompare(String(b.provider)) || String(a.name).localeCompare(String(b.name)))
        .map(m => ({
          value: m.modelId,
          label: profileOptionLabel(`${m.name || m.modelId}${m.provider ? ` · ${m.provider}` : ''}`, m.modelId),
          searchText: `${m.name || ''} ${m.provider || ''} ${m.scope || ''} ${m.modelId}`.toLowerCase(),
        })));
    } else {
      errs.push(`系统 Profiles：${sysRes.status === 'fulfilled' ? sysRes.value.error || '加载失败' : sysRes.reason?.message || '加载失败'}`);
    }
    setOptionsError(errs.join('；'));
    setOptionsLoading(false);
  };

  useEffect(() => { void loadOptions(accountId, region); }, [accountId, region]);

  const selectedFromList = !!modelId && [...appOptions, ...systemOptions].some(o => o.value === modelId);

  // 换区域时，如果当前值是从旧区域下拉选来的，就清空（ARN/区域前缀 profile 跨区调用必然失败）；
  // 手动输入的值保留，由使用者自行决定
  const onRegionChange = (next: string) => {
    if (selectedFromList) setModelId('');
    setRegion(next);
  };

  const profileOptions = [
    ...(appOptions.length ? [{ label: `Application Profiles（${appOptions.length}）`, options: appOptions }] : []),
    ...(systemOptions.length ? [{ label: `系统 Profiles（${systemOptions.length}）`, options: systemOptions }] : []),
  ];

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
        <Select size="small" style={{ width: 190 }} value={region} onChange={onRegionChange}
          showSearch optionFilterProp="label" options={REGION_OPTS} />
        {/* AutoComplete：下拉选本区域 Profile，也可直接手动输入任意 Model ID / ARN */}
        {/* 不用自定义 Input 子节点：antd AutoComplete 包自定义 Input 时 allowClear 需挂在子节点上，容易清不干净 */}
        <AutoComplete size="small" style={{ width: 460 }} value={modelId} onChange={v => setModelId(v ?? '')}
          options={profileOptions} popupMatchSelectWidth={560} allowClear
          placeholder="选择本区域 Profile，或手动输入 Model ID / Inference Profile ARN"
          filterOption={(input, option) => {
            const kw = input.trim().toLowerCase();
            // 已选中某个候选时输入框里是完整 ARN/ID，再展开要能看到全部候选去换别的，而不是只剩自己
            if (!kw || selectedFromList) return true;
            return !!(option as any)?.searchText?.includes(kw);
          }}
          notFoundContent={optionsLoading
            ? <span><LoadingOutlined /> 正在加载本区域 Profiles…</span>
            : accountId ? '本区域没有匹配的 Profile，可直接输入' : '请先选择账户'} />
        <Tooltip title="重新加载本区域 Profiles">
          <Button size="small" icon={<ReloadOutlined />} loading={optionsLoading}
            disabled={!accountId} onClick={() => loadOptions(accountId, region)} />
        </Tooltip>
        <InputNumber size="small" min={1} max={4096} value={maxTokens} onChange={v => setMaxTokens(v || 1024)} addonBefore="maxTokens" style={{ width: 180 }} />
      </Space>
      {optionsError && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }}
          message={`部分候选加载失败（仍可手动输入）：${optionsError}`} />
      )}
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
        <Select size="small" style={{ width: 190 }} value={region} onChange={setRegion}
          showSearch optionFilterProp="label" options={REGION_OPTS} />
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
        <Select size="small" style={{ width: 190 }} value={region} onChange={setRegion}
          showSearch optionFilterProp="label" options={REGION_OPTS} />
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
        {/* maxCount=20：后端 /data-retention 单次上限 */}
        <Select mode="multiple" size="small" style={{ minWidth: 320 }} value={regions} onChange={setRegions}
          showSearch optionFilterProp="label" maxCount={20}
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

// ===== Tab: Bedrock 配额查询（TPM/RPM/TPD，与配额管理页 Bedrock Tab 同一后端接口） =====
// Account-Level = 账户级跨模型总配额（Cross-Model Account-Level Tokens Per Day），
// 约束整个账户所有模型的合计用量，与按推理范围划分的其余 scope 是不同维度
const BEDROCK_QUOTA_SCOPES = ['Global Cross-Region', 'Cross-Region', 'On-Demand', 'Latency-Optimized', 'Account-Level', 'Other'];
// Provider 固定候选（与后端 inferBedrockProvider 的规范名一致，同 Quotas 页），查询前也能直接选
const BEDROCK_QUOTA_PROVIDERS = [
  'Anthropic', 'Amazon', 'Meta', 'Mistral', 'Cohere', 'AI21', 'DeepSeek', 'Qwen',
  'OpenAI', 'Google', 'Moonshot', 'MiniMax', 'NVIDIA', 'Z.ai', 'Stability',
  'TwelveLabs', 'Writer', 'Luma', 'Bedrock (服务级)', 'Other',
];
const SCOPE_COLOR: Record<string, string> = {
  'Global Cross-Region': 'blue', 'Cross-Region': 'green', 'On-Demand': 'orange', 'Latency-Optimized': 'purple',
  'Account-Level': 'magenta',
};
const fmtNum = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M` : v.toLocaleString();

const QuotaQueryTab: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [regions, setRegions] = useState<string[]>(['us-east-1']);
  const [rows, setRows] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState('');
  const [scopes, setScopes] = useState<string[]>(BEDROCK_QUOTA_SCOPES);
  const [search, setSearch] = useState('');

  const load = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    if (!regions.length) { message.warning('请至少选择一个区域'); return; }
    setLoading(true);
    try {
      const res = await api.getBedrockQuotas(accountId, regions);
      if (res.success) {
        setRows(res.data.rows || []);
        setErrors(res.data.errors || []);
        const n = (res.data.rows || []).length;
        n ? message.success(`已查询到 ${n} 条 Bedrock 配额`) : message.info('未查询到配额（该账户/区域可能未开通 Bedrock）');
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); } finally { setLoading(false); }
  };

  // Provider 候选 = 固定清单 ∪ 实际查到的（保证查询前就能选，查询后也不漏新 provider）
  const providers = [...new Set([...BEDROCK_QUOTA_PROVIDERS, ...rows.map(r => r.provider).filter(Boolean)])];
  const filtered = rows.filter(r =>
    (!provider || r.provider === provider) &&
    scopes.includes(r.scope) &&
    (!search.trim() || `${r.model} ${r.region} ${r.scope} ${r.provider}`.toLowerCase().includes(search.toLowerCase())));

  return (
    <div style={{ paddingTop: 12 }}>
      <Space wrap style={{ marginBottom: 8 }}>
        {/* 配额查询后端上限 30，正好等于区域全集，故「全选区域」可以全给 */}
        <Select mode="multiple" allowClear size="small" style={{ minWidth: 340 }} placeholder="选择区域（可多选）"
          showSearch optionFilterProp="label" maxCount={30}
          value={regions} onChange={setRegions} maxTagCount="responsive" options={REGION_OPTS} />
        <Button type="primary" size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>一键查询</Button>
        <Button size="small" onClick={() => setRegions(['us-east-1'])}>仅 us-east-1</Button>
        <Button size="small" onClick={() => setRegions(BEDROCK_REGIONS)}>全选区域（{BEDROCK_REGIONS.length}）</Button>
      </Space>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select size="small" style={{ width: 150 }} value={provider} onChange={setProvider} showSearch optionFilterProp="label"
          options={[{ label: '全部 Provider', value: '' }, ...providers.map(p => ({ label: p, value: p }))]} />
        <Select mode="multiple" size="small" style={{ width: 300 }} allowClear placeholder="推理范围"
          value={scopes} onChange={setScopes} maxTagCount="responsive"
          options={BEDROCK_QUOTA_SCOPES.map(s => ({ label: s, value: s }))} />
        <Input.Search size="small" placeholder="搜索模型 / 区域 / 范围" allowClear style={{ width: 220 }}
          onChange={e => setSearch(e.target.value)} />
        <span style={{ fontSize: 12, color: '#8a94a6' }}>{filtered.length} / {rows.length} 条</span>
      </Space>
      {errors.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }}
          message={`部分区域查询失败（多为未开通 Bedrock）：${errors.map((e: any) => e.region).join(', ')}`} />
      )}
      <Table size="small" dataSource={filtered} loading={loading}
        rowKey={(r: any) => `${r.region}|${r.provider}|${r.model}|${r.scope}`}
        pagination={{ pageSize: 15, showTotal: t => `共 ${t} 条`, showSizeChanger: true }}
        scroll={{ x: 900 }}
        locale={{ emptyText: accountId ? '选择区域后点击「一键查询」获取 TPM / RPM / TPD 配额' : '请先选择账户' }}
        columns={[
          { title: '区域', dataIndex: 'region', width: 120, sorter: (a: any, b: any) => a.region.localeCompare(b.region) },
          { title: 'Provider', dataIndex: 'provider', width: 110, render: (p: string) => <Tag style={{ margin: 0 }}>{p}</Tag> },
          { title: '模型', dataIndex: 'model', ellipsis: true, sorter: (a: any, b: any) => a.model.localeCompare(b.model) },
          { title: '推理范围', dataIndex: 'scope', width: 150,
            render: (s: string) => <Tag color={SCOPE_COLOR[s] || 'default'} style={{ margin: 0, fontSize: 11 }}>{s}</Tag> },
          ...(['TPM', 'RPM', 'TPD'] as const).map(metric => ({
            title: metric === 'TPM' ? 'TPM (令牌/分)' : metric === 'RPM' ? 'RPM (请求/分)' : 'TPD (令牌/天)',
            key: metric, width: 140, align: 'right' as const,
            sorter: (a: any, b: any) => (a.metrics?.[metric]?.value ?? -1) - (b.metrics?.[metric]?.value ?? -1),
            render: (_: any, r: any) => {
              const m = r.metrics?.[metric];
              if (!m) return <span style={{ color: 'rgba(0,0,0,0.25)' }}>-</span>;
              // inherited：该模型没有自己的 TPD，值取自账户级跨模型总配额。
              // 必须显式区分，否则会被读成"这个模型每天独享这么多 token"。
              if (m.inherited) {
                return (
                  <Tooltip title={`该模型无独立 TPD，此值取自账户级跨模型总配额（${m.quotaName}），由本账户所有模型共享`}>
                    <span style={{ fontWeight: 500, color: '#8a94a6' }}>{fmtNum(m.value)}</span>
                    <Tag color="magenta" style={{ marginLeft: 4, fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>共享</Tag>
                  </Tooltip>
                );
              }
              return <span style={{ fontWeight: 500 }}>{fmtNum(m.value)}</span>;
            },
          })),
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
  const [creatingUser, setCreatingUser] = useState(false);
  // 交付变体（规范第四节）：仅 global 版是近期主要要求，故作默认值
  const [variant, setVariant] = useState<'full' | 'global'>('global');

  // 一键创建交付 IAM 用户（AdministratorAccess + console 密码，不建 AK——交付表格只需要 console 登录），
  // 创建成功后自动填入下方用户名/密码，直接生成表格即可（与桌面版一键流程一致）
  const oneClickCreateUser = async () => {
    if (!accountId) { message.warning('请先选择账户'); return; }
    const name = iamUser.trim() || 'admin';
    setCreatingUser(true);
    try {
      const res = await api.bedrockCreateAdminUser({ accountId, userName: name, createConsoleLogin: true, createAccessKey: false });
      if (res.success) {
        setIamUser(res.data.user.userName);
        setIamPassword(res.data.consolePassword);
        message.success(`IAM 用户 ${res.data.user.userName} 已创建，凭证已自动填入`);
      } else message.error(res.error || '创建失败');
    } catch (e: any) { message.error(e.message); } finally { setCreatingUser(false); }
  };

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

  const doExport = async (v2 = false) => {
    if (!rows.length) { message.warning('请先加载 Profiles'); return; }
    if (!iamUser.trim() || !iamPassword) { message.warning('请填写 IAM 用户名和密码'); return; }
    setExporting(true);
    try {
      const res = v2
        // 李浩版：带 backendModels/scope 供服务端做 Profile↔配额（TPM/TPD）匹配，
        // 服务端会按 variant 筛选清单内模型并实时查 Service Quotas，耗时约 10-30s
        ? await api.bedrockDeliveryExportV2({
          accountId,
          rows: rows.map(r => ({ name: r.name, arn: r.arn, region: r.region, tags: r.tags || [], backendModels: r.backendModels, scope: r.scope })),
          iamUser: iamUser.trim(), iamPassword, variant,
        })
        : await api.bedrockDeliveryExport({
          rows: rows.map(r => ({ name: r.name, arn: r.arn, region: r.region, tags: r.tags || [] })),
          iamUser: iamUser.trim(), iamPassword,
        });
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${accountId}-delivery${v2 ? '-v2' : ''}.xlsx`; a.click();
      URL.revokeObjectURL(url);

      if (v2) {
        message.success(`交付表格（带 TPM 版）已下载：${res.rows} 条（${variant === 'full' ? '全量版' : '仅 global 版'}）`);
        // 规范红线：配额为 0 说明提额未生效，必须人工确认后再交付，不能直接发客户
        if (res.zeroQuota.length) {
          message.warning({
            content: `⚠️ ${res.zeroQuota.length} 条配额实测为 0（提额未生效），已如实写入。确认提额生效后请重新生成再交付：${res.zeroQuota.slice(0, 3).join('、')}${res.zeroQuota.length > 3 ? ' 等' : ''}`,
            duration: 10,
          });
        }
        if (res.missing.length) {
          message.warning({
            content: `清单中有型号在账户内不存在，已自动跳过：${res.missing.join('；')}`,
            duration: 8,
          });
        }
      } else {
        message.success('交付表格已下载');
      }
    } catch (e: any) { message.error(e.message); } finally { setExporting(false); }
  };

  return (
    <div style={{ paddingTop: 12, maxWidth: 1000 }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="生成客户交付 Excel：账户信息 + ARN List（按区域分组）+ 使用须知。服务端强校验：所有 Profile 必须同属一个账户、且都带同一个 map-migrated Tag（无 Tag 或 Tag 不一致会拒绝生成）。" />
      <Space wrap style={{ marginBottom: 12 }}>
        {/* 交付表格走 /profiles，同样受 12 区域上限约束 */}
        <Select mode="multiple" size="small" style={{ minWidth: 280 }} value={regions} onChange={setRegions}
          showSearch optionFilterProp="label" maxCount={PROFILE_REGION_LIMIT}
          options={REGION_OPTS} maxTagCount={4} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>加载 Profiles（{rows.length}）</Button>
        <Input size="small" placeholder="交付 IAM 用户名（默认 admin）" style={{ width: 210 }} value={iamUser} onChange={e => setIamUser(e.target.value)} />
        <Popconfirm title={`将在账户创建 AdministratorAccess 用户「${iamUser.trim() || 'admin'}」并生成 Console 密码，继续？`}
          okText="创建" onConfirm={oneClickCreateUser}>
          <Button size="small" icon={<UserAddOutlined />} loading={creatingUser}>一键创建 IAM 用户</Button>
        </Popconfirm>
        <Input.Password size="small" placeholder="交付 IAM 密码（可一键生成）" style={{ width: 220 }} value={iamPassword} onChange={e => setIamPassword(e.target.value)} />
        <Button size="small" type="primary" icon={<DownloadOutlined />} loading={exporting}
          disabled={!rows.length || !iamUser.trim() || !iamPassword} onClick={() => doExport(false)}>生成交付表格</Button>
        <Select size="small" style={{ width: 178 }} value={variant} onChange={setVariant}
          options={[
            { value: 'global', label: '仅 global 版（6 条/区）' },
            { value: 'full', label: '全量版（12 条/区）' },
          ]} />
        <Tooltip title="李浩版五列格式：Profile Name / ARN / TPM / TPD / Region。按所选变体筛选核心 9 模型并固定排序（含 Sonnet/Opus/Haiku 5.5；老模型 haiku-4-5/fable/opus-4-1/4-5/sonnet-4/4-5 一律剔除）；服务端实时查 Service Quotas 匹配 TPM/TPD（约 10-30s），提额未生效如实写 0">
          <Button size="small" icon={<DownloadOutlined />} loading={exporting}
            disabled={!rows.length || !iamUser.trim() || !iamPassword} onClick={() => doExport(true)}>交付表格-带TPM版</Button>
        </Tooltip>
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
          { key: 'quotas', label: '配额查询', children: <QuotaQueryTab accountId={selectedAccount} /> },
          { key: 'datashare', label: '数据共享', children: <DataShareTab accountId={selectedAccount} /> },
          { key: 'iam', label: 'IAM 用户', children: <IamTab accountId={selectedAccount} /> },
          { key: 'delivery', label: '交付表格', children: <DeliveryTab accountId={selectedAccount} /> },
        ]} />
      </Card>
    </div>
  );
};

export default BedrockPage;
