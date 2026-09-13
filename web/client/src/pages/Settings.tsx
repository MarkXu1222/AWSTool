import React, { useState, useEffect } from 'react';
import { Card, Button, message, Alert, Image, Input, Form, Table, Tag, Modal, Select, Space, Tabs, Checkbox, Tooltip, Row, Col, Dropdown } from 'antd';
import { SafetyOutlined, CheckCircleOutlined, LockOutlined, UserAddOutlined, EditOutlined, ReloadOutlined, MoreOutlined } from '@ant-design/icons';
import { api } from '../api';
import { PAGE_META, OPS_PAGE_KEY } from '../components/MainLayout';

interface SettingsPageProps {
  onLogout?: () => void;
}

const SettingsPage: React.FC<SettingsPageProps> = ({ onLogout }) => {
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<any[]>([]);
  const [checking, setChecking] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [normalExpanded, setNormalExpanded] = useState(false);
  const [settingsTab, setSettingsTab] = useState('connection');
  const [users, setUsers] = useState<any[]>([]);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [resetPwdOpen, setResetPwdOpen] = useState<any>(null);
  const [editUserOpen, setEditUserOpen] = useState<any>(null);
  const [addForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [pwdForm] = Form.useForm();
  const ALL_PAGE_KEYS = PAGE_META.map(p => p.key);
  // 敏感页面（运维监控、Bedrock 工具——后者全部走 Admin 凭证）non-admin 必须显式勾选；
  // 旧用户和新用户默认均不授予。
  const SENSITIVE_PAGE_KEYS = [OPS_PAGE_KEY, 'bedrock'];
  const DEFAULT_PAGE_KEYS = PAGE_META.filter(p => !SENSITIVE_PAGE_KEYS.includes(p.key)).map(p => p.key);
  const ROLE_OPTIONS = [
    { label: '管理员 (admin) — 全部权限', value: 'admin' },
    { label: '部分管理员 (partadmin) — 能操作但仅限勾选页面', value: 'partadmin' },
    { label: '查看者 (viewer) — 只读', value: 'viewer' },
  ];

  useEffect(() => { checkStatus(); loadUsers(); }, []);

  const checkStatus = async () => {
    try {
      const meRes = await api.me();
      if (meRes.mfaEnabled) setMfaEnabled(true);
    } catch {}
    await runConnectionTest();
  };

  // 连接测试单独抽出，支持手动重测（排障时需要复测而不是刷新整页）
  const runConnectionTest = async () => {
    setChecking(true);
    try {
      const connRes = await api.testConnection();
      if (connRes.success) { setConnection(connRes.data || []); setLastChecked(new Date()); }
    } catch {}
    setChecking(false);
  };

  const loadUsers = async () => {
    try {
      const res = await api.listUsers();
      if (res.success) setUsers(res.data || []);
    } catch {}
  };

  const setupMFA = async () => {
    setLoading(true);
    try {
      const res = await api.setupMFA();
      if (res.qrCode) { setQrCode(res.qrCode); setMfaSecret(res.secret); }
      else message.error('获取 QR 码失败');
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const confirmMFA = async () => {
    try {
      const res = await api.confirmMFA(mfaSecret, confirmCode);
      if (res.success) { setMfaEnabled(true); setQrCode(''); message.success('MFA 已启用'); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const handleAddUser = async () => {
    const values = await addForm.validateFields();
    try {
      // admin 忽略 allowedPages (后端会视为全部)；viewer 传勾选的
      const allowedPages = values.role === 'admin' ? undefined : (values.allowedPages || []);
      const res = await api.createUser(values.username, values.password, values.role, allowedPages, !!values.rootAccess, !!values.bulkQuotaAccess);
      if (res.success) { message.success(res.message); setAddUserOpen(false); addForm.resetFields(); loadUsers(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const openEditUser = (record: any) => {
    // 未设置 allowed_pages 的旧 non-admin 只默认勾选常规页面，不自动授予运维监控
    const initialPages = Array.isArray(record.allowed_pages) ? record.allowed_pages : DEFAULT_PAGE_KEYS;
    editForm.setFieldsValue({ role: record.role, allowedPages: initialPages, rootAccess: !!record.root_access, bulkQuotaAccess: !!record.bulk_quota_access });
    setEditUserOpen(record);
  };

  const handleEditUser = async () => {
    const values = await editForm.validateFields();
    try {
      const allowedPages = values.role === 'admin' ? undefined : (values.allowedPages || []);
      const res = await api.updateUser(editUserOpen.id, { role: values.role, allowedPages, rootAccess: !!values.rootAccess, bulkQuotaAccess: !!values.bulkQuotaAccess });
      if (res.success) { message.success(res.message || '已更新'); setEditUserOpen(null); editForm.resetFields(); loadUsers(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const handleDeleteUser = async (id: number) => {
    try {
      const res = await api.deleteUser(id);
      if (res.success) { message.success('已删除'); loadUsers(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  const handleResetPwd = async () => {
    const values = await resetForm.validateFields();
    try {
      const res = await api.resetUserPassword(resetPwdOpen.id, values.newPassword);
      if (res.success) { message.success(res.message); setResetPwdOpen(null); resetForm.resetFields(); }
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-header-title">设置</h2>
          <p className="page-header-subtitle">管理连接、安全策略和用户</p>
        </div>
      </div>
      {/* 各 tab 按内容限宽：全放开会在宽屏把表格列拉出大空档 */}
      <div style={{ maxWidth: settingsTab === 'users' ? 1080 : settingsTab === 'security' ? 920 : 720 }}>
      <Tabs activeKey={settingsTab} onChange={setSettingsTab} items={[
        { key: 'connection', label: '连接', children: (() => {
          const failed = connection.filter((c: any) => !c.ok);
          const okList = connection.filter((c: any) => c.ok);
          const summaryColor = connection.length === 0 ? '#8a94a6' : failed.length === 0 ? '#52c41a' : failed.length / connection.length > 1 / 3 ? '#ff4d4f' : '#d48806';
          return (
            <Card size="small" title="连接状态"
              extra={
                <Space size="middle">
                  {lastChecked && <span style={{ fontSize: 12, color: '#8a94a6' }}>检查于 {lastChecked.toLocaleTimeString()}</span>}
                  <Button size="small" icon={<ReloadOutlined />} loading={checking} onClick={runConnectionTest}>重新检测</Button>
                </Space>
              }>
              {/* 汇总行：3 秒回答「有没有挂的」 */}
              <div style={{ fontSize: 15, fontWeight: 600, color: summaryColor, marginBottom: 12 }}>
                {connection.length === 0
                  ? (checking ? '检查中…' : '暂无连接数据')
                  : failed.length === 0
                    ? `✓ 全部正常（${okList.length}/${connection.length} 组织）`
                    : `${failed.length} 个组织异常（${okList.length}/${connection.length} 正常）`}
              </div>

              {/* 异常置顶：唯一值得 Alert 级视觉重量的内容，错误原文 + 排障指引 */}
              {failed.map((c: any, i: number) => (
                <Alert key={c.name || i} type="error" showIcon style={{ marginBottom: 6 }}
                  message={<strong>{c.name}</strong>}
                  description={
                    <div>
                      <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{c.error || '连接失败'}</div>
                      <div style={{ marginTop: 6, fontSize: 12, color: '#8a94a6' }}>
                        {/AssumeRole/i.test(c.error || '')
                          ? '排查：确认该 payer 管理账户存在 role/tool，且信任策略包含平台身份；修复后点右上角「重新检测」。'
                          : '排查：确认 config.json 中该 payer 的 roleArn 配置正确、目标账户可访问；修复后点右上角「重新检测」。'}
                      </div>
                    </div>
                  } />
              ))}

              {/* 正常组织默认折叠为紧凑标签流；ID 放 tooltip 不占版面 */}
              {okList.length > 0 && (
                <div style={{ marginTop: failed.length > 0 ? 12 : 0 }}>
                  <Button type="link" size="small" style={{ padding: 0, marginBottom: 6 }}
                    onClick={() => setNormalExpanded(v => !v)}>
                    {normalExpanded ? '收起' : `展开正常组织 (${okList.length})`}
                  </Button>
                  {normalExpanded && (
                    // 中性灰 chip + 绿点：正常状态不需要 44 个绿框强调，降噪
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {okList.map((c: any) => (
                        <Tooltip key={c.name} title={`账号 ${c.account}`}>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 6,
                            background: '#f5f6f8', borderRadius: 6, padding: '3px 10px',
                            fontSize: 12, color: '#4b5563', cursor: 'default',
                          }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#52c41a', flexShrink: 0 }} />
                            {c.name}
                          </span>
                        </Tooltip>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })()},
        { key: 'security', label: '安全', children: (
          // 两卡并排（窄屏自动堆叠）：640px 容器内竖排显得零碎
          <Row gutter={[12, 12]}>
            <Col xs={24} md={12}>
            {/* 不设等高：MFA 已启用时只有一行内容，强行拉伸到与密码表单等高会产生大片空白 */}
            <Card size="small" title="MFA 双因素认证">
              {mfaEnabled ? (
                // 已启用态压缩为一行状态，不占大块面积
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#52c41a' }}>
                  <CheckCircleOutlined /> <strong>已启用</strong>
                  <span style={{ color: '#8a94a6', fontSize: 12 }}>每次登录需要动态验证码</span>
                </div>
              ) : qrCode ? (
                <div>
                  <p style={{ marginBottom: 8 }}>用 Authenticator 扫码：</p>
                  <div style={{ textAlign: 'center' }}><Image src={qrCode} width={180} /></div>
                  <p style={{ fontSize: 12, color: '#8a94a6', margin: '8px 0', wordBreak: 'break-all' }}>密钥: <code>{mfaSecret}</code></p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Input placeholder="6 位验证码" value={confirmCode} onChange={e => setConfirmCode(e.target.value)} maxLength={6} size="large" inputMode="numeric" style={{ flex: 1 }} />
                    <Button type="primary" onClick={confirmMFA} size="large">确认</Button>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={{ marginBottom: 12, color: '#666' }}>启用后登录需要密码 + 手机动态码</p>
                  <Button type="primary" icon={<SafetyOutlined />} onClick={setupMFA} loading={loading} block>启用 MFA</Button>
                </div>
              )}
            </Card>
            </Col>
            <Col xs={24} md={12}>
            <Card size="small" title="修改密码">
              {/* 成功后必须清空表单：明文密码留在输入框里是安全隐患 */}
              <Form layout="vertical" onFinish={async (values: any) => {
                if (values.newPassword !== values.confirmPassword) { message.error('两次密码不一致'); return; }
                const res = await api.changePassword(values.currentPassword, values.newPassword);
                if (res.success) { message.success('密码已修改'); pwdForm.resetFields(); } else message.error(res.error);
              }} form={pwdForm}>
                <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
                <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
                <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
                <Button type="primary" htmlType="submit" block>修改密码</Button>
              </Form>
            </Card>
            </Col>
          </Row>
        )},
        { key: 'users', label: '用户', children: (
          <Card size="small" title="用户管理"
            extra={<Button size="small" icon={<UserAddOutlined />} onClick={() => setAddUserOpen(true)}>添加</Button>}>
            <Table size="small" dataSource={users} rowKey="id" pagination={false}
              scroll={{ x: 'max-content' }}
              columns={[
                { title: '用户名', dataIndex: 'username', width: 110, render: (u: string) => <strong>{u}</strong> },
                { title: '角色', dataIndex: 'role', width: 100, render: (r: string) => (
                  <Tag color={r === 'admin' ? 'red' : r === 'partadmin' ? 'orange' : 'blue'} style={{ margin: 0 }}>{r}</Tag>
                )},
                { title: 'MFA', dataIndex: 'mfa_enabled', width: 80, align: 'center' as const, render: (m: boolean) => (
                  m ? <Tag color="success" style={{ margin: 0 }}>已绑定</Tag> : <Tag color="warning" style={{ margin: 0 }}>未绑定</Tag>
                )},
                // admin 恒有全部权限：三列都刷红色「全部」标签是重复强调，
                // 角色列的红 admin 标签已表达该语义，权限列用弱化文字即可
                { title: '页面权限', width: 320, render: (_: any, record: any) => {
                  if (record.role === 'admin') return <span style={{ color: '#8a94a6', fontSize: 12 }}>全部（管理员）</span>;
                  const pages: string[] = Array.isArray(record.allowed_pages) ? record.allowed_pages : DEFAULT_PAGE_KEYS;
                  if (pages.length === ALL_PAGE_KEYS.length) return <Tag color="green" style={{ margin: 0 }}>全部</Tag>;
                  if (pages.length === DEFAULT_PAGE_KEYS.length && DEFAULT_PAGE_KEYS.every(key => pages.includes(key))) {
                    return <Tag color="blue" style={{ margin: 0 }}>全部常规页面</Tag>;
                  }
                  if (pages.length === 0) return <Tag style={{ margin: 0 }}>无</Tag>;
                  const labels = pages.map(k => PAGE_META.find(p => p.key === k)?.label || k);
                  // 超过 3 个折叠为 +N，完整清单挂 tooltip，避免标签流撑高行
                  const shown = labels.slice(0, 3);
                  const rest = labels.slice(3);
                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {shown.map(l => <Tag key={l} style={{ margin: 0 }}>{l}</Tag>)}
                      {rest.length > 0 && (
                        <Tooltip title={rest.join('、')}>
                          <Tag style={{ margin: 0, cursor: 'default' }}>+{rest.length}</Tag>
                        </Tooltip>
                      )}
                    </div>
                  );
                }},
                { title: '根用户权限', dataIndex: 'root_access', width: 100, align: 'center' as const, render: (v: boolean, record: any) => (
                  record.role === 'admin'
                    ? <span style={{ color: '#8a94a6', fontSize: 12 }}>恒有</span>
                    : (v ? <Tag color="purple" style={{ margin: 0 }}>已授权</Tag> : <span style={{ color: '#d9d9d9' }}>—</span>)
                )},
                { title: '批量提额', dataIndex: 'bulk_quota_access', width: 100, align: 'center' as const, render: (v: boolean, record: any) => (
                  record.role === 'admin'
                    ? <span style={{ color: '#8a94a6', fontSize: 12 }}>恒有</span>
                    : (v ? <Tag color="volcano" style={{ margin: 0 }}>已授权</Tag> : <span style={{ color: '#d9d9d9' }}>—</span>)
                )},
                { title: '操作', width: 150, fixed: 'right' as const, render: (_: any, record: any) => (
                  // 高频动作（编辑）直出，低频（重置密码/删除）收进下拉，降低视觉重量
                  <Space size="small">
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEditUser(record)}>编辑</Button>
                    <Dropdown menu={{ items: [
                      { key: 'reset', label: '重置密码', onClick: () => { setResetPwdOpen(record); resetForm.resetFields(); } },
                      { key: 'delete', label: <span style={{ color: '#ff4d4f' }}>删除用户</span>, onClick: () => {
                        Modal.confirm({ title: `确定删除用户 ${record.username}？`, okText: '删除', okType: 'danger', cancelText: '取消', onOk: () => handleDeleteUser(record.id) });
                      } },
                    ] }} placement="bottomRight">
                      <Button size="small" icon={<MoreOutlined />} aria-label="更多操作" />
                    </Dropdown>
                  </Space>
                )},
              ]} />
          </Card>
        )},
        // 「账号」tab 已删除：整个 tab 只有一个退出登录按钮，而侧栏底部本来就有同一按钮，纯冗余导航
      ]} />

      {/* Add user modal */}
      <Modal title="添加用户" open={addUserOpen} onOk={handleAddUser} onCancel={() => setAddUserOpen(false)} okText="创建" destroyOnClose>
        <Form form={addForm} layout="vertical" initialValues={{ role: 'viewer', allowedPages: DEFAULT_PAGE_KEYS, rootAccess: false, bulkQuotaAccess: false }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}><Input.Password /></Form.Item>
          <Form.Item name="role" label="角色" extra="admin: 全权限 · partadmin: 能操作但页面受限 · viewer: 只读">
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.role !== cur.role}>
            {({ getFieldValue }) => getFieldValue('role') === 'admin' ? (
              <Alert type="info" showIcon message="管理员默认拥有全部页面权限与根用户凭证权限" style={{ marginBottom: 12 }} />
            ) : (
              <>
                <Form.Item name="allowedPages" label="页面权限"
                  extra="勾选该用户可见的左侧菜单页面；运维监控包含系统指标，默认不授权">
                  <Checkbox.Group options={PAGE_META.map(p => ({ label: p.label, value: p.key }))} />
                </Form.Item>
                <Form.Item name="rootAccess" valuePropName="checked" label="根用户凭证权限"
                  extra="允许在账户『根用户』tab 生成 Admin 临时凭证、删除 Root MFA、恢复根密码">
                  <Checkbox>授予根用户凭证操作权限</Checkbox>
                </Form.Item>
                <Form.Item name="bulkQuotaAccess" valuePropName="checked" label="批量提额权限"
                  extra="允许使用『批量提额』页：对某 payer 及其组织下所有账户在多区域批量提交提额请求。未授予时该菜单不可见">
                  <Checkbox>授予批量提额权限</Checkbox>
                </Form.Item>
              </>
            )}
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit user modal */}
      <Modal title={`编辑用户 — ${editUserOpen?.username}`} open={!!editUserOpen}
        onOk={handleEditUser} onCancel={() => setEditUserOpen(null)} okText="保存" destroyOnClose>
        <Form form={editForm} layout="vertical">
          <Form.Item name="role" label="角色" extra="admin: 全权限 · partadmin: 能操作但页面受限 · viewer: 只读">
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.role !== cur.role}>
            {({ getFieldValue }) => getFieldValue('role') === 'admin' ? (
              <Alert type="info" showIcon message="管理员默认拥有全部页面权限与根用户凭证权限" style={{ marginBottom: 12 }} />
            ) : (
              <>
                <Form.Item name="allowedPages" label="页面权限"
                  extra="勾选该用户可见的左侧菜单页面；运维监控包含系统指标，默认不授权">
                  <Checkbox.Group options={PAGE_META.map(p => ({ label: p.label, value: p.key }))} />
                </Form.Item>
                <Form.Item name="rootAccess" valuePropName="checked" label="根用户凭证权限"
                  extra="允许在账户『根用户』tab 生成 Admin 临时凭证、删除 Root MFA、恢复根密码">
                  <Checkbox>授予根用户凭证操作权限</Checkbox>
                </Form.Item>
                <Form.Item name="bulkQuotaAccess" valuePropName="checked" label="批量提额权限"
                  extra="允许使用『批量提额』页：对某 payer 及其组织下所有账户在多区域批量提交提额请求。未授予时该菜单不可见">
                  <Checkbox>授予批量提额权限</Checkbox>
                </Form.Item>
              </>
            )}
          </Form.Item>
        </Form>
      </Modal>

      {/* Reset password modal */}
      <Modal title={`重置密码 — ${resetPwdOpen?.username}`} open={!!resetPwdOpen} onOk={handleResetPwd} onCancel={() => setResetPwdOpen(null)} okText="重置">
        <Form form={resetForm} layout="vertical">
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}>
            <Input.Password placeholder="输入新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
    </div>
  );
};

export default SettingsPage;
