import React, { useState } from 'react';
import { Card, Form, Input, Button, message, Alert } from 'antd';
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
      } else {
        message.error(result.error || '登录失败');
      }
    } catch (e: any) {
      message.error(e.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      padding: 20,
    }}>
      <Card style={{ width: 380, borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>☁️ AWS Toolbox</h1>
          <p style={{ color: '#666', margin: '4px 0 0' }}>Multi-Account Manager</p>
        </div>

        <Form form={form} layout="vertical" onFinish={handleLogin}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" size="large" autoComplete="username" />
          </Form.Item>

          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" autoComplete="current-password" />
          </Form.Item>

          {needMFA && (
            <Form.Item name="totpCode" rules={[{ required: true, message: '请输入 6 位验证码' }]}>
              <Input prefix={<SafetyOutlined />} placeholder="MFA 验证码 (6位)" size="large" maxLength={6} autoFocus />
            </Form.Item>
          )}

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} size="large" block>
              {needMFA ? '验证并登录' : '登录'}
            </Button>
          </Form.Item>
        </Form>

        {needMFA && (
          <Alert message="请打开 Authenticator App 输入 6 位动态码" type="info" showIcon />
        )}
      </Card>
    </div>
  );
};

export default LoginPage;
