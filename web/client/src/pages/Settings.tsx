import React, { useState, useEffect } from 'react';
import { Card, Button, message, Alert, Image, Input, Form, Table, Tag, Modal, Select, Space, Popconfirm, Tabs } from 'antd';
import { SafetyOutlined, CheckCircleOutlined, LogoutOutlined, LockOutlined, UserAddOutlined, DeleteOutlined } from '@ant-design/icons';
import { api } from '../api';

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
  const [addForm] = Form.useForm();
  const [resetForm] = Form.useForm();

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
      const res = await api.createUser(values.username, values.password, values.role);
      if (res.success) { message.success(res.message); setAddUserOpen(false); addForm.resetFields(); loadUsers(); }
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
                  <p style={{ fontSize: 11, color: '#999', margin: '8px 0', wordBreak: 'break-all' }}>密钥: <code>{mfaSecret}</code></p>
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
              columns={[
                { title: '用户名', dataIndex: 'username', render: (u: string) => <strong>{u}</strong> },
                { title: '角色', dataIndex: 'role', width: 80, render: (r: string) => <Tag color={r === 'admin' ? 'red' : 'blue'}>{r}</Tag> },
                { title: 'MFA', dataIndex: 'mfa_enabled', width: 50, render: (m: boolean) => m ? '✅' : '❌' },
                { title: '操作', width: 130, render: (_: any, record: any) => (
                  <Space size="small">
                    <Button size="small" onClick={() => { setResetPwdOpen(record); resetForm.resetFields(); }}>重置</Button>
                    <Popconfirm title="确定删除？" onConfirm={() => handleDeleteUser(record.id)} okText="删除" cancelText="取消">
                      <Button size="small" danger icon={<DeleteOutlined />} />
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
      <Modal title="添加用户" open={addUserOpen} onOk={handleAddUser} onCancel={() => setAddUserOpen(false)} okText="创建">
        <Form form={addForm} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}><Input.Password /></Form.Item>
          <Form.Item name="role" label="角色" initialValue="viewer">
            <Select options={[{ label: '管理员 (admin)', value: 'admin' }, { label: '查看者 (viewer)', value: 'viewer' }]} />
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
