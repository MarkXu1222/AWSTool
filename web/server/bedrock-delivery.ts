/**
 * Bedrock 客户交付表格生成（xlsx）。
 * 从桌面版 delivery_build/delivery_verify 迁移：三个区块
 *   1) AWS 账户信息（IAM 用户名/密码/Console URL）
 *   2) 模型推理配置文件 ARN List（按区域分组、区域列合并单元格）
 *   3) Amazon Bedrock 账户使用须知（红字，map-migrated tag 替换为本单实际 tag）
 * 交付须知文案内置（桌面版从模板 xlsx 提取，平台内置等价文案）。
 */
import ExcelJS from 'exceljs';
import { checkMapTagValue, findMapTagKeyVariant, parseProfileArn, MapTagRuleError } from './map-tag-rules';

const DELIVERY_REGION_ORDER = ['us-east-1', 'us-west-2'];

const DELIVERY_NOTICE = (tagValue: string) => ` 1. Inference Profile 使用要求（重要）
当前已对模型 ID 做限制，生产调用必须使用已创建好的 Inference Profile ARN，请以上方 Excel 中提供的 Claude 模型 ARN 为准，不要直接使用裸模型 ID 作为生产调用入口。
如后续 AWS 有新模型发售，需自行创建对应的 Inference Profile，并按要求补充 Tag：map-migrated、${tagValue}后，方可用于正式调用。
 2. IP / 网络要求（重要）
建议始终使用固定、稳定、可信的海外 IP / 网络环境进行控制台登录和程序调用，避免频繁切换出口 IP。
请避免使用中国大陆、中国香港、中国澳门等地区 IP 进行访问或调用。
 3. Global 与 US 的区别（重要）
Bedrock 中的 US 属于地理范围型 Inference Profile，请求只会在美国范围内的支持区域内路由；Global 则会在 AWS 全球支持的商业区域之间自动路由，通常可获得更高吞吐和更优资源调度，并且相较地理范围型一般可有约 10% 成本优化，与 Claude 官方定价逻辑一致。
因此，有合规或数据驻留要求时建议选择 US；更看重性能、弹性和成本优化时建议选择 Global。
 4. 模型访问
交付的账号默认已开通相关模型访问权限。同时，Amazon Bedrock 的模型可用性与区域相关，不同区域支持的模型并不完全一致，请按实际目标区域确认。
 5. 区域独立性
各区域能力相对独立。控制台、CLI、SDK 以及程序请求所使用的 Region 请保持一致，不建议频繁跨区域切换。
 6. 使用方式
可通过 AWS 控制台、AWS CLI、AWS SDK / API 使用 Bedrock。正式使用前，请先确认 IAM 权限、目标区域、模型访问前置条件及网络环境均已配置完成。
 7. 账户地址
账单地址、账户地址、税务地址请保持当前海外地址信息，不建议随意修改。
 8. 权限与安全
建议按人员或项目拆分 IAM 权限，遵循最小授权原则；生产环境上线前，请先完成小流量测试和日志核验。第三方模型首次开通可能要求具备 Marketplace 订阅相关权限。`;

export interface DeliveryProfileRow {
  name: string;
  arn: string;
  region: string;
  tags: Array<{ key: string; value: string }>;
}

export interface DeliveryInputRow { name: string; arn: string; region: string; backendModels?: string; scope?: string }

/**
 * 规范化前端传来的交付行：ARN 必须属于 accountId，region 一律取 ARN 解析值，
 * 前端传来的 tags 直接丢弃 —— 路由随后从 AWS 重新读标签，前端值不得进入交付表。
 */
