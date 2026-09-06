import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Layout, Menu, Button } from 'antd';
import { HomeOutlined, TeamOutlined, DashboardOutlined, DollarOutlined, SettingOutlined, LogoutOutlined, DeleteOutlined, FileSearchOutlined, GlobalOutlined, TagsOutlined, ThunderboltOutlined } from '@ant-design/icons';
import DashboardPage from '../pages/Dashboard';
import AccountsPage from '../pages/Accounts';
import QuotasPage from '../pages/Quotas';
import BillingPage from '../pages/Billing';
import CleanupPage from '../pages/Cleanup';
import RegionsPage from '../pages/Regions';
import AuditLogPage from '../pages/AuditLog';
import SettingsPage from '../pages/Settings';
import TagCompliancePage from '../pages/TagCompliance';
import BulkQuotaPage from '../pages/BulkQuota';
import { api } from '../api';
import { APP_VERSION } from '../version';

const { Sider, Content } = Layout;

interface MainLayoutProps {
  onLogout: () => void;
}

// 页面 key 必须与后端 auth.ts 中 ALL_PAGE_KEYS 保持一致
export const PAGE_META: { key: string; label: string }[] = [
  { key: 'dashboard', label: '概览' },
  { key: 'accounts', label: '账户管理' },
  { key: 'quotas', label: '配额管理' },
  { key: 'regions', label: '区域管理' },
  { key: 'billing', label: '账单分析' },
  { key: 'cleanup', label: '资源清理' },
  { key: 'tagcompliance', label: 'MAP 标签' },
  { key: 'audit', label: '审计日志' },
  { key: 'settings', label: '系统设置' },
];

// 批量提额页 key。注意：它不在 PAGE_META / 后端 ALL_PAGE_KEYS 里，
// 可见性完全由独立权限 bulkQuotaAccess 决定，不能通过「页面权限」勾选获得。
export const BULK_QUOTA_PAGE_KEY = 'bulkquota';

