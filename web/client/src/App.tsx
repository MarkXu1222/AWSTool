import React, { useState, useEffect } from 'react';
import { ConfigProvider, theme } from 'antd';
import LoginPage from './pages/Login';
import MainLayout from './components/MainLayout';
import ErrorBoundary from './components/ErrorBoundary';
import { api } from './api';

const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState(false);
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
      await api.me();
      setAuthenticated(true);
    } catch {
      localStorage.removeItem('token');
    }
    setChecking(false);
  };

  if (checking) return null;

  return (
    <ErrorBoundary>
      <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#0071e3', borderRadius: 8, fontSize: 13 } }}>
        {authenticated ? (
          <MainLayout onLogout={() => { localStorage.removeItem('token'); setAuthenticated(false); }} />
        ) : (
          <LoginPage onSuccess={() => setAuthenticated(true)} />
        )}
      </ConfigProvider>
    </ErrorBoundary>
  );
};

export default App;
