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
