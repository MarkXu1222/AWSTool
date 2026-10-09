/**
 * EC2 Mac 专用主机配额的权威映射（服务端用）。
 *
 * 名称与代码以 AWS Service Quotas 列表为准（2026-10 实测 us-east-1）。
 * 与前端 client/src/constants/quota-presets.ts 的 Mac 预设由 tests/mac-quotas.test.ts
 * 锁定一致。
 *
 * ⚠️ 只做**精确**识别（配额代码，或完整官方名称），不做子串/关键词猜测：
 * 同服务下有 mac2 / mac2-m2 / mac2-m2pro / mac2-m1ultra / mac-m4 / mac-m4pro /
 * mac-m4max / mac-m3ultra / mac1 等同构名称，早期按 includes('m4') 猜，
 * 「mac-m4pro」会被当成 M4，「mac2」（实为 M1）会被默认成 M2。
 */
export interface MacHostQuota {
  quotaCode: string;
  quotaName: string;
  chip: string;
  instanceType: string;
}

export const MAC_HOST_QUOTAS: MacHostQuota[] = [
  { quotaCode: 'L-5D8DADF5', quotaName: 'Running Dedicated mac2 Hosts', chip: 'Apple M1', instanceType: 'mac2.metal' },
  { quotaCode: 'L-B90B5B66', quotaName: 'Running Dedicated mac2-m2 Hosts', chip: 'Apple M2', instanceType: 'mac2-m2.metal' },
  { quotaCode: 'L-2CBA8B92', quotaName: 'Running Dedicated mac-m4 Hosts', chip: 'Apple M4', instanceType: 'mac-m4.metal' },
];

/** 按配额代码或完整官方名称（忽略大小写与首尾空白）识别型号；识别不了返回 null */
export function findMacHostQuota(quotaCode?: string | null, quotaName?: string | null): MacHostQuota | null {
  const code = String(quotaCode || '').trim().toUpperCase();
  if (code) {
    const byCode = MAC_HOST_QUOTAS.find(m => m.quotaCode === code);
    if (byCode) return byCode;
  }
  const name = String(quotaName || '').trim().toLowerCase();
  if (name) {
    const byName = MAC_HOST_QUOTAS.find(m => m.quotaName.toLowerCase() === name);
    if (byName) return byName;
  }
  return null;
}

/** 是否是 Mac 专用主机类配额（含未收录的型号，如 mac-m4pro），用于归类与单位 */
export function isMacHostQuotaName(quotaName?: string | null): boolean {
  return /^running dedicated mac[\w.-]* hosts$/i.test(String(quotaName || '').trim());
}

/** 申请值必须为整数的配额（专用主机按台计） */
export function isIntegerOnlyQuota(quotaCode?: string | null, quotaName?: string | null): boolean {
  return !!findMacHostQuota(quotaCode, quotaName) || isMacHostQuotaName(quotaName);
}
