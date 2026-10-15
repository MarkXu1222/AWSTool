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

export async function sendNotification(title: string, content: string, options: { strict?: boolean } = {}) {
  if (!FEISHU_WEBHOOK) {
    if (options.strict) throw new Error('飞书通知未配置');
    console.log('[Notify] No Feishu webhook configured, skipping');
    return;
  }

  try {
    const resp = await fetch(FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.strict ? AbortSignal.timeout(15_000) : undefined,
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
    const data: any = await resp.json();
    if (options.strict && (!resp.ok || (data.code !== 0 && data.StatusCode !== 0))) {
      throw new Error('飞书通知未确认送达');
    }
    if (data.code === 0 || data.StatusCode === 0) {
      console.log(`[Notify] ✅ Sent: ${title}`);
    } else {
      console.log(`[Notify] ❌ Failed:`, data.msg || data.message || JSON.stringify(data));
    }
  } catch (e: any) {
    if (options.strict) throw new Error('飞书通知发送失败');
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
    const data: any = await resp.json();
    if (data.code === 0 || data.StatusCode === 0) console.log(`[Notify] ✅ Sent: ${title}`);
    else console.log(`[Notify] ❌ Failed:`, data.msg || JSON.stringify(data));
  } catch (e: any) {
    console.error(`[Notify] Error: ${e.message}`);
  }
}

/*
 * 2026-09-15：移除配额相关飞书通知。
 * - notifyQuotaChanged：按运营要求停推（变动仍照常落库，查配额页即可）。
 * - notifyQuotaAchieved：历史死代码，全项目无调用点，一并删除。
 */

/**
 * 账户角色不可达告警 —— 自动补齐重试到上限仍失败的账户。
 * 这类账户在 Organizations 里通常显示 ACTIVE、平台列表里也看得到，
 * 但平台无法 AssumeRole 进去，属于需要人工介入的情况（常见于账户未完成激活）。
 */
export async function notifyAccountRoleIssues(
  records: { accountId: string; accountName: string; payer: string; support: boolean; admin: boolean }[],
) {
  if (records.length === 0) return;

  const elements: any[] = [];
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `检测到 **${records.length}** 个账户缺少平台所需角色，且自动补齐已重试到上限，需要人工处理。`,
    },
  });
  elements.push({ tag: 'hr' });

  const MAX_SHOW = 15;
  for (const r of records.slice(0, MAX_SHOW)) {
    const miss: string[] = [];
    // admin-console 已改为按需临时开通，缺失是健康状态，不再告警
    if (!r.support) miss.push('support-quota');
    const orgLabel = r.payer ? `<font color='blue'>[${r.payer}]</font> ` : '';
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column', width: 'weighted', weight: 5, vertical_align: 'center',
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: `${orgLabel}**${r.accountName}**\n<font color='grey'>${r.accountId}</font>` } }],
        },
        {
          tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: `<font color='red'>缺 ${miss.join(' / ')}</font>` } }],
        },
      ],
    });
  }

  if (records.length > MAX_SHOW) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `还有 ${records.length - MAX_SHOW} 个未显示，请登录系统查看` }] });
  }

  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `常见原因：账户未完成激活（CloudFormation 返回 OptInRequired）。AWS Toolbox · ${new Date().toLocaleString('zh-CN')}` }],
  });

  await sendCard(`账户角色缺失 · ${records.length} 个`, 'red', elements);
}