export function normalizeDeliveryRows(accountId: string, raw: unknown): DeliveryInputRow[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new MapTagRuleError('没有 Profile 数据');
  const bad: string[] = [];
  const out: DeliveryInputRow[] = [];
  for (const r of raw as any[]) {
    const arn = String(r?.arn ?? '');
    const name = String(r?.name ?? '');
    const parsed = parseProfileArn(arn);
    if (!parsed || parsed.accountId !== accountId) { bad.push(name || arn); continue; }
    const row: DeliveryInputRow = { name, arn, region: parsed.region };
    if (typeof r.backendModels === 'string') row.backendModels = r.backendModels;
    if (typeof r.scope === 'string') row.scope = r.scope;
    out.push(row);
  }
  if (bad.length) {
    throw new MapTagRuleError(`以下 Profile 不属于账户 ${accountId}，已拒绝生成：`
      + `${bad.slice(0, 5).join('、')}${bad.length > 5 ? ` 等 ${bad.length} 个` : ''}`);
  }
  return out;
}

/**
 * 校验并分组：账户 ID 全表唯一；map-migrated 必须存在、格式合规（map-tag-rules）、
 * 无大小写变体 key、全表唯一。
 * 平台纪律：tag 不做默认值；路由层传入的 tags 是服务端从 AWS 重新读到的实际值。
 * 只校验唯一性不够 —— 曾经整批 profile 都打成同一个 migmig… 顺利生成了交付表。
 */
export function prepareDelivery(rows: DeliveryProfileRow[]) {
  if (!rows.length) throw new Error('没有 Profile 数据');

  const accountIds = new Set(rows.map(r => r.arn.split(':')[4]).filter(Boolean));
  if (accountIds.size !== 1) throw new Error(`ARN 中的账户 ID 不唯一：${[...accountIds].join(', ')}`);
  const accountId = [...accountIds][0];

  const bad: string[] = [];
  const tagValues = new Set<string>();
  for (const r of rows) {
    const variant = findMapTagKeyVariant(r.tags);
    if (variant) { bad.push(`${r.name}：存在与 map-migrated 仅大小写不同的 key「${variant}」`); continue; }
    const mig = (r.tags || []).find(t => t.key === 'map-migrated');
    if (!mig || !mig.value) { bad.push(`${r.name}：缺少 map-migrated`); continue; }
    const err = checkMapTagValue(mig.value);
    if (err) { bad.push(`${r.name}：${err}`); continue; }
    tagValues.add(mig.value);
  }
  if (bad.length) {
    throw new Error(`以下 ${bad.length} 个 Profile 的 map-migrated 标签不合规，不能交付：`
      + `${bad.slice(0, 10).join('；')}${bad.length > 10 ? ' 等' : ''}。请在「Profiles 管理」重新打 Tag 后再生成`);
  }
  if (tagValues.size !== 1) throw new Error(`map-migrated tag 不唯一：${[...tagValues].join(', ')}，请先统一`);
  const tagValue = [...tagValues][0];

  // 按 REGION_ORDER 分组，组内保持原始顺序；其它区域追加在后
  const grouped = new Map<string, DeliveryProfileRow[]>();
  for (const region of DELIVERY_REGION_ORDER) grouped.set(region, []);
  for (const r of rows) {
    if (!grouped.has(r.region)) grouped.set(r.region, []);
    grouped.get(r.region)!.push(r);
  }
  for (const [k, v] of grouped) if (!v.length) grouped.delete(k);
  return { grouped, tagValue, accountId };
}

