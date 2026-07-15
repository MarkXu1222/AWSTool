import React, { useState, useEffect } from 'react';
import { Card, Button, message, Image, Input, Alert, Steps } from 'antd';
import { SafetyOutlined, LogoutOutlined } from '@ant-design/icons';
import { api } from '../api';

interface SetupMFAProps {
  onComplete: () => void;
  onLogout: () => void;
}

/**
 * 强制 MFA 绑定页面 — 新用户首次登录、尚未绑定 MFA 时必须完成
 */
const SetupMFA: React.FC<SetupMFAProps> = ({ onComplete, onLogout }) => {
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => { initSetup(); }, []);

  const initSetup = async () => {
    setLoading(true);
    try {
      const res = await api.setupMFA();
      if (res.qrCode) { setQrCode(res.qrCode); setSecret(res.secret); }
      else message.error('获取 MFA 二维码失败');
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const confirm = async () => {
    if (!code || code.length !== 6) { message.warning('请输入 6 位验证码'); return; }
    setConfirming(true);
    try {
      const res = await api.confirmMFA(secret, code);
      if (res.success) {
        message.success('MFA 绑定成功');
        localStorage.setItem('mfaEnabled', 'true');
        onComplete();
      } else {
        message.error(res.error || '验证码错误');
      }
    } catch (e: any) { message.error(e.message); }
    finally { setConfirming(false); }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5', padding: 16 }}>
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <SafetyOutlined style={{ fontSize: 36, color: '#1890ff' }} />
          <h2 style={{ margin: '12px 0 4px', fontSize: 20 }}>绑定双因素认证 (MFA)</h2>
          <p style={{ color: '#888', margin: 0, fontSize: 13 }}>为保障账户安全，首次登录必须绑定 MFA</p>
        </div>

        <Alert
          type="info" showIcon style={{ marginBottom: 16 }}
          message="操作步骤"
          description={
            <ol style={{ paddingLeft: 18, margin: '4px 0', fontSize: 12 }}>
              <li>用 Authenticator App（Google / Microsoft Authenticator 等）扫描下方二维码</li>
              <li>输入 App 显示的 6 位动态验证码完成绑定</li>
            </ol>
          }
        />

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>加载二维码中...</div>
        ) : (
          <>
            <div style={{ textAlign: 'center', marginBottom: 12 }}>
              {qrCode && <Image src={qrCode} width={180} preview={false} />}
            </div>
            <p style={{ fontSize: 12, color: '#999', wordBreak: 'break-all', textAlign: 'center', marginBottom: 16 }}>
              无法扫码？手动输入密钥：<br/><code>{secret}</code>
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                placeholder="6 位验证码" value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6} size="large" inputMode="numeric"
                onPressEnter={confirm} style={{ flex: 1 }} autoFocus
              />
              <Button type="primary" size="large" loading={confirming} onClick={confirm}>确认绑定</Button>
            </div>
          </>
        )}

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button type="text" size="small" icon={<LogoutOutlined />} onClick={onLogout} style={{ color: '#999' }}>
            退出登录
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default SetupMFA;
