import React, { useState, useEffect } from 'react';
import { Card, Button, message, Alert, Image, Input, Form } from 'antd';
import { SafetyOutlined, CheckCircleOutlined, LogoutOutlined, LockOutlined } from '@ant-design/icons';
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

  useEffect(() => { checkStatus(); }, []);

  const checkStatus = async () => {
    try {
      // Check MFA from server
      const meRes = await api.me();
      if (meRes.mfaEnabled) setMfaEnabled(true);

      const connRes = await api.testConnection();
      if (connRes.success) setConnection(connRes.data);
    } catch {}
    setChecking(false);
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
      if (res.success) {
        setMfaEnabled(true);
        setQrCode('');
        localStorage.setItem('mfaEnabled', 'true');
        message.success('MFA 已启用！下次登录需要验证码');
      } else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
  };

  return (
    <div style={{ maxWidth: 500 }}>
      <Card size="small" title="🔗 连接状态" style={{ marginBottom: 12 }}>
        {connection.length === 0 && checking && <span style={{ color: '#999' }}>检查中...</span>}
        {connection.map((c, i) => (
          <Alert key={i} type={c.ok ? 'success' : 'error'} showIcon
            message={`${c.name}: ${c.ok ? '✅ ' + c.account : '❌ ' + c.error}`} style={{ marginBottom: 4 }} />
        ))}
      </Card>

      <Card size="small" title={<span><SafetyOutlined /> MFA 双因素认证</span>} style={{ marginBottom: 12 }}>
        {mfaEnabled ? (
          <Alert type="success" showIcon icon={<CheckCircleOutlined />}
            message="MFA 已启用 ✅"
            description="每次登录需要输入 Authenticator 动态验证码" />
        ) : qrCode ? (
          <div>
            <p style={{ marginBottom: 8 }}>用 Google Authenticator / Authy 扫码：</p>
            <div style={{ textAlign: 'center' }}>
              <Image src={qrCode} width={180} style={{ margin: '8px 0' }} />
            </div>
            <p style={{ fontSize: 11, color: '#999', marginBottom: 8, wordBreak: 'break-all' }}>手动输入密钥: <code>{mfaSecret}</code></p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input placeholder="输入 6 位验证码" value={confirmCode} onChange={e => setConfirmCode(e.target.value)}
                maxLength={6} style={{ flex: 1 }} size="large" inputMode="numeric" />
              <Button type="primary" onClick={confirmMFA} size="large">确认</Button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ marginBottom: 12, color: '#666' }}>启用 MFA 后，登录时除了密码还需要手机动态码，防止密码泄露被入侵。</p>
            <Button type="primary" icon={<SafetyOutlined />} onClick={setupMFA} loading={loading} block>启用 MFA</Button>
          </div>
        )}
      </Card>

      <Card size="small" title="🔑 修改密码" style={{ marginBottom: 12 }}>
        <Form layout="vertical" onFinish={async (values: any) => {
          if (values.newPassword !== values.confirmPassword) {
            message.error('两次输入的新密码不一致');
            return;
          }
          try {
            const res = await api.changePassword(values.currentPassword, values.newPassword);
            if (res.success) {
              message.success(res.message || '密码已修改');
            } else {
              message.error(res.error || '修改失败');
            }
          } catch (e: any) {
            message.error(e.message || '修改失败');
          }
        }}>
          <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="当前密码" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '密码至少 6 位' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="新密码（至少 6 位）" />
          </Form.Item>
          <Form.Item name="confirmPassword" label="确认新密码" rules={[{ required: true, message: '请确认新密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="再次输入新密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>修改密码</Button>
        </Form>
      </Card>

      {onLogout && (
        <Card size="small" style={{ marginTop: 12 }}>
          <Button danger icon={<LogoutOutlined />} onClick={onLogout} block size="large">退出登录</Button>
        </Card>
      )}
    </div>
  );
};

export default SettingsPage;