/** 生成交付 xlsx，返回 Buffer（前端直接下载） */
export async function buildDeliveryXlsx(
  rows: DeliveryProfileRow[], iamUser: string, iamPassword: string,
): Promise<{ buffer: Buffer; accountId: string; tagValue: string }> {
  const { grouped, tagValue, accountId } = prepareDelivery(rows);
  const notice = DELIVERY_NOTICE(tagValue);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`inference_profiles_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
  ws.columns = [{ width: 33.65 }, { width: 79.64 }, { width: 59.77 }];

  const fontTitle = { name: '宋体', size: 16, bold: true };
  const fontBody = { name: '宋体', size: 11 };
  const fontBlue = { name: '宋体', size: 11, color: { argb: 'FF0000FF' } };
  const fontNotice = { name: '宋体', size: 11, color: { argb: 'FFFF0000' } };
  const border: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const center: any = { horizontal: 'center', vertical: 'middle' };
  const body: any = { vertical: 'middle' };

  const setCell = (row: number, col: number, value: any, font: any, align: any) => {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font = font;
    cell.alignment = align;
    cell.border = border;
  };

  // 区块一：AWS 账户信息
  ws.mergeCells(1, 1, 1, 3);
  setCell(1, 1, 'AWS 账户信息', fontTitle, center);
  ws.getRow(1).height = 23.2;
  ['User name', 'Password', 'Console sign-in URL'].forEach((h, i) => setCell(2, i + 1, h, fontBody, body));
  setCell(3, 1, iamUser, fontBody, body);
  setCell(3, 2, iamPassword, fontBlue, body);
  setCell(3, 3, `https://${accountId}.signin.aws.amazon.com/console`, fontBlue, body);

  // 区块二：ARN 列表（第 4 行留空）
  ws.mergeCells(5, 1, 5, 3);
  setCell(5, 1, 'AWS 模型推理配置文件ARN List', fontTitle, center);
  ws.getRow(5).height = 23.2;
  ['Profile Name', 'Profile ARN', 'Region'].forEach((h, i) => setCell(6, i + 1, h, fontBody, body));

  let row = 7;
  for (const [region, items] of grouped) {
    const start = row;
    for (const item of items) {
      setCell(row, 1, item.name.trim(), fontBody, body);
      setCell(row, 2, item.arn.trim(), fontBody, body);
      setCell(row, 3, null, fontBody, center);
      row += 1;
    }
    ws.mergeCells(start, 3, row - 1, 3);
    setCell(start, 3, region, fontBody, center);
  }
  ws.getRow(row - 1).height = 23.2;

  // 区块三：使用须知（紧接 ARN 列表）
  const titleRow = row;
  ws.mergeCells(titleRow, 1, titleRow, 3);
  setCell(titleRow, 1, 'Amazon Bedrock 账户使用须知', fontTitle, center);
  ws.getRow(titleRow).height = 23.2;
  const noticeRow = titleRow + 1;
  ws.mergeCells(noticeRow, 1, noticeRow + 24, 3);
  const noticeCell = ws.getCell(noticeRow, 1);
  noticeCell.value = notice;
  noticeCell.font = fontNotice;
  noticeCell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, accountId, tagValue };
}

// ===== 李浩版（v2 五列格式）：Profile Name | Profile ARN | TPM | TPD | Region =====
// 规范：/Users/mark/Claude账户交付/交付表格规范-李浩版.md
// 列宽 A=33.65 B=79.64 C=18 D=20 E=59.77；TPM/TPD 整数、格式 #,##0、实测值（为 0 如实写 0）

export interface DeliveryProfileRowV2 extends DeliveryProfileRow {
  tpm: number;   // 实测 TPM（Service Quotas），未匹配到写 0
  tpd: number;   // 实测 TPD
  /** TPD 取自账户级跨模型共享配额（非该模型独享）时为 true，须知里会加说明 */
  tpdShared?: boolean;
}

/**
 * 交付变体（规范第四节「模型清单（两种交付变体）」）：
 *   full   = 变体 A：核心 9 模型的 us + global 版，每区最多 18 条
 *   global = 变体 B：只要 global 版，每区最多 9 条（李浩近期主要要求）
 * 核心模型 = 原 6 个 + 2026-10 新增 Sonnet 5.5 / Opus 5.5 / Haiku 5.5。
 * 新模型要进交付表必须加到这里（白名单），AWS 上新不会自动出现。
 */
export type DeliveryVariant = 'full' | 'global';

/**
 * 变体 A 的顺序：**沿用基准文件 964949461994交付(1).xlsx 第 7–18 行的历史顺序**
 * （us/global 交错，不是按模型分组）。与 generate_delivery_v2.py 的 DELIVER 一致。
 * ⚠️ 不要「顺手整理」成按模型分组，会与历史交付件对不上。
 */
