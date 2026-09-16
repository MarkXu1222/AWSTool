/**
 * 安全告警 — 被攻击/滥用时第一时间飞书通知
 *
 * 两类信号：
 * 1. 登录安全：失败爆破（同 IP 或同用户名阈值）
 * 2. HTTP 异常：429（限速被打满=疑似滥用）与 5xx 突增，滑动窗口阈值告警
 *
 * 设计约束：所有计数器在进程内存（与 ops-monitor 同理，重启清零）；
 * 每类告警有独立冷却时间，防止告警本身被刷屏；通知失败绝不影响业务请求。
 *
 * 2026-09-15 按运营要求移除：
 * - 「新 IP 登录」提醒：登录已强制密码 + MFA，该提醒噪音大于价值。
 * - 敏感操作实时推送（原 18 个动作）：这些动作**仍然完整写入审计日志**，
 *   只是不再推飞书。需要追溯时查审计页，不要以为没通知就等于没记录。
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

/**
 * 登录成功回调。
 * 曾用于「新 IP 登录」提醒，现按运营要求移除；保留空实现是为了不改动
 * auth.ts 的调用点，将来若要恢复某种登录成功侧信号，在这里加即可。
 */
export function recordLoginSuccess(_username: string, _ip: string | undefined) {
  // 有意留空：不再推送新 IP 登录提醒。登录仍写审计日志（auth.ts 的 LOGIN 条目）。
}

// ===== 2. HTTP 异常（429 滥用 / 5xx 突增） =====

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
