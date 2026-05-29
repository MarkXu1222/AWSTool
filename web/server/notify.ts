/**
 * Feishu (飞书) Bot notification — sends messages via webhook
 * 
 * Setup: 飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人 → 复制 webhook URL
 */
import path from 'path';
import fs from 'fs';

let FEISHU_WEBHOOK = '';
try {
  const configPath = path.join(__dirname, '../../config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  FEISHU_WEBHOOK = config.web?.feishuWebhook || '';
} catch {}

export async function sendNotification(title: string, content: string) {
  if (!FEISHU_WEBHOOK) {
    console.log('[Notify] No Feishu webhook configured, skipping');
    return;
  }

  try {
    const resp = await fetch(FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: title },
            template: 'blue',
          },
          elements: [{
            tag: 'div',
            text: { tag: 'lark_md', content },
          }],
        },
      }),
    });
    const data = await resp.json();
    if (data.code === 0 || data.StatusCode === 0) {
      console.log(`[Notify] ✅ Sent: ${title}`);
    } else {
      console.log(`[Notify] ❌ Failed:`, data.msg || data.message || JSON.stringify(data));
    }
  } catch (e: any) {
    console.error(`[Notify] Error: ${e.message}`);
  }
}

/**
 * Send a Feishu card with structured elements (cleaner than markdown tables)
 */
async function sendCard(title: string, template: string, elements: any[]) {
  if (!FEISHU_WEBHOOK) {
    console.log('[Notify] No Feishu webhook configured, skipping');
    return;
  }
  try {
    const resp = await fetch(FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: title }, template },
          elements,
        },
      }),
    });
    const data = await resp.json();
    if (data.code === 0 || data.StatusCode === 0) console.log(`[Notify] ✅ Sent: ${title}`);
    else console.log(`[Notify] ❌ Failed:`, data.msg || JSON.stringify(data));
  } catch (e: any) {
    console.error(`[Notify] Error: ${e.message}`);
  }
}

/**
 * Send quota achievement notification
 */
export async function notifyQuotaAchieved(records: { accountId: string; accountName: string; quotaName: string; region: string; currentValue: number; desiredValue: number }[]) {
  if (records.length === 0) return;

  const rows = records.map(r =>
    `| ${r.accountName} | ${r.accountId} | ${r.quotaName} | ${r.region} | **${r.currentValue}** / ${r.desiredValue} |`
  ).join('\n');

  const content = `✅ **${records.length} 个配额已达标**\n\n| 账户 | ID | 配额 | 区域 | 当前/期望 |\n| --- | --- | --- | --- | --- |\n${rows}\n\n---\n_AWS Toolbox 自动检测 · ${new Date().toLocaleString('zh-CN')}_`;

  await sendNotification(`配额达标通知 (${records.length}条)`, content);
}

/**
 * Send quota change notification — clean Feishu card grouped by account.
 * Uses column_set for table-like alignment + colored values.
 */
export async function notifyQuotaChanged(records: { accountId: string; accountName: string; quotaName: string; region: string; oldValue: number; newValue: number; desiredValue: number }[]) {
  if (records.length === 0) return;

  // Shorten common verbose quota names
  const shortName = (name: string) => name
    .replace('Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances', 'On-Demand Standard 实例')
    .replace(/Running On-Demand (.+?) instances/, 'On-Demand $1')
    .replace('Running Dedicated ', 'Dedicated ')
    .replace('EC2-VPC Elastic IPs', 'Elastic IPs');

  // Group by account
  const byAccount: Record<string, typeof records> = {};
  for (const r of records) {
    const key = `${r.accountName}|${r.accountId}`;
    if (!byAccount[key]) byAccount[key] = [];
    byAccount[key].push(r);
  }

  const elements: any[] = [];
  const MAX_ACCOUNTS = 12;
  const accountKeys = Object.keys(byAccount).slice(0, MAX_ACCOUNTS);

  // Summary line
  const reachedCount = records.filter(r => r.desiredValue != null && r.newValue >= r.desiredValue).length;
  const inProgressCount = records.length - reachedCount;
  const summaryParts: string[] = [];
  if (reachedCount > 0) summaryParts.push(`<font color='green'>✅ ${reachedCount} 项达标</font>`);
  if (inProgressCount > 0) summaryParts.push(`<font color='orange'>⏳ ${inProgressCount} 项提升中</font>`);
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `共 **${records.length}** 项配额变动　｜　${summaryParts.join('　')}` },
  });
  elements.push({ tag: 'hr' });

  for (let idx = 0; idx < accountKeys.length; idx++) {
    const [name, id] = accountKeys[idx].split('|');
    const items = byAccount[accountKeys[idx]];

    // Account header
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `🏢 **${name}**　<font color='grey'>${id}</font>` },
    });

    // Each quota as an aligned 2-column row
    for (const r of items) {
      const reached = r.desiredValue != null && r.newValue >= r.desiredValue;
      const changeColor = reached ? 'green' : 'orange';
      elements.push({
        tag: 'column_set',
        flex_mode: 'none',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 5, vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: `${shortName(r.quotaName)}\n<font color='grey'>📍 ${r.region}</font>` } }],
          },
          {
            tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'lark_md', content: `<font color='grey'>${r.oldValue}</font> → <font color='${changeColor}'>**${r.newValue}**</font>${reached ? ' ✅' : ''}\n<font color='grey'>目标 ${r.desiredValue ?? '-'}</font>` } }],
          },
        ],
      });
    }

    if (idx < accountKeys.length - 1) elements.push({ tag: 'hr' });
  }

  if (Object.keys(byAccount).length > MAX_ACCOUNTS) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `还有 ${Object.keys(byAccount).length - MAX_ACCOUNTS} 个账户的变动未显示，请登录系统查看` }] });
  }

  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `AWS Toolbox · ${new Date().toLocaleString('zh-CN')}` }] });

  // Header color: green if all reached, else blue
  const headerColor = inProgressCount === 0 ? 'green' : 'blue';
  await sendCard(`配额变动 · ${records.length} 项`, headerColor, elements);
}
