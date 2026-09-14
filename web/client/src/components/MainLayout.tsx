import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Layout, Menu, Button, Skeleton, Drawer } from 'antd';
import { HomeOutlined, TeamOutlined, DashboardOutlined, DollarOutlined, SettingOutlined, LogoutOutlined, DeleteOutlined, FileSearchOutlined, GlobalOutlined, TagsOutlined, ThunderboltOutlined, FundOutlined, RobotOutlined, AppstoreOutlined, UnlockOutlined } from '@ant-design/icons';
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
import BulkRootResetPage from '../pages/BulkRootReset';
import BedrockPage from '../pages/Bedrock';
// 运维监控懒加载：只有实际进入该授权页面时才下载 recharts 分包
const OpsMonitorPage = React.lazy(() => import('../pages/OpsMonitor'));
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
  { key: 'bedrock', label: 'Bedrock 工具' },
  { key: 'regions', label: '区域管理' },
  { key: 'billing', label: '账单导出' },
  { key: 'cleanup', label: '资源清理' },
  { key: 'tagcompliance', label: 'MAP 标签' },
  { key: 'audit', label: '审计日志' },
  { key: 'ops', label: '运维监控' },
  { key: 'settings', label: '系统设置' },
];

// 批量提额页 key。注意：它不在 PAGE_META / 后端 ALL_PAGE_KEYS 里，
// 可见性完全由独立权限 bulkQuotaAccess 决定，不能通过「页面权限」勾选获得。
export const BULK_QUOTA_PAGE_KEY = 'bulkquota';
// 独立的 rootResetAccess 决定可见和操作，不与根用户凭证权限合并。
export const ROOT_RESET_PAGE_KEY = 'rootreset';

// 运维监控属于可分配页面；admin 恒有，其他角色必须在 allowed_pages 中显式授权。
export const OPS_PAGE_KEY = 'ops';

