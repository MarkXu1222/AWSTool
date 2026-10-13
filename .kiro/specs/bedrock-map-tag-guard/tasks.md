# 任务拆分 —— bedrock-map-tag-guard

> 前置：`design.md` 已通过闸门 G1（2026-10-13）。所有任务的唯一依据是同目录 `design.md`。
> 拆分时为避免两个任务写同一测试文件，把 §9 的测试拆成两个文件、给 §10 脚本加了 `--plan-only`（均已回写 design.md，不改行为）。

| # | 任务名 | 独占文件 | 依赖 | design.md 章节 | 验收命令 |
|---|--------|----------|------|----------------|----------|
| T1 | 标签规则（前后端同源） | `web/server/map-tag-rules.ts`（新）<br>`web/client/src/utils/mapTag.ts`（新）<br>`web/tests/bedrock-map-tag-guard.test.ts`（新） | — | §5.1 §6.1 §9（用例 1、2、3、4、4b、7 与 Review Focus 1/2/4/5） | `cd web && node --import tsx --test tests/bedrock-map-tag-guard.test.ts && npm test && npm run typecheck` |
| T2 | 后端接线：写后回查 + 交付读 AWS | `web/server/bedrock-tools.ts`<br>`web/server/routes/bedrock.ts`<br>`web/server/bedrock-delivery.ts`<br>`web/tests/bedrock-delivery-tag-guard.test.ts`（新） | T1 | §5.2 §5.3 §5.4 §7 §8 §9（用例 5、6 与 Review Focus 3/5） | `cd web && node --import tsx --test tests/bedrock-delivery-tag-guard.test.ts tests/bedrock-delivery-55.test.ts tests/bedrock-delivery-name-match.test.ts tests/bedrock-account-tpd.test.ts && npm test && npm run typecheck` |
| T3 | 前端：实时校验 + 结果表 + 切账户重建 | `web/client/src/components/BedrockTagResults.tsx`（新）<br>`web/client/src/pages/Bedrock.tsx`<br>`web/client/src/api.ts` | T1 | §6.2 §6.3 §6.4 §8（最后一行） | `cd web && npm run typecheck && npx vite build --config client/vite.config.ts`；页面验收由协调者在 P4 按 design §1 执行 |
| T4 | 存量排查脚本（只读） | `web/scripts/audit-bedrock-map-tags.ts`（新） | T1 | §10 | 见下「T4 验收」 |

### T4 验收

```bash
cd web
mkdir -p /tmp/t4 && cat > /tmp/t4/db.json <<'EOF'
{"users":[],"audit_log":[
 {"id":1,"action":"BEDROCK_PROFILE_TAG","detail":"账户 111122223333 | us-east-1 | 2/2 个 Profile | tags: map-migrated=migmigEY52ZIK63T","created_at":"2026-10-01T00:00:00Z"},
 {"id":2,"action":"BEDROCK_DELIVERY_EXPORT","detail":"账户 111122223333 | 交付表格生成（2 个 Profile，tag=migmigEY52ZIK63T）","created_at":"2026-10-02T00:00:00Z"},
 {"id":3,"action":"BEDROCK_PROFILE_CREATE","detail":"账户 444455556666 | ap-northeast-1 | 创建 1/1 个 Profile | tags: map-migrated=migEY52ZIK63T","created_at":"2026-10-03T00:00:00Z"}
],"accounts_cache":[{"Id":"111122223333","_payer":"海底捞"},{"Id":"444455556666","_payer":"GDEX"}]}
EOF
DB_PATH=/tmp/t4/db.json npx tsx scripts/audit-bedrock-map-tags.ts --plan-only --out /tmp/t4
# 期望：stdout 列出 111122223333 → us-east-1,us-west-2 与 444455556666 → us-east-1,us-west-2,ap-northeast-1；
#      /tmp/t4/bedrock-map-tag-history-*.csv 含 3 行数据，前两行 valid=false（重复的 mig 前缀）
DB_PATH=/tmp/t4/db.json npx tsx scripts/audit-bedrock-map-tags.ts --plan-only --payer 海底捞 --out /tmp/t4
# 期望：只列出 111122223333
npm test && npm run typecheck
```

联网全量运行（读生产 `db.json` + AWS）由协调者在 P6 上线后于 EC2 执行，**worker 不得在本地对真实账户运行非 plan-only 模式**。

## 波次

- **波次 1（1 个 worker）**：T1。体量小、是其余三个任务的公共依赖，先单独落地
- 协调者合入 T1 到 `integration/bedrock-map-tag-guard`，跑 `npm test && npm run typecheck`
- **波次 2（并行 3 个 worker，基于合入 T1 后的集成分支）**：T2、T3、T4
- 协调者串行合入 T2 → T3 → T4，集成分支全量 `npm test && npm run typecheck && npm run build`，再按 design §1 做页面验收

依赖链深度 1（T1 → T2 / T3 / T4）。

T3 与 T2 之间**没有代码依赖**：T3 消费的响应字段（`status`、`oldMapValue`、`actualMapValue`、`removedVariantKeys`、`modelId`、`error`）以 design §5.2 的接口定义为准，`api.ts` 用通用 `request` 返回 `any`，可独立通过 typecheck。

## 简报中必须点名的约束

- **T2**：README 第九节高危区 —— `bedrock-delivery.ts` 的 `normalizeProfileName()`、`filterAndSortForDelivery`、`deliveryOrderFor`、xlsx 版式与须知文案**一律不改**；`/delivery-v2` 必须**先筛选再读标签**；`tests/bedrock-delivery-name-match.test.ts` 必须保持通过
- **T3**：颜色只用 AntD 语义色或 `var(--color-*)`，不写 hex（同时去掉 CreateTab 里原有的 `#cf1322`）；不用 emoji；成功提示无感叹号；不重构其它 Tab
- **T4**：CSV 数字不加千分位；只读 —— 不经 `db.ts`、不写 `data/`；非 plan-only 模式不得在本地执行
- **全部**：不准改 `version.ts`、`README.md`、`.kiro/steering/**`、`config*.json`、`data/**`；不准 `git add -A` / `git add .`

## 拆分检查清单

- [x] `design.md` 已通过闸门 G1
- [x] 每个任务都能指到 `design.md` 的具体章节
- [x] `design.md` 每一节都被覆盖：§5.1/§6.1→T1，§5.2–5.4/§7/§8→T2，§6.2–6.4→T3，§9→T1+T2，§10→T4（§1–4、§11–12 为说明性章节，由协调者在 P4/P5 核对）
- [x] 任意两个任务的独占文件无交集
- [x] 枢纽文件：`api.ts` 只在 T3；`routes/aws.ts`、`aws-service.ts`、`db.ts`、`auth.ts`、`index.ts`、`MainLayout.tsx`、`global.css` 均不涉及
- [x] 协调者独占文件不在任何任务里
- [x] 每个任务都有可执行的验收命令
- [x] 依赖链深度 1（≤ 3）
- [x] 每个任务基于集成分支（含 T1）可独立通过 `npm test`
- [x] 不涉及 `root-email-*` / `root-mail-*` / `mail-api*`
- [x] 涉及高危区的 T2 已点名具体约束