const VARIANT_FULL_ORDER = [
  'sef-us-claude-sonnet-4-6',
  'sef-us-claude-opus-4-7',
  'sef-us-claude-opus-4-6-v1',
  'sef-global-claude-opus-4-6-v1',
  'sef-global-claude-sonnet-4-6',
  'sef-global-claude-opus-4-7',
  'sef-us-claude-opus-4-8',
  'sef-global-claude-opus-4-8',
  'sef-us-claude-sonnet-5',
  'sef-us-claude-opus-5',
  'sef-global-claude-sonnet-5',
  'sef-global-claude-opus-5',
  // 2026-10 新增 5.5 系列：前 12 行历史顺序不动，追加在后，us/global 交错延续原规律
  'sef-us-claude-sonnet-5-5',
  'sef-us-claude-opus-5-5',
  'sef-us-claude-haiku-5-5',
  'sef-global-claude-sonnet-5-5',
  'sef-global-claude-opus-5-5',
  'sef-global-claude-haiku-5-5',
];

/** 变体 B 的顺序，与 filter_global_only.py 的 KEEP 一致（干净的模型序） */
const VARIANT_GLOBAL_ORDER = [
  'sef-global-claude-opus-4-6-v1',
  'sef-global-claude-sonnet-4-6',
  'sef-global-claude-opus-4-7',
  'sef-global-claude-opus-4-8',
  'sef-global-claude-sonnet-5',
  'sef-global-claude-opus-5',
  // 2026-10 新增 5.5 系列（账户里没有的会自动跳过并记入 missing）
  'sef-global-claude-sonnet-5-5',
  'sef-global-claude-opus-5-5',
  'sef-global-claude-haiku-5-5',
];

export function deliveryOrderFor(variant: DeliveryVariant): string[] {
  return variant === 'global' ? VARIANT_GLOBAL_ORDER : VARIANT_FULL_ORDER;
}

/**
 * Profile 名归一化，用于精确匹配失败后的**回退**匹配。
 *
 * 起因：账户 703844615335（HDL Account 7）里 6 个核心模型全都在，
 * 但 Profile 名是控制台默认风格「Global Anthropic Claude Opus 4.6」，
 * 而清单用的是「sef-global-claude-opus-4-6-v1」，精确查表一条都命不中，
 * 导致交付表导出报「找不到任何交付清单内的 Profile」。
 *
 * 归一化规则（只做无歧义的形态折叠，不做语义猜测）：
 *   1. 转小写、去首尾空格
 *   2. 丢弃 `sef-` / `self-` 前缀（内部命名约定，非模型信息）
 *   3. 丢弃 `anthropic` / `claude` 词（各账户写法不一，不携带区分度）
 *   4. 版本号里的 `.` 视同 `-`（4.6 ≡ 4-6）
 *   5. 丢弃结尾的 `-v1` / `-v1:0` 与 8 位日期戳
 *   6. 所有非字母数字压成单个 `-`
 *
 * 实测遇到的三种命名，必须都能折叠到同一形态：
 *   sef-global-claude-opus-4-7                      （交付清单）
 *   Self-global-claude-opus-4-7                     （账户 106360388618）
 *   Global Anthropic Claude Opus 4.7                （账户 703844615335）
 *   Self-global-claude-sonnet-4-5-20250929-v1:0     （带日期戳与版本后缀）
 *
 * ⚠️ scope 词（us / global）**必须保留**：它是变体 A 里区分
 * `sef-us-claude-opus-4-8` 与 `sef-global-claude-opus-4-8` 的唯一依据，
 * 折叠掉会让两者互相顶替，交付表出错且难以察觉。
 */
export function normalizeProfileName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .trim()
    // sef- 与 self- 都是内部前缀；不同账户用法不一，实测两种都存在
    .replace(/^(sef|self)-/, '')
    .replace(/\banthropic\b/g, ' ')
    .replace(/\bclaude\b/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1-$2')
    .replace(/[^a-z0-9]+/g, '-')
    // 先剥版本后缀（-v1 / -v1-0，源自 :0），再剥 8 位日期戳。
    // 顺序不能反：日期戳在版本号前面（...-20250929-v1-0）。
    .replace(/-v\d+(-\d+)?$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/^-+|-+$/g, '');
}

