/**
 * 账户离场记录 —— 追踪已不在任何被管理组织内的账户。
 *
 * 为什么需要：账户被移出组织后，Organizations ListAccounts 立即不再返回它，
 * 平台的账户缓存下一轮就没了，但它遗留的数据（region_data 等）仍在库里，
 * 表现为「未知组织」的孤儿记录，也无从追溯这个账户曾经是谁、什么时候走的。
 *
 * 关键难点是避免误判。`listAccounts()` 对假设失败的 payer 是静默 skip 的
 * （aws-service.ts 里 `catch { skip failed payer }`），所以「从缓存消失」
 * 有两种完全不同的原因：
 *   1. 账户真的被移出组织  → 应该记录
 *   2. 该 payer 这一轮同步失败 → 该组织所有账户都会消失，绝不能记录
 * 判据：只有当同组织仍有其他账户存活时，才认为消失的那些是真的离开了。
 * 一个组织的账户整体归零，一律判为同步失败并跳过。
 */
import { db } from './db';

/**
 * 已查证的历史离场记录（首次补录用）。
 * 这批账户在本模块上线前就已离开，缓存里查不到归属，
 * 下列信息来自各原组织管理账户的 CloudTrail RemoveAccountFromOrganization 事件。
 */
const KNOWN_DEPARTURES: Record<string, { payer: string; departedAt?: string; actor?: string; note?: string }> = {
  '266735800997': { payer: 'yanhuang5-global', departedAt: '2026-07-25T11:31:29Z', actor: 'ADFS-Admin/zzawsmanage@aws.com' },
  '911167918243': { payer: 'yanhuang5-global', departedAt: '2026-07-25T11:31:19Z', actor: 'ADFS-Admin/zzawsmanage@aws.com' },
  '509399618054': { payer: 'yanhuang5-global', departedAt: '2026-07-23T18:27:56Z', actor: 'ADFS-Admin/zzawsmanage@aws.com', note: '平台基础身份所在账户，移出后作为独立账户运行' },
  '842675992497': { payer: 'yanhuang5-global', departedAt: '2026-07-23T18:09:14Z', actor: 'ADFS-Admin/zzawsmanage@aws.com' },
  '250531684043': { payer: 'webby02', departedAt: '2026-08-05T14:53:16Z', actor: 'user/webby-admin' },
  '251335054976': { payer: 'yanhuang3-taoVolt', note: 'CloudTrail 仅见 2026-06-26 三次移出尝试均报 ConstraintViolationException，最终离开方式不明' },
  '312605973834': { payer: 'yanhuang3-taoVolt', note: 'CloudTrail 仅见 2026-06-12 移出尝试报 ConstraintViolationException，最终离开方式不明' },
};

export interface DepartedAccount {
  account_id: string;
  name?: string;
  email?: string;
  payer?: string;
  last_status?: string;
  joined_method?: string;
  last_seen_at?: string;      // 最后一次出现在账户缓存里的时间
  detected_at: string;        // 平台检测到其离开的时间
  departed_at?: string;       // 已查证的实际移出时间（若有）
  actor?: string;             // 已查证的操作者（若有）
  note?: string;
  source: 'detected' | 'backfill';
  had_region_data?: boolean;  // 是否遗留区域数据
  rejoined_at?: string | null; // 若后来重新加入，记录时间（不删记录，保留轨迹）
}

/**
 * 对比前后两次账户快照，找出真正离开的账户。
 * @param prev 上一次的账户缓存
 * @param curr 本次同步得到的账户列表
 */
export function diffDepartures(prev: any[], curr: any[]): { departed: any[]; skippedPayers: string[] } {
  if (!prev?.length || !curr?.length) return { departed: [], skippedPayers: [] };

  const currIds = new Set(curr.map(a => a.Id));
  const currPayerCount = new Map<string, number>();
  curr.forEach(a => {
    const p = a._payer || '';
    currPayerCount.set(p, (currPayerCount.get(p) || 0) + 1);
  });

  const departed: any[] = [];
  const skippedPayers = new Set<string>();

  for (const old of prev) {
    if (currIds.has(old.Id)) continue;
    const payer = old._payer || '';
    // 该组织本轮一个账户都没返回 → 判为 payer 同步失败，不算离开
    if (!currPayerCount.get(payer)) {
      skippedPayers.add(payer || '(无组织标记)');
      continue;
    }
    departed.push(old);
  }

  return { departed, skippedPayers: [...skippedPayers] };
}

