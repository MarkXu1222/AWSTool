import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Button, Space, message, Input, Spin, Descriptions, Tabs, Badge, Dropdown, Switch, Tooltip, Modal, Select, Popconfirm } from 'antd';
import { ReloadOutlined, SearchOutlined, SafetyOutlined, CheckCircleOutlined, CloseCircleOutlined, LeftOutlined, LoginOutlined, DownOutlined, WarningOutlined } from '@ant-design/icons';
import { api } from '../api';
import { exportToCSV } from '../utils/export';
import RootCredentialsPanel from '../components/RootCredentialsPanel';
import { hashColor, initials } from '../utils/color';
import { openAwsConsole, isIsolatedEnabled, setIsolatedEnabled, isLauncherInstalled, setLauncherInstalled, promptLauncherInstall } from '../utils/console-launch';

// 账户彩色首字母头像
const AccountAvatar: React.FC<{ name: string; id: string }> = ({ name, id }) => {
  const c = hashColor(name || id);
  return (
    <div style={{
      width: 34, height: 34, borderRadius: 9, flexShrink: 0,
      background: c.bg, color: c.fg, fontWeight: 700, fontSize: 14,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} aria-hidden="true">
      {initials(name)}
    </div>
  );
};

const AccountsPage: React.FC = () => {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [consoleLoading, setConsoleLoading] = useState(false);
  // 列表/侧边栏按 769（与全局 CSS 的底部导航/侧栏断点一致）
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 769);
  // 详情遮罩层断点更宽(<992)：iPad 竖屏/大屏手机点账户也走全屏详情。
  // 遮罩层是 position:fixed 全屏、自带「返回」，不依赖底部导航，所以可用更大的断点而不冲突。
  const [detailFullScreen, setDetailFullScreen] = useState(() => window.innerWidth < 992);
  useEffect(() => {
    const onResize = () => { setIsMobile(window.innerWidth < 769); setDetailFullScreen(window.innerWidth < 992); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [canRoot, setCanRoot] = useState(false);
  const [rootResetAccess, setRootResetAccess] = useState<'none' | 'view' | 'operate'>('none');
  // 权限检测等 admin 专属功能的门控
  const [isAdmin, setIsAdmin] = useState(false);
  // 独立会话开关（所有用户可用）：开启后每个账户用独立浏览器 profile 打开，可同时登录多个账户
  const [isolated, setIsolated] = useState(isIsolatedEnabled());
  // 首次开启需先装本地助手：未确认安装时弹安装引导，点「我已安装」才真正开启
  const toggleIsolated = (on: boolean) => {
    const apply = () => { setIsolated(on); setIsolatedEnabled(on); };
    if (on && !isLauncherInstalled()) promptLauncherInstall({ onInstalled: apply });
    else apply();
  };
  // 账户角色自愈状态：accountId → 记录，用于在列表里标出平台无法访问的账户
  const [roleMap, setRoleMap] = useState<Record<string, any>>({});
  const [roleChecking, setRoleChecking] = useState(false);
  const [onlyRoleIssues, setOnlyRoleIssues] = useState(false);
  // 结果面板：自动检测和手动检测的结果都在这里看
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [roleSummary, setRoleSummary] = useState<any>(null);
  const [lastCheckResult, setLastCheckResult] = useState<any>(null);
  // 已移出组织的账户
  const [departed, setDeparted] = useState<any[]>([]);
  const [departedOpen, setDepartedOpen] = useState(false);
  // 敏感权限客户账户（已收窄平台权限）
  const [restricted, setRestricted] = useState<any[]>([]);
  const [restrictedUnavailable, setRestrictedUnavailable] = useState<string[]>([]);
  const [restrictOpen, setRestrictOpen] = useState(false);
  const [restrictSubmitting, setRestrictSubmitting] = useState(false);
  const [restrictTargets, setRestrictTargets] = useState<string[]>([]);
  const [restrictNote, setRestrictNote] = useState('');

  // APN 合作伙伴账户：不在任何组织里，走独立接口，仅在展示层与主列表合并。
  // 不并入 accounts_cache —— 那份缓存被角色自愈/离场检测/批量操作共用。
  const [apnAccounts, setApnAccounts] = useState<any[]>([]);
  const [apnUnavailable, setApnUnavailable] = useState<string[]>([]);
  const [apnProbe, setApnProbe] = useState<Record<string, any>>({});
  const [apnProbing, setApnProbing] = useState(false);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const res = await api.listAccounts();
      if (res.success) setAccounts(res.data);
      else message.error(res.error);
    } catch (e: any) { message.error(e.message); }
    finally { setLoading(false); }
  };

  const loadApnAccounts = async () => {
    try {
      const res = await api.getApnAccounts();
      if (res.success) {
        setApnAccounts(res.data?.records || []);
        setApnUnavailable(res.data?.unavailable || []);
      }
    } catch { /* 附加信息，失败不影响主账户列表 */ }
  };

  const probeApn = async () => {
    setApnProbing(true);
    try {
      const res = await api.probeApnAccounts();
      if (res.success) {
        const m: Record<string, any> = {};
        (res.data || []).forEach((r: any) => { m[r.partnerKey] = r; });
        setApnProbe(m);
        const bad = (res.data || []).filter((r: any) => !r.ok);
        if (bad.length === 0) message.success('APN 账户连通正常');
        else message.warning(`${bad.length} 个 APN 账户不可达：${bad[0].error || ''}`);
      } else message.error(res.error || '探测失败');
    } catch (e: any) { message.error(e.message || '探测失败'); }
    finally { setApnProbing(false); }
  };

  useEffect(() => { fetchAccounts(); loadDeparted(); loadRestricted(); loadApnAccounts(); }, []);

  const loadRestricted = async () => {
    try {
      const res = await api.getRestrictedAccounts();
      if (res.success) {
        setRestricted(res.data?.records || []);
        setRestrictedUnavailable(res.data?.unavailable || []);
      }
    } catch { /* 附加信息，失败不影响账户列表 */ }
  };

  const restrictedMap = React.useMemo(() => {
    const m: Record<string, any> = {};
    restricted.forEach(r => { m[r.account_id] = r; });
    return m;
  }, [restricted]);

  const submitRestrict = async () => {
    if (restrictTargets.length === 0) { message.warning('请填写至少一个账户 ID'); return; }
    setRestrictSubmitting(true);
    const hide = message.loading('正在收窄权限并部署受限角色，需等 CloudFormation 完成…', 0);
    try {
      const res = await api.markRestrictedAccounts(restrictTargets, restrictNote || undefined);
      hide();
      if (res.success) {
        const r = res.data.results || [];
        const ok = r.filter((x: any) => x.ok).length;
        const bad = r.filter((x: any) => !x.ok);
        if (bad.length === 0) message.success(`${ok} 个账户已完成收窄`);
        else message.warning(`${ok} 成功，${bad.length} 失败：${bad[0].error || ''}`);
        setRestrictTargets([]);
        setRestrictNote('');
        await loadRestricted();
      } else message.error(res.error || '操作失败');
    } catch (e: any) {
      hide();
      message.error(e.message || '操作失败');
    } finally { setRestrictSubmitting(false); }
  };

  const showExternalId = async (accountId: string) => {
    try {
      const res = await api.getAccountExternalId(accountId);
      if (res.success) {
        Modal.info({
          title: `ExternalId — ${accountId}`,
          width: 560,
          content: (
            <div>
              <p style={{ fontSize: 12, color: 'rgba(0,0,0,0.55)' }}>
                需通过带外渠道交付客户，不要写入文档或邮件正文。查看此值已记入审计日志。
              </p>
              <code style={{ fontSize: 13, wordBreak: 'break-all', display: 'block', background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
                {res.data.externalId}
              </code>
            </div>
          ),
        });
      } else message.error(res.error || '获取失败');
    } catch (e: any) { message.error(e.message); }
  };

  // 已移出组织的账户 —— 与在职账户字段不同（有移出时间/原属组织），单独一份数据
  const loadDeparted = async () => {
    try {
      const res = await api.getDepartedAccounts();
      if (res.success) setDeparted(res.data?.records || []);
    } catch { /* 附加信息，失败不影响账户列表 */ }
  };

  // 权限检测仅 admin 可见（含结果）。isAdmin 是异步拿到的，
  // 所以等它确定后再拉，避免非 admin 触发一次注定被拒的请求。
  useEffect(() => { if (isAdmin) loadRoleStatus(); }, [isAdmin]);

  // 只取有问题的账户（后端已过滤），正常的不需要标记
  const loadRoleStatus = async () => {
    try {
      const res = await api.getAccountRolesStatus();
      if (res.success) {
        const m: Record<string, any> = {};
        (res.data.problems || []).forEach((p: any) => { m[p.account_id] = p; });
        setRoleMap(m);
        setRoleSummary(res.data);
      }
    } catch { /* 状态标记是增强信息，失败不影响账户列表 */ }
  };

  const runRoleCheck = async (full: boolean) => {
    setRoleChecking(true);
    setRoleModalOpen(true);   // 结果直接落到面板里，不靠一闪而过的提示
    try {
      const res = await api.checkAccountRoles({ full });
      if (res.success) {
        setLastCheckResult({ ...res.data, full, at: new Date().toISOString() });
        await loadRoleStatus();
      } else {
        message.error(res.error || '检测失败');
      }
    } catch (e: any) {
      message.error(e.message || '检测失败');
    } finally {
      setRoleChecking(false);
    }
  };

  // 拉取当前用户的根用户凭证权限，决定是否展示根用户 tab 的敏感功能；同时取角色用于 admin 专属功能门控
  useEffect(() => {
    api.me().then(r => {
      setCanRoot(!!r.rootAccess);
      setRootResetAccess(['view', 'operate'].includes(r.rootResetAccess) ? r.rootResetAccess : 'none');
      setIsAdmin(r.role === 'admin');
    }).catch(() => {});
  }, []);

  // 免登录进入该账户的 AWS 控制台。
  // access 省略 → auto（原有回退链，普通账户用）；'support' → 只读；'admin' → 完整管理员(需 root 权限)
  const openConsole = async (accountId: string, access?: 'support' | 'admin') => {
    setConsoleLoading(true);
    const hide = message.loading(access === 'admin' ? '正在生成 Admin 免登录链接...' : '正在生成免登录链接...', 0);
    try {
      const res = await api.getConsoleUrl(accountId, access ? { access } : undefined);
      hide();
      if (res.success && res.url) {
        const how = openAwsConsole(res.url, accountId);
        if (how === 'isolated') {
          // 本地助手实际没装好时点击不会有反应，给两个退路
          message.info({
            content: (
              <span>
                已用独立会话打开 {accountId}
                <a style={{ marginLeft: 10 }} onClick={() => window.open(res.url, '_blank')}>没反应？用普通标签打开</a>
                <a style={{ marginLeft: 10 }} onClick={() => { setLauncherInstalled(false); promptLauncherInstall({ onInstalled: () => {} }); }}>重新安装助手</a>
              </span>
            ),
            duration: 6,
          });
        }
      } else {
        message.error(res.error || '生成链接失败');
      }
    } catch (e: any) { hide(); message.error(e.message); }
    finally { setConsoleLoading(false); }
  };

  // 控制台下拉菜单：只读(support-quota) 对所有人开放；Admin 仅对有根用户权限者显示
  const consoleMenu = (accountId: string) => ({
    items: [
      { key: 'support', icon: <SafetyOutlined />, label: '只读控制台（support-quota）' },
      ...(canRoot ? [{ key: 'admin', icon: <LoginOutlined />, label: 'Admin 控制台（完整权限）', danger: true }] : []),
    ],
    onClick: ({ key }: { key: string }) => openConsole(accountId, key as 'support' | 'admin'),
  });

  // payer 管理账户的菜单：它上面没有 support-quota（StackSet 不覆盖管理账户），
  // 入口统一走 role/tool。有根用户权限者默认进 Admin；
  // 无权限者进只读会话（后端用 STS session policy 把 role/tool 压到 ReadOnlyAccess）。
  const payerConsoleMenu = (accountId: string) => ({
    items: [
      ...(canRoot ? [{ key: 'admin', icon: <LoginOutlined />, label: 'Admin 控制台（完整权限）', danger: true }] : []),
      { key: 'support', icon: <SafetyOutlined />, label: '只读控制台（会话限制为 ReadOnly）' },
    ],
    onClick: ({ key }: { key: string }) => openConsole(accountId, key as 'support' | 'admin'),
  });

  // payer 管理账户：默认进 Admin（有权限时），因为它不存在 support-quota 角色
  // 成员账户：_consoleDual 的组织给双选项，其余走 auto 回退链
  const ConsoleButton: React.FC<{ account: any; style?: React.CSSProperties }> = ({ account, style }) => {
    // APN 账户走独立的 apn-console 角色（AdministratorAccess）。
    // 该角色是完整管理员，所以与 Admin 控制台同样需要根用户权限。
    if (account?._isApn) {
      if (!account.consoleConfigured) {
        return (
          <Tooltip title="该主体未配置 consoleRoleArn，请先用 scripts/setup_apn_console_role.py 创建 apn-console 角色">
            <Button size="small" disabled style={style} icon={<LoginOutlined />}>控制台未配置</Button>
          </Tooltip>
        );
      }
      if (!canRoot) {
        return (
          <Tooltip title="APN 控制台角色为完整管理员权限，需具备根用户权限才能使用">
            <Button size="small" disabled style={style} icon={<LoginOutlined />}>控制台需授权</Button>
          </Tooltip>
        );
      }
      return (
        <Tooltip title="以 AdministratorAccess 进入该 APN 账户的 Partner Central 控制台（会话 1 小时，操作已审计）">
          <Button type="primary" danger size="small" icon={<LoginOutlined />} loading={consoleLoading}
            style={style} onClick={() => openConsole(account.Id, 'admin')}>Admin 控制台</Button>
        </Tooltip>
      );
    }
    if (account?._isPayer) {
      return (
        <Dropdown.Button
          type="primary"
          size="small"
          loading={consoleLoading}
          style={style}
          icon={<DownOutlined style={{ fontSize: 10 }} />}
          menu={payerConsoleMenu(account.Id)}
          onClick={() => openConsole(account.Id, canRoot ? 'admin' : 'support')}
        >
          <LoginOutlined /> {canRoot ? 'Admin 控制台' : '只读控制台'}
        </Dropdown.Button>
      );
    }
    if (account?._adminRoleExcluded) {
      return (
        <Button type="primary" size="small" icon={<SafetyOutlined />} loading={consoleLoading} style={style}
          onClick={() => openConsole(account.Id, 'support')}>只读控制台</Button>
      );
    }
    if (!account?._consoleDual) {
      return (
        <Button type="primary" size="small" icon={<LoginOutlined />} loading={consoleLoading} style={style}
          onClick={() => openConsole(account.Id)}>控制台</Button>
      );
    }
    return (
      <Dropdown menu={consoleMenu(account.Id)} trigger={['click']}>
        <Button type="primary" size="small" icon={<LoginOutlined />} loading={consoleLoading} style={style}>
          控制台 <DownOutlined style={{ fontSize: 10 }} />
        </Button>
      </Dropdown>
    );
  };

  const openDetail = async (account: any) => {
    setSelectedAccount(account);
    setDetail(null);
    // APN 账户绝不能查详情：getAccountDetail 在 assume 失败时会回退到
    // PAYERS[0] 的凭证（aws-service.ts:1109），那样拿到的是**另一个账户**的
    // IAM/MFA 数据，却挂在这个 APN 账户名下 —— 静默串号，比查不到更危险。
    if (account?._isApn) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    try {
      const [detailRes, rootRes] = await Promise.allSettled([
        api.getAccountDetail(account.Id),
        api.getRootCredentials(account.Id),
      ]);
      const d: any = {};
      if (detailRes.status === 'fulfilled' && detailRes.value.success) Object.assign(d, detailRes.value.data);
      if (rootRes.status === 'fulfilled' && rootRes.value.success) d.rootCredentials = rootRes.value.data;
      setDetail(d);
    } catch {}
    finally { setDetailLoading(false); }
  };

  // APN 账户合并进主列表。用 Id 去重：万一将来某个 APN 账户真的被纳入组织，
  // 组织侧的真实记录优先，避免同一账户出现两行。
  const allAccounts = React.useMemo(() => {
    const ids = new Set(accounts.map(a => a.Id));
    return [...accounts, ...apnAccounts.filter(a => !ids.has(a.Id))];
  }, [accounts, apnAccounts]);

  const filtered = allAccounts.filter(a => {
    // 角色异常筛选只对组织内账户有意义：APN 账户本就不部署平台角色，
    // 留在结果里会被误读成「有异常」
    if (isAdmin && onlyRoleIssues && (a._isApn || !roleMap[a.Id])) return false;
    return !searchText
      || a.Id?.includes(searchText) || a.Name?.toLowerCase().includes(searchText.toLowerCase()) || a.Email?.toLowerCase().includes(searchText.toLowerCase());
  });

  // Payer(组织管理账户)始终置顶，APN 账户沉底（功能受限，不该抢占视线），其余按名称排序。
  const sorted = [...filtered].sort((a, b) => {
    if (!!a._isApn !== !!b._isApn) return a._isApn ? 1 : -1;
    if (!!a._isPayer !== !!b._isPayer) return a._isPayer ? -1 : 1;
    return (a.Name || '').localeCompare(b.Name || '');
  });

  /**
   * 账户详情的 Tab。桌面侧栏与移动全屏共用，避免两处各写一份而行为分叉。
   * APN 账户只给「基本」+「说明」：安全/根用户面板依赖平台角色，
   * 对这类账户既取不到数据，也不该给出可点击的入口。
   *
   * 必须定义在移动端提前 return 之前 —— const 箭头函数不提升，
   * 放在后面会在移动端触发 TDZ ReferenceError。
   */
  const renderDetailTabs = (acct: any) => {
    const info = {
      key: 'info', label: '基本', children: (
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="ID"><code style={{ fontSize: 12 }}>{acct.Id}</code></Descriptions.Item>
          <Descriptions.Item label="邮箱">{acct.Email}</Descriptions.Item>
          <Descriptions.Item label={acct._isApn ? '类型' : '组织'}><Tag>{acct._payer}</Tag></Descriptions.Item>
          <Descriptions.Item label="状态"><Tag color={acct.Status === 'ACTIVE' ? 'green' : 'red'}>{acct.Status}</Tag></Descriptions.Item>
        </Descriptions>
      ),
    };

    if (acct._isApn) {
      return [info, {
        key: 'apn', label: '说明', children: (
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            <p style={{ marginTop: 0 }}>
              <strong>APN 合作伙伴账户</strong>（POC Cash 主体 <code>{acct.partnerKey}</code>）。
              该账户不属于平台管理的任何 AWS Organization，平台只有
              <strong> Partner Central </strong>一条通路（带 ExternalId 的 <code>partner-central-tool</code> 角色，
              权限仅 <code>partnercentral:*</code>）。
            </p>
            <p style={{ margin: '0 0 4px' }}>
              <strong>控制台登录</strong>走独立的 <code>apn-console</code> 角色
              （AdministratorAccess，会话 1 小时），需根用户权限，每次登录都写审计。
            </p>
            <p style={{ marginBottom: 4 }}>以下功能仍<strong>不可用</strong>（平台未在该账户部署对应角色）：</p>
            <ul style={{ paddingLeft: 18, margin: '0 0 10px' }}>
              {(acct.unavailable || []).map((u: string) => <li key={u}>{u}</li>)}
            </ul>
            <p style={{ margin: '0 0 10px' }}>
              Partner Central role：{acct.configured
                ? <Tag color="green">已配置</Tag>
                : <Tag color="red">缺少 roleArn</Tag>}
              ExternalId：{acct.externalIdConfigured
                ? <Tag color="green">已配置</Tag>
                : <Tag color="orange">未配置</Tag>}
              <br />
              控制台 role：{acct.consoleConfigured
                ? <Tag color="green">已配置</Tag>
                : <Tag color="orange">未配置</Tag>}
            </p>
            {apnProbe[acct.partnerKey] && (
              <p style={{ margin: '0 0 10px' }}>
                连通性：{apnProbe[acct.partnerKey].ok
                  ? <Tag color="green">正常（{apnProbe[acct.partnerKey].actualAccountId}）</Tag>
                  : <Tag color="red">{apnProbe[acct.partnerKey].error}</Tag>}
              </p>
            )}
            {isAdmin && (
              <Button size="small" loading={apnProbing} onClick={probeApn}>实测连通性</Button>
            )}
          </div>
        ),
      }];
    }

    return [
      info,
      { key: 'mfa', label: '安全', children: detailLoading ? <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div> : detail?.mfa ? (
        <>
          <Card size="small" style={{ marginBottom: 8 }}>
            <p style={{ fontWeight: 600 }}>Root MFA: {detail.mfa.root ? <Tag color="green">已启用</Tag> : <Tag color="red">未启用</Tag>}</p>
          </Card>
          {detail.mfa.users.map((u: any) => (
            <div key={u.user} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
              <code>{u.user}</code>
              <span>{u.hasMFA
                ? <CheckCircleOutlined style={{ color: 'var(--color-success)' }} aria-label="已绑定 MFA" />
                : <CloseCircleOutlined style={{ color: 'var(--color-error)' }} aria-label="未绑定 MFA" />}</span>
            </div>
          ))}
        </>
      ) : <span style={{ color: '#8a94a6' }}>无数据</span> },
      { key: 'root', label: '根用户', children: (
        <RootCredentialsPanel accountId={acct.Id} rootCredentials={detail?.rootCredentials} canRoot={canRoot} rootResetAccess={rootResetAccess} isAdmin={isAdmin} isPayer={!!acct._isPayer} adminExcluded={!!acct._adminRoleExcluded} loading={detailLoading} />
      ) },
    ];
  };

  // Mobile detail view (full screen overlay)
  if (selectedAccount && detailFullScreen) {
    return (
      <div className="mobile-detail-overlay" style={{ padding: 16, paddingBottom: 88 }}>
        {/* 返回栏两行布局：账户名可能很长，此前「返回 + 名称 + 组织 Tag + Payer Tag
            + 控制台按钮」硬挤一行，marginLeft:'auto' 会把控制台按钮推出屏幕外。 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Button type="text" icon={<LeftOutlined />} onClick={() => setSelectedAccount(null)}
              style={{ flexShrink: 0, paddingInline: 4 }}>返回</Button>
            <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedAccount.Name}
            </span>
            <ConsoleButton account={selectedAccount} style={{ flexShrink: 0 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            <Tag style={{ margin: 0 }}>{selectedAccount._payer}</Tag>
            {selectedAccount._isApn
              ? <Tag color="cyan" style={{ margin: 0 }}>APN</Tag>
              : selectedAccount._isPayer && <Tag color="gold" style={{ margin: 0 }}>Payer</Tag>}
          </div>
        </div>
        <Tabs size="small" items={renderDetailTabs(selectedAccount)} />
      </div>
    );
  }

  // 敏感权限客户账户面板
  // INVITED 账户没有 OAAR，收窄后平台只剩 support-quota，需单独警示
  const invitedTargetCount = restrictTargets
    .filter(id => accounts.some(a => a.Id === id && a.JoinedMethod === 'INVITED')).length;
  const renderRestrictModal = () => (
    <Modal
      title="敏感权限客户账户"
      open={restrictOpen}
      onCancel={() => setRestrictOpen(false)}
      footer={null}
      width={880}
    >
      <p style={{ color: 'var(--color-text-muted)', fontSize: 12, marginTop: 0 }}>
        收窄 <code>support-quota</code>（仅保留配额查询、提额、提额进度、Support 工单和区域状态查询）并启用 <code>ExternalId</code>；
        删除 <code>admin-console</code>；<code>OrganizationAccountAccessRole</code> 保留，
        Admin 临时凭证（最长 1 小时）、Admin 控制台和区域开通经它执行。
        只影响选中的账户，同组织其他账户不变。
      </p>
      <div style={{ background: 'var(--color-warning-bg)', border: '1px solid var(--color-warning)', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        <WarningOutlined style={{ color: 'var(--color-warning)', marginRight: 6 }} aria-hidden />
        收窄后该账户以下功能将不可用：{restrictedUnavailable.join('；') || '—'}。
        配额查询与提额、提额进度、Support 工单、区域管理不受影响（INVITED 账户除外）。
        {invitedTargetCount > 0 && (
          <div style={{ marginTop: 6, fontWeight: 600 }}>
            已选 {invitedTargetCount} 个邀请加入的账户：它们没有 OrganizationAccountAccessRole，
            收窄后平台只保留 support-quota，Admin 临时凭证、Admin 控制台、区域开通都将不可用。
          </div>
        )}
      </div>

      {isAdmin && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 4 }}>要标记的账户 ID（可多选，12 位数字）</div>
          <Select
            mode="tags"
            style={{ width: '100%' }}
            placeholder="粘贴或输入账户 ID，回车确认"
            value={restrictTargets}
            onChange={(v: string[]) => setRestrictTargets(v.filter(x => /^\d{12}$/.test(x)))}
            tokenSeparators={[',', ' ', '\n']}
            options={accounts
              .filter(a => !a._isPayer && !restrictedMap[a.Id])
              .slice(0, 300)
              .map(a => ({
                label: `${a.Id} — ${a.Name} (${a._payer})${a.JoinedMethod === 'INVITED' ? ' · 邀请加入' : ''}`,
                value: a.Id,
              }))}
          />
          <Input
            style={{ marginTop: 8 }}
            size="small"
            placeholder="备注：客户要求出处，例如「客户安全审计要求，2026-08」"
            value={restrictNote}
            onChange={e => setRestrictNote(e.target.value)}
          />
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
            <Popconfirm
              title={`确定对 ${restrictTargets.length} 个账户收窄权限？`}
              description="会实际修改客户账户内的 IAM 角色，请确认已与客户对齐"
              onConfirm={submitRestrict}
              okText="执行" cancelText="取消"
              disabled={restrictTargets.length === 0}
            >
              <Button type="primary" size="small" loading={restrictSubmitting} disabled={restrictTargets.length === 0}>
                收窄这 {restrictTargets.length} 个账户
              </Button>
            </Popconfirm>
          </div>
        </div>
      )}

      <Table
        size="small"
        rowKey="account_id"
        dataSource={restricted}
        pagination={restricted.length > 10 ? { pageSize: 10, size: 'small' } : false}
        locale={{ emptyText: '暂无敏感权限客户账户' }}
        columns={[
          {
            title: '账户', key: 'a', width: 200,
            render: (_: any, x: any) => (
              <div>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{x.account_name || '-'}</div>
                <code style={{ fontSize: 11, color: '#8a94a6' }}>{x.account_id}</code>
              </div>
            ),
          },
          { title: '组织', dataIndex: 'payer', width: 160, render: (p: string) => p ? <Tag style={{ margin: 0, fontSize: 11 }}>{p}</Tag> : '-' },
          {
            title: '状态', dataIndex: 'state', width: 100, align: 'center' as const,
            render: (s: string, x: any) => s === 'applied'
              ? <Tag color="green" style={{ margin: 0, fontSize: 11 }}>已收窄</Tag>
              : s === 'pending'
                ? <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>处理中</Tag>
                : <Tooltip title={x.last_error || ''}><Tag color="red" style={{ margin: 0, fontSize: 11 }}>失败</Tag></Tooltip>,
          },
          {
            title: '生效时间', dataIndex: 'applied_at', width: 150,
            render: (t: string) => <span style={{ fontSize: 12 }}>{t ? new Date(t).toLocaleString('zh-CN') : '-'}</span>,
          },
          { title: '标记人', dataIndex: 'marked_by', width: 90, render: (v: string) => <span style={{ fontSize: 12 }}>{v || '-'}</span> },
          { title: '备注', dataIndex: 'note', render: (v: string) => <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{v || '-'}</span> },
          {
            title: '操作', key: 'act', width: 150,
            render: (_: any, x: any) => isAdmin ? (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => showExternalId(x.account_id)}>ExternalId</Button>
                <Popconfirm
                  title="恢复默认权限？"
                  description="会先装回默认角色再删受限角色，客户侧权限将回到收窄前"
                  onConfirm={async () => {
                    const hide = message.loading('正在恢复…', 0);
                    const r = await api.unmarkRestrictedAccount(x.account_id).catch((e: any) => ({ success: false, error: e.message }));
                    hide();
                    if (r.success) { message.success('已恢复默认权限'); loadRestricted(); }
                    else message.error(r.error || '恢复失败');
                  }}
                  okText="恢复" cancelText="取消"
                >
                  <Button type="link" size="small" danger>取消标记</Button>
                </Popconfirm>
              </Space>
            ) : null,
          },
        ]}
      />
    </Modal>
  );

  // 已移出组织的账户面板
  const renderDepartedModal = () => {
    const active = departed.filter(d => !d.rejoined_at);
    const rejoined = departed.filter(d => d.rejoined_at);

    return (
      <Modal
        title="已移出组织的账户"
        open={departedOpen}
        onCancel={() => setDepartedOpen(false)}
        footer={null}
        width={900}
      >
        <p style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12, marginTop: 0 }}>
          这些账户已不在任何被管理的组织内，因此不出现在上方账户列表中。
          账户离开组织时，StackSet 会按 <code>RetainStacksOnAccountRemoval=false</code> 自动删除平台角色
          （<code>support-quota</code> / <code>admin-console</code>），所以平台已无法访问它们 —— 这是预期行为。
          账户本身是否仍存续，需在原组织的账单或 AWS 侧确认。
        </p>

        <div className="stat-chips" style={{ margin: '0 0 12px' }}>
          <span className="stat-chip">已离开 <strong>{active.length}</strong></span>
          {rejoined.length > 0 && <span className="stat-chip success">曾离开又加回 <strong>{rejoined.length}</strong></span>}
          {Object.entries(
            active.reduce((acc: Record<string, number>, d) => {
              const k = d.payer || '未知';
              acc[k] = (acc[k] || 0) + 1;
              return acc;
            }, {}),
          ).sort((a, b) => b[1] - a[1]).map(([p, n]) => (
            <span key={p} className="stat-chip">{p} <strong>{n}</strong></span>
          ))}
        </div>

        <Table
          size="small"
          rowKey="account_id"
          dataSource={departed}
          pagination={departed.length > 10 ? { pageSize: 10, size: 'small', showTotal: t => `共 ${t} 条` } : false}
          locale={{ emptyText: '暂无已移出组织的账户记录' }}
          columns={[
            {
              title: '账户', key: 'acct', width: 200,
              render: (_: any, x: any) => (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>
                    {x.name || <span style={{ color: '#8a94a6', fontWeight: 400 }}>（名称未留存）</span>}
                  </div>
                  <code style={{ fontSize: 11, color: '#8a94a6' }}>{x.account_id}</code>
                </div>
              ),
            },
            {
              title: '原属组织', dataIndex: 'payer', width: 160,
              filters: [...new Set(departed.map(d => d.payer).filter(Boolean))].map(p => ({ text: p, value: p })),
              onFilter: (v: any, r: any) => r.payer === v,
              render: (p: string) => p
                ? <Tag style={{ margin: 0, fontSize: 11 }}>{p}</Tag>
                : <span style={{ color: '#8a94a6', fontSize: 12 }}>未知</span>,
            },
            {
              title: '移出时间', dataIndex: 'departed_at', width: 155,
              sorter: (a: any, b: any) => String(a.departed_at || a.detected_at).localeCompare(String(b.departed_at || b.detected_at)),
              defaultSortOrder: 'descend' as const,
              render: (t: string, r: any) => t
                ? (
                  <Tooltip title={r.actor ? `操作者：${r.actor}` : '来自 CloudTrail 查证'}>
                    <span style={{ fontSize: 12 }}>{new Date(t).toLocaleString('zh-CN')}</span>
                  </Tooltip>
                )
                : (
                  <Tooltip title={r.note || '未查证到移出事件'}>
                    <span style={{ color: '#8a94a6', fontSize: 12 }}>未查证</span>
                  </Tooltip>
                ),
            },
            {
              title: '平台发现于', dataIndex: 'detected_at', width: 155,
              render: (t: string) => <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>{t ? new Date(t).toLocaleString('zh-CN') : '-'}</span>,
            },
            {
              title: '状态', key: 'st', width: 110, align: 'center' as const,
              render: (_: any, r: any) => r.rejoined_at
                ? <Tooltip title={`于 ${new Date(r.rejoined_at).toLocaleString('zh-CN')} 重新加入`}><Tag color="green" style={{ margin: 0, fontSize: 11 }}>已加回</Tag></Tooltip>
                : <Tag style={{ margin: 0, fontSize: 11 }}>已离开</Tag>,
            },
            {
              title: '遗留数据', dataIndex: 'had_region_data', width: 90, align: 'center' as const,
              render: (v: boolean) => v
                ? <Tooltip title="库中仍存有该账户的区域扫描数据，可在区域管理页「按组织查看」底部看到"><Tag color="orange" style={{ margin: 0, fontSize: 11 }}>有</Tag></Tooltip>
                : <span style={{ color: '#b6bdca' }}>-</span>,
            },
            {
              title: '备注', dataIndex: 'note',
              render: (n: string) => n
                ? <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>{n}</span>
                : null,
            },
          ]}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>
            账户同步时自动比对前后快照登记；某组织账户整体消失会判为同步失败而跳过，不会误记
          </span>
          {departed.length > 0 && (
            <Button
              size="small"
              onClick={() => exportToCSV(departed.map(d => ({
                账户ID: d.account_id, 名称: d.name || '', 邮箱: d.email || '', 原属组织: d.payer || '',
                移出时间: d.departed_at || '', 操作者: d.actor || '', 平台发现于: d.detected_at || '',
                最后状态: d.last_status || '', 是否加回: d.rejoined_at ? d.rejoined_at : '否',
                遗留区域数据: d.had_region_data ? '有' : '无', 备注: d.note || '',
              })), 'departed-accounts')}
            >
              导出
            </Button>
          )}
        </div>
      </Modal>
    );
  };

  // 权限检测结果面板 —— 自动检测与手动检测的结果都在这里看
  const renderRoleModal = () => {
    const problems: any[] = roleSummary?.problems || [];
    const checked = roleSummary?.total || 0;
    const activeTotal = accounts.filter(a => !a._isPayer && a.Status === 'ACTIVE').length;
    const byState = roleSummary?.byState || {};
    const r = lastCheckResult;

    return (
      <Modal
        title="账户权限检测"
        open={roleModalOpen}
        onCancel={() => setRoleModalOpen(false)}
        footer={null}
        width={860}
      >
        <p style={{ color: 'rgba(0,0,0,0.55)', fontSize: 12, marginTop: 0 }}>
          平台访问成员账户依赖两个角色：<code>support-quota</code>（只读）与 <code>admin-console</code>（管理员临时凭证 / 控制台）。
          系统每 30 分钟自动检测新账户、每 24 小时全量复检，缺失会自动通过 StackSet 补齐；连续 3 次补不上才需要人工介入。
        </p>

        {/* 覆盖与状态统计 */}
        <div className="stat-chips" style={{ margin: '0 0 12px' }}>
          <span className="stat-chip">已检测 <strong>{checked}</strong> / {activeTotal}</span>
          <span className="stat-chip success">正常 <strong>{byState.ok || 0}</strong></span>
          {(byState.pending || byState.partial) ? (
            <span className="stat-chip" style={{ color: '#d46b08', background: '#fff7e6', borderColor: '#ffd591' }}>
              补齐中 <strong>{(byState.pending || 0) + (byState.partial || 0)}</strong>
            </span>
          ) : null}
          {byState.unreachable ? (
            <span className="stat-chip" style={{ color: '#cf1322', background: '#fff1f0', borderColor: '#ffa39e' }}>
              需人工 <strong>{byState.unreachable}</strong>
            </span>
          ) : null}
          {roleSummary?.lastCheckedAt && (
            <span className="stat-chip">最近检测 <strong>{new Date(roleSummary.lastCheckedAt).toLocaleString('zh-CN')}</strong></span>
          )}
        </div>

        {/* 本次手动检测的结果 */}
        {roleChecking && (
          <div style={{ background: '#f0f5ff', border: '1px solid #adc6ff', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12 }}>
            <Spin size="small" style={{ marginRight: 8 }} />
            正在检测…缺失角色会自动补齐，补齐需等 CloudFormation 完成，可能要几分钟。
          </div>
        )}
        {!roleChecking && r && (
          <div style={{ background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6, padding: '8px 12px', marginBottom: 12, fontSize: 12 }}>
            本次{r.full ? '全量复检' : '检测'}：扫描 <strong>{r.scanned}</strong> 个
            ，正常 <strong>{r.ok}</strong>
            ，已自动补齐 <strong style={{ color: '#389e0d' }}>{r.remediated}</strong>
            ，待重试 <strong style={{ color: '#d46b08' }}>{r.pending}</strong>
            ，需人工 <strong style={{ color: '#cf1322' }}>{r.unreachable}</strong>
            {r.skippedSuspended ? `，跳过已暂停账户 ${r.skippedSuspended}` : ''}
            {r.scanned === 0 && <span>（没有需要检测的账户，全部已检测过；用「全量复检」可重新检查全部）</span>}
          </div>
        )}

        {/* 问题账户明细 */}
        <Table
          size="small"
          rowKey="account_id"
          dataSource={problems}
          pagination={{ pageSize: 8, size: 'small', showTotal: t => `共 ${t} 个异常账户` }}
          locale={{ emptyText: checked === 0 ? '尚无检测记录，点下方「立即检测」' : '所有已检测账户权限正常' }}
          columns={[
            {
              title: '账户', key: 'acct', width: 220,
              render: (_: any, x: any) => (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{x.account_name || '-'}</div>
                  <code style={{ fontSize: 11, color: '#8a94a6' }}>{x.account_id}</code>
                </div>
              ),
            },
            {
              title: '组织', dataIndex: 'payer', width: 150,
              render: (p: string) => p ? <Tag style={{ margin: 0, fontSize: 11 }}>{p}</Tag> : '-',
            },
            {
              title: '缺失角色', key: 'miss', width: 190,
              render: (_: any, x: any) => {
                const miss: string[] = [];
                if (!x.support) miss.push('support-quota');
                if (!x.admin) miss.push('admin-console');
                return <span style={{ fontSize: 11, color: '#cf1322' }}>{miss.join(' + ') || '-'}</span>;
              },
            },
            {
              title: '状态', dataIndex: 'state', width: 100, align: 'center' as const,
              render: (s: string, x: any) => s === 'unreachable'
                ? <Tag color="red" style={{ margin: 0, fontSize: 11 }}>需人工</Tag>
                : <Tooltip title={`已尝试补齐 ${x.attempts} 次，达到 3 次仍失败才会转为「需人工」`}>
                    <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>补齐中 {x.attempts}/3</Tag>
                  </Tooltip>,
            },
            {
              title: '说明', key: 'why',
              render: (_: any, x: any) => (
                <span style={{ fontSize: 11, color: 'rgba(0,0,0,0.55)' }}>
                  {x.state === 'unreachable'
                    ? '自动补齐失败，常见原因是账户未完成激活（CloudFormation 返回 OptInRequired），需先处理账户本身'
                    : '等待 StackSet 部署完成，下一轮会自动复验'}
                </span>
              ),
            },
          ]}
        />

        {/* 操作 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          <Space size={8}>
            {problems.length > 0 && (
              <>
                <Button size="small" onClick={() => { setOnlyRoleIssues(true); setRoleModalOpen(false); }}>
                  在账户列表中只看这些
                </Button>
                <Button
                  size="small"
                  onClick={() => exportToCSV(problems.map(x => ({
                    账户ID: x.account_id, 名称: x.account_name, 组织: x.payer,
                    support_quota: x.support ? '有' : '缺', admin_console: x.admin ? '有' : '缺',
                    状态: x.state, 尝试次数: x.attempts, 最近检测: x.checked_at,
                  })), 'account-role-issues')}
                >
                  导出
                </Button>
              </>
            )}
          </Space>
          {isAdmin && (
            <Space size={8}>
              <Tooltip title="只检测尚未检测过的账户和上轮待重试的，很快">
                <Button size="small" loading={roleChecking} onClick={() => runRoleCheck(false)}>立即检测（增量）</Button>
              </Tooltip>
              <Tooltip title="重新检测全部账户，单轮最多 400 个，按最久未检查优先">
                <Button size="small" type="primary" loading={roleChecking} onClick={() => runRoleCheck(true)}>全量复检</Button>
              </Tooltip>
            </Space>
          )}
        </div>
      </Modal>
    );
  };

  // 平台角色缺失标记 —— 仅 admin 可见，且只有异常账户才显示
  const renderRoleFlag = (accountId: string) => {
    if (!isAdmin) return null;
    const r = roleMap[accountId];
    if (!r) return null;
    const miss: string[] = [];
    if (!r.support) miss.push('support-quota');
    if (!r.admin) miss.push('admin-console');
    const unreachable = r.state === 'unreachable';
    const tip = unreachable
      ? `平台无法访问该账户：缺 ${miss.join(' / ')}。已重试 ${r.attempts} 次仍失败，需人工处理（常见原因是账户未完成激活）。`
      : `缺 ${miss.join(' / ')}，自动补齐进行中（已尝试 ${r.attempts} 次）。`;
    return (
      <Tooltip title={tip}>
        <Tag
          color={unreachable ? 'red' : 'orange'}
          style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px', flexShrink: 0 }}
        >
          {unreachable ? '权限缺失' : '补齐中'}
        </Tag>
      </Tooltip>
    );
  };

  // Desktop columns
  const columns = [
    { title: '账户', key: 'account', width: 300,
      sorter: (a: any, b: any) => (a.Name || '').localeCompare(b.Name || ''),
      render: (_: any, a: any) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <AccountAvatar name={a.Name} id={a.Id} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: '#1a2233', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.Name}</span>
              {a._isApn ? (
                <Tooltip title={`APN 合作伙伴账户（${a.partnerKey}），仅用于 POC Cash 商机与 POC 申请。不可用：${(a.unavailable || []).join('；')}`}>
                  <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px', flexShrink: 0 }}>APN</Tag>
                </Tooltip>
              ) : a._isPayer && <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px', flexShrink: 0 }}>Payer</Tag>}
              {a._isApn && !a.configured && (
                <Tooltip title="config.json 的 partnerCentral 下缺少该主体的 roleArn，POC Cash 无法使用">
                  <Tag color="red" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px', flexShrink: 0 }}>未配置</Tag>
                </Tooltip>
              )}
              {a._isApn && apnProbe[a.partnerKey] && (
                <Tooltip title={apnProbe[a.partnerKey].ok ? `连通正常（${apnProbe[a.partnerKey].actualAccountId}）` : apnProbe[a.partnerKey].error}>
                  <Tag color={apnProbe[a.partnerKey].ok ? 'green' : 'red'} style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px', flexShrink: 0 }}>
                    {apnProbe[a.partnerKey].ok ? '已连通' : '不可达'}
                  </Tag>
                </Tooltip>
              )}
              {restrictedMap[a.Id] && (
                <Tooltip title={`敏感权限客户账户：平台权限已收窄并启用 ExternalId。不可用功能：${restrictedUnavailable.join('；')}`}>
                  <Tag color="purple" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px', flexShrink: 0 }}>已收窄</Tag>
                </Tooltip>
              )}
              {renderRoleFlag(a.Id)}
            </div>
            <div style={{ fontSize: 12, color: '#8a94a6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.Email}>{a.Email}</div>
          </div>
        </div>
      ),
    },
    { title: 'ID', dataIndex: 'Id', key: 'Id', width: 130, render: (id: string) => <code style={{ fontSize: 12, color: '#4a5468' }}>{id}</code> },
    { title: '组织', dataIndex: '_payer', key: '_payer', width: 180,
      // 用合并后的列表取值，否则「APN 合作伙伴账户」这一组筛不出来
      filters: [...new Set(allAccounts.map(a => a._payer))].filter(Boolean).map(p => ({ text: p, value: p })),
      onFilter: (value: any, record: any) => record._payer === value,
      render: (p: string) => {
        if (!p) return null;
        const c = hashColor(p);
        return <Tag style={{ margin: 0, border: 'none', color: c.fg, background: c.bg, maxWidth: 168, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p}>{p}</Tag>;
      }, responsive: ['md'] as any },
    { title: '状态', dataIndex: 'Status', key: 'Status', width: 100, align: 'center' as const,
      filters: [{ text: 'ACTIVE', value: 'ACTIVE' }, { text: 'SUSPENDED', value: 'SUSPENDED' },
        { text: 'UNCONFIGURED', value: 'UNCONFIGURED' }],
      onFilter: (value: any, record: any) => record.Status === value,
      // UNCONFIGURED 是 APN 账户缺 roleArn 的状态，用 warning 区别于 SUSPENDED
      render: (s: string) => <Badge status={s === 'ACTIVE' ? 'success' : s === 'UNCONFIGURED' ? 'warning' : 'error'} text={<span style={{ fontSize: 12 }}>{s}</span>} /> },
  ];

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h2 className="page-header-title">账户管理</h2>
          <p className="page-header-subtitle">管理 AWS 账户、组织归属与状态</p>
        </div>
        {!isMobile && accounts.length > 0 && (
          <div className="stat-chips" style={{ margin: 0 }}>
            {/* 统计口径只算组织内账户：APN 账户不属于任何组织，
                计进「总账户/组织」会让这两个数与实际管理规模对不上 */}
            <span className="stat-chip">总账户 <strong>{accounts.length}</strong></span>
            <span className="stat-chip success">Active <strong>{accounts.filter(a => a.Status === 'ACTIVE').length}</strong></span>
            <span className="stat-chip">组织 <strong>{[...new Set(accounts.map(a => a._payer))].length}</strong></span>
            {apnAccounts.length > 0 && (
              <Tooltip title="AWS Partner Network 合作伙伴主体账户，仅用于 POC Cash，不属于任何组织">
                <span className="stat-chip">APN <strong>{apnAccounts.length}</strong></span>
              </Tooltip>
            )}
            <Tooltip title="按客户安全要求收窄了平台权限的账户，点击管理">
              <span
                className="stat-chip"
                style={{ cursor: 'pointer', ...(restricted.length ? { color: '#531dab', background: '#f9f0ff', borderColor: '#d3adf7' } : {}) }}
                onClick={() => setRestrictOpen(true)}
              >
                已收窄 <strong>{restricted.length}</strong>
              </span>
            </Tooltip>
            {departed.filter(d => !d.rejoined_at).length > 0 && (
              <Tooltip title="已移出组织、不在上方列表中的账户，点击查看">
                <span
                  className="stat-chip"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setDepartedOpen(true)}
                >
                  已离开 <strong>{departed.filter(d => !d.rejoined_at).length}</strong>
                </span>
              </Tooltip>
            )}
            {isAdmin && Object.keys(roleMap).length > 0 && (
              <Tooltip title="平台缺少访问这些账户所需的角色，点击查看明细">
                <span
                  className="stat-chip"
                  style={{ cursor: 'pointer', color: '#cf1322', background: '#fff1f0', borderColor: '#ffa39e' }}
                  onClick={() => setRoleModalOpen(true)}
                >
                  权限异常 <strong>{Object.keys(roleMap).length}</strong>
                </span>
              </Tooltip>
            )}
            {isAdmin && onlyRoleIssues && (
              <span
                className="stat-chip"
                style={{ cursor: 'pointer' }}
                onClick={() => setOnlyRoleIssues(false)}
              >
                ✓ 仅看异常 · 点此取消
              </span>
            )}
          </div>
        )}
      </div>

      {/* Content Card */}
      <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
        {/* Table Toolbar */}
        <div className="table-toolbar">
          <Input placeholder="搜索 ID、名称、邮箱或组织..." prefix={<SearchOutlined />} value={searchText}
            onChange={e => setSearchText(e.target.value)} allowClear size="small" />
          <Space size={8}>
            <span className="stat-chip">共 <strong>{filtered.length}</strong> 条</span>
            <Tooltip title="开启后，点「控制台」会用该账户专属的独立浏览器会话打开，多个账户可同时保持登录，不用先注销。首次开启会下载本地助手安装脚本（仅 macOS）。">
              <span className="hide-mobile" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <Switch size="small" checked={isolated}
                  aria-label="独立会话打开控制台"
                  onChange={toggleIsolated} />
                独立会话
              </span>
            </Tooltip>
            {isAdmin && (
              <Tooltip title="查看账户权限检测结果。系统每 30 分钟自动检测新账户、每 24 小时全量复检，缺失会自动补齐。">
                <Button size="small" className="hide-mobile" onClick={() => setRoleModalOpen(true)}>
                  权限状态
                </Button>
              </Tooltip>
            )}
            <Button size="small" className="hide-mobile" onClick={() => exportToCSV(filtered.map(a => ({ ID: a.Id, 名称: a.Name, 邮箱: a.Email, 组织: a._payer, 状态: a.Status })), 'accounts')}>导出</Button>
            <Button size="small" aria-label="刷新账户列表" icon={<ReloadOutlined />} onClick={fetchAccounts} loading={loading} />
          </Space>
        </div>

        {/* Mobile: card list */}
        {isMobile ? (
          <div>
            {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
            {sorted.slice(0, 50).map(a => (
              <div key={a.Id} className="account-card" onClick={() => openDetail(a)}>
                <div className="account-card-info">
                  <h4>{a.Name} {a._isApn
                    ? <Tag color="cyan" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px' }}>APN</Tag>
                    : a._isPayer && <Tag color="gold" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px' }}>Payer</Tag>}</h4>
                  <p>{a.Id} · {a._payer}</p>
                </div>
                <Tag color={a.Status === 'ACTIVE' ? 'green' : 'red'}>{a.Status}</Tag>
              </div>
            ))}
            {filtered.length > 50 && <p style={{ textAlign: 'center', color: '#8a94a6', padding: 8 }}>显示前 50 条，请搜索缩小范围</p>}
          </div>
        ) : (
          /* Desktop: table + side panel */
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <Table columns={columns} dataSource={sorted} rowKey="Id" loading={loading} size="small"
                pagination={{ pageSize: 15, size: 'small', showTotal: t => `共 ${t} 条`, showSizeChanger: true }}
                locale={{ emptyText: '暂无匹配账户，请调整搜索关键词' }}
                onRow={r => ({ onClick: () => openDetail(r), style: { cursor: 'pointer' } })} />
            </div>
            {selectedAccount && (
              <div style={{ width: 360, minWidth: 360 }}>
                <Card size="small" style={{ height: '100%' }} title={<span>{selectedAccount.Name}{selectedAccount._isApn
                  ? <Tag color="cyan" style={{ marginLeft: 8 }}>APN</Tag>
                  : selectedAccount._isPayer && <Tag color="gold" style={{ marginLeft: 8 }}>Payer</Tag>}</span>}
                  extra={
                    <Space size={4}>
                      <ConsoleButton account={selectedAccount} />
                      <Button type="text" size="small" aria-label="关闭" onClick={() => setSelectedAccount(null)}>✕</Button>
                    </Space>
                  }>
                  <Tabs size="small" items={renderDetailTabs(selectedAccount)} />
                </Card>
              </div>
            )}
          </div>
        )}
      </Card>

      {renderRoleModal()}
      {renderDepartedModal()}
      {renderRestrictModal()}
    </div>
  );
};

export default AccountsPage;
