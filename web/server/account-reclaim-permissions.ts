/**
 * 账户回收独立权限 `account_reclaim_access`（design.md §5.2）。
 *
 * 只有 none / operate 两档，admin 恒 operate。授予它不隐含 cleanup 页、root_access 或 root_reset_access。
 */
import type { RequestHandler } from 'express';
import type { AccountReclaimAccess, AccountReclaimActor, AccountReclaimJob } from './account-reclaim-core';

export function isAccountReclaimAccess(value: unknown): value is AccountReclaimAccess {
  return value === 'none' || value === 'operate';
}

export function resolveAccountReclaimAccess(
  user?: { role?: string; account_reclaim_access?: unknown } | null,
): AccountReclaimAccess {
  if (user?.role === 'admin') return 'operate';
  if (!user || !['viewer', 'partadmin'].includes(user.role || '')) return 'none';
  return isAccountReclaimAccess(user.account_reclaim_access) ? user.account_reclaim_access : 'none';
}

const ownsOrAdmin = (user: AccountReclaimActor, createdByUserId: string) =>
  user.role === 'admin' || String(user.id) === createdByUserId;

/** Every read requires operate; non-admin users only see their own jobs. */
export function canViewAccountReclaimJob(user: AccountReclaimActor, job: Pick<AccountReclaimJob, 'createdByUserId'>): boolean {
  return resolveAccountReclaimAccess(user) === 'operate' && ownsOrAdmin(user, job.createdByUserId);
}

export function canManageAccountReclaimJob(user: AccountReclaimActor, job: Pick<AccountReclaimJob, 'createdByUserId'>): boolean {
  return resolveAccountReclaimAccess(user) === 'operate' && ownsOrAdmin(user, job.createdByUserId);
}

/**
 * Root jobs created by account reclaim. The bridge must still verify the db link; origin alone never grants access.
 */
export function canManageAccountReclaimRootJob(
  user: AccountReclaimActor,
  job: { origin?: unknown; reclaimJobId?: unknown; createdByUserId: string },
): boolean {
  return job.origin === 'account-reclaim' && typeof job.reclaimJobId === 'string' && job.reclaimJobId.length > 0
    && resolveAccountReclaimAccess(user) === 'operate' && ownsOrAdmin(user, job.createdByUserId);
}

/** Re-read identity and permission on every request, including GET/HEAD. */
export function createAccountReclaimGuard(
  readUser: (username: string) => AccountReclaimActor | undefined | null,
): RequestHandler {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = (req as any).user;
    const user = token?.username ? readUser(token.username) : null;
    if (!user || String(user.id) !== String(token?.userId) || user.username !== token?.username) {
      res.status(401).json({ error: '用户身份已变更，请重新登录' }); return;
    }
    if (resolveAccountReclaimAccess(user) !== 'operate') {
      res.status(403).json({ error: '未授予账户回收权限' }); return;
    }
    res.locals.accountReclaimUser = user;
    next();
  };
}