/**
 * 按变体筛选 + 排序。规范要求交付表只含核心 9 模型（原 6 个 + 5.5 系列 3 个），且顺序固定；
 * 账户里的老模型（3-haiku / opus-4-1 / opus-4-5 / sonnet-4 / sonnet-4-5 /
 * haiku-4-5 / fable-5 / fable-5-1）一律不出现在交付表中。
 * 注意 haiku-5-5 在白名单而 haiku-4-5 不在：两者归一化后不同（haiku-5-5 ≠ haiku-4-5），测试锁定。
 *
 * 采用**白名单**而非黑名单：AWS 随时会上新模型，黑名单会漏，
 * 白名单能保证交付表内容完全可预期。
 * 账户中不存在的型号自动跳过（规范：「账户缺某系列时自动跳过」）。
 */
export function filterAndSortForDelivery<T extends { name: string; region: string }>(
  rows: T[], variant: DeliveryVariant,
): { kept: T[]; dropped: string[]; missingByRegion: Map<string, string[]> } {
  const order = deliveryOrderFor(variant);
  const rank = new Map(order.map((n, i) => [n, i]));
  const norm = (s: string) => String(s || '').trim();
  // 清单名的归一化形态 → 清单原名。用于精确匹配失败后的回退。
  const normOrder = new Map(order.map(n => [normalizeProfileName(n), n]));

  const kept: T[] = [];
  const matchedNames = new Set<string>();
  const missingByRegion = new Map<string, string[]>();
  // 按区域分组后，各区内按清单顺序取；同名重复保留首个（与源表/历史一致）
  const byRegion = new Map<string, Map<string, T>>();
  const byRegionNorm = new Map<string, Map<string, T>>();
  for (const r of rows) {
    const reg = norm(r.region);
    if (!byRegion.has(reg)) { byRegion.set(reg, new Map()); byRegionNorm.set(reg, new Map()); }
    const m = byRegion.get(reg)!;
    if (!m.has(norm(r.name))) m.set(norm(r.name), r);
    // 归一化索引同样「保留首个」，避免同区内两个变体名互相覆盖
    const mn = byRegionNorm.get(reg)!;
    const nk = normalizeProfileName(r.name);
    if (nk && !mn.has(nk)) mn.set(nk, r);
  }
  for (const [reg, m] of byRegion) {
    const mn = byRegionNorm.get(reg)!;
    const missing: string[] = [];
    for (const name of order) {
      // 精确优先：历史交付件与规范都按原名对齐，不能被回退逻辑改变既有行为
      const hit = m.get(name) ?? mn.get(normalizeProfileName(name));
      if (hit) { kept.push(hit); matchedNames.add(norm(hit.name)); }
      else missing.push(name);
    }
    if (missing.length) missingByRegion.set(reg, missing);
  }
  // dropped 表示「账户里有、但不属于交付清单」。经回退命中的行已进交付表，
  // 不能再算作 dropped，否则审计日志里的剔除数会虚高。
  const dropped = [...new Set(
    rows.map(r => norm(r.name))
      .filter(n => !rank.has(n) && !matchedNames.has(n) && !normOrder.has(normalizeProfileName(n))),
  )].sort();
  return { kept, dropped, missingByRegion };
}

