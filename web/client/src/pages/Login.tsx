import React, { useState } from 'react';
import { Form, Input, Button, message, Alert } from 'antd';
import { LockOutlined, UserOutlined, SafetyOutlined } from '@ant-design/icons';
import { api } from '../api';

interface LoginPageProps {
  onSuccess: () => void;
}

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
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 16,
      background: 'radial-gradient(760px 360px at 50% -8%, #e8f0ff, transparent 62%), #f4f5f7',
    }}>
      <div className="login-card" style={{
        width: '100%', maxWidth: 384, background: '#fff', borderRadius: 16,
        padding: '34px 32px 30px',
        boxShadow: '0 12px 40px rgba(16,24,40,0.10), 0 2px 8px rgba(16,24,40,0.05)',
      }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <img className="login-logo" src="/image.png" alt="AWS Toolbox" width={56} height={56}
            style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 12, display: 'block', margin: '0 auto 12px' }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#1a2233', letterSpacing: '-0.01em' }}>AWS Toolbox</h1>
          <p style={{ color: '#8a94a6', fontSize: 13, margin: '4px 0 0' }}>登录以继续</p>
        </div>

        <Form form={form} layout="vertical" onFinish={handleLogin} requiredMark={false}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]} style={{ marginBottom: 14 }}>
            <Input prefix={<UserOutlined style={{ color: '#94a3b8' }} />} placeholder="用户名" size="large"
              aria-label="用户名" autoComplete="username" spellCheck={false} autoCapitalize="off" />
          </Form.Item>

          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]} style={{ marginBottom: needMFA ? 14 : 20 }}>
            <Input.Password prefix={<LockOutlined style={{ color: '#94a3b8' }} />} placeholder="密码" size="large"
              aria-label="密码" autoComplete="current-password" />
          </Form.Item>

          {needMFA && (
            <Form.Item name="totpCode" rules={[{ required: true, message: '请输入 6 位验证码' }]} style={{ marginBottom: 20 }}>
              <Input prefix={<SafetyOutlined style={{ color: '#94a3b8' }} />} placeholder="6 位动态验证码" size="large"
                aria-label="动态验证码" maxLength={6} autoFocus inputMode="numeric" autoComplete="one-time-code" spellCheck={false} />
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
  );
};

export default LoginPage;