const navItems = [
  { key: 'dashboard', icon: <HomeOutlined />, label: '概览' },
  { key: 'accounts', icon: <TeamOutlined />, label: '账户管理' },
  { key: 'quotas', icon: <DashboardOutlined />, label: '配额管理' },
  { key: BULK_QUOTA_PAGE_KEY, icon: <ThunderboltOutlined />, label: '批量提额' },
  { key: 'regions', icon: <GlobalOutlined />, label: '区域管理' },
  { key: 'billing', icon: <DollarOutlined />, label: '账单分析' },
  { key: 'cleanup', icon: <DeleteOutlined />, label: '资源清理' },
  { key: 'tagcompliance', icon: <TagsOutlined />, label: 'MAP 标签' },
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
  // 空数组 = 尚未加载完毕，此时不做过滤；加载后仅显示允许的页面
  const [allowedPages, setAllowedPages] = useState<string[] | null>(null);
  // 批量提额独立权限；未加载完前按无权限处理，避免菜单闪现
  const [bulkQuotaAccess, setBulkQuotaAccess] = useState(false);
  const appContainerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || navigatorWithStandalone.standalone === true;
    if (!isStandalone) return;

    const root = document.documentElement;
    let orientationRefreshTimer: number | undefined;
    let focusRefreshTimer: number | undefined;

    const syncScreenHeight = () => {
      const { width, height } = window.screen;
      const isPortrait = window.matchMedia('(orientation: portrait)').matches;
      const screenHeight = isPortrait ? Math.max(width, height) : Math.min(width, height);
      root.style.setProperty('--standalone-screen-height', `${screenHeight}px`);
    };

    // iOS standalone 的键盘收起后可能保留缩短的动态视口；隐藏再恢复全屏壳
    // 会让 WebKit 重新计算 fixed containing block，同时不产生中间帧。
    const refreshStandaloneViewport = () => {
      const appContainer = appContainerRef.current;
      if (!appContainer) return;
      const previousDisplay = appContainer.style.display;
      appContainer.style.display = 'none';
      void appContainer.offsetHeight;
      if (previousDisplay) appContainer.style.display = previousDisplay;
      else appContainer.style.removeProperty('display');
      void appContainer.offsetHeight;
    };

    const handleOrientationChange = () => {
      window.clearTimeout(orientationRefreshTimer);
      orientationRefreshTimer = window.setTimeout(() => {
        syncScreenHeight();
        refreshStandaloneViewport();
      }, 300);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)
        && !(target instanceof HTMLTextAreaElement)
        && !(target instanceof HTMLSelectElement)) return;
      window.clearTimeout(focusRefreshTimer);
      focusRefreshTimer = window.setTimeout(refreshStandaloneViewport, 400);
    };

    appContainerRef.current = document.querySelector<HTMLElement>('.app-container');
    root.classList.add('standalone-mode');
    syncScreenHeight();
    const mountRefreshTimer = window.setTimeout(refreshStandaloneViewport, 0);
    window.addEventListener('orientationchange', handleOrientationChange);
    document.addEventListener('focusout', handleFocusOut, true);

    return () => {
      window.clearTimeout(mountRefreshTimer);
      window.clearTimeout(orientationRefreshTimer);
      window.clearTimeout(focusRefreshTimer);
      window.removeEventListener('orientationchange', handleOrientationChange);
      document.removeEventListener('focusout', handleFocusOut, true);
      root.classList.remove('standalone-mode');
      root.style.removeProperty('--standalone-screen-height');
      appContainerRef.current = null;
    };
  }, []);

  useEffect(() => {
    api.me().then(r => {
      setUsername(r.username || '');
      setBulkQuotaAccess(!!r.bulkQuotaAccess);
      if (Array.isArray(r.allowedPages)) {
        setAllowedPages(r.allowedPages);
        // 如果当前页不在允许列表里，回退到第一个允许的页面
        if (r.allowedPages.length > 0 && !r.allowedPages.includes('dashboard')) {
          setCurrentPage(r.allowedPages[0]);
        }
      }
    }).catch(() => {});
  }, []);

  // 允许在 me() 未加载完时先渲染完整菜单（loading 态），加载后按权限过滤
  const isPageAllowed = (key: string) => {
    // 批量提额只看独立权限，与页面权限无关
    if (key === BULK_QUOTA_PAGE_KEY) return bulkQuotaAccess;
    if (allowedPages === null) return true;
    return allowedPages.includes(key);
  };

  const visibleNavItems = navItems.filter(item => isPageAllowed(item.key));
  const visibleMobileNavItems = mobileNavItems.filter(item => isPageAllowed(item.key));

  const renderPage = () => {
    // 守卫：当前页不在允许列表中时显示无权限提示（比如通过历史 URL 或旧 state 进入）
    if (!isPageAllowed(currentPage)) {
      return (
        <div style={{ padding: 48, textAlign: 'center', color: '#8a94a6' }}>
          <h3 style={{ color: '#666' }}>无访问权限</h3>
          <p>你没有权限访问该页面，请联系管理员。</p>
        </div>
      );
    }
    switch (currentPage) {
      case 'dashboard': return <DashboardPage onNavigate={setCurrentPage} />;
      case 'accounts': return <AccountsPage />;
      case 'quotas': return <QuotasPage />;
      case BULK_QUOTA_PAGE_KEY: return <BulkQuotaPage />;
      case 'regions': return <RegionsPage />;
      case 'billing': return <BillingPage />;
      case 'cleanup': return <CleanupPage />;
      case 'tagcompliance': return <TagCompliancePage />;
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
            <img src="/logo.png" alt="logo" style={{ height: 32, width: 32, objectFit: 'contain', borderRadius: 6 }} />
            <h1 style={{ marginLeft: 8 }}>AWS Toolbox</h1>
          </div>
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={[currentPage]}
            items={visibleNavItems}
            onClick={({ key }) => setCurrentPage(key)}
          />
          <div className="sider-footer">
            <div className="sider-footer-user">{username}</div>
            <div className="sider-footer-version">v{APP_VERSION}</div>
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
            <div key={currentPage} className="page-fade">
              {renderPage()}
            </div>
          </Content>
        </Layout>
      </Layout>

      {/* Mobile bottom navigation */}
      <nav className="bottom-nav">
        {visibleMobileNavItems.map(item => (
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
