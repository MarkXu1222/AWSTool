import type { MailApiClient } from './mail-api';
import { mailRecordMatches } from './mail-api';
import { matchRootRecoveryMail } from './root-mail-links';

type MailPageResult = { kind: 'found'; mailKey: string; receivedAt: string }
  | { kind: 'pending'; cursor: number; hasMore: boolean };

/** Advance the cursor only after every relevant message on this page was checked. */
export async function scanRootMailPage(client: Pick<MailApiClient, 'list' | 'detail'>,
  job: { email: string; requestedAt: string; mailCursor?: number },
  check: () => void, signal?: AbortSignal): Promise<MailPageResult> {
  check();
  const page = await client.list(job.email, job.mailCursor || 0, signal);
  check();
  for (const record of page.list) {
    if (!mailRecordMatches(record, job.email, job.requestedAt)) continue;
    check();
    const mail = await client.detail(record.msg_key, signal);
    check();
    if (matchRootRecoveryMail(mail, job.email, job.requestedAt)) {
      return { kind: 'found', mailKey: record.msg_key, receivedAt: mail.receivedAt };
    }
  }
  return { kind: 'pending', cursor: page.next_since, hasMore: page.has_more };
}

/** Rediscover only the exact mail already bound to a failed automatic task; never infer by a broad request window. */
export async function findRootRecoveryLinks(client: Pick<MailApiClient, 'list' | 'detail'>,
  job: { email: string; requestedAt: string; mailReceivedAt: string }, check: () => void,
  signal?: AbortSignal, maxPages = 10): Promise<string[]> {
  const requestedAt = Date.parse(job.requestedAt);
  const expectedReceivedAt = Date.parse(job.mailReceivedAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expectedReceivedAt)) return [];
  const links = new Set<string>();
  let cursor = 0;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    check();
    const page = await client.list(job.email, cursor, signal);
    check();
    for (const record of page.list) {
      const receivedAt = record.timestamp * 1_000;
      if (!mailRecordMatches(record, job.email, job.requestedAt)
        || Math.abs(receivedAt - expectedReceivedAt) > 1_000) continue;
      check();
      const mail = await client.detail(record.msg_key, signal);
      check();
      const link = matchRootRecoveryMail(mail, job.email, job.requestedAt);
      if (link && Math.abs(Date.parse(mail.receivedAt) - expectedReceivedAt) <= 1_000) links.add(link);
    }
    if (!page.has_more || page.next_since <= cursor) break;
    cursor = page.next_since;
  }
  return [...links];
}