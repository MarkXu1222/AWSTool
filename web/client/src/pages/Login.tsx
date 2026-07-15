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
      background: 'radial-gradient(1000px 520px at 15% -10%, rgba(37,99,235,0.38), transparent 60%), linear-gradient(135deg, #0f172a 0%, #172554 100%)',
    }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Brand header on dark background */}
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <img src="/image.png" alt="AWS Toolbox"
            style={{ width: 60, height: 60, objectFit: 'contain', borderRadius: 14, marginBottom: 12, boxShadow: '0 8px 24px rgba(2,6,23,0.45)' }} />
          <h1 style={{ color: '#fff', fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>AWS Toolbox</h1>
          <p style={{ color: 'rgba(255,255,255,0.6)', margin: '6px 0 0', fontSize: 13 }}>多账户管理平台</p>
        </div>

        {/* Login card */}
        <div style={{ background: '#fff', borderRadius: 16, padding: '28px 26px', boxShadow: '0 24px 60px rgba(2,6,23,0.45)' }}>
          <Form form={form} layout="vertical" onFinish={handleLogin} requiredMark={false}>
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]} style={{ marginBottom: 16 }}>
              <Input prefix={<UserOutlined style={{ color: '#94a3b8' }} />} placeholder="用户名" size="large"
                autoComplete="username" spellCheck={false} autoCapitalize="off" />
            </Form.Item>

            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]} style={{ marginBottom: needMFA ? 16 : 20 }}>
              <Input.Password prefix={<LockOutlined style={{ color: '#94a3b8' }} />} placeholder="密码" size="large"
                autoComplete="current-password" />
            </Form.Item>

            {needMFA && (
              <Form.Item name="totpCode" rules={[{ required: true, message: '请输入 6 位验证码' }]} style={{ marginBottom: 20 }}>
                <Input prefix={<SafetyOutlined style={{ color: '#94a3b8' }} />} placeholder="6 位动态验证码" size="large"
                  maxLength={6} autoFocus inputMode="numeric" autoComplete="one-time-code" spellCheck={false} />
              </Form.Item>
            )}

            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" loading={loading} size="large" block>
                {needMFA ? '验证并登录' : '登录'}
              </Button>
            </Form.Item>
          </Form>

          {needMFA && (
            <Alert style={{ marginTop: 16 }} message="请打开 Authenticator App 输入 6 位动态码" type="info" showIcon />
          )}
        </div>

        <p style={{ textAlign: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 12, marginTop: 18 }}>
          © AWS Toolbox · 安全登录需 MFA
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
