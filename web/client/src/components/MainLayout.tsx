import React, { useState, useEffect } from 'react';
import { Layout, Menu, Button } from 'antd';
import { HomeOutlined, TeamOutlined, DashboardOutlined, DollarOutlined, SettingOutlined, LogoutOutlined, DeleteOutlined, FileSearchOutlined } from '@ant-design/icons';
import DashboardPage from '../pages/Dashboard';
import AccountsPage from '../pages/Accounts';
import QuotasPage from '../pages/Quotas';
import BillingPage from '../pages/Billing';
import CleanupPage from '../pages/Cleanup';
import AuditLogPage from '../pages/AuditLog';
import SettingsPage from '../pages/Settings';
import { api } from '../api';

const { Sider, Content } = Layout;

interface MainLayoutProps {
  onLogout: () => void;
}

const navItems = [
  { key: 'dashboard', icon: <HomeOutlined />, label: '概览' },
  { key: 'accounts', icon: <TeamOutlined />, label: '账户' },
  { key: 'quotas', icon: <DashboardOutlined />, label: '配额' },
  { key: 'billing', icon: <DollarOutlined />, label: '账单' },
  { key: 'cleanup', icon: <DeleteOutlined />, label: '清理' },
  { key: 'audit', icon: <FileSearchOutlined />, label: '审计' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
];

const mobileNavItems = [
  { key: 'dashboard', icon: <HomeOutlined />, label: '概览' },
  { key: 'accounts', icon: <TeamOutlined />, label: '账户' },
  { key: 'quotas', icon: <DashboardOutlined />, label: '配额' },
  { key: 'billing', icon: <DollarOutlined />, label: '账单' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
];

const MainLayout: React.FC<MainLayoutProps> = ({ onLogout }) => {
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [username, setUsername] = useState('');

  useEffect(() => {
    api.me().then(r => setUsername(r.username || '')).catch(() => {});
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard': return <DashboardPage />;
      case 'accounts': return <AccountsPage />;
      case 'quotas': return <QuotasPage />;
      case 'billing': return <BillingPage />;
      case 'cleanup': return <CleanupPage />;
      case 'audit': return <AuditLogPage />;
      case 'settings': return <SettingsPage onLogout={onLogout} />;
      default: return <DashboardPage />;
    }
  };

  return (
    <div className="app-container">
      <Layout style={{ minHeight: '100vh' }}>
        {/* Desktop sidebar */}
        <Sider width={180} className="desktop-sider"
          style={{ background: '#fff', borderRight: '1px solid #f0f0f0', position: 'fixed', height: '100vh', left: 0, top: 0, zIndex: 100 }}>
          <div style={{ padding: '16px 12px', borderBottom: '1px solid #f0f0f0' }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>☁️ AWS Toolbox</h3>
          </div>
          <Menu mode="inline" selectedKeys={[currentPage]}
            items={navItems.map(i => ({ ...i, label: i.label === '概览' ? '概览' : i.label === '账户' ? '账户管理' : i.label === '配额' ? '配额管理' : i.label === '账单' ? '账单分析' : i.label === '清理' ? '资源清理' : i.label === '审计' ? '审计日志' : '设置' }))}
            onClick={({ key }) => setCurrentPage(key)} style={{ border: 'none' }} />
          <div style={{ position: 'absolute', bottom: 16, left: 12 }}>
            <p style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>{username}</p>
            <p style={{ fontSize: 10, color: '#ccc', marginBottom: 6 }}>v0.1.0</p>
            <Button size="small" icon={<LogoutOutlined />} onClick={onLogout} danger>登出</Button>
          </div>
        </Sider>

        {/* Content area */}
        <Layout style={{ marginLeft: 'var(--sider-width, 0)' }}>
          <Content className="mobile-content" style={{ background: '#f5f5f7' }}>
            {renderPage()}
          </Content>
        </Layout>
      </Layout>

      {/* Mobile bottom navigation */}
      <nav className="bottom-nav">
        {mobileNavItems.map(item => (
          <div key={item.key} className={`bottom-nav-item ${currentPage === item.key ? 'active' : ''}`}
            onClick={() => setCurrentPage(item.key)}>
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </div>
        ))}
      </nav>

      <style>{`
        @media (min-width: 769px) {
          :root { --sider-width: 180px; }
          .mobile-content { margin-left: 180px; }
        }
      `}</style>
    </div>
  );
};

export default MainLayout;
