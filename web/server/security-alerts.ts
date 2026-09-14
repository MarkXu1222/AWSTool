/**
 * 安全告警 — 被攻击/滥用时第一时间飞书通知
 *
 * 三类信号：
 * 1. 登录安全：失败爆破（同 IP 或同用户名阈值）、登录成功但来自本进程未见过的新 IP
 * 2. 敏感操作：root 凭证类 / 用户管理类 / ExternalId 查看等，实时推送（由 db.addAuditLog 钩子触发）
 * 3. HTTP 异常：429（限速被打满=疑似滥用）与 5xx 突增，滑动窗口阈值告警
 *
 * 设计约束：所有计数器在进程内存（与 ops-monitor 同理，重启清零）；
 * 每类告警有独立冷却时间，防止告警本身被刷屏；通知失败绝不影响业务请求。
 */
import { sendNotification } from './notify';

// ===== 通用：滑动窗口计数 + 冷却 =====

interface WindowCounter { events: number[] }
const counters = new Map<string, WindowCounter>();
const lastAlertAt = new Map<string, number>();

function bump(key: string, windowMs: number): number {
  let c = counters.get(key);
  if (!c) { c = { events: [] }; counters.set(key, c); }
  const now = Date.now();
  c.events.push(now);
  // 清理窗口外事件；同时防止 Map 无限膨胀（1000 个 key 上限，超出清最旧）
  c.events = c.events.filter(t => now - t <= windowMs);
  if (counters.size > 1000) {
    const first = counters.keys().next().value;
    if (first !== undefined) counters.delete(first);
  }
  return c.events.length;
}

function cooldownOk(alertKey: string, cooldownMs: number): boolean {
  const last = lastAlertAt.get(alertKey) || 0;
  if (Date.now() - last < cooldownMs) return false;
  lastAlertAt.set(alertKey, Date.now());
  return true;
}

function fireAndForget(title: string, content: string) {
  // 通知失败只打日志，不向调用方传播
  sendNotification(title, content).catch(e => console.error('[Security] 通知失败:', e?.message));
}

const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });

// ===== 1. 登录安全 =====

const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export function recordLoginFailure(username: string, ip: string | undefined, reason: 'password' | 'mfa') {
  const cleanIp = (ip || 'unknown').replace('::ffff:', '');
  const byIp = bump(`lf:ip:${cleanIp}`, LOGIN_FAIL_WINDOW_MS);
  const byUser = bump(`lf:user:${username}`, LOGIN_FAIL_WINDOW_MS);
  if (byIp >= LOGIN_FAIL_THRESHOLD && cooldownOk(`alert:lf:ip:${cleanIp}`, LOGIN_ALERT_COOLDOWN_MS)) {
    fireAndForget('🚨 登录爆破告警',
      `IP **${cleanIp}** 在 10 分钟内登录失败 **${byIp}** 次（最近目标用户：${username}，失败环节：${reason === 'mfa' ? 'MFA 验证码' : '密码'}）。\n`
      + `已有防线：登录限速 5 次/15 分钟。若持续，考虑在 Nginx/安全组封禁该 IP。\n${ts()}`);
  } else if (byUser >= LOGIN_FAIL_THRESHOLD && cooldownOk(`alert:lf:user:${username}`, LOGIN_ALERT_COOLDOWN_MS)) {
    fireAndForget('🚨 账号被集中尝试',
      `用户名 **${username}** 在 10 分钟内被多个来源登录失败共 **${byUser}** 次（最近来源 IP：${cleanIp}）。\n`
      + `建议确认是否本人操作；必要时重置该用户密码。\n${ts()}`);
  }
}

// 每用户已见 IP（进程内存，重启后首个登录会再提醒一次，可接受）
const seenIps = new Map<string, Set<string>>();

export function recordLoginSuccess(username: string, ip: string | undefined) {
  const cleanIp = (ip || 'unknown').replace('::ffff:', '');
  let set = seenIps.get(username);
  if (!set) { set = new Set(); seenIps.set(username, set); }
  const isNew = !set.has(cleanIp);
  set.add(cleanIp);
  // 进程启动后该用户的第一次登录不告警（否则每次重启都会提醒一轮）
  if (isNew && set.size > 1 && cooldownOk(`alert:newip:${username}:${cleanIp}`, 24 * 3600 * 1000)) {
    fireAndForget('⚠️ 新 IP 登录',
      `用户 **${username}** 从本进程未见过的 IP **${cleanIp}** 登录成功（已通过密码 + MFA）。\n`
      + `若非本人操作，请立即重置密码并检查审计日志。\n${ts()}`);
  }
}

// ===== 2. 敏感操作实时通知（db.addAuditLog 钩子） =====

