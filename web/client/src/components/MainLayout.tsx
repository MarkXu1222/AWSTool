import React, { useState } from 'react';
import { Layout, Menu, Button } from 'antd';
import { TeamOutlined, DashboardOutlined, DollarOutlined, SettingOutlined, LogoutOutlined, DeleteOutlined } from '@ant-design/icons';
import AccountsPage from '../pages/Accounts';
import QuotasPage from '../pages/Quotas';
import BillingPage from '../pages/Billing';
import CleanupPage from '../pages/Cleanup';
import SettingsPage from '../pages/Settings';

const { Sider, Content } = Layout;

interface MainLayoutProps {
  onLogout: () => void;
}

const menuItems = [
  { key: 'accounts', icon: <TeamOutlined />, label: '账户管理' },
  { key: 'quotas', icon: <DashboardOutlined />, label: '配额管理' },
  { key: 'billing', icon: <DollarOutlined />, label: '账单分析' },
  { key: 'cleanup', icon: <DeleteOutlined />, label: '资源清理' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
];

const MainLayout: React.FC<MainLayoutProps> = ({ onLogout }) => {
  const [currentPage, setCurrentPage] = useState('accounts');

  const renderPage = () => {
    switch (currentPage) {
      case 'accounts': return <AccountsPage />;
      case 'quotas': return <QuotasPage />;
      case 'billing': return <BillingPage />;
      case 'cleanup': return <CleanupPage />;
      case 'settings': return <SettingsPage />;
      default: return <AccountsPage />;
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={200} breakpoint="lg" collapsedWidth={60}
        style={{ background: '#fff', borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '16px 12px', borderBottom: '1px solid #f0f0f0' }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>☁️ AWS Toolbox</h3>
        </div>
        <Menu mode="inline" selectedKeys={[currentPage]} items={menuItems}
          onClick={({ key }) => setCurrentPage(key)} style={{ border: 'none' }} />
        <div style={{ position: 'absolute', bottom: 16, left: 12 }}>
          <Button size="small" icon={<LogoutOutlined />} onClick={onLogout} danger>登出</Button>
        </div>
      </Sider>
      <Content style={{ padding: 20, background: '#f5f5f7', overflow: 'auto' }}>
        {renderPage()}
      </Content>
    </Layout>
  );
};

export default MainLayout;
