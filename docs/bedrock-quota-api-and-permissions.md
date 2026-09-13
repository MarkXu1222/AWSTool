# Amazon Bedrock TPM / RPM / TPD 配额查询与 IAM 权限操作指南

## 1. 结论

查询 Amazon Bedrock 的 TPM、RPM、TPD 配额时，实际调用的是 **AWS Service Quotas**，不是 Amazon Bedrock Runtime API。

| 项目 | 值 |
|---|---|
| AWS 服务 | AWS Service Quotas |
| API operation | `ListServiceQuotas` |
| AWS CLI 命令 | `aws service-quotas list-service-quotas` |
| JavaScript SDK v3 client | `ServiceQuotasClient` |
| JavaScript SDK v3 command | `ListServiceQuotasCommand` |
| 请求参数 | `ServiceCode: "bedrock"` |
| 最小 IAM action | `servicequotas:ListServiceQuotas` |
| IAM Resource | `"*"` |

最简 AWS CLI 命令：

```bash
aws service-quotas list-service-quotas \
  --service-code bedrock \
  --region us-east-1
```

正式 API 名称是 [`ListServiceQuotas`](https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_ListServiceQuotas.html)。

## 2. TPM、RPM、TPD 分别是什么

| 指标 | 英文 | Service Quotas 名称中的识别短语 | 含义 |
|---|---|---|---|
| TPM | Tokens Per Minute | `tokens per minute` | 每分钟允许处理的令牌数 |
| RPM | Requests Per Minute | `requests per minute` | 每分钟允许发起的请求数 |
| TPD | Tokens Per Day | `tokens per day` | 每天允许处理的令牌数 |

这些指标通常不是响应中的独立字段。需要根据每条配额的英文 `QuotaName` 判断指标类型，实际配额值位于 `Value` 字段。

典型响应字段：

```json
{
  "QuotaName": "On-demand model inference tokens per minute for <MODEL_NAME>",
  "QuotaCode": "L-EXAMPLE123",
  "Value": 200000,
  "Unit": "None",
  "Adjustable": true
}
```

字段含义：

- `QuotaName`：配额名称，包含模型、调用范围和指标类型。
- `QuotaCode`：配额唯一代码；申请提额时需要使用。
- `Value`：当前账户在当前区域的生效配额值。
- `Adjustable`：是否允许通过 Service Quotas 申请提高。
- `Unit`：AWS 返回的计量单位。

> 配额值表示允许的上限，不表示当前已经使用了多少。实际使用量需要通过对应服务指标或业务监控查看。

## 3. 查询前准备

### 3.1 本地工具

建议使用：

- AWS CLI v2；
- 有效的 AWS IAM、IAM Identity Center（SSO）或临时角色凭证；
- 可选：`jq`，用于从 JSON 中筛选 TPM/RPM/TPD。

如果使用 IAM Identity Center，可以先配置 profile：

```bash
aws configure sso --profile bedrock-quota-reader
aws sso login --profile bedrock-quota-reader
```

验证当前身份：

```bash
aws sts get-caller-identity --profile bedrock-quota-reader
```

确认输出中的 `Account` 是需要查询配额的 AWS 账户。

### 3.2 区域要求

Service Quotas 是区域性服务。查询时必须指定区域，而且不同区域返回的 Bedrock 配额可能不同。

例如，要检查 `us-east-1` 和 `us-west-2`，必须分别调用两次 API。

## 4. 最小 IAM 权限

### 4.1 同账户查询

将以下 identity policy 附加到执行查询的 IAM user 或 IAM role：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBedrockAppliedServiceQuotas",
      "Effect": "Allow",
      "Action": "servicequotas:ListServiceQuotas",
      "Resource": "*"
    }
  ]
}
```

`ListServiceQuotas` 不支持按单个 Bedrock 模型 ARN 进行资源级授权，因此这里必须使用 `Resource: "*"`。

只读取 TPM/RPM/TPD 配额时，不需要：

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels`
- `servicequotas:RequestServiceQuotaIncrease`
- `iam:CreateServiceLinkedRole`

