import React, { useState, useEffect } from 'react';
import { ConfigProvider, theme } from 'antd';
import LoginPage from './pages/Login';
import MainLayout from './components/MainLayout';
import { api } from './api';

const App: React.FC = () => {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

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
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#0071e3', borderRadius: 8, fontSize: 13 } }}>
      {authenticated ? (
        <MainLayout onLogout={() => { localStorage.removeItem('token'); setAuthenticated(false); }} />
      ) : (
        <LoginPage onSuccess={() => setAuthenticated(true)} />
      )}
    </ConfigProvider>
  );
};

export default App;
