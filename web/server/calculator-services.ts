import { randomUUID } from 'crypto';
import {
  CALC_REGION, CALC_REGION_NAME, HOURS_PER_MONTH, EC2_HOURLY, RDS_HOURLY,
  AURORA_HOURLY, ELASTICACHE_HOURLY, UNIT,
  type Ec2Type, type RdsType, type AuroraType, type CacheType,
} from './calculator-rates';

export type Ec2Role = 'web' | 'app' | 'worker' | 'batch' | 'api' | 'db';
export type RdsDeployment = 'Single-AZ' | 'Multi-AZ';

export interface ServiceParams {
  'ec2': { instanceType: Ec2Type; count: number; storageGbPerInstance: number };
  'ebs-volume': { volumes: number; gbPerVolume: number };
  's3': { gb: number; putRequests: number; getRequests: number };
  'alb': { count: number; gbPerHour: number };
  'cloudwatch': { metrics: number; logGb: number; dashboards: number; alarms: number };
  'cloudtrail': { writeTrails: number; eventsMillions: number };
  'rds-mysql': { instanceType: RdsType; nodes: number; deployment: RdsDeployment; storageGb: number; backupGb: number };
  'rds-postgresql': { instanceType: RdsType; nodes: number; deployment: RdsDeployment; storageGb: number; backupGb: number };
  'aurora-mysql': { instanceType: AuroraType; nodes: number; storageGb: number };
  'elasticache': { instanceType: CacheType; nodes: number };
  'nat-gateway': { gateways: number; gbPerGateway: number };
  'waf': { webAcls: number; rulesPerAcl: number; managedGroupsPerAcl: number; requestsMillions: number };
  'api-gateway-http': { requestsMillions: number };
  'route53': { hostedZones: number; queriesMillions: number };
  'secrets-manager': { secrets: number; apiCalls: number };
  'backup-ebs': { gb: number };
  'efs': { storageGb: number; readGb: number; writeGb: number };
  'ecr': { gb: number };
  'kms': { keys: number; requests: number };
  'sqs': { requestsMillions: number };
}
export type ServiceKind = keyof ServiceParams;
export type ServiceItem = { [K in ServiceKind]: { kind: K; params: ServiceParams[K]; role?: Ec2Role } }[ServiceKind];
export type CalculatorServiceBlock = Record<string, unknown>;

