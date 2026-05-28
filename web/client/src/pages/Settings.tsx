import React, { useState, useEffect } from 'react';
import { Card, Button, message, Alert, Image, Input, Form } from 'antd';
import { SafetyOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { api } from '../api';

const SettingsPage: React.FC = () => {
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
    <div style={{ maxWidth: 600 }}>
      <Card size="small" title="🔗 连接状态" style={{ marginBottom: 12 }}>
        {connection.map((c, i) => (
          <Alert key={i} type={c.ok ? 'success' : 'error'} showIcon
            message={`${c.name}: ${c.ok ? '✅ ' + c.account : '❌ ' + c.error}`} style={{ marginBottom: 4 }} />
        ))}
      </Card>

      <Card size="small" title={<span><SafetyOutlined /> MFA 设置</span>}>
        {mfaEnabled ? (
          <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="MFA 已启用" description="每次登录需要输入 Authenticator 动态码" />
        ) : qrCode ? (
          <div>
            <p>用 Google Authenticator / Authy 扫描以下二维码：</p>
            <Image src={qrCode} width={200} style={{ margin: '12px 0' }} />
            <p style={{ fontSize: 11, color: '#999' }}>密钥: <code>{mfaSecret}</code></p>
            <Input placeholder="输入 6 位验证码确认" value={confirmCode} onChange={e => setConfirmCode(e.target.value)} maxLength={6} style={{ width: 200, marginRight: 8 }} />
            <Button type="primary" onClick={confirmMFA}>确认启用</Button>
          </div>
        ) : (
          <div>
            <p>启用 MFA 后，每次登录需要密码 + 手机动态验证码，大幅提升安全性。</p>
            <Button type="primary" icon={<SafetyOutlined />} onClick={setupMFA} loading={loading} style={{ marginTop: 8 }}>启用 MFA</Button>
          </div>
        )}
      </Card>
    </div>
  );
};

export default SettingsPage;