换句话说，查询配额不需要模型调用权限，也不需要 Bedrock Runtime 凭证权限。

### 4.2 可选的 Service Quotas 只读权限

如果还需要按已知 `QuotaCode` 查询单项配额，或查看 AWS 默认值，可以增加：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadBedrockServiceQuotas",
      "Effect": "Allow",
      "Action": [
        "servicequotas:ListServiceQuotas",
        "servicequotas:GetServiceQuota",
        "servicequotas:ListAWSDefaultServiceQuotas"
      ],
      "Resource": "*"
    }
  ]
}
```

如果只执行本指南的列表查询，第一份最小策略即可。

## 5. 使用 AWS CLI 查询

### 5.1 查询当前区域全部 Bedrock 生效配额

```bash
aws service-quotas list-service-quotas \
  --service-code bedrock \
  --region us-east-1 \
  --profile bedrock-quota-reader \
  --output json
```

AWS CLI 默认自动处理分页。不要使用 `--no-paginate`，否则可能只得到第一页。

### 5.2 只显示 TPM、RPM、TPD

不依赖 `jq` 的表格命令：

```bash
aws service-quotas list-service-quotas \
  --service-code bedrock \
  --region us-east-1 \
  --profile bedrock-quota-reader \
  --query 'Quotas[?contains(QuotaName, `tokens per minute`) || contains(QuotaName, `requests per minute`) || contains(QuotaName, `tokens per day`)].[QuotaName,QuotaCode,Value,Adjustable,Unit]' \
  --output table
```

该查询按 `QuotaName` 中的英文短语筛选。输出列依次为：

1. 配额名称；
2. QuotaCode；
3. 当前值；
4. 是否可调整；
5. 单位。

### 5.3 使用 jq 标注指标类型

下面的命令会增加 `Metric` 字段，并排除 batch、provisioned throughput、customization 和 fine-tuning 类配额：

```bash
aws service-quotas list-service-quotas \
  --service-code bedrock \
  --region us-east-1 \
  --profile bedrock-quota-reader \
  --output json |
