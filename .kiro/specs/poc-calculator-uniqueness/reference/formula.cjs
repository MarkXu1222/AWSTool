const H = 730;
const EC2 = { 'm6i.large':0.102,'m6i.xlarge':0.204,'m6i.2xlarge':0.408,'m7i.large':0.1071,'m7i.xlarge':0.2142,'m7i.2xlarge':0.4284,'c6i.xlarge':0.1666,'c6i.2xlarge':0.3332,'c7i.large':0.08747,'c7i.xlarge':0.17494,'c7i.2xlarge':0.34988,'r6i.large':0.1292,'r6i.xlarge':0.2584,'r7i.large':0.13566,'r7i.xlarge':0.27132,'m7g.large':0.0867,'m7g.xlarge':0.1734,'m7g.2xlarge':0.3468,'c7g.xlarge':0.1416,'r7g.large':0.1098,'r7g.xlarge':0.2196,'t3.large':0.095,'t3.xlarge':0.1901 };
const RDS = { 'db.t4g.large':0.183,'db.m6g.large':0.188,'db.m6g.xlarge':0.376,'db.m7g.large':0.199,'db.m7g.xlarge':0.398,'db.r6g.large':0.23,'db.r6g.xlarge':0.46,'db.r7g.large':0.244 };
const AUR = { 'db.r6g.large':0.266,'db.r6g.xlarge':0.532,'db.r7g.large':0.283,'db.r7g.xlarge':0.566 };
const EC = { 'cache.m6g.large':0.157,'cache.m6g.xlarge':0.314,'cache.m7g.large':0.1664,'cache.m7g.xlarge':0.3328 };
const r2 = v => Math.round(v * 100) / 100;
const F = {
  ec2: p => p.count * (EC2[p.instanceType] * H + p.storageGbPerInstance * 0.0864),
  'ebs-volume': p => p.volumes * p.gbPerVolume * 0.108,
  s3: p => p.gb * 0.0225 + p.putRequests / 1000 * 0.0045 + p.getRequests / 1000 * 0.00036,
  alb: p => p.count * H * (0.0227 + p.gbPerHour * 0.008),
  cloudwatch: p => p.metrics * 0.30 + p.logGb * 0.5045 + Math.max(0, p.dashboards - 3) * 3 + p.alarms * 0.10,
  cloudtrail: p => (p.writeTrails - 1) * p.eventsMillions * 20,
  'rds-mysql': p => { const m = p.deployment === 'Multi-AZ' ? 2 : 1; return p.nodes * (RDS[p.instanceType] * m * H + p.storageGb * 0.124 * m) + p.backupGb * 0.086; },
  'aurora-mysql': p => p.nodes * AUR[p.instanceType] * H + p.storageGb * 0.099,
  elasticache: p => p.nodes * EC[p.instanceType] * H,
  'nat-gateway': p => p.gateways * (H * 0.05015 + p.gbPerGateway * 0.05015),
  waf: p => p.webAcls * (5 + p.rulesPerAcl + p.managedGroupsPerAcl) + p.requestsMillions * 0.6,
  'api-gateway-http': p => p.requestsMillions * 1.125,
  route53: p => p.hostedZones * 0.5 + p.queriesMillions * 0.4,
  'secrets-manager': p => p.secrets * 0.4 + p.apiCalls / 10000 * 0.05,
  'backup-ebs': p => p.gb * 0.07089,
  efs: p => p.storageGb * 0.324 + p.readGb * 0.036 + p.writeGb * 0.063,
  ecr: p => p.gb * 0.10,
  kms: p => p.keys * 1 + p.requests / 10000 * 0.03,
  sqs: p => p.requestsMillions * 0.34,
};
F['rds-postgresql'] = F['rds-mysql'];
module.exports = { F, r2 };
if (require.main === module) {
  const fx = require(process.argv[2]);
  let worst = 0; const bad = [];
  for (const c of fx.cases) { const v = r2(F[c.service](c.params)); const d = Math.abs(v - c.engineMonthlyUsd); worst = Math.max(worst, d); if (d > 0.02) bad.push([c.service, JSON.stringify(c.params), v, c.engineMonthlyUsd]); }
  console.log('cases', fx.cases.length, 'worst', worst.toFixed(4)); for (const b of bad) console.log('BAD', ...b);
}
