import React, { useState, useEffect } from 'react';
import { Layout, Menu, Button } from 'antd';
import { HomeOutlined, TeamOutlined, DashboardOutlined, DollarOutlined, SettingOutlined, LogoutOutlined, DeleteOutlined, FileSearchOutlined, GlobalOutlined } from '@ant-design/icons';
import DashboardPage from '../pages/Dashboard';
import AccountsPage from '../pages/Accounts';
import QuotasPage from '../pages/Quotas';
import BillingPage from '../pages/Billing';
import CleanupPage from '../pages/Cleanup';
import RegionsPage from '../pages/Regions';
import AuditLogPage from '../pages/AuditLog';
import SettingsPage from '../pages/Settings';
import { api } from '../api';

const { Sider, Content } = Layout;

interface MainLayoutProps {
  onLogout: () => void;
}

const navItems = [
  { key: 'dashboard', icon: <HomeOutlined />, label: '概览' },
  { key: 'accounts', icon: <TeamOutlined />, label: '账户管理' },
  { key: 'quotas', icon: <DashboardOutlined />, label: '配额管理' },
  { key: 'regions', icon: <GlobalOutlined />, label: '区域管理' },
  { key: 'billing', icon: <DollarOutlined />, label: '账单分析' },
  { key: 'cleanup', icon: <DeleteOutlined />, label: '资源清理' },
  { key: 'audit', icon: <FileSearchOutlined />, label: '审计日志' },
  { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
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
      case 'regions': return <RegionsPage />;
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
        {/* Desktop Sidebar — Ant Design Pro style */}
        <Sider width={208} className="desktop-sider">
          <div className="sider-logo">
            <h1>☁️ AWS Toolbox</h1>
          </div>
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={[currentPage]}
            items={navItems}
            onClick={({ key }) => setCurrentPage(key)}
          />
          <div className="sider-footer">
            <div className="sider-footer-user">{username}</div>
            <div className="sider-footer-version">v0.1.0</div>
            <Button
              size="small"
              icon={<LogoutOutlined />}
              onClick={onLogout}
              style={{
                width: '100%',
                color: 'rgba(255,255,255,0.65)',
                borderColor: 'rgba(255,255,255,0.2)',
                background: 'transparent',
              }}
            >
              退出登录
            </Button>
          </div>
        </Sider>

        {/* Content area */}
        <Layout>
          <Content className="main-content">
            {renderPage()}
          </Content>
        </Layout>
      </Layout>

      {/* Mobile bottom navigation */}
      <nav className="bottom-nav">
        {mobileNavItems.map(item => (
          <div
            key={item.key}
            className={`bottom-nav-item ${currentPage === item.key ? 'active' : ''}`}
            onClick={() => setCurrentPage(item.key)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </div>
        ))}
      </nav>
    </div>
  );
};

export default MainLayout;