// Exact embedded calculator.aws service templates; EC2 retains its existing v0.0.57 structure.
const TEMPLATES = {
  "ebs-volume": {
    "calculationComponents": {
      "numberOfInstances": {
        "value": "1"
      },
      "durationOfInstanceRuns": {
        "value": "730",
        "unit": "hours"
      },
      "storageType": {
        "value": "Storage General Purpose GB Mo"
      },
      "storageAmount": {
        "value": "300",
        "unit": "gb|NA"
      },
      "snapshotFrequency": {
        "value": "0"
      }
    },
    "serviceCode": "amazonElasticBlockStore",
    "region": "ap-southeast-5",
    "estimateFor": "elasticBlockStore",
    "version": "0.0.159",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Elastic Block Store (EBS)",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "s3": {
    "version": "0.0.86",
    "serviceCode": "amazonSimpleStorageServiceGroup",
    "estimateFor": "simpleStorageServiceClassesGroup",
    "region": "ap-southeast-5",
    "description": null,
    "subServices": [
      {
        "calculationComponents": {
          "moveToStorageClassMethod": {
            "value": "No movement required"
          },
          "s3StandardStorageSize": {
            "value": "2048",
            "unit": "gb|month"
          },
          "s3StandardPutRequests": {
            "value": "1000000"
          },
          "s3StandardGetRequests": {
            "value": "10000000"
          }
        },
        "serviceCode": "amazonS3Standard",
        "region": "ap-southeast-5",
        "estimateFor": "s3Standard",
        "version": "0.0.71",
        "description": null,
        "serviceCost": {
          "monthly": 0
        }
      },
      {
        "calculationComponents": {
          "dataTransfer": {
            "value": [
              {
                "entryType": "INBOUND",
                "value": "",
                "unit": "tb_month",
                "fromRegion": ""
              },
              {
                "entryType": "OUTBOUND",
                "value": "",
                "unit": "tb_month",
                "toRegion": ""
              }
            ]
          }
        },
        "serviceCode": "awsS3DataTransfer",
        "region": "ap-southeast-5",
        "estimateFor": "awsS3DataTransfer",
        "version": "0.0.27",
        "description": null,
        "serviceCost": {
          "monthly": 0
        }
      }
    ],
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Simple Storage Service (S3)",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "alb": {
    "serviceCode": "elasticLoadBalancing",
    "region": "ap-southeast-5",
    "description": null,
    "subServices": [
      {
        "calculationComponents": {
          "numberOfApplicationLoadBalancers": {
            "value": "1"
          },
          "sizeOfDataProcessedForEC2InstanceAndIPAddressTargets": {
            "value": "5",
            "unit": "gb|hour"
          }
        },
        "serviceCode": "applicationLoadBalancer",
        "region": "ap-southeast-5",
        "estimateFor": "template_0",
        "version": "0.0.28",
        "description": null,
        "serviceCost": {
          "monthly": 0
        }
      }
    ],
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Elastic Load Balancing",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "cloudwatch": {
    "calculationComponents": {
      "logStorageOption": {
        "value": "1"
      },
      "logParquetFormatConversionSelect": {
        "value": "[ZERO_COST]"
      },
      "numberOfMobileEvents": {
        "value": "0"
      },
      "percentageOfMobileRumEvents": {
        "value": "0"
      },
      "totalNumberOfMetrics": {
        "value": "100"
      },
      "sizeOfStandardLogsDataIngested": {
        "value": "200",
        "unit": "gb|NA"
      },
      "numberOfDashboards": {
        "value": "5"
      },
      "numberOfStandardAlarms": {
        "value": "30"
      }
    },
    "serviceCode": "amazonCloudWatch",
    "region": "ap-southeast-5",
    "estimateFor": "CloudWatch",
    "version": "0.0.141",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon CloudWatch",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "cloudtrail": {
    "calculationComponents": {
      "OpsMult": {
        "value": "1000000"
      },
      "numberOfWriteTrails": {
        "value": "2"
      },
      "numberOfReadTrails": {
        "value": "0"
      },
      "dataOpsMult": {
        "value": "1000000"
      },
      "numberOfS3Trails": {
        "value": "0"
      },
      "numberOfLambdaTrails": {
        "value": "0"
      },
      "networkActivityOpsMult": {
        "value": "1000000"
      },
      "numberOfNetworkActivityTrails": {
        "value": "0"
      },
      "numberOfWriteEvents": {
        "value": "1",
        "unit": "perMonth"
      },
      "numberOfReadEvents": {
        "value": "0",
        "unit": "perMonth"
      }
    },
    "serviceCode": "awsCloudTrail",
    "region": "ap-southeast-5",
    "estimateFor": "template",
    "version": "0.0.46",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "AWS CloudTrail",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "rds-mysql": {
    "calculationComponents": {
      "createRDSProxy": {
        "value": "0"
      },
      "storageAmount": {
        "value": "170",
        "unit": "gb|NA"
      },
      "storageType": {
        "value": "General Purpose"
      },
      "DatabaseInsightsSelected": {
        "value": "0"
      },
      "retentionPeriod": {
        "value": "0"
      },
      "addRDSExtendedSupport": {
        "value": "0"
      },
      "RDSExtendedSupportYear": {
        "value": "year12"
      },
      "columnFormIPM": {
        "value": [
          {
            "Number of Nodes": {
              "value": "1"
            },
            "Instance Type": {
              "value": "db.m6g.xlarge"
            },
            "undefined": {
              "value": {
                "unit": "100",
                "selectedId": "%Utilized/Month"
              }
            },
            "Deployment Option": {
              "value": "Multi-AZ"
            },
            "TermType": {
              "value": "OnDemand"
            }
          }
        ]
      },
      "additionalBackupStorage": {
        "value": "0",
        "unit": "gb|NA"
      }
    },
    "serviceCode": "amazonRDSMySQLDB",
    "region": "ap-southeast-5",
    "estimateFor": "mySQLDB",
    "version": "0.0.135",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon RDS for MySQL",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "rds-postgresql": {
    "calculationComponents": {
      "createRDSProxy": {
        "value": "0"
      },
      "storageAmount": {
        "value": "1000",
        "unit": "gb|NA"
      },
      "storageVolume": {
        "value": "General Purpose-GP3"
      },
      "DatabaseInsightsSelected": {
        "value": "0"
      },
      "addRDSExtendedSupport": {
        "value": "0"
      },
      "RDSExtendedSupportYear": {
        "value": "year12"
      },
      "columnFormIPM": {
        "value": [
          {
            "Number of Nodes": {
              "value": "1"
            },
            "Instance Type": {
              "value": "db.m6g.xlarge"
            },
            "undefined": {
              "value": {
                "unit": "100",
                "selectedId": "%Utilized/Month"
              }
            },
            "Deployment Option": {
              "value": "Multi-AZ"
            },
            "TermType": {
              "value": "OnDemand"
            }
          }
        ]
      },
      "gp3Iops": {
        "value": "3000"
      },
      "gp3Throughput": {
        "value": "125",
        "unit": "mbps"
      },
      "additionalBackupStorage": {
        "value": "0",
        "unit": "gb|NA"
      }
    },
    "serviceCode": "amazonRDSPostgreSQLDB",
    "region": "ap-southeast-5",
    "estimateFor": "rdsForPostgreSQL",
    "version": "0.0.111",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon RDS for PostgreSQL",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "aurora-mysql": {
    "calculationComponents": {
      "edition": {
        "value": "auroraStandard"
      },
      "createRDSProxy": {
        "value": "0"
      },
      "changeRecordsPerStatement": {
        "value": "0"
      },
      "averageStatements": {
        "value": "0",
        "unit": "perSecond"
      },
      "totalReads_BaseIO": {
        "value": "0",
        "unit": "perSecond"
      },
      "totalWrites_PeakIO": {
        "value": "0",
        "unit": "perSecond"
      },
      "durationPeakWriteId": {
        "value": "0",
        "unit": "perMonth"
      },
      "DatabaseInsightsSelected": {
        "value": "0"
      },
      "retentionPeriod": {
        "value": "0"
      },
      "addRDSExtendedSupport": {
        "value": "0"
      },
      "columnFormIPM": {
        "value": [
          {
            "Instance Type": {
              "value": "db.r7g.large"
            },
            "Number of Nodes": {
              "value": "2"
            },
            "undefined": {
              "value": {
                "unit": "100",
                "selectedId": "%Utilized/Month"
              }
            },
            "Instance Family": {
              "value": "Memory optimized"
            },
            "TermType": {
              "value": "OnDemand"
            },
            "LeaseContractLength": {
              "value": "1yr"
            },
            "PurchaseOption": {
              "value": "No Upfront"
            }
          }
        ]
      },
      "storageAmount": {
        "value": "500",
        "unit": "gb|NA"
      },
      "additionalBackupStorage": {
        "value": "0",
        "unit": "gb|NA"
      }
    },
    "serviceCode": "amazonAuroraMySQLCompatible",
    "region": "ap-southeast-5",
    "estimateFor": "auroraMySQLCompatible",
    "version": "0.0.167",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Aurora MySQL-Compatible",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "elasticache": {
    "calculationComponents": {
      "EngineType": {
        "value": "x4dSskWC2UA5R5dVtIkM0EjZJQKU02zll08quzox15U"
      },
      "columnFormIPM": {
        "value": [
          {
            "Instance Type": {
              "value": "cache.m7g.large"
            },
            "Cache Engine": {
              "value": "Redis"
            },
            "Number of Nodes": {
              "value": "2"
            },
            "undefined": {
              "value": {
                "unit": "100",
                "selectedId": "%Utilized/Month"
              }
            },
            "Instance Family": {
              "value": "Standard"
            },
            "TermType": {
              "value": "OnDemand"
            }
          }
        ]
      },
      "columnFormIPM_dsp": {
        "value": [
          {
            "TermType": {
              "value": "OnDemand"
            },
            "Cache Engine": {
              "value": "Memcached"
            }
          }
        ]
      }
    },
    "serviceCode": "amazonElastiCache",
    "region": "ap-southeast-5",
    "estimateFor": "amazonElastiCache",
    "version": "0.0.87",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon ElastiCache",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "nat-gateway": {
    "version": "0.0.101",
    "serviceCode": "amazonVirtualPrivateCloud",
    "estimateFor": "virtualPrivateCloudSubServiceSelector",
    "region": "ap-southeast-5",
    "description": null,
    "subServices": [
      {
        "calculationComponents": {
          "regionalNatGatewayCount": {
            "value": "0"
          },
          "regionalNatGatewayAzCount": {
            "value": "0"
          },
          "numberOfGateways": {
            "value": "3"
          },
          "dataProcessedPerNATGateway": {
            "value": "100",
            "unit": "gb|month"
          },
          "regionalNatGatewayDataProcessed": {
            "value": "0",
            "unit": "gb|month"
          }
        },
        "serviceCode": "networkAddressTranslationNatGatewayVpc",
        "region": "ap-southeast-5",
        "estimateFor": "networkAddressTranslationGateway",
        "version": "0.0.19",
        "description": null,
        "serviceCost": {
          "monthly": 0
        }
      }
    ],
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Virtual Private Cloud (VPC)",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "waf": {
    "calculationComponents": {
      "numberOfWebAcls": {
        "value": "1",
        "unit": "perMonth"
      },
      "numberOfRulesPerWebAcl": {
        "value": "5",
        "unit": "perMonth"
      },
      "numberOfManangedRules": {
        "value": "2",
        "unit": "perMonth"
      },
      "numberOfWebRequests": {
        "value": "400",
        "unit": "perMonth"
      }
    },
    "serviceCode": "awsWebApplicationFirewall",
    "region": "ap-southeast-5",
    "estimateFor": "awsWaf",
    "version": "0.0.34",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "AWS Web Application Firewall (WAF)",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "api-gateway-http": {
    "calculationComponents": {
      "APIOpsMult": {
        "value": "1000000"
      },
      "dataPerRequest": {
        "value": "50",
        "unit": "kb|NA"
      },
      "RESTMult": {
        "value": "1000000"
      },
      "cacheSize": {
        "value": "[ZERO_COST]"
      },
      "numberOfAPIRequests": {
        "value": "100",
        "unit": "perMonth"
      },
      "numberOfRESTRequests": {
        "value": "0",
        "unit": "perMonth"
      }
    },
    "serviceCode": "amazonApiGateway",
    "region": "ap-southeast-5",
    "estimateFor": "template",
    "version": "0.0.59",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon API Gateway",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "route53": {
    "calculationComponents": {
      "numberOfHostedZones": {
        "value": "10"
      },
      "numberOfStandardQueries": {
        "value": "10",
        "unit": "millionPerMonth"
      },
      "numberOfLatencyBasedRoutingQueries": {
        "value": "0",
        "unit": "millionPerMonth"
      },
      "numberOfGeoDNSQueries": {
        "value": "0",
        "unit": "millionPerMonth"
      },
      "numberOfIPRoutingQueries": {
        "value": "0",
        "unit": "millionPerMonth"
      },
      "numberOfElasticNetworkInterfaces": {
        "value": ""
      },
      "numberOfDNSFirewallDomains": {
        "value": "0"
      },
      "numberOfVPCs": {
        "value": "0"
      },
      "numberOFhours": {
        "value": "0",
        "unit": "hr"
      },
      "numberOfFirewallDNSQueries": {
        "value": "0",
        "unit": "millionPerMonth"
      },
      "numberOfRecursiveAverageDNSQueries": {
        "value": "",
        "unit": "millionPerMonth"
      },
      "numberOfBasicChecksWithinAWS": {
        "value": "0"
      },
      "numberOf_IP_blocks": {
        "value": ""
      },
      "RRsetRecord": {
        "value": ""
      }
    },
    "serviceCode": "amazonRoute53",
    "region": "ap-southeast-5",
    "estimateFor": "Route53",
    "version": "0.0.88",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Route 53",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "secrets-manager": {
    "calculationComponents": {
      "NumberOfSecrets": {
        "value": "100"
      },
      "secretDuration": {
        "value": "30",
        "unit": "day"
      },
      "numberOfAPIs": {
        "value": "1000",
        "unit": "perMonth"
      }
    },
    "serviceCode": "awsSecretsManager",
    "region": "ap-southeast-5",
    "estimateFor": "awssecretsmanager",
    "version": "0.0.24",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "AWS Secrets Manager",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "backup-ebs": {
    "version": "0.0.101",
    "serviceCode": "awsBackup",
    "estimateFor": "awsBackupSelector",
    "region": "ap-southeast-5",
    "description": null,
    "subServices": [
      {
        "calculationComponents": {
          "annualGrowthOfPrimaryUsage": {
            "value": "0"
          },
          "dailyChangeOfPrimaryUsage": {
            "value": "02"
          },
          "dataSize": {
            "value": "550",
            "unit": "gb|NA"
          },
          "dailyPlansWarmDays": {
            "value": "30",
            "unit": "day"
          }
        },
        "serviceCode": "ebsBackup",
        "region": "ap-southeast-5",
        "estimateFor": "ebsBackup",
        "version": "0.0.32",
        "description": null,
        "serviceCost": {
          "monthly": 0
        }
      }
    ],
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "AWS Backup",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "efs": {
    "calculationComponents": {
      "throughputModeSS": {
        "value": "pPg1vmtASUb_DcOGFyxPNa8abU3NDsNcdbBc06f_K_U"
      },
      "elasticThroughputReadDataInputSS": {
        "value": "20",
        "unit": "gb|month"
      },
      "elasticThroughputWriteDataInputSS": {
        "value": "20",
        "unit": "gb|month"
      },
      "standardStorageSize": {
        "value": "50",
        "unit": "gb|NA"
      },
      "Infrequent_Access_Tiering": {
        "value": "0",
        "unit": "gb|NA"
      },
      "Infrequent_Access_Read": {
        "value": "0",
        "unit": "gb|NA"
      },
      "Archive_Access_Tiering": {
        "value": "0",
        "unit": "gb|NA"
      },
      "Archive_Access_Read": {
        "value": "0",
        "unit": "gb|NA"
      }
    },
    "serviceCode": "amazonEFS",
    "region": "ap-southeast-5",
    "estimateFor": "elasticFileSystem",
    "version": "0.0.76",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Elastic File System (EFS)",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "ecr": {
    "calculationComponents": {
      "dataTransfer": {
        "value": [
          {
            "entryType": "INBOUND",
            "value": "",
            "unit": "tb_month",
            "fromRegion": ""
          },
          {
            "entryType": "OUTBOUND",
            "value": "",
            "unit": "tb_month",
            "toRegion": ""
          }
        ]
      },
      "amountofdatastored": {
        "value": "1000",
        "unit": "gb|month"
      }
    },
    "serviceCode": "amazonElasticContainerRegistry",
    "region": "ap-southeast-5",
    "estimateFor": "template_0",
    "version": "0.0.33",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Elastic Container Registry",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "kms": {
    "calculationComponents": {
      "numberOfCmk": {
        "value": "10"
      },
      "numberOfSymmetricRequests": {
        "value": "200000"
      },
      "numberOfAsymmetricRequestsExceptRsa2048": {
        "value": "0"
      },
      "numberOfAsymmetricRsaRequests": {
        "value": "0"
      },
      "numberOfEccGenerateDataKeyPairRequests": {
        "value": "0"
      },
      "numberOfRsaGenerateDataKeyPairRequests": {
        "value": "0"
      }
    },
    "serviceCode": "awsKeyManagementService",
    "region": "ap-southeast-5",
    "estimateFor": "kms",
    "version": "0.0.20",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "AWS Key Management Service",
    "regionName": "Asia Pacific (Malaysia)"
  },
  "sqs": {
    "calculationComponents": {
      "dataTransfer": {
        "value": [
          {
            "entryType": "INBOUND",
            "value": "",
            "unit": "tb_month",
            "fromRegion": ""
          },
          {
            "entryType": "OUTBOUND",
            "value": "",
            "unit": "tb_month",
            "toRegion": ""
          }
        ]
      },
      "standardQueueRequests": {
        "value": "200",
        "unit": "perMonth"
      },
      "fifoQueueRequests": {
        "value": "0",
        "unit": "perMonth"
      }
    },
    "serviceCode": "amazonSimpleQueueService",
    "region": "ap-southeast-5",
    "estimateFor": "simpleQueueService",
    "version": "0.0.51",
    "description": null,
    "serviceCost": {
      "monthly": 0,
      "upfront": 0
    },
    "serviceName": "Amazon Simple Queue Service (SQS)",
    "regionName": "Asia Pacific (Malaysia)"
  },
} as const;

/** Engine-calibrated monthly cost, rounded to cents per service. */
export function monthlyCost(item: ServiceItem): number {
  let value: number;
  switch (item.kind) {
    case 'ec2': value = item.params.count * (EC2_HOURLY[item.params.instanceType] * HOURS_PER_MONTH
      + item.params.storageGbPerInstance * UNIT.ec2EbsGp3GbMonth); break;
    case 'ebs-volume': value = item.params.volumes * item.params.gbPerVolume * UNIT.ebsGp2GbMonth; break;
    case 's3': value = item.params.gb * UNIT.s3GbMonth + item.params.putRequests / 1000 * UNIT.s3PutPer1k
      + item.params.getRequests / 1000 * UNIT.s3GetPer1k; break;
    case 'alb': value = item.params.count * HOURS_PER_MONTH * (UNIT.albHour + item.params.gbPerHour * UNIT.albLcuHour); break;
    case 'cloudwatch': value = item.params.metrics * UNIT.cwMetric + item.params.logGb * UNIT.cwLogGb
      + Math.max(0, item.params.dashboards - UNIT.cwFreeDashboards) * UNIT.cwDashboard + item.params.alarms * UNIT.cwAlarm; break;
    case 'cloudtrail': value = (item.params.writeTrails - 1) * item.params.eventsMillions * UNIT.cloudTrailPerMillionExtraTrail; break;
    case 'rds-mysql':
    case 'rds-postgresql': {
      const m = item.params.deployment === 'Multi-AZ' ? 2 : 1;
      value = item.params.nodes * (RDS_HOURLY[item.params.instanceType] * m * HOURS_PER_MONTH
        + item.params.storageGb * UNIT.rdsStorageGbMonth * m) + item.params.backupGb * UNIT.rdsBackupGbMonth;
      break;
    }
    case 'aurora-mysql': value = item.params.nodes * AURORA_HOURLY[item.params.instanceType] * HOURS_PER_MONTH
      + item.params.storageGb * UNIT.auroraStorageGbMonth; break;
    case 'elasticache': value = item.params.nodes * ELASTICACHE_HOURLY[item.params.instanceType] * HOURS_PER_MONTH; break;
    case 'nat-gateway': value = item.params.gateways * (HOURS_PER_MONTH * UNIT.natHour + item.params.gbPerGateway * UNIT.natGb); break;
    case 'waf': value = item.params.webAcls * (UNIT.wafAcl + item.params.rulesPerAcl * UNIT.wafRule
      + item.params.managedGroupsPerAcl * UNIT.wafManagedGroup) + item.params.requestsMillions * UNIT.wafPerMillion; break;
    case 'api-gateway-http': value = item.params.requestsMillions * UNIT.apiGwHttpPerMillion; break;
    case 'route53': value = item.params.hostedZones * UNIT.r53Zone + item.params.queriesMillions * UNIT.r53PerMillion; break;
    case 'secrets-manager': value = item.params.secrets * UNIT.secret + item.params.apiCalls / 10000 * UNIT.secretPer10k; break;
    case 'backup-ebs': value = item.params.gb * UNIT.backupEbsGbMonth; break;
    case 'efs': value = item.params.storageGb * UNIT.efsGbMonth + item.params.readGb * UNIT.efsReadGb + item.params.writeGb * UNIT.efsWriteGb; break;
    case 'ecr': value = item.params.gb * UNIT.ecrGbMonth; break;
    case 'kms': value = item.params.keys * UNIT.kmsKey + item.params.requests / 10000 * UNIT.kmsPer10k; break;
    case 'sqs': value = item.params.requestsMillions * UNIT.sqsPerMillion; break;
  }
  return Math.round(value * 100) / 100;
}

/** The exact English configuration summary stored in the calculator block. */
export function configSummary(item: ServiceItem): string {
  switch (item.kind) {
    case 'ec2': return `Tenancy (Shared Instances), Operating system (Linux), Workload (Consistent, Number of instances: ${item.params.count}), Advance EC2 instance (${item.params.instanceType}), Pricing strategy (On-Demand Utilization: 100 %Utilized/Month), Enable monitoring (disabled), EBS Storage amount (${item.params.storageGbPerInstance} GB), DT Inbound: Not selected (0 TB per month), DT Outbound: Not selected (0 TB per month), DT Intra-Region: (0 TB per month)`;
    case 'ebs-volume': return `Number of volumes (${item.params.volumes}), Average duration of volume (730 hours per month), Storage amount per volume (${item.params.gbPerVolume} GB), Snapshot Frequency (No snapshot storage)`;
    case 's3': return `S3 Standard storage (${item.params.gb} GB per month), PUT, COPY, POST, LIST requests to S3 Standard (${item.params.putRequests}), GET, SELECT, and all other requests from S3 Standard (${item.params.getRequests}), DT Inbound: Not selected (0 TB per month), DT Outbound: Not selected (0 TB per month)`;
    case 'alb': return `Number of Application Load Balancers (${item.params.count}), Processed bytes (EC2 Instances and IP addresses as targets) (${item.params.gbPerHour} GB per hour)`;
    case 'cloudwatch': return `Number of Metrics (includes detailed and custom metrics) (${item.params.metrics}), Standard Logs: Data Ingested (${item.params.logGb} GB), Number of Dashboards (${item.params.dashboards}), Number of Standard Resolution Alarm Metrics (${item.params.alarms})`;
    case 'cloudtrail': return `Management event trails (${item.params.writeTrails}), Number of management events (${item.params.eventsMillions} million per month)`;
    case 'rds-mysql': return `Storage amount (${item.params.storageGb} GB), Storage for each RDS instance (General Purpose SSD (gp2)), Nodes (${item.params.nodes}), Instance type (${item.params.instanceType}), Utilization (On-Demand only) (100 %Utilized/Month), Deployment option (${item.params.deployment}), Pricing strategy (OnDemand), Additional backup storage (${item.params.backupGb} GB)`;
    case 'rds-postgresql': return `Storage amount (${item.params.storageGb} GB), Storage volume (General Purpose SSD (gp3)), Nodes (${item.params.nodes}), Instance Type (${item.params.instanceType}), Utilization (On-Demand only) (100 %Utilized/Month), Deployment Option (${item.params.deployment}), Pricing Model (OnDemand), Additional backup storage (${item.params.backupGb} GB)`;
    case 'aurora-mysql': return `Aurora MySQL Cluster Configuration Option (Aurora Standard), Instance Type (${item.params.instanceType}), Nodes (${item.params.nodes}), Utilization (100 %Utilized/Month), Pricing Model (OnDemand), Storage amount (${item.params.storageGb} GB)`;
    case 'elasticache': return `Engine (Redis OSS), Instance type (${item.params.instanceType}), Nodes (${item.params.nodes}), Utilization (On-Demand only) (100 %Utilized/Month), Cache Node Type (Standard), Pricing strategy (OnDemand)`;
    case 'nat-gateway': return `Number of NAT Gateways (${item.params.gateways}), Data Processed per NAT Gateway (${item.params.gbPerGateway} GB per month)`;
    case 'waf': return `Number of Web Access Control Lists (Web ACLs) utilized (${item.params.webAcls} per month), Number of Rules added per Web ACL (${item.params.rulesPerAcl} per month), Number of Managed Rule Groups per Web ACL (${item.params.managedGroupsPerAcl} per month), Number of web requests received across all web ACLs (${item.params.requestsMillions} million per month)`;
    case 'api-gateway-http': return `HTTP API requests (${item.params.requestsMillions} million per month), Average size of each request (50 KB)`;
    case 'route53': return `Hosted Zones (${item.params.hostedZones}), Standard queries (${item.params.queriesMillions} million per month)`;
    case 'secrets-manager': return `Number of secrets (${item.params.secrets}), Average duration of each secret (30 days), Number of API calls (${item.params.apiCalls} per month)`;
    case 'backup-ebs': return `Amount of primary data to be backed up (${item.params.gb} GB), Daily backups warm retention period (30 Days)`;
    case 'efs': return `Desired Storage Capacity (${item.params.storageGb} GB per month), Read Data Transferred (${item.params.readGb} GB per month), Write Data Transferred (${item.params.writeGb} GB per month)`;
    case 'ecr': return `Amount of data stored (${item.params.gb} GB per month)`;
    case 'kms': return `Number of customer managed Customer Master Keys (CMK) (${item.params.keys}), Number of symmetric requests (${item.params.requests})`;
    case 'sqs': return `Standard queue requests (${item.params.requestsMillions} million per month)`;
  }
}

/** Compact service name for the submitted application result. */
export function shortLabel(item: ServiceItem): string {
  switch (item.kind) {
    case 'ec2': return `EC2 ${item.role || 'app'} · ${item.params.instanceType} ×${item.params.count}`;
    case 'ebs-volume': return `EBS gp2 ×${item.params.volumes} · ${item.params.gbPerVolume} GB`;
    case 's3': return `S3 · ${item.params.gb} GB`;
    case 'alb': return `ALB ×${item.params.count}`;
    case 'cloudwatch': return 'CloudWatch';
    case 'cloudtrail': return 'CloudTrail';
    case 'rds-mysql': return `RDS MySQL · ${item.params.instanceType} ×${item.params.nodes} ${item.params.deployment}`;
    case 'rds-postgresql': return `RDS PostgreSQL · ${item.params.instanceType} ×${item.params.nodes} ${item.params.deployment}`;
    case 'aurora-mysql': return `Aurora MySQL · ${item.params.instanceType} ×${item.params.nodes}`;
    case 'elasticache': return `ElastiCache · ${item.params.instanceType} ×${item.params.nodes}`;
    case 'nat-gateway': return `NAT Gateway ×${item.params.gateways}`;
    case 'waf': return 'WAF';
    case 'api-gateway-http': return 'API Gateway';
    case 'route53': return 'Route 53';
    case 'secrets-manager': return 'Secrets Manager';
    case 'backup-ebs': return `AWS Backup · ${item.params.gb} GB`;
    case 'efs': return `EFS · ${item.params.storageGb} GB`;
    case 'ecr': return `ECR · ${item.params.gb} GB`;
    case 'kms': return 'KMS';
    case 'sqs': return 'SQS';
  }
}

function ec2Block(item: Extract<ServiceItem, { kind: 'ec2' }>): CalculatorServiceBlock {
  const { instanceType, count, storageGbPerInstance } = item.params;
  return {
    calculationComponents: {
      tenancy: { value: 'shared' }, selectedOS: { value: 'linux' },
      workloadSelection: { value: 'consistent' },
      storageType: { value: 'Storage General Purpose gp3 GB Mo' },
      dataTransferForEC2: { value: [
        { entryType: 'INBOUND', value: '', unit: 'tb_month', fromRegion: '' },
        { entryType: 'OUTBOUND', value: '', unit: 'tb_month', toRegion: '' },
        { entryType: 'INTRA_REGION', value: '', unit: 'tb_month' },
      ] },
      workload: { value: { workloadType: 'consistent', data: String(count) } },
      detailedMonitoringCheckbox: { value: false }, ec2AdvancedPricingMetrics: { value: 1 },
      instanceType: { value: instanceType },
      pricingStrategy: { value: {
        selectedOption: 'on-demand', term: '1 year',
        utilizationValue: '100', utilizationUnit: '%Utilized/Month',
      } },
      storageAmount: { value: String(storageGbPerInstance), unit: 'gb|NA' },
      snapshotFrequency: { value: 'monthly' }, gp3Iops: { value: '3000' },
      snapshotAmount: { value: '0', unit: 'gb|NA' },
      gp3Throughput: { value: '125', unit: 'mbps' },
    },
    serviceCode: 'ec2Enhancement', region: CALC_REGION, estimateFor: 'template',
    version: '0.0.57', description: null,
    serviceCost: { monthly: monthlyCost(item), upfront: 0 },
    serviceName: 'Amazon EC2', regionName: CALC_REGION_NAME,
    configSummary: configSummary(item),
  };
}

/** Calculator service code and complete block with string-valued input controls. */
export function buildServiceBlock(item: ServiceItem): [string, CalculatorServiceBlock] {
  if (item.kind === 'ec2') {
    const block = ec2Block(item);
    return [`${block.serviceCode}-${randomUUID()}`, block];
  }
  const block: any = structuredClone(TEMPLATES[item.kind]);
  const cc = block.calculationComponents;
  const sub0 = block.subServices?.[0]?.calculationComponents;
  const set = (components: any, field: string, value: string | number) => {
    components[field].value = String(value);
  };
  const setRow = (field: string, value: string | number) => {
    cc.columnFormIPM.value[0][field].value = String(value);
  };
  switch (item.kind) {
    case 'ebs-volume': set(cc, 'numberOfInstances', item.params.volumes); set(cc, 'storageAmount', item.params.gbPerVolume); break;
    case 's3': set(sub0, 's3StandardStorageSize', item.params.gb); set(sub0, 's3StandardPutRequests', item.params.putRequests);
      set(sub0, 's3StandardGetRequests', item.params.getRequests); break;
    case 'alb': set(sub0, 'numberOfApplicationLoadBalancers', item.params.count);
      set(sub0, 'sizeOfDataProcessedForEC2InstanceAndIPAddressTargets', item.params.gbPerHour); break;
    case 'cloudwatch': set(cc, 'totalNumberOfMetrics', item.params.metrics); set(cc, 'sizeOfStandardLogsDataIngested', item.params.logGb);
      set(cc, 'numberOfDashboards', item.params.dashboards); set(cc, 'numberOfStandardAlarms', item.params.alarms); break;
    case 'cloudtrail': set(cc, 'numberOfWriteTrails', item.params.writeTrails); set(cc, 'numberOfWriteEvents', item.params.eventsMillions); break;
    case 'rds-mysql': case 'rds-postgresql':
      setRow('Instance Type', item.params.instanceType); setRow('Number of Nodes', item.params.nodes);
      setRow('Deployment Option', item.params.deployment); set(cc, 'storageAmount', item.params.storageGb);
      set(cc, 'additionalBackupStorage', item.params.backupGb); break;
    case 'aurora-mysql': setRow('Instance Type', item.params.instanceType); setRow('Number of Nodes', item.params.nodes);
      set(cc, 'storageAmount', item.params.storageGb); break;
    case 'elasticache': setRow('Instance Type', item.params.instanceType); setRow('Number of Nodes', item.params.nodes); break;
    case 'nat-gateway': set(sub0, 'numberOfGateways', item.params.gateways);
      set(sub0, 'dataProcessedPerNATGateway', item.params.gbPerGateway); break;
    case 'waf': set(cc, 'numberOfWebAcls', item.params.webAcls); set(cc, 'numberOfRulesPerWebAcl', item.params.rulesPerAcl);
      set(cc, 'numberOfManangedRules', item.params.managedGroupsPerAcl);
      set(cc, 'numberOfWebRequests', item.params.requestsMillions); break;
    case 'api-gateway-http': set(cc, 'numberOfAPIRequests', item.params.requestsMillions); break;
    case 'route53': set(cc, 'numberOfHostedZones', item.params.hostedZones); set(cc, 'numberOfStandardQueries', item.params.queriesMillions); break;
    case 'secrets-manager': set(cc, 'NumberOfSecrets', item.params.secrets); set(cc, 'numberOfAPIs', item.params.apiCalls); break;
    case 'backup-ebs': set(sub0, 'dataSize', item.params.gb); break;
    case 'efs': set(cc, 'standardStorageSize', item.params.storageGb); set(cc, 'elasticThroughputReadDataInputSS', item.params.readGb);
      set(cc, 'elasticThroughputWriteDataInputSS', item.params.writeGb); break;
    case 'ecr': set(cc, 'amountofdatastored', item.params.gb); break;
    case 'kms': set(cc, 'numberOfCmk', item.params.keys); set(cc, 'numberOfSymmetricRequests', item.params.requests); break;
    case 'sqs': set(cc, 'standardQueueRequests', item.params.requestsMillions); break;
  }
  const cost = monthlyCost(item);
  block.serviceCost.monthly = cost;
  if (block.subServices) block.subServices.forEach((sub: any, i: number) => { sub.serviceCost.monthly = i === 0 ? cost : 0; });
  block.description = null;
  block.configSummary = configSummary(item);
  block.regionName = CALC_REGION_NAME;
  return [`${block.serviceCode}-${randomUUID()}`, block];
}
