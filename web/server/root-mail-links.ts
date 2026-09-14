/** Pure mail matching helpers. The mail adapter must supply decoded text/HTML, not raw MIME. */
export interface RootRecoveryMail {
  id: string;
  recipients: string[];
  receivedAt: string;
  text?: string;
  html?: string;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** Accept only the observed AWS RootUser recovery endpoint and its expected credential fields. */
export function validateRootResetLink(value: string): string | null {
  if (value.length > 20_000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'signin.aws.amazon.com'
      || url.port || url.username || url.password || url.hash || url.pathname !== '/resetpassword') return null;
    const params = url.searchParams;
    if (params.getAll('type').length !== 1 || params.get('type') !== 'RootUser'
      || params.getAll('token').length !== 1 || params.getAll('key').length !== 1
      || [...params.keys()].some(key => !['type', 'token', 'key'].includes(key))) return null;
    if (!['token', 'key'].every(name => /^[A-Za-z0-9_+=/-]{16,8192}$/.test(params.get(name) || ''))) return null;
    return url.href;
  } catch { return null; }
}

export function extractRootResetLinks(mail: Pick<RootRecoveryMail, 'text' | 'html'>): string[] {
  const candidates: string[] = [];
  for (const match of (mail.html || '').matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gis)) candidates.push(decodeEntities(match[2]));
  for (const match of (mail.text || '').matchAll(/https?:\/\/[^\s<>"']+/g)) candidates.push(match[0].replace(/[).,;]+$/, ''));
  return [...new Set(candidates.map(validateRootResetLink).filter((link): link is string => link !== null))];
}

/** Do not select a link from another recipient, an old message, or an ambiguous message. */
export function matchRootRecoveryMail(mail: RootRecoveryMail, expectedEmail: string, requestedAt: string, now = Date.now()): string | null {
  const received = Date.parse(mail.receivedAt);
  const requested = Date.parse(requestedAt);
  if (!mail.id || !Number.isFinite(received) || !Number.isFinite(requested)
    || received < requested || received > now + 60_000
    || !mail.recipients.some(address => address.trim().toLowerCase() === expectedEmail.trim().toLowerCase())) return null;
  const links = extractRootResetLinks(mail);
  return links.length === 1 ? links[0] : null;
}
