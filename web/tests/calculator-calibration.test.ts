import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildServiceBlock, monthlyCost, type ServiceItem, type ServiceKind } from '../server/calculator-services';

const templateDir = path.join(__dirname, '../../.kiro/specs/poc-calculator-uniqueness/templates');
const calibration = JSON.parse(readFileSync(path.join(__dirname,
  '../../.kiro/specs/poc-calculator-uniqueness/templates/calibration.json'), 'utf8')) as {
    cases: { service: ServiceKind; params: ServiceItem['params']; engineMonthlyUsd: number }[];
  };

test('112 个 Update estimate 标定月费误差不超过 0.02 USD', () => {
  assert.equal(calibration.cases.length, 112);
  for (const c of calibration.cases) {
    const item = { kind: c.service, params: c.params } as ServiceItem;
    const actual = monthlyCost(item);
    assert.ok(Math.abs(actual - c.engineMonthlyUsd) <= 0.02,
      `${c.service} ${JSON.stringify(c.params)}: ${actual} vs ${c.engineMonthlyUsd}`);
  }
});

const knobPaths: Record<string, string[]> = {
  'ebs-volume': ['numberOfInstances', 'storageAmount'],
  s3: ['s3StandardStorageSize', 's3StandardPutRequests', 's3StandardGetRequests'],
  alb: ['numberOfApplicationLoadBalancers', 'sizeOfDataProcessedForEC2InstanceAndIPAddressTargets'],
  cloudwatch: ['totalNumberOfMetrics', 'sizeOfStandardLogsDataIngested', 'numberOfDashboards', 'numberOfStandardAlarms'],
  cloudtrail: ['numberOfWriteTrails', 'numberOfWriteEvents'],
  'rds-mysql': ['columnFormIPM', 'storageAmount', 'additionalBackupStorage'],
  'rds-postgresql': ['columnFormIPM', 'storageAmount', 'additionalBackupStorage'],
  'aurora-mysql': ['columnFormIPM', 'storageAmount'],
  elasticache: ['columnFormIPM'],
  'nat-gateway': ['numberOfGateways', 'dataProcessedPerNATGateway'],
  waf: ['numberOfWebAcls', 'numberOfRulesPerWebAcl', 'numberOfManangedRules', 'numberOfWebRequests'],
  'api-gateway-http': ['numberOfAPIRequests'],
  route53: ['numberOfHostedZones', 'numberOfStandardQueries'],
  'secrets-manager': ['NumberOfSecrets', 'numberOfAPIs'],
  'backup-ebs': ['dataSize'],
  efs: ['standardStorageSize', 'elasticThroughputReadDataInputSS', 'elasticThroughputWriteDataInputSS'],
  ecr: ['amountofdatastored'],
  kms: ['numberOfCmk', 'numberOfSymmetricRequests'],
  sqs: ['standardQueueRequests'],
};

function withoutChangedFields(source: Record<string, any>): Record<string, any> {
  const block = structuredClone(source);
  for (const field of ['serviceCost', 'configSummary', 'description', 'regionName']) delete block[field];
  if (block.subServices) for (const sub of block.subServices) delete sub.serviceCost.monthly;
  return block;
}

function templateItem(kind: string, template: Record<string, any>): ServiceItem {
  const sample = calibration.cases.find(v => v.service === kind);
  assert.ok(sample);
  const component = ['s3', 'alb', 'nat-gateway', 'backup-ebs'].includes(kind)
    ? template.subServices[0].calculationComponents : template.calculationComponents;
  const values = knobPaths[kind].flatMap(field => field === 'columnFormIPM'
    ? ['Instance Type', 'Number of Nodes', 'Deployment Option']
      .filter(column => component.columnFormIPM.value[0][column])
      .map(column => component.columnFormIPM.value[0][column].value)
    : [component[field].value]);
  const names = Object.keys(sample.params);
  assert.equal(values.length, names.length, kind);
  const params = Object.fromEntries(names.map((name, i) =>
    [name, name === 'instanceType' || name === 'deployment' ? values[i] : Number(values[i])]));
  return { kind: kind as ServiceKind, params } as ServiceItem;
}

test('每种服务的模板非旋钮字段逐字保留', () => {
  for (const kind of Object.keys(knobPaths)) {
    const template = JSON.parse(readFileSync(path.join(templateDir, `${kind}.json`), 'utf8'));
    const item = templateItem(kind, template);
    const [key, block] = buildServiceBlock(item);
    assert.match(key, new RegExp(`^${template.serviceCode}-[0-9a-f-]+$`));
    assert.equal(block.serviceCode, template.serviceCode);
    assert.equal(block.region, 'ap-southeast-5');
    assert.equal((block.serviceCost as { monthly: number }).monthly, monthlyCost(item));
    assert.doesNotMatch(String(block.configSummary), /[一-鿿]|\d,\d{3}/);
    assert.deepEqual(withoutChangedFields(block), withoutChangedFields(template), kind);
  }
  const ec2 = calibration.cases.find(v => v.service === 'ec2');
  assert.ok(ec2);
  const item = { kind: 'ec2', params: ec2.params } as ServiceItem;
  const [, block] = buildServiceBlock(item);
  assert.equal(block.serviceCode, 'ec2Enhancement');
  assert.equal(block.region, 'ap-southeast-5');
  assert.equal((block.serviceCost as { monthly: number }).monthly, monthlyCost(item));
  assert.doesNotMatch(String(block.configSummary), /[一-鿿]|\d,\d{3}/);
});
