# MAP 标签部署最小权限化（首发 taoVolt）— 实现方案

## 1. 需求与验收

承接 `requirements.md`：把平台下发到客户组织的打标/搜索角色收紧到最小权限，已存在但不合规的 `AutoTaggerRole`
StackSet 原地更新；区域发现改用 `account:ListRegions` 并容忍单账户失败，使两个受限账户也能被打标。
代码上线后只对 taoVolt（`724772095868`，tag 值 `migT0O0U93ZQY`）执行。

验收：
- [ ] `cd web && npm test -- tests/tag-least-privilege.test.ts tests/tag-compliance-policy.test.ts` 通过
- [ ] `cd web && npm test && npm run typecheck && npm run build` 全绿
- [ ] 第 12 节运行手册执行后，第 5 步只读核验的输出全部符合预期

## 2. 现状分析

`web/server/tag-compliance.ts`：
- `AUTO_TAGGER_ROLE_TEMPLATE`（L592-776）：参数只有 `CentralToolingAccountId`；一个大 Statement（`tag:TagResources`、`tag:GetResources`
  + ~135 个服务打标 Action，`Resource: "*"`）；两条 apigateway 语句（PUT/POST/DELETE/GET 于 `arn:aws:apigateway:*::/tags/*`，
  GET/PATCH 于 `arn:aws:apigateway:*::*`）。
- `provisionOrg(payerAccountId)`（L804-1038）步骤：org → RE 服务访问 → payer 聚合索引 → OrgView → search-role（L918-963，
  信任 central root 无条件，挂两个托管只读）→ AutoTaggerRole StackSet（L965-1015，**按名字存在即跳过**）→ payer tagger（L1017-1035）。
- `AUTO_TAGGER_INLINE_POLICY()`（L1050-1066）：用正则 `^\s+- ([a-z0-9-]+:[A-Za-z*]+)$` 从模板解析 Action，排除 apigateway，
  再拼一条 apigateway 语句。`tests/tag-compliance-policy.test.ts` 锁定其结构。
- `ensurePayerTaggerRole(creds, central)`（L1076-1112）：不存在则建 + 挂 `ReadOnlyAccess`；每次覆盖写 `AutoTagPolicy`。
- `getMemberEnabledRegions(payerAccountId)`（L1813-1860）：Organizations 列 ACTIVE 成员，5 个一批 `Promise.all`，
  `assumeToAccount` + `ec2:DescribeRegions`；任何一个抛错整体抛错。返回 `Record<accountId, regions[]>`。
- `getOrgEnabledRegions`（L1862-1898）调用它，路由 `routes/aws.ts` L369、L414 使用。
- 中央账户：`centralAccountId()` 由 `config.tagCompliance.roleArn` 解析，生产为 `382309211956`。

`web/server/tag-onboarding.ts`：`runProvision`/`runWaitManagementIndex` 调 `provisionOrg`（pending → 留在
`wait_management_index` 轮询，45 分钟超时）；`runDeployReIndexes`（L274-345）调 `getMemberEnabledRegions`，结果写入
`artifacts.memberEnabledRegions`，后续 `wait_stacksets`/`verify` 只核验该矩阵里的账户。

`web/server/db.ts` L223-231：`TagOnboardingJob.artifacts` 类型。

中央 RE-AUTOTAG（不在本仓库，不改）：`search_handler` 只用 `resource-explorer-2:ListResources`（OrgView）与
`organizations:ListAccounts`；`tag_handler` 只用 `resourcegroupstaggingapi.tag_resources`。中央 Lambda 角色由 SAM 栈
`tag-compliance-prod` 生成，名称以 `tag-compliance` 开头。

## 3. 方案总览

```
全自动接入 job ──runProvision──▶ provisionOrg(payer, { allowedTagKeys })
   ├─ search-role：信任加 PrincipalArn 条件；内联 SearchPolicy；摘掉两个托管只读
   ├─ AutoTaggerRole StackSet：resolveAutoTaggerParams → autoTaggerDrift
   │     有差异 → UpdateStackSet（新模板 + 参数）→ pending，job 轮询直到一致
   └─ payer auto-tagger-role：信任对齐、AutoTagPolicy（同源 + 同一 EnforceTagKeys）、摘 ReadOnlyAccess
   ──runDeployReIndexes──▶ getMemberEnabledRegions → { regions, unreachable }
         unreachable 写入 artifacts 并跳过；其余流程不变
运维（第 12 节）：tag-keys-canary.ts 对单账户开启 EnforceTagKeys → 中央扫描验证 → --all 全量开启
```

