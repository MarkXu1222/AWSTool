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
      <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#1890ff', borderRadius: 4, fontSize: 13 } }}>
        {renderContent()}
      </ConfigProvider>
    </ErrorBoundary>
  );
};

export default App;
