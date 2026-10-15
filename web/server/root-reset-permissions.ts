import type { RequestHandler } from 'express';

export type RootResetAccess = 'none' | 'view' | 'operate';
type PermissionUser = { role?: string; root_reset_access?: unknown };
type CurrentUser = PermissionUser & { id: number | string; username: string };

export function isRootResetAccess(value: unknown): value is RootResetAccess {
  return value === 'none' || value === 'view' || value === 'operate';
}

/** Separate from root_access: granting this feature never grants Admin credentials or MFA deletion. */
export function resolveRootResetAccess(user?: PermissionUser | null): RootResetAccess {
  if (user?.role === 'admin') return 'operate';
  if (!user || !['viewer', 'partadmin'].includes(user.role || '')) return 'none';
  return isRootResetAccess(user.root_reset_access) ? user.root_reset_access : 'none';
}

export function canManageRootEmailJob(user: PermissionUser & { id: number | string },
  job: { createdByUserId: string; origin?: unknown }): boolean {
  return job.origin === undefined && resolveRootResetAccess(user) === 'operate'
    && (user.role === 'admin' || String(user.id) === job.createdByUserId);
}

/** Non-admin users can only see jobs they created; admin visibility is global. */
export function canViewRootEmailJob(user: PermissionUser & { id: number | string },
  job: { createdByUserId: string; origin?: unknown }): boolean {
  return job.origin === undefined && (user.role === 'admin' || String(user.id) === job.createdByUserId);
}

/** Reset links are owner-only credentials; admin task-management authority never overrides ownership. */
export function canRetrieveRootEmailManualLink(user: PermissionUser & { id: number | string },
  job: { createdByUserId: string; origin?: unknown }): boolean {
  return job.origin === undefined && resolveRootResetAccess(user) === 'operate' && String(user.id) === job.createdByUserId;
}

/** Re-read identity and permission on every request, including link retrieval. */
export function createRootResetGuard(readUser: (username: string) => CurrentUser | undefined | null): RequestHandler {
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = (req as any).user;
    const user = token?.username ? readUser(token.username) : null;
    if (!user || String(user.id) !== String(token?.userId) || user.username !== token?.username) {
      res.status(401).json({ error: '用户身份已变更，请重新登录' }); return;
    }
    const access = resolveRootResetAccess(user);
    if (access === 'none' || (!['GET', 'HEAD'].includes(req.method) && access !== 'operate')) {
      res.status(403).json({ error: access === 'view' ? '仅有批量重置查看权限，无法执行此操作' : '未授予批量重置 Root 密码权限' }); return;
    }
    res.locals.rootResetUser = user;
    next();
  };
}