## 4. 数据模型变更

- `data/db.json`：`tag_onboarding_jobs[].artifacts` 新增可选字段 `unreachableAccounts?: Array<{ accountId: string; error: string }>`。
  老任务没有该字段，读出为 `undefined`，不迁移。
- `config.json`：无变更。

## 5. 后端设计 — `web/server/tag-compliance.ts`（修改）

### 5.1 新的成员模板 `AUTO_TAGGER_ROLE_TEMPLATE`

整体替换为下面的结构。**服务打标 Action 列表沿用现有模板 L626-758 的全部行，只删除 `tag:GetResources` 一行**；
每个 Action 行保持 `                  - service:Action` 的缩进格式（解析正则依赖它）。

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: >
  IAM role for the central MAP tag-compliance auto-tagger (managed by AWSTool).
  Least privilege: tag-write actions only. Deploy to ONE region per account (IAM is global).

Parameters:
  CentralToolingAccountId:
    Type: String
    Description: Account ID of the central tooling account where the tagger Lambda runs
  AllowedTagKeys:
    Type: CommaDelimitedList
    Default: map-migrated
    Description: Tag keys the role may write when EnforceTagKeys is true
  EnforceTagKeys:
    Type: String
    Default: "false"
    AllowedValues: ["true", "false"]
    Description: Restrict writes to AllowedTagKeys via aws:TagKeys

Conditions:
  EnforceTagKeys: !Equals [!Ref EnforceTagKeys, "true"]

Resources:
  AutoTaggerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: auto-tagger-role
      Description: Central MAP tag-compliance auto-tagger (managed by AWSTool)
      AssumeRolePolicyDocument:            # 与现模板相同：Principal central root + StringLike aws:PrincipalArn role/tag-compliance*
        ...
      Policies:
        - PolicyName: AutoTagPolicy
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Sid: TagWrite
                Effect: Allow
                Action:
                  - tag:TagResources
                  - ec2:CreateTags
                  ...                       # 现有服务打标 Action 全部保留（删 tag:GetResources）
                  - glacier:TagResource
                Resource: "*"
                Condition: !If
                  - EnforceTagKeys
                  - "ForAllValues:StringEquals":
                      "aws:TagKeys": !Ref AllowedTagKeys
                  - !Ref "AWS::NoValue"
              - Sid: ApiGatewayTagWrite
                Effect: Allow
                Action:
                  - apigateway:PUT
                  - apigateway:POST
                Resource:
                  - "arn:aws:apigateway:*::/tags/*"
                Condition: !If
                  - EnforceTagKeys
                  - "ForAllValues:StringEquals":
                      "aws:TagKeys": !Ref AllowedTagKeys
                  - !Ref "AWS::NoValue"
      Tags:
        - Key: Purpose
          Value: AutoTagger
        - Key: ManagedBy
          Value: AWSTool
```

删除：`tag:GetResources`；apigateway 的 `DELETE`、`GET`；整条 `arn:aws:apigateway:*::*` 的 GET/PATCH 语句。
`ForAllValues:StringEquals` 在请求不带 `aws:TagKeys` 时判为真（如 `s3:GetBucketTagging`），因此不会误伤 TagResources 内部的读取调用。

### 5.2 纯函数（全部 export，供测试）

```ts
export const MAP_TAG_KEY = 'map-migrated';   // 已存在则复用，不重复定义

/** ['map-migrated', extra?]，去重、去空白；extra 等于 map-migrated 时忽略 */
export function normalizeAllowedTagKeys(extraTagKey?: string): string[]

export interface AutoTaggerParams {
  CentralToolingAccountId: string;
  AllowedTagKeys: string;          // 逗号分隔
  EnforceTagKeys: 'true' | 'false';
}
type CfnParam = { ParameterKey?: string; ParameterValue?: string };

