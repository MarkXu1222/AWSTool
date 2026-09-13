/**
 * Bedrock 客户交付表格生成（xlsx）。
 * 从桌面版 delivery_build/delivery_verify 迁移：三个区块
 *   1) AWS 账户信息（IAM 用户名/密码/Console URL）
 *   2) 模型推理配置文件 ARN List（按区域分组、区域列合并单元格）
 *   3) Amazon Bedrock 账户使用须知（红字，map-migrated tag 替换为本单实际 tag）
 * 交付须知文案内置（桌面版从模板 xlsx 提取，平台内置等价文案）。
 */
import ExcelJS from 'exceljs';

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

/**
 * 校验并分组：账户 ID 全表唯一；tag（map-migrated）全表唯一且必须存在。
 * 平台纪律：tag 不做默认值，来自 Profile 实际打的 tag。
 */
export function prepareDelivery(rows: DeliveryProfileRow[]) {
  if (!rows.length) throw new Error('没有 Profile 数据');

  const accountIds = new Set(rows.map(r => r.arn.split(':')[4]).filter(Boolean));
  if (accountIds.size !== 1) throw new Error(`ARN 中的账户 ID 不唯一：${[...accountIds].join(', ')}`);
  const accountId = [...accountIds][0];

  const tagValues = new Set<string>();
  for (const r of rows) {
    const mig = (r.tags || []).find(t => t.key === 'map-migrated');
    if (!mig || !mig.value) throw new Error(`Profile「${r.name}」没有 map-migrated tag，不能交付`);
    tagValues.add(mig.value);
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
}

export async function buildDeliveryXlsxV2(
  rows: DeliveryProfileRowV2[], iamUser: string, iamPassword: string,
): Promise<{ buffer: Buffer; accountId: string; tagValue: string }> {
  const { grouped, tagValue, accountId } = prepareDelivery(rows);
  const notice = DELIVERY_NOTICE(tagValue);

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
