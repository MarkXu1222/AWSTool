import React, { useState, useEffect } from 'react';
import { Card, Button, message, Alert, Image, Input, Form, Table, Tag, Modal, Select, Space, Popconfirm, Tabs, Checkbox } from 'antd';
import { SafetyOutlined, CheckCircleOutlined, LogoutOutlined, LockOutlined, UserAddOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { api } from '../api';
import { PAGE_META } from '../components/MainLayout';

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
  const [users, setUsers] = useState<any[]>([]);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [resetPwdOpen, setResetPwdOpen] = useState<any>(null);
  const [editUserOpen, setEditUserOpen] = useState<any>(null);
  const [addForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const ALL_PAGE_KEYS = PAGE_META.map(p => p.key);
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
      const connRes = await api.testConnection();
      if (connRes.success) setConnection(connRes.data);
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
      if (res.success) { setMfaEnabled(true); setQrCode(''); message.success('MFA 已启用！'); }
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
    // 未设置 allowed_pages (旧数据/admin) 时默认勾全
    const initialPages = Array.isArray(record.allowed_pages) ? record.allowed_pages : ALL_PAGE_KEYS;
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
      <div style={{ maxWidth: 640 }}>
      <Tabs items={[
        { key: 'connection', label: '连接', children: (
          <Card size="small" title="连接状态">
            {connection.length === 0 && checking && <span style={{ color: '#999' }}>检查中...</span>}
            {connection.map((c, i) => (
              <Alert key={i} type={c.ok ? 'success' : 'error'} showIcon
                message={`${c.name}: ${c.ok ? '✅ ' + c.account : '❌ ' + c.error}`} style={{ marginBottom: 4 }} />
            ))}
          </Card>
        )},
        { key: 'security', label: '安全', children: (
          <>
            <Card size="small" title="MFA 双因素认证" style={{ marginBottom: 12 }}>
              {mfaEnabled ? (
                <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="MFA 已启用 ✅" description="每次登录需要动态验证码" />
              ) : qrCode ? (
                <div>
                  <p style={{ marginBottom: 8 }}>用 Authenticator 扫码：</p>
                  <div style={{ textAlign: 'center' }}><Image src={qrCode} width={180} /></div>
                  <p style={{ fontSize: 12, color: '#999', margin: '8px 0', wordBreak: 'break-all' }}>密钥: <code>{mfaSecret}</code></p>
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
            <Card size="small" title="修改密码">
              <Form layout="vertical" onFinish={async (values: any) => {
                if (values.newPassword !== values.confirmPassword) { message.error('两次密码不一致'); return; }
                const res = await api.changePassword(values.currentPassword, values.newPassword);
                if (res.success) message.success('密码已修改'); else message.error(res.error);
              }}>
                <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
                <Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
                <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} /></Form.Item>
                <Button type="primary" htmlType="submit" block>修改密码</Button>
              </Form>
            </Card>
          </>
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
                { title: 'MFA', dataIndex: 'mfa_enabled', width: 60, align: 'center' as const, render: (m: boolean) => m ? '✅' : '❌' },
                { title: '页面权限', width: 260, render: (_: any, record: any) => {
                  if (record.role === 'admin') return <Tag color="red" style={{ margin: 0 }}>全部</Tag>;
                  const pages: string[] = Array.isArray(record.allowed_pages) ? record.allowed_pages : ALL_PAGE_KEYS;
                  if (pages.length === ALL_PAGE_KEYS.length) return <Tag color="green" style={{ margin: 0 }}>全部</Tag>;
                  if (pages.length === 0) return <Tag style={{ margin: 0 }}>无</Tag>;
                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {pages.map(k => {
                        const meta = PAGE_META.find(p => p.key === k);
                        return <Tag key={k} style={{ margin: 0 }}>{meta?.label || k}</Tag>;
                      })}
                    </div>
                  );
                }},
                { title: '根用户权限', dataIndex: 'root_access', width: 110, align: 'center' as const, render: (v: boolean, record: any) => (
                  record.role === 'admin'
                    ? <Tag color="red" style={{ margin: 0 }}>全部</Tag>
                    : (v ? <Tag color="purple" style={{ margin: 0 }}>已授权</Tag> : <Tag style={{ margin: 0 }}>—</Tag>)
                )},
                { title: '批量提额', dataIndex: 'bulk_quota_access', width: 110, align: 'center' as const, render: (v: boolean, record: any) => (
                  record.role === 'admin'
                    ? <Tag color="red" style={{ margin: 0 }}>全部</Tag>
                    : (v ? <Tag color="volcano" style={{ margin: 0 }}>已授权</Tag> : <Tag style={{ margin: 0 }}>—</Tag>)
                )},
                { title: '操作', width: 190, fixed: 'right' as const, render: (_: any, record: any) => (
                  <Space size="small">
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEditUser(record)}>编辑</Button>
                    <Button size="small" onClick={() => { setResetPwdOpen(record); resetForm.resetFields(); }}>重置</Button>
                    <Popconfirm title="确定删除？" onConfirm={() => handleDeleteUser(record.id)} okText="删除" cancelText="取消">
                      <Button size="small" danger aria-label="删除用户" icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                )},
              ]} />
          </Card>
        )},
        { key: 'account', label: '账号', children: (
          <Card size="small">
            <Button danger icon={<LogoutOutlined />} onClick={onLogout} block size="large">退出登录</Button>
          </Card>
        )},
      ]} />

      {/* Add user modal */}
      <Modal title="添加用户" open={addUserOpen} onOk={handleAddUser} onCancel={() => setAddUserOpen(false)} okText="创建" destroyOnClose>
        <Form form={addForm} layout="vertical" initialValues={{ role: 'viewer', allowedPages: ALL_PAGE_KEYS, rootAccess: false, bulkQuotaAccess: false }}>
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
                  extra="勾选该用户可见的左侧菜单页面">
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
                  extra="勾选该用户可见的左侧菜单页面">
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
