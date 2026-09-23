# requirements.md — POC Cash 客户主体误填防护

## 目标

消除 POC Cash「创建商机」表单里**诱导填错客户法人主体**的两个来源，避免再次出现
`Korea Wallpaper (KL) Sdn Bhd` 这类错主体一路复制到 AWS 商机与 POC 资金申请的事故。

## 背景（事故经过）

2026-09-23，合作方 SY Siow 指出 Korea Wallpaper 的商机与 funding request 应使用
`Korea Wallpaper (HQ) Sdn Bhd`，而非 `Korea Wallpaper (KL) Sdn Bhd`。

实测结果：5 条 Korea Wallpaper 商机（O23557918 / O28604112 / O28666335 / O28666851 /
O28666903）客户公司名**全部**是 `(KL)`。其中只有仍处 `Pending Submission` 的
O28666851 能改，其余 4 条以及资金申请 `benappl-vsstxyhcytp31d` 均被 AWS 锁死：

- 商机：`ACTION_NOT_PERMITTED customer.account.companyName is not editable if status is Approved`
- 资金申请：`ConflictException: UpdateBenefitApplication is not allowed ... in IN_REVIEW status`
  以及 `Field path 'Name' is not amendable for this benefit`

**结论：填错一旦提交给 AWS 就不可逆。** 所以防线必须前移到填写阶段。

## 错误的两个来源

1. **placeholder 拿真实客户当示例** —— `PocCash.tsx:1150` 的「客户公司全称」输入框
   placeholder 字面写着 `Korea Wallpaper (KL) Sdn Bhd`；`PocCash.tsx:1193` 的商机名称
   placeholder 同样用了真实客户名。
2. **「参考已有商机」静默带入客户名** —— `applyTemplate()`（`PocCash.tsx:186`）会把来源
   商机的 `companyName` 直接写进表单。这是**刻意设计**（同一客户做新项目要复用客户信息），
   但来源本身错了就会无声传播。这正是 (KL) 从 7 月的 O23557918 一路复制到 9 月 4 条的路径。

## 使用者与角色

POC Cash 页面（`poccash`）**仅 `role === 'admin'` 可见**，没有对应权限字段，勾选也授不了。
本需求不改变任何权限模型。

## 范围内

- 把两处 placeholder 换成中性示例，不再用真实客户名当样板
- 套用过模板时，在「客户公司全称」字段下给出核对提示
- **切换 Partner 主体时清理模板带入的残留**（见下）
- 把回归测试里钉死的 `(KL)` 样例换成 `(HQ)`

### 第三项的由来

方案复核时发现：切换「Partner 主体」下拉只重载 Solution 与商机列表
（`PocCash.tsx:160-177` 的 useEffect），**完全不碰表单**。于是切换后：

- `refFrom` 仍指向上一个主体名下的商机 ID，「已套用 X 的信息」提示与本次新增的核对
  提示都会显示一个在新主体里根本不存在的 ID
- 表单里残留着上一个主体带入的 `companyName` 等客户信息 —— 这正是本需求要防的
  「错客户名无声传播」
- `solutionId` 残留得更糟：它是**旧主体目录里的 Solution**，新主体的下拉选项里没有这一项

页面自己的文案（`PocCash.tsx:1137`）写着「切换主体会同时切换 Solution 与商机列表
（各主体数据互相隔离）」，但实际并没有隔离表单数据。属既有缺陷，本次一并修。

## 明确不做

- **不改 `applyTemplate()` 的带入行为本身** —— 带出客户信息是刻意设计，删掉是功能倒退
- **不加客户名黑名单硬编码** —— 讨论中评估过，把具体客户写进代码后续要维护，否决
- 不做强制校验 / 不阻断提交 —— 提示是核对提醒，不是错误
- 不动后端、不动 AWS 链路、不动权限、不动 `data/db.json`
- 不修复历史数据（4 条商机 + 1 条资金申请已被 AWS 锁死，需走 AWS 侧人工处理）
- 不处理 7 月的 O23557918（仍是 `(KL)`，Approved 状态改不动）

## 验收标准

- [ ] `web/client/src/pages/PocCash.tsx` 中 `grep -c "Korea Wallpaper"` 返回 `0`
- [ ] 「创建商机」页未套用模板时，「客户公司全称」下方**不显示**核对提示
- [ ] 在「参考已有商机」选中任一商机后，「客户公司全称」下方显示含来源商机 ID 的核对提示
- [ ] 点击已有的「知道了」按钮清除 `refFrom` 后，该提示随之消失
- [ ] 套用模板后切换「Partner 主体」：核对提示与「已套用 X 的信息」Alert 同时消失，
      客户公司全称 / 行业 / 客户网址 / 邮编 / 业务描述 / 关联 Solution 被清空，
      国家回到 `MY`、Use Case 回到 `Migration / Database Migration`、
      Marketing 两项回到 `None` / `No`，并弹出一条切换提示
- [ ] **未**套用过模板时切换「Partner 主体」：表单里用户手填的内容**不被清空**
- [ ] `cd web && npm test` 全绿（含 `tests/poc-cash.test.ts`）
- [ ] `cd web && npm run typecheck` 无报错
- [ ] `cd web && npx vite build --config client/vite.config.ts` 构建通过

## 已知约束

- 后端 tsx 直跑不编译，类型错误不会在运行时暴露 —— 前端改动必须靠 `vite build` 验证
- 前端样式规范见 `.kiro/steering/coding-standards.md`：颜色只用 `var(--color-*)`，
  不用 emoji 当图标，成功文案不加感叹号