export async function buildDeliveryXlsxV2(
  rows: DeliveryProfileRowV2[], iamUser: string, iamPassword: string,
): Promise<{ buffer: Buffer; accountId: string; tagValue: string }> {
  const { grouped, tagValue, accountId } = prepareDelivery(rows);
  // AWS 2026 起取消了 Anthropic 逐模型 TPD，改为账户级跨模型总配额。
  // 此时表里各行 TPD 是同一个共享额度，必须说明，否则客户会按「每模型独享」理解，
  // 误判整体吞吐上限（比如 6 个模型不是 6×540M，仍是 540M）。
  const hasShared = rows.some(r => r.tpdShared);
  const notice = DELIVERY_NOTICE(tagValue) + (hasShared
    ? '\n 9. 关于 TPD（每日 Token 上限）\n'
      + '上表 TPD 取自账户级跨模型配额（Cross-Model Account-Level Tokens Per Day），'
      + '该额度由本账户下所有模型共享，并非每个模型各自独享；'
      + '各模型的 TPM（每分钟 Token）仍是独立配额。'
    : '');

  const wb = new ExcelJS.Workbook();
  // 工作表名固定（李浩版规范：不随日期变）
  const ws = wb.addWorksheet('inference_profiles_20260320_184');
  ws.columns = [{ width: 33.65 }, { width: 79.64 }, { width: 18 }, { width: 20 }, { width: 59.77 }];

  const fontTitle = { name: '宋体', size: 16, bold: true };
  const fontBody = { name: '宋体', size: 11 };
  const fontBlue = { name: '宋体', size: 11, color: { argb: 'FF0000FF' } };
  const fontNotice = { name: '宋体', size: 11, color: { argb: 'FFFF0000' } };
  const border: any = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  const center: any = { horizontal: 'center', vertical: 'middle' };
  const body: any = { vertical: 'middle' };

  const setCell = (row: number, col: number, value: any, font: any, align: any, numFmt?: string) => {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font = font;
    cell.alignment = align;
    cell.border = border;
    if (numFmt) cell.numFmt = numFmt;
  };

  // 区块一：AWS 账户信息（A1:E1 标题；Password 占 B:D 合并）
  ws.mergeCells(1, 1, 1, 5);
  setCell(1, 1, 'AWS 账户信息', fontTitle, center);
  ws.getRow(1).height = 23.2;
  setCell(2, 1, 'User name', fontBody, body);
  ws.mergeCells(2, 2, 2, 4);
  setCell(2, 2, 'Password', fontBody, body);
  setCell(2, 5, 'Console sign-in URL', fontBody, body);
  setCell(3, 1, iamUser.trim(), fontBody, body);
  ws.mergeCells(3, 2, 3, 4);
  setCell(3, 2, iamPassword.trim(), fontBlue, body);
  setCell(3, 5, `https://${accountId}.signin.aws.amazon.com/console`, fontBlue, body);

  // 区块二：ARN 列表（第 4 行空）
  ws.mergeCells(5, 1, 5, 5);
  setCell(5, 1, 'AWS 模型推理配置文件ARN List', fontTitle, center);
  ws.getRow(5).height = 23.2;
  ['Profile Name', 'Profile ARN', 'TPM', 'TPD', 'Region'].forEach((h, i) => setCell(6, i + 1, h, fontBody, body));

  let row = 7;
  for (const [region, items] of grouped) {
    const start = row;
    for (const item of items as DeliveryProfileRowV2[]) {
      setCell(row, 1, item.name.trim(), fontBody, body);
      setCell(row, 2, item.arn.trim(), fontBody, body);
      setCell(row, 3, Math.round(item.tpm || 0), fontBody, body, '#,##0');
      setCell(row, 4, Math.round(item.tpd || 0), fontBody, body, '#,##0');
      setCell(row, 5, null, fontBody, center);
      row += 1;
    }
    ws.mergeCells(start, 5, row - 1, 5);
    setCell(start, 5, region, fontBody, center);
  }
  ws.getRow(row - 1).height = 23.2;

  // 区块三：使用须知（紧接 ARN，无空行；正文无边框、红字、左上对齐、wrap）
  const titleRow = row;
  ws.mergeCells(titleRow, 1, titleRow, 5);
  setCell(titleRow, 1, 'Amazon Bedrock 账户使用须知', fontTitle, center);
  ws.getRow(titleRow).height = 23.2;
  const noticeRow = titleRow + 1;
  ws.mergeCells(noticeRow, 1, noticeRow + 24, 5);
  const noticeCell = ws.getCell(noticeRow, 1);
  noticeCell.value = notice;
  noticeCell.font = fontNotice;
  noticeCell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, accountId, tagValue };
}