jq '
  [
    .Quotas[]
    | (.QuotaName // "" | ascii_downcase) as $name
    | select($name | test("tokens per minute|requests per minute|tokens per day"))
    | select(($name | test("batch|provisioned|customization|fine-tun")) | not)
    | {
        Metric: (
          if $name | contains("tokens per minute") then "TPM"
          elif $name | contains("requests per minute") then "RPM"
          elif $name | contains("tokens per day") then "TPD"
          else "OTHER"
          end
        ),
        QuotaName,
        QuotaCode,
        Value,
        Adjustable,
        Unit
      }
  ]'
```

如果需要查看 batch、provisioned 或 customization 配额，删除第二个 `select(...)` 过滤条件。

### 5.4 查询多个区域

```bash
regions=(us-east-1 us-west-2 eu-west-1)

for region in "${regions[@]}"; do
  echo "===== ${region} ====="
  aws service-quotas list-service-quotas \
    --service-code bedrock \
    --region "${region}" \
    --profile bedrock-quota-reader \
    --query 'Quotas[?contains(QuotaName, `tokens per minute`) || contains(QuotaName, `requests per minute`) || contains(QuotaName, `tokens per day`)].[QuotaName,QuotaCode,Value,Adjustable,Unit]' \
    --output table || echo "查询 ${region} 失败" >&2
done
```

不要假设一个区域的配额适用于其他区域。跨区域推理和 Global Cross-Region 配额也应以各区域实际返回结果为准。

## 6. 使用 AWS SDK for JavaScript v3 查询

依赖包：`@aws-sdk/client-service-quotas`。

下面的 TypeScript 示例使用 AWS SDK 默认凭证链、处理全部分页、识别三个指标，并在结束时释放 SDK client：

```ts
import {
  ListServiceQuotasCommand,
  ServiceQuotasClient,
} from '@aws-sdk/client-service-quotas';

type Metric = 'TPM' | 'RPM' | 'TPD';

interface BedrockQuotaResult {
  metric: Metric;
  quotaName: string;
  quotaCode: string;
  value: number | null;
  adjustable: boolean;
  unit: string;
}

function detectMetric(quotaName: string): Metric | null {
  const name = quotaName.toLowerCase();
  if (name.includes('tokens per minute')) return 'TPM';
  if (name.includes('requests per minute')) return 'RPM';
  if (name.includes('tokens per day')) return 'TPD';
  return null;
}

async function listBedrockQuotas(region: string): Promise<BedrockQuotaResult[]> {
  const client = new ServiceQuotasClient({ region, maxAttempts: 3 });
  const results: BedrockQuotaResult[] = [];

  try {
    let nextToken: string | undefined;

    do {
      const response = await client.send(new ListServiceQuotasCommand({
        ServiceCode: 'bedrock',
        MaxResults: 100,
        NextToken: nextToken,
      }));

      for (const quota of response.Quotas ?? []) {
        const quotaName = quota.QuotaName ?? '';
        const metric = detectMetric(quotaName);
        if (!metric) continue;

        results.push({
          metric,
          quotaName,
          quotaCode: quota.QuotaCode ?? '',
          value: quota.Value ?? null,
          adjustable: quota.Adjustable ?? false,
          unit: quota.Unit ?? '',
        });
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return results;
  } finally {
    client.destroy();
  }
}

const region = process.argv[2] || process.env.AWS_REGION || 'us-east-1';

listBedrockQuotas(region)
  .then(quotas => console.table(quotas))
  .catch(error => {
    console.error(`查询 ${region} 的 Bedrock 配额失败：`, error);
    process.exitCode = 1;
  });
```

运行时可通过标准凭证链指定身份，例如：

```bash
AWS_PROFILE=bedrock-quota-reader npx tsx list-bedrock-quotas.ts us-east-1
```

SDK 中必须持续读取 `NextToken`。只调用一次 `ListServiceQuotasCommand` 可能漏掉后续页面。

## 7. 跨账户查询

跨账户场景需要同时配置三部分：

1. 目标账户中的查询角色拥有 Service Quotas 读取权限；
2. 目标角色的 trust policy 信任调用方；
3. 调用方拥有对目标角色执行 `sts:AssumeRole` 的权限。

任何一部分缺失都会导致 `AccessDenied`。

### 7.1 目标账户：创建查询角色权限

将以下策略附加到目标账户中的角色，例如 `BedrockQuotaReadRole`：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBedrockAppliedQuotas",
      "Effect": "Allow",
      "Action": "servicequotas:ListServiceQuotas",
      "Resource": "*"
    }
  ]
}
```

### 7.2 目标账户：配置角色 trust policy

如果调用方是另一个 AWS 账户中的 IAM role：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrustQuotaReader",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<CALLER_ACCOUNT_ID>:role/<CALLER_ROLE_NAME>"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "<UNIQUE_EXTERNAL_ID>"
        }
      }
    }
  ]
}
```

如果是向第三方提供跨账户访问，建议使用不可预测且每个客户唯一的 ExternalId。不要在公开文档、日志或代码仓库中保存真实 ExternalId。

如果双方属于同一受控环境且不使用 ExternalId，应同时删除 trust policy 中的整个 `Condition`，并且调用 AssumeRole 时不要传 `ExternalId`。

### 7.3 调用方账户：允许 AssumeRole

将以下策略附加到调用方 user 或 role：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeBedrockQuotaReadRole",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::<TARGET_ACCOUNT_ID>:role/BedrockQuotaReadRole"
    }
  ]
}
```

尽量填写具体目标角色 ARN，不要将 `Resource` 放宽为 `*`。

### 7.4 配置 AWS CLI 跨账户 profile

在 `~/.aws/config` 中配置：

