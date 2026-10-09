/**
 * 通用 AWS 部署架构图（内联 SVG）。
 * 行业模式没有公司专属架构图，用这张：Region → VPC → 两个 AZ（公有 / 应用 / 数据子网）。
 * 纯静态图形 + 少量可变文字（区域、应用层名称），文字均已转义。
 */

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);
}

function box(x: number, y: number, w: number, h: number, fill: string, stroke: string, dash = false): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.4"${dash ? ' stroke-dasharray="5 4"' : ''}/>`;
}

function node(x: number, y: number, w: number, h: number, title: string, sub: string, color: string): string {
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>
    <rect x="${x}" y="${y}" width="6" height="${h}" rx="2" fill="${color}"/>
    <text x="${x + w / 2 + 3}" y="${y + h / 2 - 2}" text-anchor="middle" font-size="11" font-weight="600" fill="#232f3e">${esc(title)}</text>
    <text x="${x + w / 2 + 3}" y="${y + h / 2 + 12}" text-anchor="middle" font-size="9" fill="#555">${esc(sub)}</text>
  </g>`;
}

function label(x: number, y: number, text: string, color: string, size = 10, anchor = 'start'): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="600" fill="${color}" text-anchor="${anchor}">${esc(text)}</text>`;
}

function arrow(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#545b64" stroke-width="1.3" marker-end="url(#arr)"/>`;
}

/**
 * @param regionDisplay 例如 "Singapore (ap-southeast-1)"
 * @param computeLabel 应用层节点名（例如 "EC2 Auto Scaling" / "Mac Dedicated Hosts"）
 */
export function genericArchitectureSvg(regionDisplay: string, computeLabel: string): string {
  const W = 720, H = 470;
  const orange = '#ff9900', green = '#3f8624', blue = '#147eba', purple = '#8c4fff', red = '#c7131f';
  const azW = 255, azX1 = 70, azX2 = 345;
  const parts: string[] = [];
  parts.push(`<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#545b64"/></marker></defs>`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  // Users / Internet
  parts.push(node(270, 8, 180, 36, 'End Users / Partners', 'HTTPS / API', '#232f3e'));
  // Region
  parts.push(box(10, 62, 700, 400, '#fafafa', '#147eba', true));
  parts.push(label(20, 78, `AWS Region · ${regionDisplay}`, blue, 11));
  // VPC
  parts.push(box(55, 88, 560, 364, '#f4fbf2', green));
  parts.push(label(65, 103, 'VPC (multi-AZ)', green, 10));
  // Internet gateway + ALB
  parts.push(node(285, 112, 150, 34, 'Internet Gateway', 'ingress / egress', purple));
  parts.push(arrow(360, 44, 360, 112));
  parts.push(node(270, 156, 180, 34, 'Application Load Balancer', 'TLS · health checks', purple));
  parts.push(arrow(360, 146, 360, 156));
  // AZ columns
  for (const [i, x] of [azX1, azX2].entries()) {
    parts.push(box(x, 198, azW, 246, 'none', '#879196', true));
    parts.push(label(x + 8, 212, `Availability Zone ${i + 1}`, '#545b64', 10));
    parts.push(box(x + 10, 218, azW - 20, 44, '#e9f3fb', blue));
    parts.push(label(x + 16, 230, 'Public subnet', blue, 9));
    parts.push(node(x + 90, 232, 100, 26, 'NAT Gateway', '', purple));
    parts.push(box(x + 10, 270, azW - 20, 88, '#eaf6e6', green));
    parts.push(label(x + 16, 282, 'Private subnet · application', green, 9));
    parts.push(node(x + 25, 290, azW - 50, 56, computeLabel, 'core services · workers', orange));
    parts.push(box(x + 10, 366, azW - 20, 70, '#f3eefe', purple));
    parts.push(label(x + 16, 378, 'Private subnet · data', purple, 9));
    parts.push(node(x + 45, 386, azW - 90, 40, i === 0 ? 'Amazon RDS (Primary)' : 'Amazon RDS (Standby)', i === 0 ? 'Multi-AZ' : 'sync replication', blue));
    // ALB → 应用层：直角折线，从 NAT 节点右侧绕过，避免斜线穿过节点
    const ax = x + azW - 30;
    parts.push(`<polyline points="360,190 360,195 ${ax},195 ${ax},290" fill="none" stroke="#545b64" stroke-width="1.3" marker-end="url(#arr)"/>`);
  }
  parts.push(`<line x1="${azX1 + azW - 45}" y1="406" x2="${azX2 + 45}" y2="406" stroke="${blue}" stroke-width="1.3" stroke-dasharray="4 3"/>`);
  // Regional services (right side)
  const sx = 625;
  parts.push(node(sx - 2, 120, 84, 40, 'Amazon S3', 'objects · backup', green));
  parts.push(node(sx - 2, 172, 84, 40, 'CloudWatch', 'metrics · logs', red));
  parts.push(node(sx - 2, 224, 84, 40, 'IAM / KMS', 'access · keys', red));
  parts.push(node(sx - 2, 276, 84, 40, 'CloudTrail', 'audit', red));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="Helvetica Neue, Arial, sans-serif">${parts.join('')}</svg>`;
}
