export function exportToCSV(data: Record<string, any>[], filename: string) {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]);
  const csvRows = [headers.join(','), ...data.map(row => headers.map(h => {
    const str = String(row[h] ?? '').replace(/"/g, '""');
    return str.includes(',') || str.includes('\n') ? `"${str}"` : str;
  }).join(','))];
  const blob = new Blob(['\uFEFF' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function exportToJSON(data: any, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}_${new Date().toISOString().split('T')[0]}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// Region display names
const REGION_NAMES: Record<string, string> = {
  'us-east-1': '美国·弗吉尼亚', 'us-east-2': '美国·俄亥俄', 'us-west-1': '美国·加州', 'us-west-2': '美国·俄勒冈',
  'eu-west-1': '爱尔兰', 'eu-west-2': '伦敦', 'eu-west-3': '巴黎', 'eu-north-1': '斯德哥尔摩', 'eu-central-1': '法兰克福',
  'ap-southeast-1': '新加坡', 'ap-southeast-2': '悉尼', 'ap-southeast-3': '雅加达', 'ap-southeast-4': '墨尔本', 'ap-southeast-5': '马来西亚',
  'ap-northeast-1': '东京', 'ap-northeast-2': '首尔', 'ap-northeast-3': '大阪',
  'ap-south-1': '孟买', 'ap-south-2': '海得拉巴', 'ap-east-1': '香港', 'ap-east-2': '台北',
  'sa-east-1': '巴西·圣保罗', 'ca-central-1': '加拿大', 'ca-west-1': '加拿大·卡尔加里',
  'af-south-1': '开普敦', 'me-south-1': '巴林', 'me-central-1': '阿联酋',
  'eu-south-1': '米兰', 'eu-south-2': '西班牙', 'eu-central-2': '苏黎世',
  'il-central-1': '特拉维夫', 'ap-southeast-6': '新西兰', 'ap-southeast-7': '泰国', 'mx-central-1': '墨西哥',
};

/**
 * Export quota requests as a pivot table (Excel HTML format)
 * Rows = quota names, Columns = regions, Cells = current value (desired value highlighted)
 */
export function exportQuotaPivotTable(records: any[], accountName: string, filename: string) {
  if (records.length === 0) return;

  // Get unique regions and quotas
  const regions = [...new Set(records.map(r => r.region || 'us-east-1'))].sort();
  const quotaMap: Record<string, { desired: number; byRegion: Record<string, { current: any; desired: number; status: string }> }> = {};

  for (const r of records) {
    const name = r.quota_name || r.QuotaName || '';
    const region = r.region || r._region || 'us-east-1';
    if (!quotaMap[name]) quotaMap[name] = { desired: r.desired_value || r.DesiredValue, byRegion: {} };
    quotaMap[name].byRegion[region] = {
      current: r.current_value ?? r._currentValue ?? '-',
      desired: r.desired_value || r.DesiredValue,
      status: r.status || r.Status?.Value || '',
    };
    // Use the max desired value
    const dv = r.desired_value || r.DesiredValue || 0;
    if (dv > quotaMap[name].desired) quotaMap[name].desired = dv;
  }

  const quotaNames = Object.keys(quotaMap).sort();

  // Build HTML table
  let html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="utf-8">
<style>
  table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 11px; }
  th { background: #4472C4; color: #fff; padding: 6px 10px; border: 1px solid #2F5496; text-align: center; font-weight: bold; }
  td { padding: 5px 10px; border: 1px solid #B4B4B4; text-align: center; }
  tr:nth-child(even) td { background: #F2F2F2; }
  .quota-name { text-align: left; font-weight: 500; min-width: 280px; }
  .desired { background: #FFFF00 !important; font-weight: bold; }
  .achieved { background: #C6EFCE; color: #006100; font-weight: bold; }
  .pending { background: #FFF2CC; }
  .header-sub { font-size: 10px; color: #D9E2F3; font-weight: normal; }
  h2 { font-family: Arial; margin-bottom: 8px; }
  .meta { font-size: 11px; color: #666; margin-bottom: 12px; }
</style>
</head><body>
<h2>${accountName} — 配额提升记录</h2>
<p class="meta">导出时间: ${new Date().toLocaleString('zh-CN')} | 共 ${records.length} 条记录 | ${regions.length} 个区域</p>
<table>
<tr>
  <th class="quota-name">配额项</th>
  <th>需求值</th>
  ${regions.map(r => `<th>${REGION_NAMES[r] || r}<br><span class="header-sub">(${r})</span></th>`).join('')}
</tr>`;

  for (const name of quotaNames) {
    const q = quotaMap[name];
    html += `<tr>
  <td class="quota-name">${name}</td>
  <td class="desired">${q.desired}</td>`;
    for (const region of regions) {
      const cell = q.byRegion[region];
      if (!cell) {
        html += `<td>-</td>`;
      } else {
        const isAchieved = cell.current !== '-' && cell.current !== null && Number(cell.current) >= cell.desired;
        const isPending = cell.status === 'CASE_OPENED' || cell.status === 'PENDING';
        const cls = isAchieved ? 'achieved' : isPending ? 'pending' : '';
        html += `<td class="${cls}">${cell.current !== null && cell.current !== '-' ? cell.current : '-'}</td>`;
      }
    }
    html += `</tr>`;
  }

  html += `</table>
<br>
<p class="meta">
  <span style="background:#FFFF00;padding:2px 8px;">■</span> 需求值 &nbsp;
  <span style="background:#C6EFCE;padding:2px 8px;">■</span> 已达标 &nbsp;
  <span style="background:#FFF2CC;padding:2px 8px;">■</span> 进行中
</p>
</body></html>`;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}_${new Date().toISOString().split('T')[0]}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Export full quota records as a detailed list (better formatted CSV)
 */
export function exportQuotaRecords(records: any[], accounts: any[], filename: string) {
  if (records.length === 0) return;

  const rows = records.map(r => {
    const acct = accounts.find((a: any) => a.Id === r.account_id);
    const region = r.region || 'us-east-1';
    const regionName = REGION_NAMES[region] || region;
    const createdAt = r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '-';
    const current = r.current_value ?? '-';
    const desired = r.desired_value ?? '-';
    const achieved = current !== '-' && desired !== '-' && Number(current) >= Number(desired) ? '✓' : '';

    return {
      '账户ID': r.account_id,
      '账户名称': acct?.Name || '-',
      '组织': acct?._payer || '-',
      '配额名称': r.quota_name || '-',
      '服务': r.service_code || '-',
      '区域': `${regionName} (${region})`,
      '当前值': current,
      '期望值': desired,
      '已达标': achieved,
      '状态': r.status || '-',
      'Case ID': r.case_id || '-',
      '创建时间': createdAt,
    };
  });

  exportToCSV(rows, filename);
}
