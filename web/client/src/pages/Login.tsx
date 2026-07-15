import React, { useState } from 'react';
import { Form, Input, Button, message, Alert } from 'antd';
import { LockOutlined, UserOutlined, SafetyOutlined, CheckCircleFilled } from '@ant-design/icons';
import { api } from '../api';

interface LoginPageProps {
  onSuccess: () => void;
}

const Logo: React.FC<{ size?: number }> = ({ size = 40 }) => (
  <img
    src="/image.png"
    alt="AWS Toolbox"
    width={size}
    height={size}
    style={{ width: size, height: size, objectFit: 'contain', borderRadius: size * 0.2, display: 'block', flexShrink: 0 }}
  />
);

const FEATURES = [
  '账户总览 · 免登录直达 AWS 控制台',
  '配额提升 · 区域批量开通',
  '根用户安全加固 · 全量操作审计',
];

const LoginPage: React.FC<LoginPageProps> = ({ onSuccess }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [needMFA, setNeedMFA] = useState(false);

  const handleLogin = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      const result = await api.login(values.username, values.password, values.totpCode);
      if (result.requireMFA) {
        setNeedMFA(true);
        message.info('请输入 MFA 验证码');
      } else if (result.token) {
        localStorage.setItem('token', result.token);
        message.success('登录成功');
        onSuccess();
      } else if (result.error) {
        message.error(result.error);
      } else {
        message.error('登录失败');
      }
    } catch (e: any) {
      message.error(e.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-split">
      {/* Brand panel (desktop) */}
      <div className="login-brand">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Logo size={40} />
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>AWS Toolbox</span>
        </div>

        <div>
          <h1 style={{ color: '#fff', fontSize: 34, fontWeight: 800, lineHeight: 1.22, letterSpacing: '-0.02em', margin: 0, textWrap: 'balance' }}>
            多账户 AWS,<br />一个控制台搞定
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 15, marginTop: 16, maxWidth: 440, lineHeight: 1.7 }}>
            统一管理账户、费用、配额、区域,以及根用户安全加固与操作审计。
          </p>
          <ul style={{ listStyle: 'none', margin: '30px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {FEATURES.map(t => (
              <li key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'rgba(255,255,255,0.88)', fontSize: 14 }}>
                <CheckCircleFilled style={{ color: '#60a5fa', fontSize: 16, flexShrink: 0 }} />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>© AWS Toolbox · 安全登录需 MFA</div>
      </div>

      {/* Form panel */}
      <div className="login-form-panel">
        <div style={{ width: '100%', maxWidth: 360 }}>
          {/* Mobile-only brand */}
          <div className="login-mobile-brand" style={{ textAlign: 'center', marginBottom: 28 }}>
            <Logo size={52} />
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 12, color: '#1a2233' }}>AWS Toolbox</div>
          </div>

          <h2 style={{ fontSize: 24, fontWeight: 700, margin: 0, color: '#1a2233', letterSpacing: '-0.01em' }}>欢迎回来</h2>
          <p style={{ color: '#8a94a6', fontSize: 14, margin: '6px 0 24px' }}>登录以继续管理你的 AWS 账户</p>

          <Form form={form} layout="vertical" onFinish={handleLogin} requiredMark={false}>
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]} style={{ marginBottom: 16 }}>
              <Input prefix={<UserOutlined style={{ color: '#94a3b8' }} />} placeholder="用户名" size="large"
                autoComplete="username" spellCheck={false} autoCapitalize="off" />
            </Form.Item>

            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]} style={{ marginBottom: needMFA ? 16 : 24 }}>
              <Input.Password prefix={<LockOutlined style={{ color: '#94a3b8' }} />} placeholder="密码" size="large"
                autoComplete="current-password" />
            </Form.Item>

            {needMFA && (
              <Form.Item name="totpCode" label="动态验证码" rules={[{ required: true, message: '请输入 6 位验证码' }]} style={{ marginBottom: 24 }}>
                <Input prefix={<SafetyOutlined style={{ color: '#94a3b8' }} />} placeholder="6 位动态验证码" size="large"
                  maxLength={6} autoFocus inputMode="numeric" autoComplete="one-time-code" spellCheck={false} />
              </Form.Item>
            )}

            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" loading={loading} size="large" block style={{ height: 44, fontWeight: 600 }}>
                {needMFA ? '验证并登录' : '登 录'}
              </Button>
            </Form.Item>
          </Form>

          {needMFA && (
            <Alert style={{ marginTop: 16 }} message="请打开 Authenticator App 输入 6 位动态码" type="info" showIcon />
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
