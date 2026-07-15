// 稳定的颜色哈希:同一字符串永远得到同一组颜色。用于账户头像、组织标签等。
export interface ColorPair {
  bg: string;
  fg: string;
}

const PALETTE: ColorPair[] = [
  { bg: '#eff4ff', fg: '#2563eb' }, // blue
  { bg: '#ecfdf5', fg: '#059669' }, // emerald
  { bg: '#fff7ed', fg: '#ea580c' }, // orange
  { bg: '#f5f3ff', fg: '#7c3aed' }, // violet
  { bg: '#ecfeff', fg: '#0891b2' }, // cyan
  { bg: '#fdf2f8', fg: '#db2777' }, // pink
  { bg: '#fefce8', fg: '#ca8a04' }, // amber
  { bg: '#f0fdf4', fg: '#16a34a' }, // green
  { bg: '#eef2ff', fg: '#4f46e5' }, // indigo
  { bg: '#fef2f2', fg: '#e11d48' }, // rose
];

export function hashColor(input: string): ColorPair {
  const str = input || '';
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

export function initials(name: string): string {
  const s = (name || '').trim();
  if (!s) return '?';
  return s.charAt(0).toUpperCase();
}