const SENSITIVE_ACTIONS: Record<string, string> = {
  TEMP_CREDENTIALS: '生成 Admin 临时凭证',
  ROOT_MFA_DELETE: '删除 Root MFA',
  ROOT_PASSWORD_RECOVER: '恢复根用户密码',
  ROOT_ACCESSKEY_DELETE: '删除 Root Access Key',
  ROOT_PASSWORD_BATCH_CREATE: '创建批量 Root 自动改密任务',
  ROOT_PASSWORD_SET: '自动设置 Root 新密码成功',
  ROOT_PASSWORD_SET_FAILED: '自动设置 Root 新密码失败',
  ROOT_PASSWORD_SET_UNKNOWN: 'Root 新密码提交结果未知',
  ROOT_PASSWORD_CSV_DOWNLOAD: '下载一次性 Root 密码 CSV',
  ROOT_PASSWORD_CREDENTIAL_DESTROY: '销毁临时 Root 密码密文',
  ROOT_PASSWORD_STEPUP_FAILED: 'Root 密码高风险操作 MFA 验证失败',
  CONSOLE_ADMIN_LOGIN: 'Admin 控制台登录',
  USER_CREATE: '创建平台用户',
  USER_DELETE: '删除平台用户',
  USER_UPDATE: '修改用户权限',
  PASSWORD_RESET: '重置用户密码',
  ACCOUNT_EXTERNALID_VIEW: '查看客户 ExternalId',
  ACCOUNT_RESTRICT: '标记敏感权限客户',
  ACCOUNT_UNRESTRICT: '取消敏感权限标记',
};

// 单类敏感操作 5 分钟内只推一次汇总冷却，避免批量操作刷屏；
// root 凭证四类风险最高，不设冷却、每次必达。
const ALWAYS_NOTIFY = new Set(['ROOT_MFA_DELETE', 'ROOT_PASSWORD_RECOVER', 'ROOT_ACCESSKEY_DELETE',
  'ROOT_PASSWORD_BATCH_CREATE', 'ROOT_PASSWORD_SET', 'ROOT_PASSWORD_SET_FAILED', 'ROOT_PASSWORD_SET_UNKNOWN',
  'ROOT_PASSWORD_CSV_DOWNLOAD', 'ROOT_PASSWORD_CREDENTIAL_DESTROY']);
const SENSITIVE_COOLDOWN_MS = 5 * 60 * 1000;

export function onAuditAction(action: string, username: string | null | undefined, ip: string | null | undefined, detail: string) {
  const label = SENSITIVE_ACTIONS[action];
  if (!label) return;
  const key = `alert:sens:${action}:${username || ''}`;
  if (!ALWAYS_NOTIFY.has(action) && !cooldownOk(key, SENSITIVE_COOLDOWN_MS)) return;
  const cleanIp = (ip || '未知').replace('::ffff:', '');
  fireAndForget(`🔔 敏感操作 · ${label}`,
    `操作人：**${username || '未知'}**（IP ${cleanIp}）\n动作：${action}\n详情：${detail.slice(0, 300)}\n${ts()}`
    + (ALWAYS_NOTIFY.has(action) ? '' : '\n_同类操作 5 分钟内合并通知_'));
}

// ===== 3. HTTP 异常（429 滥用 / 5xx 突增） =====

const HTTP_WINDOW_MS = 5 * 60 * 1000;
const HTTP_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const THRESHOLD_429 = 20;  // 5 分钟内 20 次 429（限速被持续打满 = 疑似脚本滥用）
const THRESHOLD_5XX = 5;   // 5 分钟内 5 次 5xx（服务异常）

export function recordHttpStatus(status: number, path: string, ip: string | undefined) {
  const cleanIp = (ip || 'unknown').replace('::ffff:', '');
  if (status === 429) {
    const n = bump('http:429', HTTP_WINDOW_MS);
    if (n >= THRESHOLD_429 && cooldownOk('alert:429', HTTP_ALERT_COOLDOWN_MS)) {
      fireAndForget('🚨 限速被持续触发（疑似滥用）',
        `5 分钟内累计 **${n}** 次 429（最近：${path}，IP ${cleanIp}）。\n`
        + `可能是脚本高频调用或多标签页异常轮询。请查运维监控端点排行与审计日志定位来源。\n${ts()}`);
    }
  } else if (status >= 500) {
    const n = bump('http:5xx', HTTP_WINDOW_MS);
    if (n >= THRESHOLD_5XX && cooldownOk('alert:5xx', HTTP_ALERT_COOLDOWN_MS)) {
      fireAndForget('🚨 服务端错误突增',
        `5 分钟内累计 **${n}** 次 5xx（最近：${status} ${path}）。\n`
        + `请查运维监控页与 pm2 logs 定位。\n${ts()}`);
    }
  }
}
