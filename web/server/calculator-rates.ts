// 2026-10-12 calculator.aws Update estimate 实测；AWS 调价后重跑
// scripts/verify-calculator-render.ts 并更新本文件。
export const CALC_REGION = 'ap-southeast-5' as const;
export const CALC_REGION_NAME = 'Asia Pacific (Malaysia)';
export const HOURS_PER_MONTH = 730;

export const EC2_HOURLY = {
  'm6i.large': 0.102, 'm6i.xlarge': 0.204, 'm6i.2xlarge': 0.408,
  'm7i.large': 0.1071, 'm7i.xlarge': 0.2142, 'm7i.2xlarge': 0.4284,
  'c6i.xlarge': 0.1666, 'c6i.2xlarge': 0.3332,
  'c7i.large': 0.08747, 'c7i.xlarge': 0.17494, 'c7i.2xlarge': 0.34988,
  'r6i.large': 0.1292, 'r6i.xlarge': 0.2584, 'r7i.large': 0.13566, 'r7i.xlarge': 0.27132,
  'm7g.large': 0.0867, 'm7g.xlarge': 0.1734, 'm7g.2xlarge': 0.3468, 'c7g.xlarge': 0.1416,
  'r7g.large': 0.1098, 'r7g.xlarge': 0.2196, 't3.large': 0.095, 't3.xlarge': 0.1901,
} as const;
export type Ec2Type = keyof typeof EC2_HOURLY;

// MySQL/PostgreSQL same measured price; Multi-AZ doubles Single-AZ compute.
export const RDS_HOURLY = {
  'db.t4g.large': 0.183, 'db.m6g.large': 0.188, 'db.m6g.xlarge': 0.376,
  'db.m7g.large': 0.199, 'db.m7g.xlarge': 0.398, 'db.r6g.large': 0.23,
  'db.r6g.xlarge': 0.46, 'db.r7g.large': 0.244,
} as const;
export type RdsType = keyof typeof RDS_HOURLY;
export const AURORA_HOURLY = {
  'db.r6g.large': 0.266, 'db.r6g.xlarge': 0.532,
  'db.r7g.large': 0.283, 'db.r7g.xlarge': 0.566,
} as const;
export type AuroraType = keyof typeof AURORA_HOURLY;
export const ELASTICACHE_HOURLY = {
  'cache.m6g.large': 0.157, 'cache.m6g.xlarge': 0.314,
  'cache.m7g.large': 0.1664, 'cache.m7g.xlarge': 0.3328,
} as const;
export type CacheType = keyof typeof ELASTICACHE_HOURLY;

export const UNIT = {
  ec2EbsGp3GbMonth: 0.0864,
  ebsGp2GbMonth: 0.108,
  s3GbMonth: 0.0225, s3PutPer1k: 0.0045, s3GetPer1k: 0.00036,
  albHour: 0.0227, albLcuHour: 0.008,
  cwMetric: 0.30, cwLogGb: 0.5045, cwDashboard: 3, cwFreeDashboards: 3, cwAlarm: 0.10,
  cloudTrailPerMillionExtraTrail: 20,
  rdsStorageGbMonth: 0.124, rdsBackupGbMonth: 0.086,
  auroraStorageGbMonth: 0.099,
  natHour: 0.05015, natGb: 0.05015,
  wafAcl: 5, wafRule: 1, wafManagedGroup: 1, wafPerMillion: 0.6,
  apiGwHttpPerMillion: 1.125,
  r53Zone: 0.5, r53PerMillion: 0.4,
  secret: 0.4, secretPer10k: 0.05,
  backupEbsGbMonth: 0.07089,
  efsGbMonth: 0.324, efsReadGb: 0.033, efsWriteGb: 0.066,
  ecrGbMonth: 0.10,
  kmsKey: 1, kmsPer10k: 0.03,
  sqsPerMillion: 0.34,
} as const;