```ini
[profile bedrock-quota-target]
role_arn = arn:aws:iam::<TARGET_ACCOUNT_ID>:role/BedrockQuotaReadRole
source_profile = caller
external_id = <UNIQUE_EXTERNAL_ID>
region = us-east-1
role_session_name = bedrock-quota-read
```

然后执行：

```bash
aws sts get-caller-identity --profile bedrock-quota-target

aws service-quotas list-service-quotas \
  --service-code bedrock \
  --region us-east-1 \
  --profile bedrock-quota-target \
  --output json
```

如果 trust policy 没有 ExternalId 条件，应从 profile 中删除 `external_id`。

> IAM policy、role trust、SCP、permissions boundary 和 session policy 会共同决定最终权限。任何显式 Deny 都会覆盖 Allow。

## 8. 如何识别模型和调用范围

`ListServiceQuotas` 会返回多个模型和多种调用范围的配额。建议至少保留以下字段作为唯一记录：

```text
Region + QuotaCode + QuotaName
```

常见 `QuotaName` 关键词：

| 关键词 | 含义 |
|---|---|
| `global cross-region` | Global Cross-Region 推理配额 |
| `cross-region` | Cross-Region 推理配额 |
| `latency-optimized` | 延迟优化推理配额 |
| `on-demand` | 按需推理配额 |
| `batch` | 批量推理配额 |
| `provisioned` | Provisioned Throughput 相关配额 |
| `customization` / `fine-tun` | 模型定制或微调配额 |

分类时应先判断 `global cross-region`，再判断 `cross-region`，否则前者会被错误归入普通 Cross-Region。

模型名称通常位于以下短语之后：

```text
tokens per minute for <MODEL_NAME>
requests per minute for <MODEL_NAME>
tokens per day for <MODEL_NAME>
```

AWS 可能调整、新增或重命名配额。自动化程序不应只依赖固定的 QuotaCode 清单，建议同时保存 `QuotaCode` 和原始 `QuotaName` 并定期检查未识别条目。

## 9. 查询默认值和单项配额

### 9.1 查看 AWS 默认配额

`ListServiceQuotas` 主要用于查看当前账户的 applied quota。查看 AWS 默认值可使用：

```bash
aws service-quotas list-aws-default-service-quotas \
  --service-code bedrock \
  --region us-east-1 \
  --profile bedrock-quota-reader
```

需要权限：

```text
servicequotas:ListAWSDefaultServiceQuotas
```

默认值与当前账户的生效值不一定相同，不应把默认值直接当作账户当前额度。

### 9.2 按 QuotaCode 查询单项配额

```bash
aws service-quotas get-service-quota \
  --service-code bedrock \
  --quota-code <QUOTA_CODE> \
  --region us-east-1 \
  --profile bedrock-quota-reader
```

需要权限：

```text
servicequotas:GetServiceQuota
```

## 10. 查询和申请提额的区别

查询与提额属于两个不同操作，应分别授权：

| 用途 | API operation | IAM action | 是否产生变更 |
|---|---|---|---|
| 列出当前配额 | `ListServiceQuotas` | `servicequotas:ListServiceQuotas` | 否 |
| 查询单项配额 | `GetServiceQuota` | `servicequotas:GetServiceQuota` | 否 |
| 申请提高配额 | `RequestServiceQuotaIncrease` | `servicequotas:RequestServiceQuotaIncrease` | 是 |

如果确实需要申请提额，应单独授予：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RequestBedrockQuotaIncrease",
      "Effect": "Allow",
      "Action": "servicequotas:RequestServiceQuotaIncrease",
      "Resource": "*"
    }
  ]
}
```

提交申请：

```bash
aws service-quotas request-service-quota-increase \
  --service-code bedrock \
  --quota-code <QUOTA_CODE> \
  --desired-value <NEW_VALUE> \
  --region us-east-1 \
  --profile bedrock-quota-admin
