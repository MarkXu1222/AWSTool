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

  const checkAuth = async () => {
    const token = localStorage.getItem('token');
    if (!token) { setChecking(false); return; }
    try {
      const me = await api.me();
      setAuthenticated(true);
      setMfaBound(!!me.mfaEnabled);
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
      setMfaBound(!!me.mfaEnabled);
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
          colorSuccess: '#16a34a',
          colorWarning: '#d97706',
          colorError: '#dc2626',
          borderRadius: 8,
          fontSize: 14,
          colorBgLayout: '#f4f5f7',
          colorBorderSecondary: '#e8eaf0',
          controlHeight: 34,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
        },
        components: {
          Card: { borderRadiusLG: 14 },
          Button: { primaryShadow: 'none', fontWeight: 500 },
          Table: { headerBg: '#f9fafb', rowHoverBg: '#f6f8fb', borderColor: '#eef0f4' },
          Tabs: { inkBarColor: '#2563eb' },
          Segmented: { itemSelectedBg: '#2563eb', itemSelectedColor: '#fff' },
        },
      }}>
        {renderContent()}
      </ConfigProvider>
    </ErrorBoundary>
  );
};

export default App;