/**
 * 记录本轮检测到的离场账户。在账户缓存被覆盖写入之前调用。
 */
export function recordDepartures(prev: any[], curr: any[]): { recorded: number; skippedPayers: string[]; rejoined: number } {
  const { departed, skippedPayers } = diffDepartures(prev, curr);

  // 重新加入的：此前记为离开、现在又出现在列表里
  const existing = db.getDepartedAccounts();
  const currIds = new Set(curr.map((a: any) => a.Id));
  const rejoinedRecords = existing
    .filter((r: any) => !r.rejoined_at && currIds.has(r.account_id))
    .map((r: any) => ({ ...r, rejoined_at: new Date().toISOString() }));

  const now = new Date().toISOString();
  const newRecords: DepartedAccount[] = departed.map((a: any) => {
    const known = KNOWN_DEPARTURES[a.Id];
    return {
      account_id: a.Id,
      name: a.Name,
      email: a.Email,
      payer: a._payer || known?.payer,
      last_status: a.Status,
      joined_method: a.JoinedMethod,
      last_seen_at: now,
      detected_at: now,
      departed_at: known?.departedAt,
      actor: known?.actor,
      note: known?.note,
      source: 'detected',
      had_region_data: db.getRegionData().some((r: any) => r.account_id === a.Id),
      rejoined_at: null,
    };
  });

  const all = [...newRecords, ...rejoinedRecords];
  if (all.length) db.upsertDepartedAccounts(all);

  if (newRecords.length) {
    console.log(`[Lifecycle] 检测到 ${newRecords.length} 个账户已离开组织: `
      + newRecords.map(r => `${r.account_id}(${r.payer || '?'})`).join(', '));
  }
  if (rejoinedRecords.length) {
    console.log(`[Lifecycle] ${rejoinedRecords.length} 个账户重新加入: ${rejoinedRecords.map((r: any) => r.account_id).join(', ')}`);
  }
  if (skippedPayers.length) {
    console.log(`[Lifecycle] 以下组织本轮无任何账户返回，判为同步失败已跳过（不记为离场）: ${skippedPayers.join(', ')}`);
  }

  return { recorded: newRecords.length, skippedPayers, rejoined: rejoinedRecords.length };
}

/**
 * 补录：把「有遗留数据但已不在账户缓存里」的账户登记进来。
 * 用于本模块上线前就已离开的账户 —— 它们不会再触发 diff 检测。
 */
export function backfillDepartures(): { added: number } {
  const { accounts } = db.getAccountsCache();
  if (!accounts?.length) return { added: 0 };

  const inCache = new Set(accounts.map((a: any) => a.Id));
  const existing = new Set(db.getDepartedAccounts().map((r: any) => r.account_id));

  // 目前唯一的遗留数据来源是 region_data；后续若有别的按账户存的数据可一并纳入
  const orphanIds = [...new Set(
    db.getRegionData()
      .map((r: any) => r.account_id)
      .filter((id: string) => id && !inCache.has(id) && !existing.has(id)),
  )];

  if (!orphanIds.length) return { added: 0 };

  const now = new Date().toISOString();
  const records: DepartedAccount[] = orphanIds.map(id => {
    const known = KNOWN_DEPARTURES[id];
    const rd = db.getRegionData().find((r: any) => r.account_id === id);
    return {
      account_id: id,
      payer: known?.payer,
      last_seen_at: rd?.updated_at,
      detected_at: now,
      departed_at: known?.departedAt,
      actor: known?.actor,
      note: known?.note || '本模块上线前已离开，信息据遗留数据补录',
      source: 'backfill',
      had_region_data: true,
      rejoined_at: null,
    };
  });

  db.upsertDepartedAccounts(records);
  console.log(`[Lifecycle] 补录 ${records.length} 个历史离场账户: ${orphanIds.join(', ')}`);
  return { added: records.length };
}

/** 供前端展示：离场账户列表 + 汇总 */
export function getDepartedSummary() {
  const all = db.getDepartedAccounts();
  const active = all.filter((r: any) => !r.rejoined_at);
  const byPayer: Record<string, number> = {};
  active.forEach((r: any) => {
    const k = r.payer || '(未知)';
    byPayer[k] = (byPayer[k] || 0) + 1;
  });
  return {
    total: active.length,
    rejoined: all.filter((r: any) => r.rejoined_at).length,
    byPayer,
    records: [...all].sort((a: any, b: any) =>
      String(b.departed_at || b.detected_at).localeCompare(String(a.departed_at || a.detected_at))),
  };
}
