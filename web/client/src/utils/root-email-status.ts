import type { RootEmailJobView } from '../api';

/** Do not label an uncertain CAPTCHA submission as a confirmed recovery email. */
export function rootEmailStatusLabel(job: RootEmailJobView, fallback: string): string {
  if (job.status === 'running' && job.phase === 'manual_captcha') return '待手工验证码';
  if (job.status === 'running' && job.phase === 'resuming') return '等待继续验证';
  if (job.status === 'waiting_mail') return job.emailDeliveryState === 'aws_confirmed' ? '已发信·等待收件' : '发信未确认·核查邮箱';
  if (job.status === 'mail_failed' && job.emailDeliveryState === 'unconfirmed') return '发信未确认';
  return fallback;
}
