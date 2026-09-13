---
name: aws-account-cleanup
description: 清空 AWS 成员账户的计费资源到可关户/交还的程度。当用户说「清空账号」「删除某账户所有资源」「账号退还前清理」「nuke 账号」时使用。支持多账号、全区域扫描、dry-run 预览、分阶段确认。
metadata:
  version: "1.0.0"
  argument-hint: <account-id> [account-id ...]
---

# AWS 账户资源清空

把一个或多个 AWS 成员账户的计费资源清空到可以关户或交还的程度。

## 绝对不可违反的规则

1. **未经用户明确确认，绝不执行删除**。扫描和 dry-run 可以直接做；真删必须先把清单给用户看过、拿到确认。
2. **每个阶段开头都要校验账号身份**。删错账号是这套流程唯一无法挽回的错误。脚本里 `assert_account` 已强制，不要绕过。
3. **一次只处理一个账号的真删**。不要为了省事并发删多个账号。
4. **不碰 payer/管理账户**。脚本会把 payer ID 写进 blocklist 当保险丝，若目标就是 payer 直接拒绝。
5. **保留 `OrganizationAccountAccessRole`**。删了它 payer 再也进不去，无法验收和关户。

## 前置判断：走哪条路

先判断目标账号是否在平台配置的组织树内（`config.json` 的 `payers`）。

**情况 A — 在组织树内且是 CREATED 账号**（有 `OrganizationAccountAccessRole`）：
直接用 payer 二级跳拿管理员凭证。这是首选，不需要在目标账号里建任何东西，事后无需清理。

**情况 B — 在组织树内但是 INVITED 账号**（没有 OAAR）：
检查是否有 `admin-console` 角色（由组织级 StackSet 下发、直接信任平台身份）。有就用它。

**情况 C — 完全拿不到管理员凭证**：
只能让用户提供该账号的临时凭证，然后引导创建长期 IAM User。这条路复杂且事后要清理，仅在 A/B 都不可行时使用。

判断脚本：

```bash
python3 scripts/cleanup.py probe <account-id> [<account-id> ...]
```

## 标准流程

### 第一步：扫描（只读，可直接执行）

```bash
python3 scripts/cleanup.py scan <account-id>
```

输出该账号所有启用区域里的资源分布 + 本月按服务的花费。
**必须把结果给用户看**，让他确认这些东西确实该删。

注意花费与资源不一致是正常的：Cost Explorer 有最多 24 小时延迟，本月已删掉的资源仍会有历史账单。

### 第二步：dry-run（只读，可直接执行）

```bash
python3 scripts/cleanup.py plan <account-id>
```

列出将要删除的每一个资源。把清单给用户看，等确认。

### 第三步：真删（必须先拿到用户确认）

```bash
python3 scripts/cleanup.py nuke <account-id> --confirm <account-id>
```

`--confirm` 必须重复输入账号 ID，防手滑。脚本会循环删除直到扫不出资源。

删除是分轮次的，因为资源间有依赖（VPC 里还有 ENI、RDS 子网组要等实例先删）。
单轮内出现大量失败是正常现象，判断是否真出问题看两点：**是否权限拒绝**、**是否连续多轮同样的失败**。

### 第四步：验收

```bash
python3 scripts/cleanup.py verify <account-id>
```

独立复核（不依赖删除阶段的日志），全区域直查 API，输出报告。

## 会踩的坑

以下都是实际踩过的，脚本已处理，但你要知道为什么：

**异步删除会被误判成卡死**。RDS/DocDB 集群删除要 5~15 分钟，前几轮看起来「没删掉任何东西」。判断卡死必须把「已触发删除」「等待中」算作有进展，只看「已完成」会提前放弃。

**账号级订阅不是资源，删不掉**。DevOps Guru、Support Plan、Savings Plans、预留实例、Marketplace 订阅、Route53 域名自动续费——这些清完资源后账单仍会产生。脚本会在扫描阶段比对账单服务并标出来，需要人工去控制台处理。

**opt-in 区域未启用时 STS 凭证会被拒**。表现为 `UnrecognizedClientException`，不是错误，是该账号没开通那个区域，跳过即可。

**IAM 是最终一致的**。新建的凭证立即使用可能报 `InvalidClientTokenId`，禁用后仍可能几十秒内有效。涉及 IAM 变更后必须轮询确认，不能发完命令就当完事。

**默认 VPC 不计费**。验收时某区域只剩 1 个默认 VPC 属于正常终态，不要当成残留。同理 `AWSServiceRoleFor*` 服务关联角色由 AWS 托管、不计费、无法手工删除，随账号关闭消失。

## 关户（可选，需 payer 权限）

资源清完后如果要关账号：

```bash
aws organizations close-account --account-id <account-id> --profile <payer-profile>
```

关户后 90 天内可恢复。默认不做这一步，除非用户明确要求。

## 依赖

- Python 3 + boto3（`pip3 install boto3`）
- 平台的 `config.json`（读 payer 列表和基础凭证）

不依赖 aws-nuke，也不依赖 bash 4+（macOS 自带 bash 3.2 可用）。
