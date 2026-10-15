# MAP 标签部署最小权限化（首发 taoVolt）— 需求纪要

## 背景（2026-10-15 只读排查结论）

taoVolt（payer `724772095868`，ACTIVE 成员 133 个）打 tag 部署失败：
`support-quota/web-103259692075 is not authorized to perform: ec2:DescribeRegions`。

- 区域发现（`tag-compliance.ts` `getMemberEnabledRegions`）对每个成员用 `assumeToAccount` + `ec2:DescribeRegions`，
  且 `Promise.all` 一个失败整体失败。两个受限账户（`103259692075`、`359994326596`，名 tor）的收窄策略
  没有 `ec2:DescribeRegions`（只有 `account:ListRegions`）；`623581626210` 完全进不去。
- 实测 `account:ListRegions` 在 132/133 个成员上可用（含两个受限账户）。
- 成员 `AutoTaggerRole` StackSet 是**按旧 README 手工建的**：信任旧中央账户 `211125508317`，
  现中央是 `382309211956` → 当前中央**无法打标**。平台 `provisionOrg` 只按名字判断「已存在」就跳过，未发现参数错误。
- 打标模板权限偏宽：`apigateway:GET/PATCH` 作用于 `arn:aws:apigateway:*::*`（可改 API 配置）、含未使用的
  `tag:GetResources`、写标签不限 key。
- payer `auto-tagger-role`（平台 10-12 创建）挂了托管 `ReadOnlyAccess`（可读 S3 对象等业务数据），中央打标代码只调 `TagResources`。
- payer `resource-explorer-search-role` 信任中央账户 root 无条件，挂 `AWSOrganizationsReadOnlyAccess` + `AWSResourceExplorerReadOnlyAccess`；
  中央 `search_handler` 实际只调 `resource-explorer-2:ListResources` 与 `organizations:ListAccounts`。
- taoVolt 另有 `tagger-iam-role`（AWS「MAP Tagger Solution」样例）、Quick Setup Resource Explorer 等既有资源。

## 目标

按最小权限原则重新部署 taoVolt 的 MAP 标签（`map-migrated = migT0O0U93ZQY`），中央 `382309211956` 能给全部可达成员打标，
**两个受限账户也要打**。

## 使用者与角色

MAP 标签页「全自动接入」与「一键接入」，现有守卫 `requireStrictAdmin`，不变。

## 范围内（用户 2026-10-15 确认）

1. 成员 `auto-tagger-role` 模板最小化：信任改为当前中央；去掉 `tag:GetResources`；API Gateway 只留标签路径 PUT/POST；
   新增 `aws:TagKeys` 限制（允许 `map-migrated` + 组织额外标签 key），以 StackSet 参数控制，**先在一个账户开启实测，再全量开启**。
2. 已存在的 `AutoTaggerRole` StackSet：模板或参数不符时**原地更新**，不再按名字跳过。
3. payer `auto-tagger-role`：去掉 `ReadOnlyAccess`；权限与成员模板同源。
4. payer `search-role`：信任加 `aws:PrincipalArn` 条件；两个托管只读策略换成最小内联策略。
5. 区域发现改用 `account:ListRegions`；单个账户失败记录并跳过，不再整体失败。
6. 首发只对 taoVolt 执行；其它 payer 之后逐个重跑接入推广。

## 明确不做

- 不动 `tagger-iam-role`（归属未确认，只报告）。
- 不改中央 SAM 的 `FixWrongValues`（保持改写现有值）。
- 不修 `623581626210` 无法进入的问题（单独排查），本次只在结果中列出。
- 不更新其它 payer；不改受限账户的 `support-quota` 收窄策略；不改中央 RE-AUTOTAG 代码。

## 验收标准

- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿（含新增测试）。
- [ ] taoVolt 全自动接入（tag 值 `migT0O0U93ZQY`）跑到 `completed`；结果中列出不可达账户 `623581626210`。
- [ ] 只读核验：taoVolt `AutoTaggerRole` 参数 `CentralToolingAccountId=382309211956`，模板与平台模板一致；
      成员（含 `103259692075`、`359994326596`）的 `auto-tagger-role` 信任中央 `382309211956` 的 `tag-compliance*`。
- [ ] 只读核验：payer `auto-tagger-role` 无 `ReadOnlyAccess`；`search-role` 无两个托管策略、有 `SearchPolicy` 内联与 PrincipalArn 条件。
- [ ] 中央手动扫描 taoVolt 后，两个受限账户的资源被打上 `map-migrated=migT0O0U93ZQY`。
- [ ] TagKeys 实测：在一个成员账户开启后扫描，该账户打标失败数不增加；之后全量开启。
