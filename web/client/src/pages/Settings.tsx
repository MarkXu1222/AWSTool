import React, { useState, useEffect } from 'react';
import { Card, Button, message, Alert, Image, Input, Divider } from 'antd';
import { SafetyOutlined, CheckCircleOutlined, LogoutOutlined } from '@ant-design/icons';
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

  useEffect(() => { checkStatus(); }, []);

  const checkStatus = async () => {
    try {
      const connRes = await api.testConnection();
      if (connRes.success) setConnection(connRes.data);
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

  return (
    <div style={{ maxWidth: 500 }}>
      <Card size="small" title="🔗 连接状态" style={{ marginBottom: 12 }}>
        {connection.map((c, i) => (
          <Alert key={i} type={c.ok ? 'success' : 'error'} showIcon
            message={`${c.name}: ${c.ok ? '✅ ' + c.account : '❌ ' + c.error}`} style={{ marginBottom: 4 }} />
        ))}
      </Card>

      <Card size="small" title={<span><SafetyOutlined /> MFA 设置</span>} style={{ marginBottom: 12 }}>
        {mfaEnabled ? (
          <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="MFA 已启用" />
        ) : qrCode ? (
          <div>
            <p style={{ marginBottom: 8 }}>用 Authenticator 扫码：</p>
            <Image src={qrCode} width={180} style={{ margin: '8px 0' }} />
            <p style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>密钥: <code>{mfaSecret}</code></p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input placeholder="6 位验证码" value={confirmCode} onChange={e => setConfirmCode(e.target.value)} maxLength={6} style={{ flex: 1 }} />
              <Button type="primary" onClick={confirmMFA}>确认</Button>
            </div>
          </div>
        ) : (
          <div>
            <p style={{ marginBottom: 8 }}>启用后每次登录需要动态验证码</p>
            <Button type="primary" icon={<SafetyOutlined />} onClick={setupMFA} loading={loading}>启用 MFA</Button>
          </div>
        )}
      </Card>

      {onLogout && (
        <Card size="small">
          <Button danger icon={<LogoutOutlined />} onClick={onLogout} block>登出</Button>
        </Card>
      )}
    </div>
  );
};

export default SettingsPage;
