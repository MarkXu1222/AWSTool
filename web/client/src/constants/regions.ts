/**
 * 区域下拉的单一数据源（配额、批量提额、Bedrock 共用）。
 *
 * label 同时写国家/地区和城市：下拉框按 label 搜索，只写城市时搜「巴西」「美国」「日本」都搜不到，
 * 看起来就像区域缺失。覆盖范围由 tests/regions.test.ts 对照 AWS 商业区全集锁定。
 */
export const REGIONS = [
  { label: '全部区域', value: '' },
  // 默认区域
  { label: 'us-east-1 (美国·弗吉尼亚)', value: 'us-east-1' },
  { label: 'us-east-2 (美国·俄亥俄)', value: 'us-east-2' },
  { label: 'us-west-1 (美国·加州)', value: 'us-west-1' },
  { label: 'us-west-2 (美国·俄勒冈)', value: 'us-west-2' },
  { label: 'eu-west-1 (爱尔兰)', value: 'eu-west-1' },
  { label: 'eu-west-2 (英国·伦敦)', value: 'eu-west-2' },
  { label: 'eu-west-3 (法国·巴黎)', value: 'eu-west-3' },
  { label: 'eu-north-1 (瑞典·斯德哥尔摩)', value: 'eu-north-1' },
  { label: 'eu-central-1 (德国·法兰克福)', value: 'eu-central-1' },
  { label: 'ap-southeast-1 (新加坡)', value: 'ap-southeast-1' },
  { label: 'ap-southeast-2 (澳大利亚·悉尼)', value: 'ap-southeast-2' },
  { label: 'ap-northeast-1 (日本·东京)', value: 'ap-northeast-1' },
  { label: 'ap-northeast-2 (韩国·首尔)', value: 'ap-northeast-2' },
  { label: 'ap-northeast-3 (日本·大阪)', value: 'ap-northeast-3' },
  { label: 'ap-south-1 (印度·孟买)', value: 'ap-south-1' },
  { label: 'sa-east-1 (巴西·圣保罗)', value: 'sa-east-1' },
  { label: 'ca-central-1 (加拿大·蒙特利尔)', value: 'ca-central-1' },
  // Opt-in 区域
  { label: 'af-south-1 (南非·开普敦)', value: 'af-south-1' },
  { label: 'ap-east-1 (中国香港)', value: 'ap-east-1' },
  { label: 'ap-east-2 (中国台湾·台北)', value: 'ap-east-2' },
  { label: 'ap-south-2 (印度·海得拉巴)', value: 'ap-south-2' },
  { label: 'ap-southeast-3 (印尼·雅加达)', value: 'ap-southeast-3' },
  { label: 'ap-southeast-4 (澳大利亚·墨尔本)', value: 'ap-southeast-4' },
  { label: 'ap-southeast-5 (马来西亚)', value: 'ap-southeast-5' },
  { label: 'ap-southeast-6 (新西兰)', value: 'ap-southeast-6' },
  { label: 'ap-southeast-7 (泰国)', value: 'ap-southeast-7' },
  { label: 'ca-west-1 (加拿大·卡尔加里)', value: 'ca-west-1' },
  { label: 'eu-central-2 (瑞士·苏黎世)', value: 'eu-central-2' },
  { label: 'eu-south-1 (意大利·米兰)', value: 'eu-south-1' },
  { label: 'eu-south-2 (西班牙)', value: 'eu-south-2' },
  { label: 'il-central-1 (以色列·特拉维夫)', value: 'il-central-1' },
  { label: 'me-central-1 (阿联酋)', value: 'me-central-1' },
  { label: 'me-south-1 (巴林)', value: 'me-south-1' },
  { label: 'mx-central-1 (墨西哥)', value: 'mx-central-1' },
];
