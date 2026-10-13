# 任务拆分 —— admin-console-on-demand

> 前置：`design.md` 已通过闸门 G1（2026-10-13）。所有任务的唯一依据是同目录 `design.md`。
> 拆分时为保证文件所有权互斥：测试拆为三个文件；`unmarkRestricted` 的 `requestedBy` 改为可选参数（均已回写 design.md，不改行为）。
> 执行方式：协调会话不在 Orca 托管终端内，按用户既定偏好由 Claude 按本表边界与顺序直接实现、逐任务提交，完成后派独立审核子代理。
>
> **实际执行记录**：T1 `2922f4e` → T3 `88886f8` → T2 `2ab7c33` → T4 `59a9283` → T5 `39f9507` → 审核修复 `c7a396a`。
> T3 先于 T2 提交：`routes/aws.ts`（T2）向 `unmarkRestricted` 传入 T3 新增的可选参数，按原顺序 T2 单独提交无法通过类型检查；两个提交文件仍互不重叠。
> 审核修复跨多个任务的文件（协调者在 P4 统一修复），内容见 design.md §11。

| # | 任务名 | 独占文件 | 依赖 | design.md 章节 | 验收命令 |
|---|--------|----------|------|----------------|----------|
| T1 | 临时开通核心 + 存储 | `web/server/temp-admin.ts`（新）<br>`web/server/db.ts`<br>`web/tests/temp-admin.test.ts`（新） | — | §4 §5.1 §5.8 §7 §8（用例 1–9、Review Focus 2–5） | `cd web && node --import tsx --test tests/temp-admin.test.ts && npm test && npm run typecheck` |
| T2 | 后端接线：Admin 链路 / 自愈 / 调度 / 路由 | `web/server/aws-service.ts`<br>`web/server/bedrock-tools.ts`<br>`web/server/account-roles.ts`<br>`web/server/notify.ts`<br>`web/server/scheduler.ts`<br>`web/server/routes/aws.ts`<br>`web/tests/temp-admin-chain.test.ts`（新） | T1 | §5.2 §5.3 §5.4 §5.6 §5.7 §5.9 §6 §8（account-roles 判定、凭证时长） | `cd web && node --import tsx --test tests/temp-admin-chain.test.ts tests/restricted-admin-access.test.ts tests/apn-accounts.test.ts tests/audit-middleware.test.ts && npm test && npm run typecheck` |
| T3 | 敏感权限账户适配 | `web/server/restricted-accounts.ts`<br>`web/tests/restricted-admin-access.test.ts` | T1 | §5.5 §8（restricted 修改与新增、Review Focus 1） | `cd web && node --import tsx --test tests/restricted-admin-access.test.ts && npm test && npm run typecheck` |
| T4 | 组织脚本：去掉 admin 模式 + 存量清理脚本 | `web/scripts/setup-org-stacksets.ts`<br>`web/scripts/remove-orgwide-admin-console.ts`（新） | — | §5.10 §5.11 | 见下「T4 验收」 |
| T5 | 前端：开通弹窗 / 倒计时 / 引导 / 凭证时长 | `web/client/src/components/TempAdminModal.tsx`（新）<br>`web/client/src/api.ts`<br>`web/client/src/pages/Accounts.tsx`<br>`web/client/src/components/RootCredentialsPanel.tsx` | —（只依赖 §5.9 的接口契约） | §5.12 | `cd web && npm run typecheck && npx vite build --config client/vite.config.ts`；页面验收在 P6 |

### T4 验收

```bash
cd web
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck --target es2022 --module commonjs --moduleResolution node \
  scripts/setup-org-stacksets.ts scripts/remove-orgwide-admin-console.ts
npx tsx scripts/setup-org-stacksets.ts admin 2>&1 | grep -q "按需临时开通"     # admin 模式已移除
npx tsx scripts/remove-orgwide-admin-console.ts 2>&1 | grep -q "用法"           # 未指定 --payer/--all 时打印用法并退出
```

联网 dry-run 与 `--execute` 由协调者在 P6 于 EC2 执行（G4 单独确认），**本地不得对真实组织运行 `--execute`**。

## 波次

- **波次 1**：T1、T4、T5（互不依赖）
- **波次 2**：T2、T3（依赖 T1）
- 实际执行（Claude 直接实现，串行）：T1 → T2 → T3 → T4 → T5，每个任务单独提交并跑自己的验收；
  全部完成后集成分支全量 `npm test && npm run typecheck && npm run build`，再派独立审核

依赖链深度 1。

## 必须点名的约束

- **T1 / T3**：`temp-admin.ts` 不得 import `aws-service` / `restricted-accounts` / `account-roles`（循环依赖）
- **T3**：高危区 —— 取消标记仍保持「先恢复 support-quota、最后删记录」；`getExcludedAccountIds()` 不改；
  只认 `AccessDenied` 为「已删除」，网络错误不得当作成功
- **T2**：新路由注册在 `/accounts/:id/detail` 之前；`requireStrictAdmin` 是实时校验 admin 的守卫（`requireAdmin` 会放行 partadmin，不能用）
- **T4**：清理脚本默认 dry-run；CSV 数字不加千分位；不读写 `data/`
- **T5**：只用 AntD 语义色 / `var(--color-*)`，无 hex、无 emoji，成功提示无感叹号
- **全部**：不改 `version.ts`、`README.md`、`.kiro/steering/**`、`config*.json`、`data/**`；只 add 具体文件

## 拆分检查清单

- [x] `design.md` 已通过闸门 G1
- [x] 每个任务都能指到 `design.md` 的具体章节
- [x] `design.md` 每一节都被覆盖：§4/§5.1/§5.8→T1，§5.2–5.4/§5.6/§5.7/§5.9/§6→T2，§5.5→T3，§5.10/§5.11→T4，§5.12→T5，§7/§8 分摊到 T1/T2/T3（§1–3、§9–10 说明性）
- [x] 任意两个任务的独占文件无交集
- [x] 枢纽文件：`routes/aws.ts`、`aws-service.ts`、`db.ts` 分属 T2/T2/T1；`api.ts` 只在 T5；同一波次内每个枢纽文件只有一个持有者
- [x] 协调者独占文件不在任何任务里
- [x] 每个任务有可执行的验收命令
- [x] 依赖链深度 1
- [x] 每个任务基于集成分支（含依赖）可独立通过 `npm test`
- [x] 不涉及 root-email 模块
- [x] 涉及高危区的 T3 已点名具体约束
