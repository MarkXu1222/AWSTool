import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRootResetLinks, matchRootRecoveryMail, validateRootResetLink } from '../server/root-mail-links';

// Synthetic values only; never use real mail tokens in a fixture.
const link = 'https://signin.aws.amazon.com/resetpassword?type=RootUser&token=synthetic_token_12345678&key=synthetic_key_12345678';
const now = Date.parse('2026-09-14T15:00:00Z');
const mail = { id: 'mail-1', recipients: ['owner@example.test'], receivedAt: '2026-09-14T14:59:00Z', text: `Reset: ${link}` };

test('extracts AWS links from decoded text and HTML without evaluating email content', () => {
  assert.deepEqual(extractRootResetLinks({ text: `${link}\nhttps://aws.amazon.com/support`,
    html: `<a href="${link.replaceAll('&', '&amp;')}">Reset password</a>` }), [link]);
  assert.deepEqual(extractRootResetLinks({ html: `<a href='${link.replaceAll('&', '&#38;')}'>reset</a>` }), [link]);
});
test('rejects lookalike hosts, insecure URLs, wrong user type and duplicate/extra parameters', () => {
  for (const value of [link.replace('https:', 'http:'), link.replace('.com/', '.com.evil.test/'),
    link.replace('signin.aws.amazon.com', 'signin.aws.amazon.com@evil.test'), link.replace('RootUser', 'IAMUser'),
    link + '&token=second_token_12345', link + '&redirect=https://evil.test', link + '#fragment',
    link.replace('/resetpassword?', '/other?')]) assert.equal(validateRootResetLink(value), null);
});
test('matches the exact recipient and request time, rejecting old mail and ambiguous links', () => {
  assert.equal(matchRootRecoveryMail(mail, 'OWNER@example.test', '2026-09-14T14:58:00Z', now), link);
  assert.equal(matchRootRecoveryMail(mail, 'other@example.test', '2026-09-14T14:58:00Z', now), null);
  assert.equal(matchRootRecoveryMail(mail, 'owner@example.test', '2026-09-14T14:59:01Z', now), null);
  assert.equal(matchRootRecoveryMail({ ...mail, text: link + '\n' + link.replace('synthetic_token', 'different_token') },
    'owner@example.test', '2026-09-14T14:58:00Z', now), null);
  assert.equal(matchRootRecoveryMail({ ...mail, receivedAt: 'invalid' }, 'owner@example.test', '2026-09-14T14:58:00Z', now), null);
});
