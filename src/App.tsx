import React, { useState, useEffect } from 'react';
import { ConfigProvider, theme, Spin, Result, Button } from 'antd';
import {
  TeamOutlined,
  DashboardOutlined,
  DeleteOutlined,
  DollarOutlined,
  SettingOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import AccountsPage from './pages/Accounts';
import QuotasPage from './pages/Quotas';
import CleanupPage from './pages/Cleanup';
import BillingPage from './pages/Billing';
import SettingsPage from './pages/Settings';

const navItems = [
  { key: 'accounts', icon: <TeamOutlined />, label: '账户管理' },
  { key: 'quotas', icon: <DashboardOutlined />, label: '配额管理' },
  { key: 'cleanup', icon: <DeleteOutlined />, label: '资源清理' },
  { key: 'billing', icon: <DollarOutlined />, label: '账单分析' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
];

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState('accounts');
  const [initialized, setInitialized] = useState(false);
  const [hasCredentials, setHasCredentials] = useState(false);

  useEffect(() => { checkCredentials(); }, []);

  const checkCredentials = async () => {
    try {
      const result = await window.awsAPI.hasCredentials();
      if (result.success && result.data) {
        setHasCredentials(true);
      } else {
        setCurrentPage('settings');
      }
    } catch {
      setCurrentPage('settings');
    }
    setInitialized(true);
  };

  const renderPage = () => {
    if (!hasCredentials && currentPage !== 'settings') {
      return (
        <Result
          icon={<SettingOutlined style={{ color: 'var(--aws-orange)' }} />}
          title="请先配置 AWS 凭证"
          subTitle="在设置页面配置 Access Key 后即可使用所有功能"
          extra={<Button type="primary" size="large" onClick={() => setCurrentPage('settings')}>去设置</Button>}
        />
      );
    }
    switch (currentPage) {
      case 'accounts': return <AccountsPage />;
      case 'quotas': return <QuotasPage />;
      case 'cleanup': return <CleanupPage />;
      case 'billing': return <BillingPage />;
      case 'settings': return <SettingsPage onConnected={() => setHasCredentials(true)} />;
      default: return <AccountsPage />;
    }
  };

  if (!initialized) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--bg-primary)' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#0071e3',
          borderRadius: 8,
          colorBgContainer: '#ffffff',
          colorBgElevated: '#ffffff',
          colorBgLayout: '#f5f5f7',
          colorBorder: 'rgba(0,0,0,0.1)',
          colorText: '#1d1d1f',
          colorTextSecondary: '#6e6e73',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', sans-serif",
          fontSize: 13,
        },
      }}
    >
      {/* macOS drag region */}
      <div className="titlebar-drag" />

      <div className="app-layout">
        {/* Sidebar */}
        <aside className="app-sidebar">
          <div className="sidebar-brand">
            <h1>☁️ AWS Toolbox</h1>
            <p>Multi-Account Manager</p>
          </div>

          <nav className="sidebar-nav">
            {navItems.map(item => (
              <div
                key={item.key}
                className={`nav-item ${currentPage === item.key ? 'active' : ''}`}
                onClick={() => setCurrentPage(item.key)}
              >
                <span className="nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="connection-status">
              <div className={`connection-dot ${hasCredentials ? '' : 'disconnected'}`} />
              <span>{hasCredentials ? 'Connected' : 'Not connected'}</span>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="app-content">
          {renderPage()}
        </main>
      </div>
    </ConfigProvider>
  );
};

export default App;