/**
 * requestedKeys 有值 → 用它；否则沿用 existing 里的 AllowedTagKeys；都没有 → 'map-migrated'。
 * EnforceTagKeys 只沿用 existing（'true'/'false'），否则 'false' —— 由运维脚本切换，重跑接入不改它。
 */
export function resolveAutoTaggerParams(
  central: string, requestedKeys: string[] | undefined, existing: CfnParam[] | undefined,
): AutoTaggerParams

/** 返回差异说明列表，[] 表示一致。模板按 trim 后全文比较。 */
export function autoTaggerDrift(
  current: { TemplateBody?: string; Parameters?: CfnParam[] }, desired: AutoTaggerParams,
): string[]
```
`autoTaggerDrift` 文案：模板不同 → `'模板不是平台当前的最小权限版本'`；参数不同 → ``${key}: ${旧值 || '(无)'} → ${新值}``，按
`CentralToolingAccountId`、`AllowedTagKeys`、`EnforceTagKeys` 顺序。

```ts
/** 中央 tag-compliance* 角色专用信任（payer tagger 与 search-role 共用） */
export function buildCentralTrust(central: string): object
//  { Version, Statement: [{ Effect:'Allow', Principal:{ AWS:`arn:aws:iam::${central}:root` }, Action:'sts:AssumeRole',
//    Condition:{ StringLike:{ 'aws:PrincipalArn': `arn:aws:iam::${central}:role/tag-compliance*` } } }] }

export function buildSearchRolePolicy(payerAccountId: string): object
//  { Version:'2012-10-17', Statement:[
//    { Sid:'ListOrgViewResources', Effect:'Allow', Action:['resource-explorer-2:ListResources'],
//      Resource:`arn:aws:resource-explorer-2:*:${payerAccountId}:view/OrgView/*` },
//    { Sid:'ListOrgAccounts', Effect:'Allow', Action:['organizations:ListAccounts'], Resource:'*' } ] }

/** account:ListRegions 结果 → 已启用区域（ENABLED / ENABLED_BY_DEFAULT），排序 */
export function enabledRegionsFromListRegions(
  regions: Array<{ RegionName?: string; RegionOptStatus?: string }>,
): string[]