const navItems = [
  { key: 'dashboard', icon: <HomeOutlined />, label: '概览' },
  { key: 'accounts', icon: <TeamOutlined />, label: '账户管理' },
  { key: 'quotas', icon: <DashboardOutlined />, label: '配额管理' },
  { key: BULK_QUOTA_PAGE_KEY, icon: <ThunderboltOutlined />, label: '批量提额' },
  { key: ROOT_RESET_PAGE_KEY, icon: <UnlockOutlined />, label: '批量重置 Root 密码' },
  { key: 'bedrock', icon: <RobotOutlined />, label: 'Bedrock 工具' },
  { key: 'regions', icon: <GlobalOutlined />, label: '区域管理' },
  { key: 'billing', icon: <DollarOutlined />, label: '账单导出' },
  { key: 'cleanup', icon: <DeleteOutlined />, label: '资源清理' },
  { key: 'tagcompliance', icon: <TagsOutlined />, label: 'MAP 标签' },
  { key: 'audit', icon: <FileSearchOutlined />, label: '审计日志' },
  { key: OPS_PAGE_KEY, icon: <FundOutlined />, label: '运维监控' },
  { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
];

// 移动端底栏只放 4 个高频入口，其余全部收进「更多」抽屉。
// 此前底栏是写死的 5 项，Bedrock/区域/清理/MAP 标签/审计/运维/批量提额
// 在手机上完全无法访问 —— 现在所有有权限的页面都能从「更多」进入。
// 底栏标签用短名（账户/配额），抽屉里用 navItems 的全名。
const MOBILE_PRIMARY_KEYS = ['dashboard', 'accounts', 'quotas', 'bedrock'];
const MOBILE_SHORT_LABEL: Record<string, string> = {
  dashboard: '概览',
  accounts: '账户',
  quotas: '配额',
  bedrock: 'Bedrock',
};

// ===== URL 同步（轻量实现，不引入 react-router）=====
// 规则：/accounts → accounts 页；/ 或未知路径 → dashboard。
// 刷新/直链可用（后端 SPA fallback 已把所有路径指向 index.html），
// 浏览器前进/后退通过 popstate 生效。
const VALID_PAGE_KEYS = new Set([
  ...PAGE_META.map(p => p.key),
  BULK_QUOTA_PAGE_KEY,
  ROOT_RESET_PAGE_KEY,
  OPS_PAGE_KEY,
]);

function pageFromLocation(): string {
  const seg = window.location.pathname.split('/').filter(Boolean)[0] || '';
  return VALID_PAGE_KEYS.has(seg) ? seg : 'dashboard';
}

const MainLayout: React.FC<MainLayoutProps> = ({ onLogout }) => {
  // 初始页从 URL 读取：刷新或直接打开 /billing 等链接时落到对应页面
  const [currentPage, setCurrentPage] = useState(pageFromLocation);
  const [username, setUsername] = useState('');
  // 空数组 = 尚未加载完毕，此时不做过滤；加载后仅显示允许的页面
  const [allowedPages, setAllowedPages] = useState<string[] | null>(null);
  // 批量提额独立权限；未加载完前按无权限处理，避免菜单闪现
  const [bulkQuotaAccess, setBulkQuotaAccess] = useState(false);
  const [rootResetAccess, setRootResetAccess] = useState<'none' | 'view' | 'operate'>('none');
  // admin 恒有运维监控权限；未加载完前按无权限处理，避免敏感菜单闪现
  const [isAdmin, setIsAdmin] = useState(false);
  // 移动端「更多」抽屉
  const [moreOpen, setMoreOpen] = useState(false);
  const appContainerRef = useRef<HTMLElement | null>(null);

  // 导航：更新 state 并把页面 key 写入 URL（pushState 不触发刷新）
  const navigate = (key: string) => {
    setCurrentPage(key);
    const path = key === 'dashboard' ? '/' : `/${key}`;
    if (window.location.pathname !== path) {
      window.history.pushState({ page: key }, '', path);
    }
  };

  // 浏览器前进/后退：从 URL 恢复页面（不再 pushState，避免历史循环）
  useEffect(() => {
    const onPopState = () => { setCurrentPage(pageFromLocation()); setMoreOpen(false); };
    window.addEventListener('popstate', onPopState);
    // 首次进入时把当前页写进 history state，保证后退行为一致
    window.history.replaceState({ page: pageFromLocation() }, '', window.location.pathname);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 给 <html> 打标记：仅在已登录的应用壳内把根背景染成品牌深色。
  // iOS Safari 状态栏后的半透明材质是从根元素背景取色的，根元素若是浅灰
  // （body 的 #f4f5f7），顶部就会糊出一圈磨砂白影。登录/MFA 页不加该类，
  // 仍保持浅色背景。
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add('app-shell');
    return () => root.classList.remove('app-shell');
  }, []);

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
      // /auth/me 的 401 是正常 resolve 的（带 unauthorized 标记），
      // 不能拿它去覆盖用户名/权限，否则会闪成空用户名 + 空菜单。
      if (!r || r.unauthorized || !r.username) return;
      setUsername(r.username || '');
      setBulkQuotaAccess(!!r.bulkQuotaAccess);
      setRootResetAccess(['view', 'operate'].includes(r.rootResetAccess) ? r.rootResetAccess : 'none');
      setIsAdmin(r.role === 'admin');
      if (Array.isArray(r.allowedPages)) {
        setAllowedPages(r.allowedPages);
        // 如果当前页不在允许列表里，回退到第一个允许的页面
        const requested = pageFromLocation();
        const independentAccess = (requested === ROOT_RESET_PAGE_KEY && ['view', 'operate'].includes(r.rootResetAccess))
          || (requested === BULK_QUOTA_PAGE_KEY && r.bulkQuotaAccess);
        if (r.allowedPages.length > 0 && !r.allowedPages.includes(requested) && !independentAccess) {
          navigate(r.allowedPages[0]);
        }
      }
    }).catch(() => {});
  }, []);

  // 允许在 me() 未加载完时先渲染完整菜单（loading 态），加载后按权限过滤
  const isPageAllowed = (key: string) => {
    // 批量提额只看独立权限，与页面权限无关
    if (key === BULK_QUOTA_PAGE_KEY) return bulkQuotaAccess;
    if (key === ROOT_RESET_PAGE_KEY) return rootResetAccess !== 'none';
    // 运维监控：admin 恒有；其他角色仅在页面权限中显式授予后可见
    if (key === OPS_PAGE_KEY) return isAdmin || allowedPages?.includes(OPS_PAGE_KEY) === true;
    if (allowedPages === null) return true;
    return allowedPages.includes(key);
  };

  const visibleNavItems = navItems.filter(item => isPageAllowed(item.key));
  // 底栏 = 有权限的高频页（按 MOBILE_PRIMARY_KEYS 顺序）；其余进「更多」抽屉。
  // 若高频页因权限缺失不足 4 个，从剩余页面按 navItems 顺序补位，避免底栏出现空位。
  const mobilePrimary = (() => {
    const primary = MOBILE_PRIMARY_KEYS
      .map(key => visibleNavItems.find(item => item.key === key))
      .filter((item): item is typeof navItems[number] => !!item);
    if (primary.length >= 4) return primary.slice(0, 4);
    const fill = visibleNavItems.filter(item => !primary.includes(item));
    return [...primary, ...fill].slice(0, 4);
  })();
  const mobileMoreItems = visibleNavItems.filter(item => !mobilePrimary.includes(item));

  // keep-alive：高频切换、数据重的页面保持挂载（display:none 隐藏），
  // 切回时不重新请求/重建，明显更流畅。
  // 不保活的页面：ops（有 30s 轮询定时器，隐藏时会白轮询）、
  // settings/audit/cleanup 等低频页（重新加载反而保证数据新鲜）。
  const KEEP_ALIVE_PAGES = ['dashboard', 'accounts', 'quotas', 'regions', 'billing'];
  // 记录访问过的保活页，只挂载访问过的，避免登录后立刻全量请求
  const [visitedPages, setVisitedPages] = useState<string[]>([]);
  useEffect(() => {
    if (KEEP_ALIVE_PAGES.includes(currentPage) && isPageAllowed(currentPage)) {
      setVisitedPages(prev => prev.includes(currentPage) ? prev : [...prev, currentPage]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, allowedPages]);

  const pageComponent = (key: string): React.ReactNode => {
    switch (key) {
      case 'dashboard': return <DashboardPage onNavigate={navigate} />;
      case 'accounts': return <AccountsPage />;
      case 'quotas': return <QuotasPage />;
      case 'bedrock': return <BedrockPage />;
      case BULK_QUOTA_PAGE_KEY: return <BulkQuotaPage />;
      case ROOT_RESET_PAGE_KEY: return <BulkRootResetPage canOperate={rootResetAccess === 'operate'} />;
      case OPS_PAGE_KEY: return (
        <React.Suspense fallback={<div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 8 }} /></div>}>
          <OpsMonitorPage />
        </React.Suspense>
      );
      case 'regions': return <RegionsPage />;
      case 'billing': return <BillingPage />;
      case 'cleanup': return <CleanupPage />;
      case 'tagcompliance': return <TagCompliancePage />;
      case 'audit': return <AuditLogPage />;
      case 'settings': return <SettingsPage onLogout={onLogout} />;
      default: return <DashboardPage />;
    }
  };

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
    const isKeepAlive = KEEP_ALIVE_PAGES.includes(currentPage);
    return (
      <>
        {/* 保活页：访问过的都保持挂载，仅当前页显示。首次挂载有 page-fade 动画，切回瞬时显示 */}
        {visitedPages.map(key => (
          <div key={key} className="page-fade" style={{ display: key === currentPage ? undefined : 'none' }}>
            {pageComponent(key)}
          </div>
        ))}
        {/* 非保活页：按旧逻辑每次重建（key 变化触发 fade 动画与数据刷新） */}
        {!isKeepAlive && (
          <div key={currentPage} className="page-fade">
            {pageComponent(currentPage)}
          </div>
        )}
      </>
    );
  };

  // 移动端顶栏标题：优先用导航项的全名，兜底用 PAGE_META
  const currentTitle =
    navItems.find(i => i.key === currentPage)?.label
    || PAGE_META.find(p => p.key === currentPage)?.label
    || 'AWS Toolbox';

  return (
    <div className="app-container">
      {/* Mobile top bar —— 电脑端靠深色侧边栏承载品牌，手机端此前顶部是一片
          空白浅灰。这里补一条同色系品牌栏，并让状态栏安全区也染上品牌色。 */}
      <header className="mobile-topbar">
        <img src="/logo.png" alt="" className="mobile-topbar-logo" />
        <span className="mobile-topbar-title">{currentTitle}</span>
        <span className="mobile-topbar-user">{username}</span>
      </header>
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
            onClick={({ key }) => navigate(key)}
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
            {/* 注意：这里不能再套 key={currentPage} 的包装（会强制整树重建，破坏 keep-alive）。
                fade 动画已由 renderPage 内部每个页面的包装 div 承担。 */}
            {renderPage()}
          </Content>
        </Layout>
      </Layout>

      {/* Mobile bottom navigation：4 个高频入口 + 「更多」 */}
      <nav className="bottom-nav">
        {mobilePrimary.map(item => (
          <div
            key={item.key}
            className={`bottom-nav-item ${currentPage === item.key ? 'active' : ''}`}
            onClick={() => navigate(item.key)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{MOBILE_SHORT_LABEL[item.key] || item.label}</span>
          </div>
        ))}
        {mobileMoreItems.length > 0 && (
          <div
            className={`bottom-nav-item ${moreOpen || mobileMoreItems.some(i => i.key === currentPage) ? 'active' : ''}`}
            onClick={() => setMoreOpen(true)}
          >
            <span className="nav-icon"><AppstoreOutlined /></span>
            <span className="nav-label">更多</span>
          </div>
        )}
      </nav>

      {/* 「更多」抽屉：宫格排列剩余全部有权限页面 + 用户信息/退出 */}
      <Drawer
        placement="bottom"
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        closable={false}
        height="auto"
        styles={{ body: { padding: '20px 16px calc(20px + var(--safe-bottom))' } }}
        zIndex={1050}
        rootClassName="more-drawer"
      >
        <div className="more-drawer-title">全部功能</div>
        <div className="more-grid">
          {mobileMoreItems.map(item => (
            <div
              key={item.key}
              className={`more-grid-item ${currentPage === item.key ? 'active' : ''}`}
              onClick={() => { navigate(item.key); setMoreOpen(false); }}
            >
              <span className="more-grid-icon">{item.icon}</span>
              <span className="more-grid-label">{item.label}</span>
            </div>
          ))}
        </div>
        <div className="more-drawer-footer">
          <span className="more-drawer-user">{username}<span className="more-drawer-version">v{APP_VERSION}</span></span>
          <Button size="small" icon={<LogoutOutlined />} onClick={onLogout}>退出登录</Button>
        </div>
      </Drawer>
    </div>
  );
};

export default MainLayout;
