import type { RootEmailAccount } from '../api';

export function matchRootAccountImport(ids: string[], accounts: RootEmailAccount[]) {
  const matched: RootEmailAccount[] = [];
  const rejected: Array<{ accountId: string; reason: string }> = [];
  for (const accountId of new Set(ids)) {
    const candidates = accounts.filter(account => account.accountId === accountId);
    if (candidates.length !== 1) {
      rejected.push({ accountId, reason: candidates.length ? '账户缓存存在重复记录' : '未找到可管理的成员账户' });
    } else if (!candidates[0].eligible) {
      rejected.push({ accountId, reason: candidates[0].state !== 'ACTIVE' ? `账户状态为 ${candidates[0].state}` : '缺少有效 Root 邮箱' });
    } else matched.push(candidates[0]);
  }
  return { matched, rejected };
}

export function filterRootAccounts(accounts: RootEmailAccount[], payer: string, search: string,
  selectedOnly: boolean, selected: string[]) {
  const term = search.trim().toLowerCase();
  return accounts.filter(account => (!payer || account.payerAccountId === payer)
    && (!selectedOnly || selected.includes(account.accountId))
    && `${account.accountId} ${account.name} ${account.email}`.toLowerCase().includes(term));
}
