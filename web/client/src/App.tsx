import React, { useState, useEffect } from 'react';
import { ConfigProvider, theme } from 'antd';
import LoginPage from './pages/Login';
import MainLayout from './components/MainLayout';
import SetupMFA from './pages/SetupMFA';
import ErrorBoundary from './components/ErrorBoundary';
import { api } from './api';

const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState(false);
  const [mfaBound, setMfaBound] = useState(true); // 是否已绑定 MFA
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  // Auto-logout when JWT expires (check every 60s)
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(() => {
      const token = localStorage.getItem('token');
      if (!token) { setAuthenticated(false); return; }
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          localStorage.removeItem('token');
          setAuthenticated(false);
        }
      } catch {
        localStorage.removeItem('token');
        setAuthenticated(false);
      }
    }, 60 * 1000);
    return () => clearInterval(interval);
  }, [authenticated]);

  // /auth/me 的 401 不会 reject（要把错误文案交给登录页），所以必须显式判断：
  // 只有拿到带 username 的正常响应才算已登录。否则会话过期会被当成
  // 「已登录但 mfaEnabled 缺失」而错误跳转到 MFA 绑定页（且二维码为空）。
  const isValidMe = (me: any) => !!me && !me.unauthorized && !me.error && !!me.username;

  const checkAuth = async () => {
    const token = localStorage.getItem('token');
    if (!token) { setChecking(false); return; }
    try {
      const me = await api.me();
      if (isValidMe(me)) {
        setAuthenticated(true);
        setMfaBound(!!me.mfaEnabled);
      } else {
        localStorage.removeItem('token');
      }
    } catch {
      localStorage.removeItem('token');
    }
    setChecking(false);
  };

  // 登录成功回调：检查是否已绑定 MFA
  const handleLoginSuccess = async () => {
    setAuthenticated(true);
    try {
      const me = await api.me();
      // 取不到有效信息时按「已绑定」处理，宁可放行到主界面（后续请求会再触发 401
      // 刷新回登录页），也不要把用户推进一个必然空白的 MFA 绑定页。
      setMfaBound(isValidMe(me) ? !!me.mfaEnabled : true);
    } catch { setMfaBound(true); }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setAuthenticated(false);
    setMfaBound(true);
  };

  if (checking) return null;

  const renderContent = () => {
    if (!authenticated) {
      return <LoginPage onSuccess={handleLoginSuccess} />;
    }
    if (!mfaBound) {
      // 已登录但未绑定 MFA — 强制绑定
      return <SetupMFA onComplete={() => setMfaBound(true)} onLogout={handleLogout} />;
    }
    return <MainLayout onLogout={handleLogout} />;
  };

  return (
    <ErrorBoundary>
      <ConfigProvider theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#2563eb',
          colorInfo: '#2563eb',
          colorSuccess: '#52c41a',
          colorWarning: '#faad14',
          colorError: '#ff4d4f',
          borderRadius: 8,
          fontSize: 14,
          colorBgLayout: '#f4f5f7',
          colorBorderSecondary: '#e8eaf0',
          controlHeight: 36,
          controlHeightSM: 30,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
        },
        components: {
          Card: { borderRadiusLG: 14 },
          Button: { primaryShadow: 'none', fontWeight: 500 },
          Table: { headerBg: '#f9fafb', rowHoverBg: '#f6f8fb', borderColor: '#eef0f4' },
          Tabs: { inkBarColor: '#2563eb', titleFontSize: 15 },
          Segmented: { itemSelectedBg: '#2563eb', itemSelectedColor: '#fff' },
        },
      }}>
        {renderContent()}
      </ConfigProvider>
    </ErrorBoundary>
  );
};

export default App;