```

操作前确认：

- `QuotaCode` 来自目标账户和目标区域；
- `Adjustable` 为 `true`；
- 新值符合 AWS 对该配额的要求；
- 操作者已获得提交变更的授权；
- 已记录变更审批和 CloudTrail 审计信息。

首次使用某些 Service Quotas 写操作时，AWS 可能需要创建 service-linked role。如果实际报错明确要求，可额外授予以下受限权限；只读查询不需要它：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CreateServiceQuotasServiceLinkedRole",
      "Effect": "Allow",
      "Action": "iam:CreateServiceLinkedRole",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "iam:AWSServiceName": "servicequotas.amazonaws.com"
        }
      }
    }
  ]
}
```

## 11. 常见问题排查

### 11.1 `AccessDenied`：无法 AssumeRole

常见错误：

```text
AccessDenied: not authorized to perform sts:AssumeRole
```

依次检查：

1. 调用方 identity policy 是否允许目标 role ARN；
2. 目标 role trust policy 是否信任真实调用方 ARN；
3. ExternalId 是否在 trust policy、CLI profile 或 SDK 请求中完全一致；
4. 调用方是否通过其他 role 间接调用，导致 principal ARN 与预期不同；
5. SCP、permissions boundary 或 session policy 是否包含 Deny。

### 11.2 `AccessDeniedException`：无法查询 Service Quotas

常见错误：

```text
AccessDeniedException: not authorized to perform servicequotas:ListServiceQuotas
```

这通常说明凭证本身有效，但当前 user/role 缺少 `servicequotas:ListServiceQuotas`，或者权限被 SCP、permissions boundary、session policy、VPC endpoint policy 等限制。

### 11.3 没有返回某个模型或某项指标

可能原因：

- 选错了 AWS Region；
- Bedrock 或该模型不支持该区域；
- 该配额没有可用的 applied value，因此未出现在 `ListServiceQuotas` 响应中；
- AWS 修改了配额英文名称，筛选表达式没有匹配；
- 使用了 `--no-paginate`，只读取了第一页；
- 自动化脚本主动排除了 batch、provisioned、customization 或 fine-tuning 配额；
- 需要查看的是 AWS 默认值，应改用 `ListAWSDefaultServiceQuotas`。

排查时先去掉 `--query` 和 `jq`，保存完整原始 JSON，再搜索模型名称或 `QuotaCode`。

### 11.4 API 节流或临时网络错误

建议自动化程序：

- 使用 AWS SDK 标准重试；
- 对多个区域设置有限并发，不要无限并行；
- 完整处理分页；
- 设置合理超时；
- 记录失败区域并允许单独重试；
- 长期运行进程在不再使用 client 时调用 `destroy()`。

### 11.5 CloudTrail 审计

可在 CloudTrail 中检查：

| 操作 | Event source | Event name |
|---|---|---|
| 跨账户角色 | `sts.amazonaws.com` | `AssumeRole` |
| 配额查询 | `servicequotas.amazonaws.com` | `ListServiceQuotas` |
| 单项查询 | `servicequotas.amazonaws.com` | `GetServiceQuota` |
| 配额提升 | `servicequotas.amazonaws.com` | `RequestServiceQuotaIncrease` |

## 12. 官方参考

- [AWS Service Quotas API — ListServiceQuotas](https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_ListServiceQuotas.html)
- [AWS SDK for JavaScript v3 — ListServiceQuotasCommand](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/service-quotas/command/ListServiceQuotasCommand/)
- [AWS CLI — list-service-quotas](https://docs.aws.amazon.com/cli/latest/reference/service-quotas/list-service-quotas.html)
- [IAM Service Authorization — Service Quotas actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_service-quotas.html)
- [AWS STS API — AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
- [AWS Service Quotas API — RequestServiceQuotaIncrease](https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_RequestServiceQuotaIncrease.html)
- [AWS Service Quotas User Guide](https://docs.aws.amazon.com/servicequotas/latest/userguide/intro.html)