/** 信任策略比较：两边 JSON.parse（GetRole 返回的是 URL 编码字符串，先 decodeURIComponent）后做深比较 */
export function samePolicyDocument(a: unknown, b: unknown): boolean
```

`AUTO_TAGGER_INLINE_POLICY` 改为：
```ts
export function AUTO_TAGGER_INLINE_POLICY(
  opts: { allowedTagKeys?: string[]; enforceTagKeys?: boolean } = {},
): { Version: string; Statement: object[] }
```
- 解析正则与 apigateway 过滤不变。
- Statement[0]：`{ Sid:'TagWrite', Effect:'Allow', Action:<解析结果>, Resource:'*' }`
- Statement[1]：`{ Sid:'ApiGatewayTagWrite', Effect:'Allow', Action:['apigateway:PUT','apigateway:POST'], Resource:['arn:aws:apigateway:*::/tags/*'] }`
- `opts.enforceTagKeys === true` 时，两条都加 `Condition: { 'ForAllValues:StringEquals': { 'aws:TagKeys': opts.allowedTagKeys ?? ['map-migrated'] } }`。

### 5.3 `provisionOrg` 改动

签名：
```ts
export interface ProvisionOptions { /** 接入任务传入；手工「一键接入」不传则沿用 StackSet 现值 */ allowedTagKeys?: string[] }
export async function provisionOrg(payerAccountId: string, opts: ProvisionOptions = {}): Promise<ProvisionResult>
```
新增 import：`DetachRolePolicyCommand`、`UpdateAssumeRolePolicyCommand`（client-iam）；`UpdateStackSetCommand`、
`ListStackSetOperationsCommand`（client-cloudformation，若未导入）。

**步骤 4 search-role**（替换 L918-963 主体，step key/label 不变）：
1. 不存在 → `CreateRole`，`AssumeRolePolicyDocument = buildCentralTrust(central)`（其余参数同现状）。
2. 存在 → `GetRole`，若 `!samePolicyDocument(decode(doc), buildCentralTrust(central))` → `UpdateAssumeRolePolicy`。
3. `PutRolePolicy({ RoleName: SEARCH_ROLE_NAME, PolicyName: 'SearchPolicy', PolicyDocument: buildSearchRolePolicy(payerAccountId) })`。
4. **之后**再 `DetachRolePolicy` 掉已挂的 `AWSResourceExplorerReadOnlyAccess`、`AWSOrganizationsReadOnlyAccess`（先加后摘，避免中间无权限）。
5. status：新建 `created`；有任何变更（信任更新/摘策略）→ `created` 且 detail 列出变更；否则 `skipped`。不设 pending。

**步骤 5 AutoTaggerRole StackSet**（替换 L965-1015 主体）：
1. 不存在 → `desired = resolveAutoTaggerParams(central, opts.allowedTagKeys, undefined)`，`CreateStackSet`（同现状，
   Parameters 改为 desired 三项）；后续「无实例则 CreateStackInstances」逻辑不变。
2. 存在 → `DescribeStackSet` 拿 `TemplateBody`/`Parameters`；`desired = resolveAutoTaggerParams(central, opts.allowedTagKeys, Parameters)`；
   `diffs = autoTaggerDrift(...)`。
   - `ListStackSetOperations({ MaxResults: 1 })` 最新操作状态为 `RUNNING|QUEUED|STOPPING` → status `pending`，detail
     `StackSet 操作进行中，稍后重跑`，`needsRetry = true`。
   - 否则 `diffs.length > 0` → `UpdateStackSet({ StackSetName, TemplateBody: AUTO_TAGGER_ROLE_TEMPLATE, Parameters: desired 三项,
     Capabilities: ['CAPABILITY_NAMED_IAM'], Description: 'IAM role for central tag-compliance auto-tagger (managed by AWSTool)',
     OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 }, CallAs: 'SELF' })`；
     status `pending`，detail `已提交更新：${diffs.join('；')}`，`needsRetry = true`。
   - 否则：`ListStackInstances` 统计 `Status !== 'CURRENT'` 的实例，status `skipped`，detail
     `模板与参数一致（最小权限）；N 个实例未更新：<最多 5 个账户 ID>`（N=0 时省略后半句）。
3. 把 `desired.EnforceTagKeys === 'true'` 与 `desired.AllowedTagKeys.split(',')` 记为局部变量，供步骤 6 使用；
   若步骤 5 抛错，步骤 6 用 `{ enforceTagKeys:false, allowedTagKeys: opts.allowedTagKeys ?? ['map-migrated'] }`。

**步骤 6 payer tagger**：`ensurePayerTaggerRole(creds, central, { allowedTagKeys, enforceTagKeys })`：
```ts
async function ensurePayerTaggerRole(
  creds: AwsCredentials, centralAccount: string,
  policyOpts: { allowedTagKeys: string[]; enforceTagKeys: boolean },
): Promise<{ created: boolean; changes: string[] }>
```
1. 不存在 → `CreateRole`（信任 `buildCentralTrust`，Description/Tags 同现状），**不再挂 ReadOnlyAccess**。
2. 存在 → 信任不一致则 `UpdateAssumeRolePolicy`，changes 记 `'信任策略已对齐中央 tag-compliance*'`。
3. `PutRolePolicy AutoTagPolicy = AUTO_TAGGER_INLINE_POLICY(policyOpts)`。
4. 之后若已挂 `arn:aws:iam::aws:policy/ReadOnlyAccess` → `DetachRolePolicy`，changes 记 `'已移除 ReadOnlyAccess'`。
步骤 6 status：created → `created`；changes 非空 → `created` 且 detail 为 changes；否则 `skipped`。
（文件里没有现成凭证类型：在 `tag-compliance.ts` 内新增 `type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };`，`assumePayer` 的返回值即此形状。）

### 5.4 区域发现

```ts
export interface MemberRegionDiscovery {
  regions: Record<string, string[]>;
  unreachable: Array<{ accountId: string; error: string }>;
}
export async function getMemberEnabledRegions(payerAccountId: string): Promise<MemberRegionDiscovery>
```
- 成员列举与 5 个一批不变；每个账户 `try { assumeToAccount → new AccountClient({ region:'us-east-1', credentials })
  分页 ListRegionsCommand({ RegionOptStatusContains: ['ENABLED','ENABLED_BY_DEFAULT'], MaxResults: 50, NextToken }) }`，
  结果过 `enabledRegionsFromListRegions`；结果为空视为失败（error `'ListRegions 返回空'`）。
- 失败：`unreachable.push({ accountId, error: awsErrorDetail(e) })`，不抛。
- 从文件 import 中移除不再使用的 `EC2Client`/`DescribeRegionsCommand`（若 `getRegionAvailability` 仍用则保留）。

`OrgEnabledRegionsResult` 新增 `unreachableAccounts: Array<{ accountId: string; error: string }>`；`getOrgEnabledRegions`
用 `discovery.regions` 计算其余字段（逻辑不变），并返回 `unreachableAccounts: discovery.unreachable`。

## 6. 后端设计 — `web/server/tag-onboarding.ts` 与 `web/server/db.ts`（修改）

- `db.ts`：`TagOnboardingJob.artifacts` 加 `unreachableAccounts?: Array<{ accountId: string; error: string }>;`
- `runProvision`、`runWaitManagementIndex`：`provisionOrg(job.payerAccountId, { allowedTagKeys: tagCompliance.normalizeAllowedTagKeys(job.extraTagKey) })`。
- `runDeployReIndexes`：`const discovery = await tagCompliance.getMemberEnabledRegions(...)`；`memberEnabledRegions = discovery.regions`
  （其余用法不变）。`advance(... 'wait_stacksets' ...)` 的 artifacts 加 `unreachableAccounts: discovery.unreachable`；
  消息末尾在 `unreachable.length > 0` 时追加 ``；跳过 ${n} 个无法进入的账户：${ids.join(', ')}``。
  另在该函数开头若 `discovery.unreachable.length > 0`，`console.warn('[MAP Onboarding] ...')` 一行。
- `runVerify`：`completeJob` 文案在 `job.artifacts.unreachableAccounts?.length` 时追加
  ``；${n} 个账户无法进入、未纳入打标：${ids.join(', ')}``。
- `routes/aws.ts`：`/tag-compliance/provision` 调用 `provisionOrg(payer)` 不变（opts 省略 → 沿用 StackSet 现值）；
  `getOrgEnabledRegions` 两处调用不需改（返回值多一个字段）。

## 7. 运维脚本 — `web/scripts/tag-keys-canary.ts`（新建）

用途：在 taoVolt 先对单个账户开启 `EnforceTagKeys`，验证后全量开启。仅 EC2 上手动执行。
```
npx tsx scripts/tag-keys-canary.ts --payer 724772095868 --account <12位> --enforce true|false   # 单账户参数覆盖
npx tsx scripts/tag-keys-canary.ts --payer 724772095868 --all                                  # 全量开启
npx tsx scripts/tag-keys-canary.ts --payer 724772095868 --status                               # 只读：参数、覆盖、最近操作
```
- 凭证：读 `../config.json` 的 `credentials`，在 `config.payers` 中找 `roleArn` 含 `:<payer>:` 的项，`AssumeRole`（会话名 `tag-keys-canary`）。
- 单账户：`DescribeOrganization`/`ListRoots` 取根 OU；`UpdateStackInstances({ StackSetName:'AutoTaggerRole', CallAs:'SELF',
  DeploymentTargets:{ OrganizationalUnitIds:[root], Accounts:[account], AccountFilterType:'INTERSECTION' }, Regions:['us-east-1'],
  ParameterOverrides:[{ ParameterKey:'EnforceTagKeys', ParameterValue:<true|false> }] })`，打印 OperationId。
- `--all`：`UpdateStackSet({ UsePreviousTemplate:true, Capabilities:['CAPABILITY_NAMED_IAM'], Parameters:[
  { ParameterKey:'CentralToolingAccountId', UsePreviousValue:true }, { ParameterKey:'AllowedTagKeys', UsePreviousValue:true },
  { ParameterKey:'EnforceTagKeys', ParameterValue:'true' }], OperationPreferences:{ FailureTolerancePercentage:100, MaxConcurrentPercentage:100 } })`，
  并对 payer 的 `auto-tagger-role` `PutRolePolicy AutoTagPolicy = AUTO_TAGGER_INLINE_POLICY({ allowedTagKeys:<StackSet 现值>, enforceTagKeys:true })`。
- `--status`：打印 StackSet 的三个参数值与 `ListStackSetOperations` 最近 3 个操作（ID、Action、Status）；
  同时给了 `--account` 时，再用 `DescribeStackInstance`（Region `us-east-1`）打印该账户实例的 `ParameterOverrides` 与 `StackInstanceStatus`。
- 参数校验：payer/account 必须 12 位数字；`--enforce` 只能 true/false；三种模式互斥，否则打印用法退出码 2。
- 每次写操作后 `console.log` 操作 ID；不写 db.json（脚本不在服务进程内）。

## 8. AWS 链路

- payer 侧：`config.payers[].roleArn`（`role/tool`）——与现状相同，需要的新 action：`iam:UpdateAssumeRolePolicy`、
  `iam:DetachRolePolicy`、`cloudformation:UpdateStackSet`、`cloudformation:ListStackSetOperations`、`cloudformation:UpdateStackInstances`。
  `role/tool` 是 payer 管理员角色，已具备。
- 成员侧：`assumeToAccount`（一级跳 `support-quota`；受限账户不回退 admin）+ `account:ListRegions`。实测 132/133 可用。
- 调用量：taoVolt 133 次 AssumeRole + ListRegions；一次 UpdateStackSet（137 个实例，单区域）。

## 9. 错误处理与边界

- `UpdateStackSet` 抛 `OperationInProgressException` → 当作 pending（同 5.3 步骤 5 的进行中分支）。
- 更新后个别实例失败（如 `623581626210`）：容忍度 100%，StackSet 级参数已是新值 → 下一轮 drift 为空，步骤显示「N 个实例未更新」，不阻断。
- payer 角色操作顺序固定「先写新策略/内联，再摘旧托管策略」，任何一步失败不会让角色处于无权限状态。
- 区域发现：全部成员都不可达时 `regions` 为空 → 现有逻辑继续（会因没有成员目标而快速完成），`unreachable` 全量列出。
- 中央扫描若因 `SearchPolicy` 不足失败（例如需要额外 action），回滚见第 11 节。

## 10. 测试计划

- **修改** `web/tests/tag-compliance-policy.test.ts`：
  - Statement 数仍为 2；`Statement[0].Sid === 'TagWrite'`，Action > 100 且含原必需 6 项，**不含** `tag:GetResources`；
  - `Statement[1].Action` 深等于 `['apigateway:PUT','apigateway:POST']`，`Resource` 深等于 `['arn:aws:apigateway:*::/tags/*']`；
  - 默认无 `Condition`；`{ enforceTagKeys:true, allowedTagKeys:['map-migrated','CostCenter'] }` 时两条都有
    `ForAllValues:StringEquals` / `aws:TagKeys` = 该数组。
- **新增** `web/tests/tag-least-privilege.test.ts`：
  - 模板字符串不含 `apigateway:PATCH`、`apigateway:DELETE`、`apigateway:*::*`、`tag:GetResources`；含 `AllowedTagKeys`、`EnforceTagKeys`、`aws:TagKeys`。
  - `normalizeAllowedTagKeys()` → `['map-migrated']`；`('CostCenter')` → `['map-migrated','CostCenter']`；`('map-migrated')`、`('  ')` → `['map-migrated']`。
  - `resolveAutoTaggerParams`：无 existing → Enforce `'false'`、Keys `'map-migrated'`；existing `EnforceTagKeys='true'` 保留；
    requestedKeys 覆盖 existing Keys；无 requestedKeys 沿用 existing Keys。
  - `autoTaggerDrift`：taoVolt 场景（旧模板 + `CentralToolingAccountId=211125508317`、无另两参数）→ 含模板差异与
    `CentralToolingAccountId: 211125508317 → 382309211956`；完全一致 → `[]`。
  - `buildCentralTrust('382309211956')` 含 PrincipalArn 条件；`buildSearchRolePolicy('724772095868')` 恰两条语句、Resource 精确匹配。
  - `enabledRegionsFromListRegions`：只保留 ENABLED / ENABLED_BY_DEFAULT，排序。
  - `samePolicyDocument`：key 顺序不同但内容相同 → true；Principal 不同 → false。
- 全量：`cd web && npm test && npm run typecheck && npm run build`。

## 11. 影响面与风险

- README 第九节高危区：均不涉及（不碰 temp-admin、restricted-accounts、map-tag-rules）。受限账户的 `support-quota` 收窄策略不改，
  只是区域发现换成它本来就允许的 `account:ListRegions`。
- 对已接入的其它 payer：**只有重跑接入时**才会更新它们的 StackSet/角色（本次不重跑）。手工「一键接入」按钮同样会触发更新——上线后
  在 G4 清单中注明「其它 payer 暂不点一键接入」。
- 回滚：代码回滚即可停止后续变更；已更新的 taoVolt 资源回滚方式——`AutoTaggerRole` 用 `tag-keys-canary.ts --enforce false` 或
  再次 `UpdateStackSet` 设 `EnforceTagKeys=false`；`search-role` 若扫描失败，重新 `AttachRolePolicy AWSResourceExplorerReadOnlyAccess`（单条命令）。

## 12. taoVolt 运行手册（P6，代码上线后执行，每步都是 G4 清单项）

1. 页面 MAP 标签 →「全自动接入」：payer `724772095868`，tag 值 `migT0O0U93ZQY`，不填额外标签。等待 job `completed`
   （期间 provision 阶段会显示 `AutoTaggerRole 已提交更新…`，自动轮询）。
2. 中央手动扫描（页面「手动触发扫描」），看报告：两个受限账户有打标成功，失败数与此前同组织报告相比不上升。
3. 选一个有未打标资源的普通成员账户作为 canary：`tag-keys-canary.ts --account <id> --enforce true` → 再扫描 → 该账户失败数不增加。
4. `tag-keys-canary.ts --all` → 再扫描一次确认。
5. 只读核验：临时脚本读取 StackSet 参数/模板一致性、两个受限账户实例状态、payer 两个角色的托管策略与信任，跑完删除。

## 13. 方案增补（P3 实现中发现，用户 2026-10-15 批准「从 payer 侧只读核验」）

实现中发现两处会让 taoVolt 接入在 `wait_stacksets` 失败，原方案遗漏：

1. **受限账户读不到既有索引。** `getOnboardingStackSetStatus` 对 StackSet 因 AlreadyExists 失败的目标，用成员 `support-quota`
   `GetIndex` 判断既有索引能否复用；受限账户收窄后无 `GetIndex` → 判 `invalid` → 索引冲突。taoVolt 全组织已有 Quick Setup 索引，必然触发。
   - 修正：`classifyTargetIndex` 捕获到权限拒绝（`isAccessDeniedError`）时，改用 payer 凭证调
     `resource-explorer-2:ListIndexesForMembers({ AccountIdList: [accountId] })`（按账户缓存）取各区域索引类型，交给
     `classifyIndexFromMemberListing(stackSetName, aggregatorRegion, region, type)`：聚合 StackSet 要求聚合区为 `AGGREGATOR`；
     本地 StackSet 要求 `LOCAL`；其它（含查不到、聚合区为 LOCAL 需升级）→ `invalid`。看不到 State/复制状态，仅用于成员侧读取被拒时。
   - 不改受限账户的收窄策略。只读核对：两个受限账户均为 us-east-1 AGGREGATOR + 其它区域 LOCAL，无需升级。
2. **不可达账户导致覆盖核验直接抛错。** 该函数自行从 Organizations 列全部 ACTIVE 成员，`623581626210` 不在区域矩阵里 →
   抛「缺少成员账户 … 的区域启用状态」。
   - 修正：`getOnboardingStackSetStatus(..., skippedAccountIds: string[] = [])`、`repairOnboardingStackSetCoverage(..., inspected?, skippedAccountIds = [])`
     只排除明确跳过的账户；其它缺区域信息的账户仍报错（保留原安全检查）。`tag-onboarding.ts` 的 `runWaitStackSets`/`runVerify`
     传入 `job.artifacts.unreachableAccounts` 的账户 ID。
