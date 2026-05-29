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
          header: {
            title: { tag: 'plain_text', content: title },
            template: 'green',
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
