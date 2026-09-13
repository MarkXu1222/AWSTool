#!/usr/bin/env python3
"""Safely inventory, plan, remove, and verify resources in one AWS member account.

This CLI is intentionally conservative. It reads the repository's ``config.json`` and
``data/db.json`` without modifying either file, refuses payer/management accounts,
asserts the active STS account at every stage and deletion round, preserves all access
chain roles, and never closes an Organizations account or changes domain registration.

Runtime: Python 3.9+ and boto3 1.42.68. No third-party dependency beyond boto3 is used.
All command output is structured JSON. Credentials and ExternalIds are never emitted.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, Final

import boto3
import botocore
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import BotoCoreError, ClientError, OperationNotPageableError


JsonValue = Any
_DEFAULT_ROOT: Final = Path(__file__).resolve().parents[1]
ROOT: Final = Path(os.environ.get("AWSTOOL_ROOT", str(_DEFAULT_ROOT))).expanduser().resolve()
CONFIG_PATH: Final = Path(os.environ.get("AWSTOOL_CONFIG", str(ROOT / "config.json"))).expanduser().resolve()
DB_PATH: Final = Path(os.environ.get("AWSTOOL_DB", str(ROOT / "data" / "db.json"))).expanduser().resolve()
REQUIRED_BOTO3: Final = "1.42.68"
ACCOUNT_RE: Final = re.compile(r"^[0-9]{12}$")
PAYER_ARN_RE: Final = re.compile(r"^arn:(?:aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role/(.+)$")
COVERAGE_CONTRACT_VERSION: Final = "2026-08-17.v3"
# These resource families are intentionally reported as coverage gaps until an
# authoritative enumerator and safe deleter exist. A gap makes verify fail and
# blocks nuke before its first write; discovery hints must never waive a gap.
KNOWN_COVERAGE_GAPS: Final = (
    "app-runner",
    "autoscaling",
    "aws-backup-recovery-points",
    "aws-batch",
    "codebuild-codepipeline",
    "documentdb-neptune",
    "ec2-vpn-transit-gateway-peering-dhcp",
    "efs-fsx",
    "elastic-beanstalk",
    "elasticache-memorydb",
    "emr",
    "firehose-kinesis",
    "glue-sagemaker",
    "lightsail",
    "mq",
    "msk",
    "opensearch",
    "redshift",
    "rds-proxy-global-cluster",
)
# A service model is not considered fully covered merely because one scanner
# exists. Every known unimplemented resource family remains an explicit gap.
RESOURCE_FAMILY_GAPS: Final[dict[str, tuple[str, ...]]] = {
    "apigateway": ("api-keys-usage-plans-domain-names-vpc-links",),
    "cloudfront": ("continuous-deployment-policies-field-level-encryption-realtime-logs-vpc-origins",),
    "dynamodb": ("backups-exports-imports",),
    "ec2": ("capacity-reservations-capacity-blocks-dedicated-hosts-fleets-spot-requests",),
    "ecr": ("pull-through-cache-rules-replication-config",),
    "lambda": ("layer-versions-code-signing-configs",),
    "route53": ("health-checks-traffic-policies-cidr-collections-query-logging-configs",),
    "s3": ("access-points-access-grants-multi-region-access-points-storage-lens",),
}
REGIONAL_SCANNER_IDS: Final = (
    "ec2", "rds", "lambda", "cloudformation", "resource-explorer-2", "elbv2", "elb", "ecs", "ecr", "eks",
    "dynamodb", "sqs", "sns", "logs", "events", "stepfunctions", "secretsmanager", "ssm",
    "apigateway", "apigatewayv2", "acm", "wafv2", "guardduty", "kms",
)
GLOBAL_SCANNER_IDS: Final = (
    "s3", "iam", "cloudfront-distributions", "cloudfront-functions", "cloudfront-key-groups",
    "cloudfront-public-keys", "cloudfront-oai", "cloudfront-oac", "route53", "route53domains",
    "wafv2-global",
)
SCANNER_RESOURCE_TYPE_MANIFEST: Final[dict[str, frozenset[str]]] = {
    "ec2": frozenset({
        "EC2Instance", "EC2Volume", "EC2Snapshot", "EC2AMI", "EC2ElasticIP",
        "EC2NatGateway", "EC2VpcEndpoint", "EC2NetworkInterface", "EC2LaunchTemplate",
        "EC2KeyPair", "EC2InternetGateway", "EC2Subnet", "EC2RouteTable", "EC2Route",
        "EC2SecurityGroup", "EC2NetworkAcl", "EC2Vpc", "EC2ReservedInstance",
    }),
    "rds": frozenset({
        "RDSInstance", "RDSCluster", "RDSManualSnapshot", "RDSManualClusterSnapshot",
        "RDSSubnetGroup", "RDSReservedInstance",
    }),
    "lambda": frozenset({"LambdaFunction"}),
    "cloudformation": frozenset({"CloudFormationStack"}),
    "resource-explorer-2": frozenset({"ResourceExplorerIndex", "ResourceExplorerView"}),
    "elbv2": frozenset({"ELBv2LoadBalancer", "ELBv2TargetGroup"}),
    "elb": frozenset({"ClassicELB"}),
    "ecs": frozenset({
        "ECSCluster", "ECSService", "ECSTask", "ECSContainerInstance",
        "ECSTaskDefinition", "ECSCapacityProvider",
    }),
    "ecr": frozenset({"ECRRepository"}),
    "eks": frozenset({"EKSCluster", "EKSNodegroup", "EKSFargateProfile", "EKSAddon"}),
    "dynamodb": frozenset({"DynamoDBTable"}),
    "sqs": frozenset({"SQSQueue"}),
    "sns": frozenset({"SNSTopic", "SNSSubscription", "SNSPendingSubscription"}),
    "logs": frozenset({"CloudWatchLogGroup"}),
    "events": frozenset({"EventBridgeRule", "EventBridgeBus"}),
    "stepfunctions": frozenset({
        "StepFunctionsStateMachine", "StepFunctionsExecution", "StepFunctionsActivity",
    }),
    "secretsmanager": frozenset({"SecretsManagerSecret"}),
    "ssm": frozenset({"SSMAssociation", "SSMParameter"}),
    "apigateway": frozenset({"APIGatewayRestApi"}),
    "apigatewayv2": frozenset({"APIGatewayV2Api"}),
    "acm": frozenset({"ACMCertificate"}),
    "wafv2": frozenset({"WAFv2WebACL", "WAFv2RuleGroup", "WAFv2IPSet", "WAFv2RegexPatternSet"}),
    "guardduty": frozenset({"GuardDutyDetector"}),
    "kms": frozenset({"KMSKey"}),
    "s3": frozenset({"S3Bucket"}),
    "iam": frozenset({
        "IAMUser", "IAMGroup", "IAMRole", "IAMCustomerManagedPolicy", "IAMInstanceProfile",
        "IAMVirtualMFADevice", "IAMServerCertificate", "IAMSAMLProvider", "IAMOpenIDConnectProvider",
    }),
    "cloudfront-distributions": frozenset({"CloudFrontDistribution"}),
    "cloudfront-functions": frozenset({"CloudFrontFunction"}),
    "cloudfront-key-groups": frozenset({"CloudFrontKeyGroup"}),
    "cloudfront-public-keys": frozenset({"CloudFrontPublicKey"}),
    "cloudfront-oai": frozenset({"CloudFrontOriginAccessIdentity"}),
    "cloudfront-oac": frozenset({"CloudFrontOriginAccessControl"}),
    "route53": frozenset({"Route53HostedZone"}),
    "route53domains": frozenset({"Route53RegisteredDomain"}),
    "wafv2-global": frozenset({"WAFv2WebACL", "WAFv2RuleGroup", "WAFv2IPSet", "WAFv2RegexPatternSet"}),
}
COVERED_BOTOCORE_SERVICE_MODELS: Final = frozenset({
    "acm", "apigateway", "apigatewayv2", "cloudformation", "cloudfront", "dynamodb", "ec2",
    "ecr", "ecs", "eks", "elb", "elbv2", "events", "guardduty", "iam", "kms", "lambda",
    "logs", "rds", "resource-explorer-2", "route53", "route53domains", "s3", "secretsmanager",
    "sns", "sqs", "ssm", "stepfunctions", "wafv2",
})
KMS_SCHEDULED_STATES: Final = frozenset({"PendingDeletion", "PendingReplicaDeletion"})
ASYNC_STATE_FIELDS: Final[dict[str, tuple[str, ...]]] = {
    "CloudFormationStack": ("status",),
    "CloudFrontDistribution": ("enabled", "status"),
    "ResourceExplorerIndex": ("type",),
    "EC2Instance": ("state",),
    "EC2NatGateway": ("state",),
    "EKSCluster": ("status",),
    "EKSAddon": ("status",),
    "EKSNodegroup": ("status",),
    "EKSFargateProfile": ("status",),
    "RDSInstance": ("status",),
    "RDSCluster": ("status",),
    "DynamoDBTable": ("status",),
    "StepFunctionsExecution": ("status",),
    "KMSKey": ("state", "multi_region_key_type"),
}
PRESERVED_ROLE_DEFAULTS: Final = frozenset(
    {"OrganizationAccountAccessRole", "admin-console", "support-quota"}
)
AWS_CONFIG: Final = BotocoreConfig(
    retries={"max_attempts": 6, "mode": "standard"},
    connect_timeout=10,
    read_timeout=90,
    user_agent_extra="awstool-account-cleanup/1.0",
)
ASYNC_TYPES: Final = frozenset(
    {
        "CloudFormationStack",
        "CloudFrontDistribution",
        "ResourceExplorerIndex",
        "EC2Instance",
        "EC2NatGateway",
        "EKSCluster",
        "EKSAddon",
        "EKSNodegroup",
        "EKSFargateProfile",
        "RDSInstance",
        "RDSCluster",
        "DynamoDBTable",
        "StepFunctionsExecution",
        "KMSKey",
    }
)
MANUAL_TYPES: Final = frozenset(
    {"EC2ReservedInstance", "RDSReservedInstance", "Route53RegisteredDomain", "SNSPendingSubscription"}
)
NOT_FOUND_CODES: Final = frozenset(
    {
        "NoSuchEntity",
        "NoSuchBucket",
        "NoSuchDistribution",
        "NoSuchHostedZone",
        "NoSuchKey",
        "ResourceNotFoundException",
        "ResourceNotFound",
        "RepositoryNotFoundException",
        "ClusterNotFoundException",
        "DBInstanceNotFound",
        "DBClusterNotFoundFault",
        "DBSnapshotNotFound",
        "DBClusterSnapshotNotFoundFault",
        "DBSubnetGroupNotFoundFault",
        "InvalidGroup.NotFound",
        "InvalidInstanceID.NotFound",
        "InvalidVolume.NotFound",
        "InvalidSnapshot.NotFound",
        "InvalidAMIID.NotFound",
        "InvalidVpcID.NotFound",
        "InvalidSubnetID.NotFound",
        "InvalidRouteTableID.NotFound",
        "InvalidNetworkInterfaceID.NotFound",
        "InvalidVpcEndpointId.NotFound",
        "LoadBalancerNotFound",
        "LoadBalancerNotFoundException",
        "TargetGroupNotFound",
        "TargetGroupNotFoundException",
        "QueueDoesNotExist",
        "ParameterNotFound",
        "AssociationDoesNotExist",
        "NotFoundException",
    }
)
WAITING_CODES: Final = frozenset(
    {
        "DependencyViolation",
        "ResourceInUseException",
        "ResourceInUse",
        "InvalidState",
        "InvalidStateException",
        "OperationNotPermitted",
        "DeleteConflict",
        "KMSInvalidStateException",
        "ConflictException",
        "ConcurrentModificationException",
        "PriorRequestNotComplete",
        "Throttling",
        "ThrottlingException",
        "TooManyRequestsException",
        "LimitExceededException",
        "InvalidDBInstanceState",
        "InvalidDBClusterStateFault",
        "InvalidDBSnapshotState",
        "InvalidDBClusterSnapshotStateFault",
        "InvalidSubnet",
        "ResourceInUseFault",
        "BucketNotEmpty",
        "DistributionNotDisabled",
        "HostedZoneNotEmpty",
        "WAFAssociatedItemException",
    }
)
ACCESS_DENIED_CODES: Final = frozenset(
    {
        "AccessDenied",
        "AccessDeniedException",
        "UnauthorizedOperation",
        "UnrecognizedClientException",
        "InvalidClientTokenId",
        "AuthFailure",
        "ForbiddenException",
    }
)
UNSUPPORTED_REGION_CODES: Final = frozenset(
    {"OptInRequired", "InvalidAction", "UnknownOperationException", "SubscriptionRequiredException"}
)


class CleanupError(RuntimeError):
    """Expected, sanitized command failure suitable for structured output."""


class CleanupWaitingError(CleanupError):
    """A dependency or asynchronous transition that should be retried."""


@dataclasses.dataclass(frozen=True)
class Payer:
    name: str
    role_arn: str
    account_id: str


@dataclasses.dataclass(frozen=True)
class AccountRecord:
    account_id: str
    payer_name: str | None
    joined_method: str | None


@dataclasses.dataclass(frozen=True)
class AppConfig:
    region: str
    access_key_id: str
    secret_access_key: str
    session_token: str | None
    payers: tuple[Payer, ...]
    child_role_name: str
    admin_role_name: str
    support_role_name: str
    encryption_source: str

    @property
    def payer_ids(self) -> frozenset[str]:
        return frozenset(payer.account_id for payer in self.payers)

    @property
    def preserved_roles(self) -> frozenset[str]:
        return frozenset(
            {
                *PRESERVED_ROLE_DEFAULTS,
                self.child_role_name,
                self.admin_role_name,
                self.support_role_name,
            }
        )


@dataclasses.dataclass(frozen=True)
class Resource:
    service: str
    resource_type: str
    region: str
    resource_id: str
    arn: str | None = None
    metadata: Mapping[str, JsonValue] = dataclasses.field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.service}:{self.resource_type}:{self.region}:{self.resource_id}"

    def to_dict(self) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {
            "service": self.service,
            "type": self.resource_type,
            "region": self.region,
            "id": self.resource_id,
            "metadata": dict(self.metadata),
        }
        if self.arn:
            result["arn"] = self.arn
        return result


@dataclasses.dataclass(frozen=True)
class ScanIssue:
    service: str
    region: str
    category: str
    code: str
    message: str

    def to_dict(self) -> dict[str, JsonValue]:
        return dataclasses.asdict(self)


@dataclasses.dataclass(frozen=True)
class CoverageRecord:
    scanner_id: str
    region: str
    status: str
    detail: str = ""

    def to_dict(self) -> dict[str, JsonValue]:
        return dataclasses.asdict(self)


@dataclasses.dataclass
class Inventory:
    account_id: str
    credential_path: str
    regions: list[str]
    resources: list[Resource]
    issues: list[ScanIssue]
    coverage: list[CoverageRecord]
    coverage_gaps: list[str]
    costs: dict[str, float]
    manual_checks: list[dict[str, JsonValue]]
    generated_at: str = dataclasses.field(default_factory=lambda: utc_now().isoformat())

    @property
    def expected_coverage_keys(self) -> frozenset[tuple[str, str]]:
        return frozenset(
            [(scanner_id, region) for region in self.regions for scanner_id in REGIONAL_SCANNER_IDS]
            + [(scanner_id, "global") for scanner_id in GLOBAL_SCANNER_IDS]
        )

    @property
    def coverage_complete(self) -> bool:
        actual_keys = [(item.scanner_id, item.region) for item in self.coverage]
        return (
            bool(self.coverage)
            and not self.coverage_gaps
            and len(actual_keys) == len(set(actual_keys))
            and frozenset(actual_keys) == self.expected_coverage_keys
            and all(item.status in {"complete", "not_applicable"} for item in self.coverage)
        )

    @property
    def fingerprint(self) -> str:
        rows: list[str] = []
        for resource in self.resources:
            fields = ASYNC_STATE_FIELDS.get(resource.resource_type, ())
            lifecycle = {field: resource.metadata.get(field) for field in fields}
            rows.append(f"{resource.key}|{json.dumps(lifecycle, sort_keys=True, default=json_default)}")
        return hashlib.sha256("\n".join(sorted(rows)).encode("utf-8")).hexdigest()

    def to_dict(self, include_resources: bool = True) -> dict[str, JsonValue]:
        counts = Counter(f"{resource.service}/{resource.resource_type}" for resource in self.resources)
        by_region = Counter(resource.region for resource in self.resources)
        coverage_failures = [
            item for item in self.coverage if item.status not in {"complete", "not_applicable"}
        ]
        result: dict[str, JsonValue] = {
            "account_id": self.account_id,
            "credential_path": self.credential_path,
            "generated_at": self.generated_at,
            "regions_scanned": self.regions,
            "coverage_contract_version": COVERAGE_CONTRACT_VERSION,
            "coverage_complete": self.coverage_complete,
            "coverage_expected": [
                {"scanner_id": scanner_id, "region": region}
                for scanner_id, region in sorted(self.expected_coverage_keys)
            ],
            "coverage_gaps": sorted(self.coverage_gaps),
            "coverage": [item.to_dict() for item in self.coverage],
            "summary": {
                "resource_count": len(self.resources),
                "by_type": dict(sorted(counts.items())),
                "by_region": dict(sorted(by_region.items())),
                "scan_issue_count": len(self.issues),
                "coverage_failure_count": len(coverage_failures),
                "coverage_gap_count": len(self.coverage_gaps),
                "month_to_date_cost_usd": round(sum(self.costs.values()), 6),
            },
            "month_to_date_cost_by_service_usd": {
                key: round(value, 6) for key, value in sorted(self.costs.items())
            },
            "manual_checks": self.manual_checks,
            "issues": [issue.to_dict() for issue in self.issues],
        }
        if include_resources:
            result["resources"] = [resource.to_dict() for resource in sorted_resources(self.resources)]
        return result


@dataclasses.dataclass(frozen=True)
class ActionResult:
    resource_key: str
    status: str
    operation: str
    category: str | None = None
    code: str | None = None
    message: str | None = None

    def to_dict(self) -> dict[str, JsonValue]:
        return {
            key: value
            for key, value in dataclasses.asdict(self).items()
            if value is not None
        }


@dataclasses.dataclass(frozen=True)
class SessionPath:
    session: boto3.session.Session
    description: str
    payer: Payer | None


# AES-256-CBC decryption is implemented locally so encrypted restricted-account
# ExternalIds can be used for read-only probe without adding a dependency.
_AES_SBOX: Final = (
    0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
    0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
    0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
    0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
    0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
    0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
    0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
    0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
    0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
    0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
    0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
    0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
    0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
    0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
    0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
)
_AES_INV_SBOX: Final = tuple(_AES_SBOX.index(value) for value in range(256))
_AES_RCON: Final = (0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36)


def _aes_expand_key(key: bytes) -> list[bytes]:
    if len(key) != 32:
        raise ValueError("AES-256 requires a 32-byte key")
    words = [list(key[offset : offset + 4]) for offset in range(0, 32, 4)]
    for index in range(8, 60):
        temp = words[index - 1][:]
        if index % 8 == 0:
            temp = temp[1:] + temp[:1]
            temp = [_AES_SBOX[value] for value in temp]
            temp[0] ^= _AES_RCON[index // 8]
        elif index % 8 == 4:
            temp = [_AES_SBOX[value] for value in temp]
        words.append([words[index - 8][column] ^ temp[column] for column in range(4)])
    return [bytes(sum(words[index : index + 4], [])) for index in range(0, 60, 4)]


def _aes_mul(value: int, multiplier: int) -> int:
    result = 0
    while multiplier:
        if multiplier & 1:
            result ^= value
        value = ((value << 1) ^ (0x11B if value & 0x80 else 0)) & 0xFF
        multiplier >>= 1
    return result


def _aes_decrypt_block(block: bytes, round_keys: Sequence[bytes]) -> bytes:
    state = list(block)

    def add_round_key(round_index: int) -> None:
        for index, value in enumerate(round_keys[round_index]):
            state[index] ^= value

    def inverse_shift_rows() -> None:
        previous = state[:]
        for row in range(1, 4):
            for column in range(4):
                state[4 * column + row] = previous[4 * ((column - row) % 4) + row]

    def inverse_sub_bytes() -> None:
        for index, value in enumerate(state):
            state[index] = _AES_INV_SBOX[value]

    def inverse_mix_columns() -> None:
        for column in range(4):
            offset = 4 * column
            a0, a1, a2, a3 = state[offset : offset + 4]
            state[offset] = _aes_mul(a0, 14) ^ _aes_mul(a1, 11) ^ _aes_mul(a2, 13) ^ _aes_mul(a3, 9)
            state[offset + 1] = _aes_mul(a0, 9) ^ _aes_mul(a1, 14) ^ _aes_mul(a2, 11) ^ _aes_mul(a3, 13)
            state[offset + 2] = _aes_mul(a0, 13) ^ _aes_mul(a1, 9) ^ _aes_mul(a2, 14) ^ _aes_mul(a3, 11)
            state[offset + 3] = _aes_mul(a0, 11) ^ _aes_mul(a1, 13) ^ _aes_mul(a2, 9) ^ _aes_mul(a3, 14)

    add_round_key(14)
    for round_index in range(13, 0, -1):
        inverse_shift_rows()
        inverse_sub_bytes()
        add_round_key(round_index)
        inverse_mix_columns()
    inverse_shift_rows()
    inverse_sub_bytes()
    add_round_key(0)
    return bytes(state)


def decrypt_external_id(value: str, encryption_source: str) -> str:
    """Decrypt the Node AES-256-CBC field format; never include the value in errors."""
    if ":" not in value:
        return value
    try:
        iv_hex, ciphertext_hex = value.split(":", 1)
        iv = bytes.fromhex(iv_hex)
        ciphertext = bytes.fromhex(ciphertext_hex)
        if len(iv) != 16 or not ciphertext or len(ciphertext) % 16:
            raise ValueError("invalid encrypted field shape")
        key = hashlib.sha256(encryption_source.encode("utf-8")).digest()
        round_keys = _aes_expand_key(key)
        plaintext = bytearray()
        previous = iv
        for offset in range(0, len(ciphertext), 16):
            current = ciphertext[offset : offset + 16]
            decrypted = _aes_decrypt_block(current, round_keys)
            plaintext.extend(left ^ right for left, right in zip(decrypted, previous))
            previous = current
        padding = plaintext[-1]
        if padding < 1 or padding > 16 or plaintext[-padding:] != bytes([padding]) * padding:
            raise ValueError("invalid encrypted field padding")
        return bytes(plaintext[:-padding]).decode("utf-8")
    except (ValueError, UnicodeError) as exc:
        raise CleanupError("Unable to decrypt the restricted-account ExternalId") from exc


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def json_default(value: Any) -> JsonValue:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return "<bytes>"
    if hasattr(value, "as_tuple"):
        return float(value)
    return str(value)


def emit(payload: Mapping[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=json_default, sort_keys=True))


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError as exc:
        raise CleanupError(f"Required {label} file is missing") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise CleanupError(f"Unable to read valid JSON from {label}") from exc
    if not isinstance(value, dict):
        raise CleanupError(f"{label} must contain a JSON object")
    return value


def load_state() -> tuple[AppConfig, tuple[AccountRecord, ...], dict[str, str]]:
    raw_config = read_json_object(CONFIG_PATH, "config")
    raw_db = read_json_object(DB_PATH, "database")
    credentials = raw_config.get("credentials")
    if not isinstance(credentials, dict):
        raise CleanupError("config credentials are missing")
    access_key_id = credentials.get("accessKeyId")
    secret_access_key = credentials.get("secretAccessKey")
    if not isinstance(access_key_id, str) or not access_key_id or not isinstance(secret_access_key, str) or not secret_access_key:
        raise CleanupError("config credentials are incomplete")

    payers: list[Payer] = []
    raw_payers = raw_config.get("payers")
    if not isinstance(raw_payers, list) or not raw_payers:
        raise CleanupError("config payers must be a non-empty array")
    seen_payer_ids: set[str] = set()
    seen_payer_names: set[str] = set()
    for raw_payer in raw_payers:
        if not isinstance(raw_payer, dict):
            raise CleanupError("config contains an invalid payer entry")
        name, role_arn = raw_payer.get("name"), raw_payer.get("roleArn")
        if not isinstance(name, str) or not name or not isinstance(role_arn, str):
            raise CleanupError("config contains an incomplete payer entry")
        match = PAYER_ARN_RE.fullmatch(role_arn)
        if not match:
            raise CleanupError(f"payer {name!r} has an invalid role ARN")
        payer_id = match.group(1)
        if payer_id in seen_payer_ids:
            raise CleanupError("config contains duplicate payer account IDs")
        if name in seen_payer_names:
            raise CleanupError("config contains duplicate payer names")
        seen_payer_ids.add(payer_id)
        seen_payer_names.add(name)
        payers.append(Payer(name=name, role_arn=role_arn, account_id=payer_id))

    web_config = raw_config.get("web") if isinstance(raw_config.get("web"), dict) else {}
    encryption_source = web_config.get("encryptionKey") or web_config.get("jwtSecret") or "default-fallback-key-32chars-xxx"
    if not isinstance(encryption_source, str):
        raise CleanupError("config encryption source must be a string")
    config = AppConfig(
        region=str(raw_config.get("region") or "us-east-1"),
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=credentials.get("sessionToken") if isinstance(credentials.get("sessionToken"), str) else None,
        payers=tuple(payers),
        child_role_name=str(raw_config.get("childRoleName") or "OrganizationAccountAccessRole"),
        admin_role_name=str(raw_config.get("adminRoleName") or "admin-console"),
        support_role_name=str(raw_config.get("supportRoleName") or "support-quota"),
        encryption_source=encryption_source,
    )

    records: list[AccountRecord] = []
    raw_accounts = raw_db.get("accounts_cache", [])
    if not isinstance(raw_accounts, list):
        raise CleanupError("database accounts_cache must be an array")
    for raw_account in raw_accounts:
        if not isinstance(raw_account, dict) or not isinstance(raw_account.get("Id"), str):
            continue
        payer_name = raw_account.get("_payer") if isinstance(raw_account.get("_payer"), str) else None
        joined_method = raw_account.get("JoinedMethod") if isinstance(raw_account.get("JoinedMethod"), str) else None
        records.append(AccountRecord(raw_account["Id"], payer_name, joined_method))

    restricted: dict[str, str] = {}
    raw_restricted = raw_db.get("restricted_accounts", [])
    if isinstance(raw_restricted, list):
        for record in raw_restricted:
            if not isinstance(record, dict):
                continue
            account_id, encrypted = record.get("account_id"), record.get("external_id_enc")
            if isinstance(account_id, str) and isinstance(encrypted, str) and encrypted:
                restricted[account_id] = encrypted
    return config, tuple(records), restricted


def validate_runtime() -> None:
    if sys.version_info[:2] < (3, 9):
        raise CleanupError(f"Python 3.9 or newer is required; running {sys.version_info.major}.{sys.version_info.minor}")
    if boto3.__version__ != REQUIRED_BOTO3:
        raise CleanupError(f"boto3 {REQUIRED_BOTO3} is required; running {boto3.__version__}")

    scanner_ids = frozenset({*REGIONAL_SCANNER_IDS, *GLOBAL_SCANNER_IDS})
    if frozenset(SCANNER_RESOURCE_TYPE_MANIFEST) != scanner_ids:
        raise CleanupError("Scanner resource-type manifest drift detected")
    declared_types = frozenset(
        resource_type
        for resource_types in SCANNER_RESOURCE_TYPE_MANIFEST.values()
        for resource_type in resource_types
    )
    unmapped_cfn_targets = frozenset(CFN_RESOURCE_TYPE_MAP.values()) - declared_types
    if unmapped_cfn_targets:
        raise CleanupError("CloudFormation ownership map targets undeclared scanner resource types")
    automatic_types = declared_types - MANUAL_TYPES
    if automatic_types - frozenset(DELETE_ORDER):
        raise CleanupError("Scanner resource type has no explicit deletion order")
    missing_handlers = {
        resource_type
        for resource_type in automatic_types
        if not callable(getattr(ResourceDeleter, f"_delete_{resource_type}", None))
    }
    if missing_handlers:
        raise CleanupError("Scanner resource type has no safe automatic deleter")


def validate_target(account_id: str, config: AppConfig) -> None:
    if not ACCOUNT_RE.fullmatch(account_id):
        raise CleanupError("Target account ID must be exactly 12 decimal digits")
    if account_id in config.payer_ids:
        raise CleanupError("Refusing to operate on a configured payer/management account")


def error_code(exc: BaseException) -> str:
    if isinstance(exc, ClientError):
        return str(exc.response.get("Error", {}).get("Code") or exc.__class__.__name__)
    return exc.__class__.__name__


def safe_error_message(exc: BaseException) -> str:
    if isinstance(exc, ClientError):
        raw = str(exc.response.get("Error", {}).get("Message") or "AWS API request failed")
    elif isinstance(exc, BotoCoreError):
        raw = exc.__class__.__name__
    else:
        raw = str(exc) or exc.__class__.__name__
    raw = re.sub(r"(?i)(access[_ ]?key|secret|token|externalid)\s*[=:]\s*\S+", r"\1=<redacted>", raw)
    return raw[:500]


def classify_error(exc: BaseException) -> str:
    if isinstance(exc, CleanupWaitingError):
        return "waiting"
    code = error_code(exc)
    if code in NOT_FOUND_CODES:
        return "not_found"
    if code in ACCESS_DENIED_CODES or "AccessDenied" in code or "Unauthorized" in code:
        return "access_denied"
    if code in WAITING_CODES or "InUse" in code or "Conflict" in code or "Throttl" in code:
        return "waiting"
    if code in {"UnknownEndpointError", "EndpointConnectionError"}:
        return "endpoint_unavailable"
    if code in UNSUPPORTED_REGION_CODES:
        return "unsupported_region"
    return "failed"


def assert_account(session: boto3.session.Session, expected_account_id: str, phase: str, region: str) -> dict[str, str]:
    try:
        identity = session.client("sts", region_name=region, config=AWS_CONFIG).get_caller_identity()
    except (ClientError, BotoCoreError) as exc:
        raise CleanupError(f"STS identity assertion failed at {phase}: {error_code(exc)}") from exc
    actual = str(identity.get("Account") or "")
    if actual != expected_account_id:
        raise CleanupError(f"Account assertion failed at {phase}: expected target does not match active identity")
    return {"account_id": actual, "arn": str(identity.get("Arn") or "")}


def session_from_assume(response: Mapping[str, Any], region: str) -> boto3.session.Session:
    credentials = response.get("Credentials")
    if not isinstance(credentials, Mapping):
        raise CleanupError("STS AssumeRole returned no credentials")
    try:
        return boto3.Session(
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
            region_name=region,
        )
    except KeyError as exc:
        raise CleanupError("STS AssumeRole returned incomplete credentials") from exc


class CredentialManager:
    """Resolve only approved target-account sessions and retain no persisted credentials."""

    def __init__(
        self,
        config: AppConfig,
        records: Sequence[AccountRecord],
        restricted: Mapping[str, str],
    ) -> None:
        self.config = config
        self.records = {record.account_id: record for record in records}
        self.record_counts = Counter(record.account_id for record in records)
        self.restricted = restricted
        self.base_session = boto3.Session(
            aws_access_key_id=config.access_key_id,
            aws_secret_access_key=config.secret_access_key,
            aws_session_token=config.session_token,
            region_name=config.region,
        )
        self._payer_sessions: dict[str, boto3.session.Session] = {}

    def account_record(self, account_id: str) -> AccountRecord | None:
        return self.records.get(account_id)

    def payer_for_target(self, account_id: str) -> Payer | None:
        record = self.account_record(account_id)
        if not record or not record.payer_name:
            return None
        return next((payer for payer in self.config.payers if payer.name == record.payer_name), None)

    def validate_member(self, account_id: str) -> tuple[AccountRecord, Payer]:
        validate_target(account_id, self.config)
        if self.record_counts.get(account_id) != 1:
            raise CleanupError("Target must have exactly one accounts_cache member record")
        record = self.account_record(account_id)
        payer = self.payer_for_target(account_id)
        if record is None or payer is None:
            raise CleanupError("Target member must have an exact _payer mapping to config.payers")
        return record, payer

    def assert_destructive_membership(self, account_id: str) -> Payer:
        """Prove from the mapped management account that target is an ACTIVE member."""
        _, payer = self.validate_member(account_id)
        payer_session = self.assume_payer(payer)
        assert_account(payer_session, payer.account_id, "organizations-preflight-payer", self.config.region)
        try:
            organizations = payer_session.client("organizations", region_name="us-east-1", config=AWS_CONFIG)
            organization = organizations.describe_organization().get("Organization", {})
            management_id = str(organization.get("ManagementAccountId") or "")
            legacy_id = str(organization.get("MasterAccountId") or "")
            if management_id and legacy_id and management_id != legacy_id:
                raise CleanupError("Organizations returned conflicting management account IDs")
            authoritative_management_id = management_id or legacy_id
            if authoritative_management_id != payer.account_id:
                raise CleanupError("Mapped payer is not the live Organizations management account")
            if account_id == authoritative_management_id:
                raise CleanupError("Refusing to operate on the live Organizations management account")
            account = organizations.describe_account(AccountId=account_id).get("Account", {})
        except (ClientError, BotoCoreError) as exc:
            raise CleanupError(f"Live Organizations membership validation failed: {error_code(exc)}") from exc
        if str(account.get("Id") or "") != account_id:
            raise CleanupError("Organizations returned a different member account ID")
        status = str(account.get("State") or account.get("Status") or "")
        if status != "ACTIVE":
            raise CleanupError("Target is not an ACTIVE member of the mapped organization")
        return payer

    def assume_payer(self, payer: Payer) -> boto3.session.Session:
        cached = self._payer_sessions.get(payer.role_arn)
        if cached:
            assert_account(cached, payer.account_id, "payer-session-reuse", self.config.region)
            return cached
        response = self.base_session.client("sts", region_name=self.config.region, config=AWS_CONFIG).assume_role(
            RoleArn=payer.role_arn,
            RoleSessionName="cleanup-payer",
            DurationSeconds=3600,
        )
        session = session_from_assume(response, self.config.region)
        assert_account(session, payer.account_id, "payer-assume", self.config.region)
        self._payer_sessions[payer.role_arn] = session
        return session

    def _assume_direct_admin(self, account_id: str) -> SessionPath:
        role_arn = f"arn:aws:iam::{account_id}:role/{self.config.admin_role_name}"
        response = self.base_session.client("sts", region_name=self.config.region, config=AWS_CONFIG).assume_role(
            RoleArn=role_arn,
            RoleSessionName=f"cleanup-admin-{account_id}"[:64],
            DurationSeconds=3600,
        )
        session = session_from_assume(response, self.config.region)
        assert_account(session, account_id, "direct-admin-assume", self.config.region)
        return SessionPath(session, f"base→{self.config.admin_role_name}", self.payer_for_target(account_id))

    def _assume_oaar(self, account_id: str, payer: Payer) -> SessionPath:
        payer_session = self.assume_payer(payer)
        role_arn = f"arn:aws:iam::{account_id}:role/{self.config.child_role_name}"
        response = payer_session.client("sts", region_name=self.config.region, config=AWS_CONFIG).assume_role(
            RoleArn=role_arn,
            RoleSessionName=f"cleanup-child-{account_id}"[:64],
            DurationSeconds=3600,
        )
        session = session_from_assume(response, self.config.region)
        assert_account(session, account_id, "oaar-assume", self.config.region)
        return SessionPath(
            session,
            f"base→payer:{payer.name}/tool→{self.config.child_role_name}",
            payer,
        )

    def assume_admin(self, account_id: str) -> SessionPath:
        _, known_payer = self.validate_member(account_id)
        failures: list[str] = []
        try:
            return self._assume_direct_admin(account_id)
        except (ClientError, BotoCoreError, CleanupError) as exc:
            failures.append(f"direct-admin:{error_code(exc)}")

        try:
            return self._assume_oaar(account_id, known_payer)
        except (ClientError, BotoCoreError, CleanupError) as exc:
            failures.append(f"known-payer-oaar:{error_code(exc)}")

        raise CleanupError("No administrator credential path succeeded (" + ", ".join(failures) + ")")

    def probe_support(self, account_id: str) -> dict[str, JsonValue]:
        self.validate_member(account_id)
        request: dict[str, Any] = {
            "RoleArn": f"arn:aws:iam::{account_id}:role/{self.config.support_role_name}",
            "RoleSessionName": f"cleanup-probe-{account_id}"[:64],
            "DurationSeconds": 900,
        }
        encrypted_external_id = self.restricted.get(account_id)
        restricted = encrypted_external_id is not None
        if encrypted_external_id:
            request["ExternalId"] = decrypt_external_id(encrypted_external_id, self.config.encryption_source)
        try:
            response = self.base_session.client("sts", region_name=self.config.region, config=AWS_CONFIG).assume_role(**request)
            session = session_from_assume(response, self.config.region)
            assert_account(session, account_id, "support-probe", self.config.region)
            return {
                "available": True,
                "path": f"base→{self.config.support_role_name}",
                "restricted_external_id_used": restricted,
                "scope": "read_only_probe_only",
            }
        except (ClientError, BotoCoreError, CleanupError) as exc:
            return {
                "available": False,
                "path": f"base→{self.config.support_role_name}",
                "restricted_external_id_used": restricted,
                "scope": "read_only_probe_only",
                "error": {"category": classify_error(exc), "code": error_code(exc)},
            }


def paginate(client: Any, operation: str, **kwargs: Any) -> Iterator[dict[str, Any]]:
    try:
        paginator = client.get_paginator(operation)
        yield from paginator.paginate(**kwargs)
    except OperationNotPageableError:
        yield getattr(client, operation)(**kwargs)


def list_event_bus_names(client: Any) -> list[str]:
    """Enumerate every EventBridge bus; botocore 1.42.68 has no paginator for this API."""
    names = {"default"}
    next_token: str | None = None
    seen_tokens: set[str] = set()
    while True:
        request: dict[str, Any] = {"NextToken": next_token} if next_token else {}
        response = client.list_event_buses(**request)
        names.update(
            str(item["Name"])
            for item in response.get("EventBuses", [])
            if item.get("Name")
        )
        raw_next_token = response.get("NextToken")
        next_token = str(raw_next_token) if raw_next_token else None
        if not next_token:
            return sorted(names)
        if next_token in seen_tokens:
            raise CleanupError("EventBridge ListEventBuses returned a repeated pagination token")
        seen_tokens.add(next_token)


def issue_from_exception(service: str, region: str, exc: BaseException) -> ScanIssue:
    category = classify_error(exc)
    if error_code(exc) == "UnrecognizedClientException":
        category = "region_credentials_unavailable"
    return ScanIssue(service, region, category, error_code(exc), safe_error_message(exc))


def sorted_resources(resources: Iterable[Resource]) -> list[Resource]:
    return sorted(resources, key=lambda item: (item.region, item.service, item.resource_type, item.resource_id))


def make_resource(
    service: str,
    resource_type: str,
    region: str,
    resource_id: Any,
    *,
    arn: Any = None,
    metadata: Mapping[str, JsonValue] | None = None,
) -> Resource:
    return Resource(
        service=service,
        resource_type=resource_type,
        region=region,
        resource_id=str(resource_id),
        arn=str(arn) if arn else None,
        metadata=metadata or {},
    )


def runtime_coverage_gaps(session: boto3.session.Session) -> list[str]:
    """Derive a fail-closed positive manifest from service models and resource families."""
    family_gaps = {
        f"unimplemented-resource-family:{service}:{family}"
        for service, families in RESOURCE_FAMILY_GAPS.items()
        for family in families
    }
    try:
        available = set(session.get_available_services())
    except Exception as exc:
        return sorted({*KNOWN_COVERAGE_GAPS, *family_gaps, f"service-model-manifest-unavailable:{error_code(exc)}"})
    unclassified = sorted(available - COVERED_BOTOCORE_SERVICE_MODELS)
    return sorted({
        *KNOWN_COVERAGE_GAPS,
        *family_gaps,
        *(f"unclassified-service-model:{name}" for name in unclassified),
    })


def deduplicate_resources(resources: Sequence[Resource]) -> tuple[list[Resource], list[ScanIssue]]:
    """Remove exact API duplicates but fail closed on conflicting resource identities."""
    grouped: dict[str, list[Resource]] = {}
    for resource in resources:
        grouped.setdefault(resource.key, []).append(resource)
    result: list[Resource] = []
    issues: list[ScanIssue] = []
    for key, matches in grouped.items():
        signatures = {
            json.dumps({"arn": item.arn, "metadata": dict(item.metadata)}, sort_keys=True, default=json_default)
            for item in matches
        }
        if len(signatures) == 1:
            result.append(matches[0])
            continue
        result.extend(matches)
        issues.append(ScanIssue(
            matches[0].service,
            matches[0].region,
            "duplicate_identity",
            "ConflictingResourceIdentity",
            f"Resource key {key} resolved to multiple distinct parent-scoped resources",
        ))
    return result, issues


class InventoryScanner:
    """Read-only cross-region and global resource inventory."""

    def __init__(self, config: AppConfig, manager: CredentialManager, target: SessionPath, account_id: str) -> None:
        self.config = config
        self.manager = manager
        self.target = target
        self.account_id = account_id

    def enabled_regions(self) -> tuple[list[str], list[ScanIssue]]:
        try:
            ec2 = self.target.session.client("ec2", region_name=self.config.region, config=AWS_CONFIG)
            response = ec2.describe_regions(AllRegions=True)
            regions = sorted(
                str(item["RegionName"])
                for item in response.get("Regions", [])
                if item.get("RegionName")
                and item.get("OptInStatus") in {"opt-in-not-required", "opted-in"}
            )
            if not regions:
                raise CleanupError("EC2 returned no enabled regions")
            return regions, []
        except (ClientError, BotoCoreError, CleanupError) as exc:
            return [self.config.region], [issue_from_exception("ec2:DescribeRegions", "global", exc)]

    def scan(self, *, include_costs: bool = True) -> Inventory:
        assert_account(self.target.session, self.account_id, "scan", self.config.region)
        regions, issues = self.enabled_regions()
        resources: list[Resource] = []
        coverage: list[CoverageRecord] = []
        max_workers = min(8, max(1, len(regions)))
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(self._scan_region, region): region for region in regions}
            for future in concurrent.futures.as_completed(futures):
                region = futures[future]
                try:
                    region_resources, region_issues, region_coverage = future.result()
                    resources.extend(region_resources)
                    issues.extend(region_issues)
                    coverage.extend(region_coverage)
                except BaseException as exc:  # a worker must never make the whole inventory disappear
                    issues.append(issue_from_exception("regional-scan", region, exc))
                    coverage.append(CoverageRecord("regional-scan", region, "failed", error_code(exc)))
        global_resources, global_issues, global_coverage = self._scan_global()
        resources.extend(global_resources)
        issues.extend(global_issues)
        coverage.extend(global_coverage)

        costs: dict[str, float] = {}
        if include_costs:
            costs, cost_issues = self._scan_costs()
            issues.extend(cost_issues)
        unique_resources, identity_issues = deduplicate_resources(resources)
        issues.extend(identity_issues)
        related_resources, relationship_issues = apply_resource_relationships(
            unique_resources,
            self.config,
        )
        issues.extend(relationship_issues)
        manual_checks = self._manual_checks(costs, related_resources)
        return Inventory(
            account_id=self.account_id,
            credential_path=self.target.description,
            regions=regions,
            resources=related_resources,
            issues=issues,
            coverage=coverage,
            coverage_gaps=runtime_coverage_gaps(self.target.session),
            costs=costs,
            manual_checks=manual_checks,
        )

    def _collect(
        self,
        service: str,
        region: str,
        function: Callable[[], list[Resource]],
    ) -> tuple[list[Resource], list[ScanIssue], CoverageRecord]:
        try:
            resources = function()
            declared_types = SCANNER_RESOURCE_TYPE_MANIFEST.get(service)
            if declared_types is None:
                raise CleanupError(f"Scanner {service} has no resource-type manifest")
            unexpected_types = sorted({
                resource.resource_type
                for resource in resources
                if resource.resource_type not in declared_types
            })
            if unexpected_types:
                raise CleanupError(
                    f"Scanner {service} emitted undeclared resource types: {', '.join(unexpected_types)}"
                )
            return resources, [], CoverageRecord(service, region, "complete")
        except (ClientError, BotoCoreError, CleanupError, KeyError, ValueError) as exc:
            return [], [issue_from_exception(service, region, exc)], CoverageRecord(
                service, region, "failed", error_code(exc)
            )

    def _scan_region(self, region: str) -> tuple[list[Resource], list[ScanIssue], list[CoverageRecord]]:
        resources: list[Resource] = []
        issues: list[ScanIssue] = []
        coverage: list[CoverageRecord] = []
        scanners: tuple[tuple[str, Callable[[], list[Resource]]], ...] = (
            ("ec2", lambda: self._scan_ec2(region)),
            ("rds", lambda: self._scan_rds(region)),
            ("lambda", lambda: self._scan_lambda(region)),
            ("cloudformation", lambda: self._scan_cloudformation(region)),
            ("resource-explorer-2", lambda: self._scan_resource_explorer(region)),
            ("elbv2", lambda: self._scan_elbv2(region)),
            ("elb", lambda: self._scan_elb(region)),
            ("ecs", lambda: self._scan_ecs(region)),
            ("ecr", lambda: self._scan_ecr(region)),
            ("eks", lambda: self._scan_eks(region)),
            ("dynamodb", lambda: self._scan_dynamodb(region)),
            ("sqs", lambda: self._scan_sqs(region)),
            ("sns", lambda: self._scan_sns(region)),
            ("logs", lambda: self._scan_logs(region)),
            ("events", lambda: self._scan_eventbridge(region)),
            ("stepfunctions", lambda: self._scan_stepfunctions(region)),
            ("secretsmanager", lambda: self._scan_secrets(region)),
            ("ssm", lambda: self._scan_ssm(region)),
            ("apigateway", lambda: self._scan_apigateway(region)),
            ("apigatewayv2", lambda: self._scan_apigateway_v2(region)),
            ("acm", lambda: self._scan_acm(region)),
            ("wafv2", lambda: self._scan_wafv2(region, "REGIONAL")),
            ("guardduty", lambda: self._scan_guardduty(region)),
            ("kms", lambda: self._scan_kms(region)),
        )
        if tuple(service for service, _ in scanners) != REGIONAL_SCANNER_IDS:
            raise CleanupError("Regional scanner manifest drift detected")
        for service, scanner in scanners:
            found, scan_issues, scan_coverage = self._collect(service, region, scanner)
            resources.extend(found)
            issues.extend(scan_issues)
            coverage.append(scan_coverage)
        return resources, issues, coverage

    def _scan_ec2(self, region: str) -> list[Resource]:
        client = self.target.session.client("ec2", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "describe_instances"):
            for reservation in page.get("Reservations", []):
                for instance in reservation.get("Instances", []):
                    state = instance.get("State", {}).get("Name")
                    if state != "terminated":
                        result.append(make_resource("ec2", "EC2Instance", region, instance["InstanceId"], metadata={"state": state or "unknown", "vpc_id": instance.get("VpcId") or ""}))
        for page in paginate(client, "describe_volumes"):
            for volume in page.get("Volumes", []):
                result.append(make_resource("ec2", "EC2Volume", region, volume["VolumeId"], metadata={"state": volume.get("State") or "unknown", "encrypted": bool(volume.get("Encrypted"))}))
        for page in paginate(client, "describe_snapshots", OwnerIds=["self"]):
            for snapshot in page.get("Snapshots", []):
                result.append(make_resource("ec2", "EC2Snapshot", region, snapshot["SnapshotId"], metadata={"state": snapshot.get("State") or "unknown"}))
        for page in paginate(client, "describe_images", Owners=["self"], IncludeDeprecated=True):
            for image in page.get("Images", []):
                result.append(make_resource("ec2", "EC2AMI", region, image["ImageId"], metadata={"state": image.get("State") or "unknown", "name": image.get("Name") or ""}))
        for address in client.describe_addresses().get("Addresses", []):
            allocation_id = address.get("AllocationId") or address.get("PublicIp")
            result.append(make_resource("ec2", "EC2ElasticIP", region, allocation_id, metadata={"association_id": address.get("AssociationId") or "", "public_ip": address.get("PublicIp") or ""}))
        for page in paginate(client, "describe_nat_gateways", Filter=[{"Name": "state", "Values": ["pending", "available", "deleting", "failed"]}]):
            for gateway in page.get("NatGateways", []):
                if gateway.get("State") != "deleted":
                    result.append(make_resource("ec2", "EC2NatGateway", region, gateway["NatGatewayId"], metadata={"state": gateway.get("State") or "unknown", "vpc_id": gateway.get("VpcId") or ""}))
        for page in paginate(client, "describe_vpc_endpoints"):
            for endpoint in page.get("VpcEndpoints", []):
                if endpoint.get("State") not in {"deleted", "failed"}:
                    result.append(make_resource("ec2", "EC2VpcEndpoint", region, endpoint["VpcEndpointId"], metadata={"state": endpoint.get("State") or "unknown", "vpc_id": endpoint.get("VpcId") or ""}))
        for page in paginate(client, "describe_network_interfaces"):
            for interface in page.get("NetworkInterfaces", []):
                result.append(make_resource("ec2", "EC2NetworkInterface", region, interface["NetworkInterfaceId"], metadata={"status": interface.get("Status") or "unknown", "requester_managed": bool(interface.get("RequesterManaged")), "vpc_id": interface.get("VpcId") or ""}))
        for page in paginate(client, "describe_launch_templates"):
            for template in page.get("LaunchTemplates", []):
                result.append(make_resource("ec2", "EC2LaunchTemplate", region, template["LaunchTemplateId"], metadata={"name": template.get("LaunchTemplateName") or ""}))
        for key_pair in client.describe_key_pairs().get("KeyPairs", []):
            result.append(make_resource("ec2", "EC2KeyPair", region, key_pair.get("KeyPairId") or key_pair["KeyName"], metadata={"name": key_pair["KeyName"]}))
        for page in paginate(client, "describe_internet_gateways"):
            for gateway in page.get("InternetGateways", []):
                result.append(make_resource("ec2", "EC2InternetGateway", region, gateway["InternetGatewayId"], metadata={"vpc_ids": [item.get("VpcId", "") for item in gateway.get("Attachments", [])]}))
        for page in paginate(client, "describe_subnets"):
            for subnet in page.get("Subnets", []):
                result.append(make_resource("ec2", "EC2Subnet", region, subnet["SubnetId"], metadata={"vpc_id": subnet.get("VpcId") or "", "default_for_az": bool(subnet.get("DefaultForAz"))}))
        for page in paginate(client, "describe_route_tables"):
            for table in page.get("RouteTables", []):
                main = any(association.get("Main") for association in table.get("Associations", []))
                table_id = str(table["RouteTableId"])
                vpc_id = str(table.get("VpcId") or "")
                result.append(make_resource("ec2", "EC2RouteTable", region, table_id, metadata={"vpc_id": vpc_id, "main": main}))
                for route in table.get("Routes", []):
                    if route.get("GatewayId") == "local" or route.get("Origin") == "CreateRouteTable":
                        continue
                    destination_type = next(
                        (name for name in ("DestinationCidrBlock", "DestinationIpv6CidrBlock", "DestinationPrefixListId") if route.get(name)),
                        "",
                    )
                    if not destination_type:
                        continue
                    destination = str(route[destination_type])
                    result.append(make_resource("ec2", "EC2Route", region, f"{table_id}:{destination}", metadata={"route_table_id": table_id, "vpc_id": vpc_id, "destination_type": destination_type, "destination": destination, "state": route.get("State") or "unknown"}))
        for page in paginate(client, "describe_security_groups"):
            for group in page.get("SecurityGroups", []):
                result.append(make_resource("ec2", "EC2SecurityGroup", region, group["GroupId"], metadata={"vpc_id": group.get("VpcId") or "", "name": group.get("GroupName") or "", "default": group.get("GroupName") == "default"}))
        for page in paginate(client, "describe_network_acls"):
            for acl in page.get("NetworkAcls", []):
                result.append(make_resource("ec2", "EC2NetworkAcl", region, acl["NetworkAclId"], metadata={"vpc_id": acl.get("VpcId") or "", "default": bool(acl.get("IsDefault"))}))
        default_vpc_ids: set[str] = set()
        for page in paginate(client, "describe_vpcs"):
            for vpc in page.get("Vpcs", []):
                is_default = bool(vpc.get("IsDefault"))
                if is_default:
                    default_vpc_ids.add(str(vpc["VpcId"]))
                result.append(make_resource("ec2", "EC2Vpc", region, vpc["VpcId"], metadata={"default": is_default, "state": vpc.get("State") or "unknown"}))
        for page in paginate(client, "describe_reserved_instances"):
            for reservation in page.get("ReservedInstances", []):
                if reservation.get("State") in {"active", "payment-pending"}:
                    result.append(make_resource("ec2", "EC2ReservedInstance", region, reservation["ReservedInstancesId"], metadata={"state": reservation.get("State") or "unknown", "disposition": "manual_contract"}))

        default_igw_counts: Counter[str] = Counter()
        for resource in result:
            if resource.resource_type != "EC2InternetGateway":
                continue
            attachments = resource.metadata.get("vpc_ids")
            if isinstance(attachments, list):
                for vpc_id in attachments:
                    if isinstance(vpc_id, str) and vpc_id in default_vpc_ids:
                        default_igw_counts[vpc_id] += 1

        annotated: list[Resource] = []
        for resource in result:
            metadata = dict(resource.metadata)
            vpc_id = metadata.get("vpc_id")
            in_default_vpc = isinstance(vpc_id, str) and vpc_id in default_vpc_ids
            baseline = resource.resource_type == "EC2Vpc" and bool(metadata.get("default"))
            if resource.resource_type == "EC2SecurityGroup":
                baseline = in_default_vpc and metadata.get("name") == "default"
            elif resource.resource_type == "EC2RouteTable":
                baseline = in_default_vpc and bool(metadata.get("main"))
            elif resource.resource_type == "EC2Subnet":
                baseline = in_default_vpc and bool(metadata.get("default_for_az"))
            elif resource.resource_type == "EC2NetworkAcl":
                baseline = in_default_vpc and bool(metadata.get("default"))
            elif resource.resource_type == "EC2InternetGateway":
                vpc_ids = metadata.get("vpc_ids")
                baseline = (
                    isinstance(vpc_ids, list)
                    and len(vpc_ids) == 1
                    and isinstance(vpc_ids[0], str)
                    and vpc_ids[0] in default_vpc_ids
                    and default_igw_counts[vpc_ids[0]] == 1
                )
            metadata["in_default_vpc"] = in_default_vpc
            metadata["default_vpc_baseline"] = baseline
            annotated.append(dataclasses.replace(resource, metadata=metadata))
        return annotated

    def _scan_rds(self, region: str) -> list[Resource]:
        client = self.target.session.client("rds", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "describe_db_instances"):
            for item in page.get("DBInstances", []):
                result.append(make_resource("rds", "RDSInstance", region, item["DBInstanceIdentifier"], arn=item.get("DBInstanceArn"), metadata={"status": item.get("DBInstanceStatus") or "unknown", "cluster_id": item.get("DBClusterIdentifier") or ""}))
        for page in paginate(client, "describe_db_clusters"):
            for item in page.get("DBClusters", []):
                result.append(make_resource("rds", "RDSCluster", region, item["DBClusterIdentifier"], arn=item.get("DBClusterArn"), metadata={"status": item.get("Status") or "unknown"}))
        for page in paginate(client, "describe_db_snapshots", SnapshotType="manual"):
            for item in page.get("DBSnapshots", []):
                result.append(make_resource("rds", "RDSManualSnapshot", region, item["DBSnapshotIdentifier"], arn=item.get("DBSnapshotArn"), metadata={"status": item.get("Status") or "unknown"}))
        for page in paginate(client, "describe_db_cluster_snapshots", SnapshotType="manual"):
            for item in page.get("DBClusterSnapshots", []):
                result.append(make_resource("rds", "RDSManualClusterSnapshot", region, item["DBClusterSnapshotIdentifier"], arn=item.get("DBClusterSnapshotArn"), metadata={"status": item.get("Status") or "unknown"}))
        for page in paginate(client, "describe_db_subnet_groups"):
            for item in page.get("DBSubnetGroups", []):
                result.append(make_resource("rds", "RDSSubnetGroup", region, item["DBSubnetGroupName"], arn=item.get("DBSubnetGroupArn"), metadata={"vpc_id": item.get("VpcId") or ""}))
        for page in paginate(client, "describe_reserved_db_instances"):
            for item in page.get("ReservedDBInstances", []):
                if item.get("State") in {"active", "payment-pending"}:
                    result.append(make_resource("rds", "RDSReservedInstance", region, item["ReservedDBInstanceId"], metadata={"state": item.get("State") or "unknown", "disposition": "manual_contract"}))
        return result

    def _scan_lambda(self, region: str) -> list[Resource]:
        client = self.target.session.client("lambda", region_name=region, config=AWS_CONFIG)
        return [make_resource("lambda", "LambdaFunction", region, item["FunctionName"], arn=item.get("FunctionArn")) for page in paginate(client, "list_functions") for item in page.get("Functions", [])]

    def _scan_cloudformation(self, region: str) -> list[Resource]:
        client = self.target.session.client("cloudformation", region_name=region, config=AWS_CONFIG)
        statuses = [
            "CREATE_IN_PROGRESS", "CREATE_FAILED", "CREATE_COMPLETE", "ROLLBACK_IN_PROGRESS", "ROLLBACK_FAILED", "ROLLBACK_COMPLETE",
            "DELETE_IN_PROGRESS", "DELETE_FAILED", "UPDATE_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", "UPDATE_COMPLETE",
            "UPDATE_FAILED", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_FAILED", "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
            "UPDATE_ROLLBACK_COMPLETE", "REVIEW_IN_PROGRESS", "IMPORT_IN_PROGRESS", "IMPORT_COMPLETE", "IMPORT_ROLLBACK_IN_PROGRESS",
            "IMPORT_ROLLBACK_FAILED", "IMPORT_ROLLBACK_COMPLETE",
        ]
        summaries: dict[str, Mapping[str, Any]] = {}
        for page in paginate(client, "list_stacks", StackStatusFilter=statuses):
            for stack in page.get("StackSummaries", []):
                stack_id = str(stack["StackId"])
                summaries[stack_id] = stack

        owned: dict[str, list[dict[str, JsonValue]]] = {}
        parents: dict[str, set[str]] = {stack_id: set() for stack_id in summaries}
        children: dict[str, set[str]] = {stack_id: set() for stack_id in summaries}
        protected_seeds: set[str] = set()
        protected_roles: dict[str, set[str]] = {stack_id: set() for stack_id in summaries}
        lambda_client: Any = None
        events_client: Any = None
        event_bus_names: list[str] | None = None

        def reference_confirmed_absent(resource_type: str, physical_id: str) -> bool:
            nonlocal lambda_client, events_client, event_bus_names
            if resource_type == "AWS::Lambda::Function":
                if lambda_client is None:
                    lambda_client = self.target.session.client("lambda", region_name=region, config=AWS_CONFIG)
                try:
                    lambda_client.get_function(FunctionName=physical_id)
                    return False
                except ClientError as exc:
                    if error_code(exc) in NOT_FOUND_CODES:
                        return True
                    raise
            if resource_type == "AWS::Events::Rule":
                if events_client is None:
                    events_client = self.target.session.client("events", region_name=region, config=AWS_CONFIG)
                if event_bus_names is None:
                    event_bus_names = list_event_bus_names(events_client)
                for event_bus_name in event_bus_names:
                    try:
                        events_client.describe_rule(Name=physical_id, EventBusName=event_bus_name)
                        return False
                    except ClientError as exc:
                        if error_code(exc) not in NOT_FOUND_CODES:
                            raise
                return True
            return False

        for stack_id in summaries:
            references: list[dict[str, JsonValue]] = []
            for resource_page in paginate(client, "list_stack_resources", StackName=stack_id):
                for stack_resource in resource_page.get("StackResourceSummaries", []):
                    resource_type = str(stack_resource.get("ResourceType") or "")
                    physical_id = str(stack_resource.get("PhysicalResourceId") or "")
                    logical_id = str(stack_resource.get("LogicalResourceId") or "")
                    reference: dict[str, JsonValue] = {
                        "logical_id": logical_id,
                        "resource_type": resource_type,
                        "physical_id": physical_id,
                        "status": str(stack_resource.get("ResourceStatus") or "unknown"),
                    }
                    if (
                        physical_id
                        and reference["status"] not in {"DELETE_COMPLETE", "DELETE_SKIPPED"}
                        and reference_confirmed_absent(resource_type, physical_id)
                    ):
                        reference["confirmed_absent_by_api"] = True
                    references.append(reference)
                    if resource_type in {"AWS::IAM::Role", "AWS::IAM::ServiceLinkedRole"}:
                        role_name = physical_id.rsplit("/", 1)[-1]
                        if is_preserved_role(role_name, cfn_type=resource_type, config=self.config):
                            protected_seeds.add(stack_id)
                            protected_roles[stack_id].add(role_name or resource_type)
                    if resource_type == "AWS::CloudFormation::Stack":
                        if not physical_id:
                            raise CleanupError("CloudFormation nested stack has no physical ID")
                        children.setdefault(stack_id, set()).add(physical_id)
                        parents.setdefault(physical_id, set()).add(stack_id)

            permission_references = [
                reference
                for reference in references
                if reference.get("resource_type") == "AWS::Lambda::Permission"
            ]
            template_resources: Mapping[str, Any] = {}
            if permission_references:
                raw_template_body = client.get_template(
                    StackName=stack_id,
                    TemplateStage="Processed",
                ).get("TemplateBody")
                if isinstance(raw_template_body, str):
                    try:
                        raw_template_body = json.loads(raw_template_body)
                    except json.JSONDecodeError as exc:
                        raise CleanupError("CloudFormation processed template is not valid JSON") from exc
                if not isinstance(raw_template_body, Mapping):
                    raise CleanupError("CloudFormation processed template has an invalid shape")
                template_body = raw_template_body
                raw_template_resources = template_body.get("Resources")
                if not isinstance(raw_template_resources, Mapping):
                    raise CleanupError("CloudFormation processed template has no resource map")
                template_resources = raw_template_resources

            for reference in permission_references:
                logical_id = str(reference.get("logical_id") or "")
                permission = template_resources.get(logical_id)
                properties = permission.get("Properties") if isinstance(permission, Mapping) else None
                function_name = properties.get("FunctionName") if isinstance(properties, Mapping) else None
                parent_logical_id = ""
                if isinstance(function_name, Mapping):
                    ref_value = function_name.get("Ref")
                    get_att = function_name.get("Fn::GetAtt")
                    if isinstance(ref_value, str):
                        parent_logical_id = ref_value
                    elif isinstance(get_att, list) and len(get_att) == 2 and get_att[1] == "Arn":
                        parent_logical_id = str(get_att[0])
                    elif isinstance(get_att, str) and get_att.endswith(".Arn"):
                        parent_logical_id = get_att[:-4]
                parent_references = [
                    candidate
                    for candidate in references
                    if candidate.get("logical_id") == parent_logical_id
                    and candidate.get("resource_type") == "AWS::Lambda::Function"
                    and candidate.get("physical_id")
                    and candidate.get("status") not in {"DELETE_COMPLETE", "DELETE_SKIPPED"}
                ]
                if (
                    isinstance(permission, Mapping)
                    and permission.get("Type") == "AWS::Lambda::Permission"
                    and len(parent_references) == 1
                ):
                    reference["trusted_stack_managed_child"] = True
                    reference["parent_logical_id"] = parent_logical_id

            owned[stack_id] = references

        def assert_acyclic(stack_id: str, visiting: frozenset[str] = frozenset()) -> None:
            if stack_id in visiting:
                raise CleanupError("CloudFormation nested stack cycle detected")
            for child_id in children.get(stack_id, set()):
                assert_acyclic(child_id, visiting | {stack_id})

        for stack_id in summaries:
            assert_acyclic(stack_id)

        protected_stacks = set(protected_seeds)
        changed = True
        while changed:
            changed = False
            for stack_id in tuple(protected_stacks):
                for related in parents.get(stack_id, set()) | children.get(stack_id, set()):
                    if related not in protected_stacks:
                        protected_stacks.add(related)
                        changed = True

        result: list[Resource] = []
        for stack_id, stack in summaries.items():
            result.append(make_resource(
                "cloudformation",
                "CloudFormationStack",
                region,
                stack_id,
                arn=stack_id,
                metadata={
                    "name": stack.get("StackName") or "",
                    "status": stack.get("StackStatus") or "unknown",
                    "owned_resources": owned.get(stack_id, []),
                    "parent_stack_ids": sorted(parents.get(stack_id, set())),
                    "child_stack_ids": sorted(children.get(stack_id, set())),
                    "protected_roles": sorted(protected_roles.get(stack_id, set())),
                    "preserve": stack_id in protected_stacks,
                    "preserve_reason": "protected_stack_closure" if stack_id in protected_stacks else "",
                    "ownership_complete": True,
                },
            ))
        return result

    def _scan_resource_explorer(self, region: str) -> list[Resource]:
        client = self.target.session.client("resource-explorer-2", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_views"):
            for raw_view_arn in page.get("Views", []):
                if not isinstance(raw_view_arn, str) or not raw_view_arn:
                    raise CleanupError("Resource Explorer ListViews returned an invalid ARN")
                result.append(make_resource(
                    "resource-explorer-2",
                    "ResourceExplorerView",
                    region,
                    raw_view_arn,
                    arn=raw_view_arn,
                ))
        for page in paginate(client, "list_indexes"):
            for item in page.get("Indexes", []):
                if not isinstance(item, Mapping) or not item.get("Arn"):
                    raise CleanupError("Resource Explorer ListIndexes returned an invalid item")
                index_arn = str(item["Arn"])
                result.append(make_resource(
                    "resource-explorer-2",
                    "ResourceExplorerIndex",
                    region,
                    index_arn,
                    arn=index_arn,
                    metadata={"type": str(item.get("Type") or "unknown")},
                ))
        return result

    def _scan_elbv2(self, region: str) -> list[Resource]:
        client = self.target.session.client("elbv2", region_name=region, config=AWS_CONFIG)
        result = [make_resource("elbv2", "ELBv2LoadBalancer", region, item["LoadBalancerArn"], arn=item["LoadBalancerArn"], metadata={"name": item.get("LoadBalancerName") or "", "state": item.get("State", {}).get("Code") or "unknown"}) for page in paginate(client, "describe_load_balancers") for item in page.get("LoadBalancers", [])]
        result.extend(make_resource("elbv2", "ELBv2TargetGroup", region, item["TargetGroupArn"], arn=item["TargetGroupArn"], metadata={"name": item.get("TargetGroupName") or ""}) for page in paginate(client, "describe_target_groups") for item in page.get("TargetGroups", []))
        return result

    def _scan_elb(self, region: str) -> list[Resource]:
        client = self.target.session.client("elb", region_name=region, config=AWS_CONFIG)
        return [make_resource("elb", "ClassicELB", region, item["LoadBalancerName"], metadata={"vpc_id": item.get("VPCId") or ""}) for page in paginate(client, "describe_load_balancers") for item in page.get("LoadBalancerDescriptions", [])]

    def _scan_ecs(self, region: str) -> list[Resource]:
        client = self.target.session.client("ecs", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        cluster_arns = [arn for page in paginate(client, "list_clusters") for arn in page.get("clusterArns", [])]
        for cluster_arn in cluster_arns:
            result.append(make_resource("ecs", "ECSCluster", region, cluster_arn, arn=cluster_arn))
            for page in paginate(client, "list_services", cluster=cluster_arn):
                for service_arn in page.get("serviceArns", []):
                    result.append(make_resource("ecs", "ECSService", region, service_arn, arn=service_arn, metadata={"cluster": cluster_arn}))
            for page in paginate(client, "list_tasks", cluster=cluster_arn):
                for task_arn in page.get("taskArns", []):
                    result.append(make_resource("ecs", "ECSTask", region, task_arn, arn=task_arn, metadata={"cluster": cluster_arn}))
            for page in paginate(client, "list_container_instances", cluster=cluster_arn):
                for container_arn in page.get("containerInstanceArns", []):
                    result.append(make_resource("ecs", "ECSContainerInstance", region, container_arn, arn=container_arn, metadata={"cluster": cluster_arn}))
        for status in ("ACTIVE", "INACTIVE"):
            for page in paginate(client, "list_task_definitions", status=status):
                for task_definition_arn in page.get("taskDefinitionArns", []):
                    result.append(make_resource("ecs", "ECSTaskDefinition", region, task_definition_arn, arn=task_definition_arn, metadata={"status": status}))
        capacity_token: str | None = None
        while True:
            request: dict[str, Any] = {"nextToken": capacity_token} if capacity_token else {}
            page = client.describe_capacity_providers(**request)
            for provider in page.get("capacityProviders", []):
                name = provider.get("name")
                if name and name not in {"FARGATE", "FARGATE_SPOT"}:
                    result.append(make_resource("ecs", "ECSCapacityProvider", region, name, metadata={"status": provider.get("status") or "unknown"}))
            capacity_token = page.get("nextToken")
            if not capacity_token:
                break
        return result

    def _scan_ecr(self, region: str) -> list[Resource]:
        client = self.target.session.client("ecr", region_name=region, config=AWS_CONFIG)
        return [make_resource("ecr", "ECRRepository", region, item["repositoryName"], arn=item.get("repositoryArn")) for page in paginate(client, "describe_repositories") for item in page.get("repositories", [])]

    def _scan_eks(self, region: str) -> list[Resource]:
        client = self.target.session.client("eks", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        cluster_names = [name for page in paginate(client, "list_clusters") for name in page.get("clusters", [])]
        for cluster_name in cluster_names:
            cluster = client.describe_cluster(name=cluster_name).get("cluster", {})
            cluster_arn = str(cluster.get("arn") or "")
            result.append(make_resource("eks", "EKSCluster", region, cluster_arn or cluster_name, arn=cluster_arn or None, metadata={"name": cluster_name, "status": cluster.get("status") or "unknown", "identity_aliases": [cluster_name]}))
            for page in paginate(client, "list_nodegroups", clusterName=cluster_name):
                for name in page.get("nodegroups", []):
                    nodegroup = client.describe_nodegroup(clusterName=cluster_name, nodegroupName=name).get("nodegroup", {})
                    arn = str(nodegroup.get("nodegroupArn") or "")
                    result.append(make_resource("eks", "EKSNodegroup", region, arn or f"{cluster_name}/{name}", arn=arn or None, metadata={"name": name, "cluster": cluster_name, "status": nodegroup.get("status") or "unknown", "identity_aliases": [name, f"{cluster_name}/{name}"]}))
            for page in paginate(client, "list_fargate_profiles", clusterName=cluster_name):
                for name in page.get("fargateProfileNames", []):
                    profile = client.describe_fargate_profile(clusterName=cluster_name, fargateProfileName=name).get("fargateProfile", {})
                    arn = str(profile.get("fargateProfileArn") or "")
                    result.append(make_resource("eks", "EKSFargateProfile", region, arn or f"{cluster_name}/{name}", arn=arn or None, metadata={"name": name, "cluster": cluster_name, "status": profile.get("status") or "unknown", "identity_aliases": [name, f"{cluster_name}/{name}"]}))
            for page in paginate(client, "list_addons", clusterName=cluster_name):
                for name in page.get("addons", []):
                    addon = client.describe_addon(clusterName=cluster_name, addonName=name).get("addon", {})
                    arn = str(addon.get("addonArn") or "")
                    result.append(make_resource("eks", "EKSAddon", region, arn or f"{cluster_name}/{name}", arn=arn or None, metadata={"name": name, "cluster": cluster_name, "status": addon.get("status") or "unknown", "identity_aliases": [name, f"{cluster_name}/{name}"]}))
        return result

    def _scan_dynamodb(self, region: str) -> list[Resource]:
        client = self.target.session.client("dynamodb", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_tables"):
            for table_name in page.get("TableNames", []):
                table = client.describe_table(TableName=table_name).get("Table", {})
                arn = str(table.get("TableArn") or "")
                result.append(make_resource("dynamodb", "DynamoDBTable", region, arn or table_name, arn=arn or None, metadata={"name": table_name, "status": table.get("TableStatus") or "unknown", "identity_aliases": [table_name]}))
        return result

    def _scan_sqs(self, region: str) -> list[Resource]:
        client = self.target.session.client("sqs", region_name=region, config=AWS_CONFIG)
        return [make_resource("sqs", "SQSQueue", region, url) for page in paginate(client, "list_queues") for url in page.get("QueueUrls", [])]

    def _scan_sns(self, region: str) -> list[Resource]:
        client = self.target.session.client("sns", region_name=region, config=AWS_CONFIG)
        result = [make_resource("sns", "SNSTopic", region, item["TopicArn"], arn=item["TopicArn"]) for page in paginate(client, "list_topics") for item in page.get("Topics", [])]
        for page in paginate(client, "list_subscriptions"):
            for subscription in page.get("Subscriptions", []):
                arn = subscription.get("SubscriptionArn") or ""
                resource_type = "SNSPendingSubscription" if arn in {"PendingConfirmation", "Deleted", ""} else "SNSSubscription"
                pending_fingerprint = hashlib.sha256(
                    f"{subscription.get('TopicArn', '')}|{subscription.get('Protocol', '')}|{subscription.get('Endpoint', '')}".encode("utf-8")
                ).hexdigest()[:16]
                result.append(make_resource("sns", resource_type, region, arn or f"pending:{pending_fingerprint}", arn=arn if arn.startswith("arn:") else None, metadata={"topic_arn": subscription.get("TopicArn") or "", "protocol": subscription.get("Protocol") or "", "disposition": "manual_if_pending" if resource_type == "SNSPendingSubscription" else "automatic"}))
        return result

    def _scan_logs(self, region: str) -> list[Resource]:
        client = self.target.session.client("logs", region_name=region, config=AWS_CONFIG)
        return [make_resource("logs", "CloudWatchLogGroup", region, item["logGroupName"], arn=item.get("arn")) for page in paginate(client, "describe_log_groups") for item in page.get("logGroups", [])]

    def _scan_eventbridge(self, region: str) -> list[Resource]:
        client = self.target.session.client("events", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        buses = list_event_bus_names(client)
        for bus in buses:
            for page in paginate(client, "list_rules", EventBusName=bus):
                for item in page.get("Rules", []):
                    name = str(item["Name"])
                    arn = str(item.get("Arn") or "")
                    result.append(make_resource("events", "EventBridgeRule", region, arn or f"{bus}/{name}", arn=arn or None, metadata={"name": name, "event_bus": bus, "managed_by": item.get("ManagedBy") or "", "identity_aliases": [name, f"{bus}/{name}"]}))
        for bus in sorted(set(buses)):
            if bus != "default":
                result.append(make_resource("events", "EventBridgeBus", region, bus))
        return result

    def _scan_stepfunctions(self, region: str) -> list[Resource]:
        client = self.target.session.client("stepfunctions", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_state_machines"):
            for item in page.get("stateMachines", []):
                state_machine_arn = item["stateMachineArn"]
                workflow_type = str(item.get("type") or "STANDARD")
                result.append(make_resource("stepfunctions", "StepFunctionsStateMachine", region, state_machine_arn, arn=state_machine_arn, metadata={"name": item.get("name") or "", "workflow_type": workflow_type, "express_execution_visibility": "not_available_from_aws_api" if workflow_type == "EXPRESS" else "available"}))
                if workflow_type == "STANDARD":
                    for execution_page in paginate(client, "list_executions", stateMachineArn=state_machine_arn, statusFilter="RUNNING"):
                        for execution in execution_page.get("executions", []):
                            result.append(make_resource("stepfunctions", "StepFunctionsExecution", region, execution["executionArn"], arn=execution["executionArn"], metadata={"name": execution.get("name") or "", "state_machine_arn": state_machine_arn, "status": execution.get("status") or "RUNNING"}))
        result.extend(make_resource("stepfunctions", "StepFunctionsActivity", region, item["activityArn"], arn=item["activityArn"], metadata={"name": item.get("name") or ""}) for page in paginate(client, "list_activities") for item in page.get("activities", []))
        return result

    def _scan_secrets(self, region: str) -> list[Resource]:
        client = self.target.session.client("secretsmanager", region_name=region, config=AWS_CONFIG)
        return [make_resource("secretsmanager", "SecretsManagerSecret", region, item.get("ARN") or item["Name"], arn=item.get("ARN"), metadata={"name": item["Name"], "scheduled_deletion": bool(item.get("DeletedDate"))}) for page in paginate(client, "list_secrets", IncludePlannedDeletion=True) for item in page.get("SecretList", [])]

    def _scan_ssm(self, region: str) -> list[Resource]:
        client = self.target.session.client("ssm", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_associations"):
            for item in page.get("Associations", []):
                association_id = str(item.get("AssociationId") or "")
                if not association_id:
                    raise CleanupError("SSM ListAssociations returned an association without an ID")
                overview = item.get("Overview") if isinstance(item.get("Overview"), Mapping) else {}
                result.append(make_resource(
                    "ssm",
                    "SSMAssociation",
                    region,
                    association_id,
                    metadata={
                        "name": str(item.get("Name") or ""),
                        "status": str(overview.get("Status") or "unknown"),
                    },
                ))
        for page in paginate(client, "describe_parameters"):
            for item in page.get("Parameters", []):
                result.append(make_resource(
                    "ssm",
                    "SSMParameter",
                    region,
                    item["Name"],
                    arn=item.get("ARN"),
                    metadata={"type": item.get("Type") or "unknown"},
                ))
        return result

    def _scan_apigateway(self, region: str) -> list[Resource]:
        client = self.target.session.client("apigateway", region_name=region, config=AWS_CONFIG)
        return [make_resource("apigateway", "APIGatewayRestApi", region, item["id"], metadata={"name": item.get("name") or ""}) for page in paginate(client, "get_rest_apis") for item in page.get("items", [])]

    def _scan_apigateway_v2(self, region: str) -> list[Resource]:
        client = self.target.session.client("apigatewayv2", region_name=region, config=AWS_CONFIG)
        return [make_resource("apigatewayv2", "APIGatewayV2Api", region, item["ApiId"], metadata={"name": item.get("Name") or "", "protocol": item.get("ProtocolType") or ""}) for page in paginate(client, "get_apis") for item in page.get("Items", [])]

    def _scan_acm(self, region: str) -> list[Resource]:
        client = self.target.session.client("acm", region_name=region, config=AWS_CONFIG)
        return [make_resource("acm", "ACMCertificate", region, item["CertificateArn"], arn=item["CertificateArn"], metadata={"domain": item.get("DomainName") or ""}) for page in paginate(client, "list_certificates", Includes={"keyTypes": ["RSA_1024", "RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1", "EC_secp521r1"]}) for item in page.get("CertificateSummaryList", [])]

    def _scan_wafv2(self, region: str, scope: str) -> list[Resource]:
        client = self.target.session.client("wafv2", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for resource_type, operation, key in (
            ("WAFv2WebACL", "list_web_acls", "WebACLs"),
            ("WAFv2RuleGroup", "list_rule_groups", "RuleGroups"),
            ("WAFv2IPSet", "list_ip_sets", "IPSets"),
            ("WAFv2RegexPatternSet", "list_regex_pattern_sets", "RegexPatternSets"),
        ):
            for page in paginate(client, operation, Scope=scope):
                for item in page.get(key, []):
                    result.append(make_resource("wafv2", resource_type, region if scope == "REGIONAL" else "global", item["Id"], arn=item.get("ARN"), metadata={"name": item["Name"], "scope": scope}))
        return result

    def _scan_guardduty(self, region: str) -> list[Resource]:
        client = self.target.session.client("guardduty", region_name=region, config=AWS_CONFIG)
        return [make_resource("guardduty", "GuardDutyDetector", region, detector_id) for page in paginate(client, "list_detectors") for detector_id in page.get("DetectorIds", [])]

    def _scan_kms(self, region: str) -> list[Resource]:
        client = self.target.session.client("kms", region_name=region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_keys"):
            for key in page.get("Keys", []):
                try:
                    metadata = client.describe_key(KeyId=key["KeyId"]).get("KeyMetadata", {})
                except ClientError as exc:
                    if error_code(exc) in NOT_FOUND_CODES:
                        continue
                    raise
                if metadata.get("KeyManager") != "CUSTOMER":
                    continue
                multi_region = metadata.get("MultiRegionConfiguration") or {}
                result.append(make_resource(
                    "kms",
                    "KMSKey",
                    region,
                    key["KeyId"],
                    arn=metadata.get("Arn"),
                    metadata={
                        "state": metadata.get("KeyState") or "unknown",
                        "multi_region": bool(metadata.get("MultiRegion")),
                        "multi_region_key_type": multi_region.get("MultiRegionKeyType") or "",
                        "primary_key_arn": (multi_region.get("PrimaryKey") or {}).get("Arn") or "",
                        "replica_key_arns": [
                            str(item.get("Arn")) for item in multi_region.get("ReplicaKeys", []) if item.get("Arn")
                        ],
                        "deletion_window_days": 7,
                        "action": "schedule_deletion",
                    },
                ))
        return result

    def _scan_global(self) -> tuple[list[Resource], list[ScanIssue], list[CoverageRecord]]:
        resources: list[Resource] = []
        issues: list[ScanIssue] = []
        coverage: list[CoverageRecord] = []
        scanners: tuple[tuple[str, Callable[[], list[Resource]]], ...] = (
            ("s3", self._scan_s3),
            ("iam", self._scan_iam),
            ("cloudfront-distributions", self._scan_cloudfront_distributions),
            ("cloudfront-functions", self._scan_cloudfront_functions),
            ("cloudfront-key-groups", self._scan_cloudfront_key_groups),
            ("cloudfront-public-keys", self._scan_cloudfront_public_keys),
            ("cloudfront-oai", self._scan_cloudfront_oai),
            ("cloudfront-oac", self._scan_cloudfront_oac),
            ("route53", self._scan_route53),
            ("route53domains", self._scan_route53_domains),
            ("wafv2-global", lambda: self._scan_wafv2("us-east-1", "CLOUDFRONT")),
        )
        if tuple(service for service, _ in scanners) != GLOBAL_SCANNER_IDS:
            raise CleanupError("Global scanner manifest drift detected")
        for service, scanner in scanners:
            found, scan_issues, scan_coverage = self._collect(service, "global", scanner)
            resources.extend(found)
            issues.extend(scan_issues)
            coverage.append(scan_coverage)
        return resources, issues, coverage

    def _scan_s3(self) -> list[Resource]:
        client = self.target.session.client("s3", region_name=self.config.region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_buckets"):
            for bucket in page.get("Buckets", []):
                name = bucket["Name"]
                try:
                    location = client.get_bucket_location(Bucket=name).get("LocationConstraint")
                    region = "us-east-1" if location in {None, ""} else "eu-west-1" if location == "EU" else str(location)
                except ClientError:
                    region = self.config.region
                result.append(make_resource("s3", "S3Bucket", region, name, arn=f"arn:aws:s3:::{name}"))
        return result

    def _scan_iam(self) -> list[Resource]:
        client = self.target.session.client("iam", region_name=self.config.region, config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_users"):
            for item in page.get("Users", []):
                result.append(make_resource("iam", "IAMUser", "global", item["UserName"], arn=item.get("Arn")))
        for page in paginate(client, "list_groups"):
            for item in page.get("Groups", []):
                result.append(make_resource("iam", "IAMGroup", "global", item["GroupName"], arn=item.get("Arn")))
        preserved_policy_arns: set[str] = set()
        for page in paginate(client, "list_roles"):
            for item in page.get("Roles", []):
                name = item["RoleName"]
                path = str(item.get("Path") or "/")
                preserved = is_preserved_role(name, path=path, config=self.config)
                attached_policy_arns: list[str] = []
                boundary_arn = ""
                if preserved:
                    for policy_page in paginate(client, "list_attached_role_policies", RoleName=name):
                        for policy in policy_page.get("AttachedPolicies", []):
                            arn = str(policy.get("PolicyArn") or "")
                            if arn:
                                attached_policy_arns.append(arn)
                                preserved_policy_arns.add(arn)
                    role_details = client.get_role(RoleName=name).get("Role", {})
                    boundary_arn = str((role_details.get("PermissionsBoundary") or {}).get("PermissionsBoundaryArn") or "")
                    if boundary_arn:
                        preserved_policy_arns.add(boundary_arn)
                service_linked = is_preserved_role(name, path=path, cfn_type="AWS::IAM::ServiceLinkedRole", config=self.config) and (
                    name.startswith("AWSServiceRoleFor") or path.startswith("/aws-service-role/")
                )
                result.append(make_resource("iam", "IAMRole", "global", name, arn=item.get("Arn"), metadata={"path": path, "service_linked": service_linked, "preserve": preserved, "preserve_reason": "service_linked" if service_linked else "access_chain" if preserved else "", "protected_policy_arns": sorted(attached_policy_arns), "permissions_boundary_arn": boundary_arn}))
        for page in paginate(client, "list_policies", Scope="Local", OnlyAttached=False):
            for item in page.get("Policies", []):
                arn = str(item["Arn"])
                preserve = arn in preserved_policy_arns
                result.append(make_resource("iam", "IAMCustomerManagedPolicy", "global", arn, arn=arn, metadata={"name": item.get("PolicyName") or "", "preserve": preserve, "preserve_reason": "attached_to_preserved_role" if preserve else ""}))
        for page in paginate(client, "list_instance_profiles"):
            for item in page.get("InstanceProfiles", []):
                role_names = [str(role.get("RoleName")) for role in item.get("Roles", []) if role.get("RoleName")]
                preserve = any(is_preserved_role(name, config=self.config) for name in role_names)
                result.append(make_resource("iam", "IAMInstanceProfile", "global", item["InstanceProfileName"], arn=item.get("Arn"), metadata={"roles": role_names, "preserve": preserve, "preserve_reason": "contains_preserved_role" if preserve else ""}))
        for page in paginate(client, "list_virtual_mfa_devices", AssignmentStatus="Unassigned"):
            for item in page.get("VirtualMFADevices", []):
                result.append(make_resource("iam", "IAMVirtualMFADevice", "global", item["SerialNumber"], arn=item["SerialNumber"]))
        for page in paginate(client, "list_server_certificates"):
            for item in page.get("ServerCertificateMetadataList", []):
                result.append(make_resource("iam", "IAMServerCertificate", "global", item["ServerCertificateName"], arn=item.get("Arn")))
        for page in paginate(client, "list_saml_providers"):
            for item in page.get("SAMLProviderList", []):
                result.append(make_resource("iam", "IAMSAMLProvider", "global", item["Arn"], arn=item["Arn"]))
        for page in paginate(client, "list_open_id_connect_providers"):
            for item in page.get("OpenIDConnectProviderList", []):
                result.append(make_resource("iam", "IAMOpenIDConnectProvider", "global", item["Arn"], arn=item["Arn"]))
        return result

    def _scan_cloudfront_distributions(self) -> list[Resource]:
        client = self.target.session.client("cloudfront", region_name="us-east-1", config=AWS_CONFIG)
        result: list[Resource] = []
        marker: str | None = None
        while True:
            response = client.list_distributions(**({"Marker": marker} if marker else {}))
            items = response.get("DistributionList", {})
            for item in items.get("Items", []) or []:
                result.append(make_resource("cloudfront", "CloudFrontDistribution", "global", item["Id"], arn=item.get("ARN"), metadata={"enabled": bool(item.get("Enabled")), "status": item.get("Status") or "unknown", "domain": item.get("DomainName") or ""}))
            marker = items.get("NextMarker") if items.get("IsTruncated") else None
            if not marker:
                return result

    def _scan_cloudfront_functions(self) -> list[Resource]:
        client = self.target.session.client("cloudfront", region_name="us-east-1", config=AWS_CONFIG)
        result: list[Resource] = []
        marker: str | None = None
        while True:
            request = {"Stage": "DEVELOPMENT", **({"Marker": marker} if marker else {})}
            items = client.list_functions(**request).get("FunctionList", {})
            for item in items.get("Items", []) or []:
                metadata = item.get("FunctionMetadata", {})
                result.append(make_resource("cloudfront", "CloudFrontFunction", "global", item["Name"], arn=metadata.get("FunctionARN"), metadata={"stage": metadata.get("Stage") or "DEVELOPMENT", "status": item.get("Status") or "unknown"}))
            marker = items.get("NextMarker")
            if not marker:
                return result

    def _scan_cloudfront_key_groups(self) -> list[Resource]:
        client = self.target.session.client("cloudfront", region_name="us-east-1", config=AWS_CONFIG)
        result: list[Resource] = []
        marker: str | None = None
        while True:
            items = client.list_key_groups(**({"Marker": marker} if marker else {})).get("KeyGroupList", {})
            for item in items.get("Items", []) or []:
                key_group = item.get("KeyGroup")
                if not isinstance(key_group, Mapping):
                    raise CleanupError("CloudFront ListKeyGroups returned an invalid item")
                config = key_group.get("KeyGroupConfig", {})
                result.append(make_resource("cloudfront", "CloudFrontKeyGroup", "global", key_group["Id"], metadata={"name": config.get("Name") or ""}))
            marker = items.get("NextMarker")
            if not marker:
                return result

    def _scan_cloudfront_public_keys(self) -> list[Resource]:
        client = self.target.session.client("cloudfront", region_name="us-east-1", config=AWS_CONFIG)
        return [
            make_resource("cloudfront", "CloudFrontPublicKey", "global", item["Id"], metadata={"name": item.get("Name") or ""})
            for page in paginate(client, "list_public_keys")
            for item in page.get("PublicKeyList", {}).get("Items", []) or []
        ]

    def _scan_cloudfront_oai(self) -> list[Resource]:
        client = self.target.session.client("cloudfront", region_name="us-east-1", config=AWS_CONFIG)
        return [
            make_resource("cloudfront", "CloudFrontOriginAccessIdentity", "global", item["Id"])
            for page in paginate(client, "list_cloud_front_origin_access_identities")
            for item in page.get("CloudFrontOriginAccessIdentityList", {}).get("Items", []) or []
        ]

    def _scan_cloudfront_oac(self) -> list[Resource]:
        client = self.target.session.client("cloudfront", region_name="us-east-1", config=AWS_CONFIG)
        return [
            make_resource("cloudfront", "CloudFrontOriginAccessControl", "global", item["Id"], metadata={"name": item.get("Name") or ""})
            for page in paginate(client, "list_origin_access_controls")
            for item in page.get("OriginAccessControlList", {}).get("Items", []) or []
        ]

    def _scan_route53(self) -> list[Resource]:
        client = self.target.session.client("route53", region_name="us-east-1", config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_hosted_zones"):
            for zone in page.get("HostedZones", []):
                zone_id = str(zone["Id"]).split("/")[-1]
                result.append(make_resource("route53", "Route53HostedZone", "global", zone_id, metadata={"name": zone.get("Name") or "", "private": bool(zone.get("Config", {}).get("PrivateZone")), "record_count": int(zone.get("ResourceRecordSetCount") or 0)}))
        return result

    def _scan_route53_domains(self) -> list[Resource]:
        client = self.target.session.client("route53domains", region_name="us-east-1", config=AWS_CONFIG)
        result: list[Resource] = []
        for page in paginate(client, "list_domains"):
            for domain in page.get("Domains", []):
                result.append(make_resource("route53domains", "Route53RegisteredDomain", "global", domain["DomainName"], metadata={"auto_renew": bool(domain.get("AutoRenew")), "disposition": "manual_never_delete"}))
        return result

    def _scan_costs(self) -> tuple[dict[str, float], list[ScanIssue]]:
        payer = self.target.payer or self.manager.payer_for_target(self.account_id)
        if not payer:
            return {}, [ScanIssue("cost-explorer", "global", "mapping_missing", "PayerUnknown", "Cost scan requires an exact accounts_cache _payer mapping")]
        try:
            payer_session = self.manager.assume_payer(payer)
            client = payer_session.client("ce", region_name="us-east-1", config=AWS_CONFIG)
            today = utc_now().date()
            start = today.replace(day=1)
            end = today + dt.timedelta(days=1)
            costs: dict[str, float] = {}
            token: str | None = None
            while True:
                request: dict[str, Any] = {
                    "TimePeriod": {"Start": start.isoformat(), "End": end.isoformat()},
                    "Granularity": "MONTHLY",
                    "Metrics": ["UnblendedCost"],
                    "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
                    "Filter": {"Dimensions": {"Key": "LINKED_ACCOUNT", "Values": [self.account_id]}},
                }
                if token:
                    request["NextPageToken"] = token
                response = client.get_cost_and_usage(**request)
                for period in response.get("ResultsByTime", []):
                    for group in period.get("Groups", []):
                        keys = group.get("Keys", [])
                        amount = group.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", "0")
                        if keys:
                            costs[str(keys[0])] = costs.get(str(keys[0]), 0.0) + float(amount)
                token = response.get("NextPageToken")
                if not token:
                    break
            return costs, []
        except (ClientError, BotoCoreError, CleanupError, ValueError) as exc:
            return {}, [issue_from_exception("cost-explorer", "global", exc)]

    @staticmethod
    def _manual_checks(costs: Mapping[str, float], resources: Sequence[Resource]) -> list[dict[str, JsonValue]]:
        cost_keywords = {
            "marketplace": "AWS Marketplace subscriptions",
            "support": "AWS Support plan",
            "savings plans": "Savings Plans commitments",
            "devops guru": "DevOps Guru account configuration",
            "route 53": "Route 53 domains and auto-renewal",
        }
        checks: list[dict[str, JsonValue]] = []
        for keyword, item in cost_keywords.items():
            matching = {service: amount for service, amount in costs.items() if keyword in service.lower() and amount != 0}
            checks.append({"item": item, "automatic": False, "cost_detected": bool(matching), "matching_cost_services": sorted(matching)})
        checks.extend(
            [
                {"item": "Reserved Instances", "automatic": False, "resource_detected": any(resource.resource_type in {"EC2ReservedInstance", "RDSReservedInstance"} for resource in resources)},
                {"item": "Route 53 registered domains", "automatic": False, "resource_detected": any(resource.resource_type == "Route53RegisteredDomain" for resource in resources), "note": "Domain registration is never modified"},
                {"item": "Marketplace agreements, private offers, and subscriptions", "automatic": False, "note": "Review and cancel in the payer/account consoles"},
                {"item": "Savings Plans and other contractual commitments", "automatic": False, "note": "Commitments cannot be deleted by this resource cleanup"},
                {"item": "Step Functions Express in-flight executions", "automatic": False, "resource_detected": any(resource.resource_type == "StepFunctionsStateMachine" and resource.metadata.get("workflow_type") == "EXPRESS" for resource in resources), "note": "AWS does not expose running Express executions; they can continue for at most five minutes after new starts are stopped"},
            ]
        )
        return checks


def is_preserved_role(
    role_name: str,
    *,
    path: str | None = None,
    cfn_type: str | None = None,
    config: AppConfig,
) -> bool:
    return (
        role_name in config.preserved_roles
        or role_name.startswith("AWSServiceRoleFor")
        or bool(path and path.startswith("/aws-service-role/"))
        or cfn_type == "AWS::IAM::ServiceLinkedRole"
    )


def is_scheduled_kms(resource: Resource) -> bool:
    return resource.resource_type == "KMSKey" and str(resource.metadata.get("state") or "") in KMS_SCHEDULED_STATES


def is_default_vpc_baseline(resource: Resource) -> bool:
    return bool(resource.metadata.get("default_vpc_baseline")) and resource.resource_type in {
        "EC2Vpc",
        "EC2SecurityGroup",
        "EC2RouteTable",
        "EC2Subnet",
        "EC2InternetGateway",
        "EC2NetworkAcl",
    }


CFN_RESOURCE_TYPE_MAP: Final[dict[str, str]] = {
    "AWS::CloudFormation::Stack": "CloudFormationStack",
    "AWS::Lambda::Function": "LambdaFunction",
    "AWS::ElasticLoadBalancingV2::LoadBalancer": "ELBv2LoadBalancer",
    "AWS::ElasticLoadBalancingV2::TargetGroup": "ELBv2TargetGroup",
    "AWS::ElasticLoadBalancing::LoadBalancer": "ClassicELB",
    "AWS::RDS::DBInstance": "RDSInstance",
    "AWS::RDS::DBCluster": "RDSCluster",
    "AWS::RDS::DBSubnetGroup": "RDSSubnetGroup",
    "AWS::DynamoDB::Table": "DynamoDBTable",
    "AWS::S3::Bucket": "S3Bucket",
    "AWS::ECR::Repository": "ECRRepository",
    "AWS::EKS::Cluster": "EKSCluster",
    "AWS::EKS::Nodegroup": "EKSNodegroup",
    "AWS::EKS::FargateProfile": "EKSFargateProfile",
    "AWS::EKS::Addon": "EKSAddon",
    "AWS::SNS::Topic": "SNSTopic",
    "AWS::SQS::Queue": "SQSQueue",
    "AWS::Logs::LogGroup": "CloudWatchLogGroup",
    "AWS::Events::Rule": "EventBridgeRule",
    "AWS::StepFunctions::StateMachine": "StepFunctionsStateMachine",
    "AWS::SecretsManager::Secret": "SecretsManagerSecret",
    "AWS::SSM::Parameter": "SSMParameter",
    "AWS::SSM::Association": "SSMAssociation",
    "AWS::ResourceExplorer2::Index": "ResourceExplorerIndex",
    "AWS::ResourceExplorer2::View": "ResourceExplorerView",
    "AWS::ApiGateway::RestApi": "APIGatewayRestApi",
    "AWS::ApiGatewayV2::Api": "APIGatewayV2Api",
    "AWS::CertificateManager::Certificate": "ACMCertificate",
    "AWS::EC2::Instance": "EC2Instance",
    "AWS::EC2::Volume": "EC2Volume",
    "AWS::EC2::NatGateway": "EC2NatGateway",
    "AWS::EC2::VPCEndpoint": "EC2VpcEndpoint",
    "AWS::EC2::NetworkInterface": "EC2NetworkInterface",
    "AWS::EC2::LaunchTemplate": "EC2LaunchTemplate",
    "AWS::EC2::KeyPair": "EC2KeyPair",
    "AWS::EC2::InternetGateway": "EC2InternetGateway",
    "AWS::EC2::Subnet": "EC2Subnet",
    "AWS::EC2::RouteTable": "EC2RouteTable",
    "AWS::EC2::SecurityGroup": "EC2SecurityGroup",
    "AWS::EC2::NetworkAcl": "EC2NetworkAcl",
    "AWS::EC2::VPC": "EC2Vpc",
    "AWS::KMS::Key": "KMSKey",
    "AWS::IAM::Role": "IAMRole",
    "AWS::IAM::ServiceLinkedRole": "IAMRole",
    "AWS::IAM::InstanceProfile": "IAMInstanceProfile",
    "AWS::IAM::ManagedPolicy": "IAMCustomerManagedPolicy",
    "AWS::CloudFront::Distribution": "CloudFrontDistribution",
    "AWS::CloudFront::Function": "CloudFrontFunction",
    "AWS::Route53::HostedZone": "Route53HostedZone",
}

CFN_STACK_MANAGED_CHILD_TYPES: Final[dict[str, str]] = {
    "AWS::Lambda::Permission": "AWS::Lambda::Function",
    "AWS::S3::BucketPolicy": "AWS::S3::Bucket",
}


def apply_resource_relationships(
    resources: Sequence[Resource],
    config: AppConfig,
) -> tuple[list[Resource], list[ScanIssue]]:
    """Apply CloudFormation ownership and the access-chain preservation closure."""
    stacks = {resource.resource_id: resource for resource in resources if resource.resource_type == "CloudFormationStack"}
    owner_ids_by_key: dict[str, set[str]] = {}
    issues: list[ScanIssue] = []
    confirmed_absent_by_stack: dict[str, list[dict[str, str]]] = {}
    stack_managed_children_by_stack: dict[str, list[dict[str, str]]] = {}

    for stack_id, stack in stacks.items():
        references = stack.metadata.get("owned_resources")
        if not isinstance(references, list):
            issues.append(ScanIssue("cloudformation", stack.region, "ownership_unknown", "InvalidOwnershipData", "CloudFormation ownership data is missing"))
            continue
        valid_references = [reference for reference in references if isinstance(reference, Mapping)]
        if len(valid_references) != len(references):
            issues.append(ScanIssue("cloudformation", stack.region, "ownership_unknown", "InvalidOwnershipData", "CloudFormation ownership item is invalid"))
        for raw_reference in valid_references:
            cfn_type = str(raw_reference.get("resource_type") or "")
            physical_id = str(raw_reference.get("physical_id") or "")
            logical_id = str(raw_reference.get("logical_id") or "")
            status = str(raw_reference.get("status") or "")
            if not physical_id:
                if status != "DELETE_COMPLETE":
                    issues.append(ScanIssue(
                        "cloudformation",
                        stack.region,
                        "ownership_unknown",
                        "MissingPhysicalResourceId",
                        f"{cfn_type or 'unknown type'} has no physical resource ID in state {status or 'unknown'}",
                    ))
                continue

            required_parent_type = CFN_STACK_MANAGED_CHILD_TYPES.get(cfn_type)
            if required_parent_type:
                if status == "DELETE_COMPLETE":
                    continue
                if status == "DELETE_SKIPPED":
                    issues.append(ScanIssue(
                        "cloudformation",
                        stack.region,
                        "ownership_unknown",
                        "RetainedStackManagedChild",
                        f"{cfn_type} was retained and requires an authoritative scanner",
                    ))
                    continue
                parent_proven = False
                if cfn_type == "AWS::Lambda::Permission":
                    parent_logical_id = str(raw_reference.get("parent_logical_id") or "")
                    parent_proven = raw_reference.get("trusted_stack_managed_child") is True and sum(
                        1
                        for reference in valid_references
                        if str(reference.get("logical_id") or "") == parent_logical_id
                        and str(reference.get("resource_type") or "") == "AWS::Lambda::Function"
                        and bool(reference.get("physical_id"))
                        and str(reference.get("status") or "") not in {"DELETE_COMPLETE", "DELETE_SKIPPED"}
                    ) == 1
                elif cfn_type == "AWS::S3::BucketPolicy":
                    parent_proven = any(
                        str(reference.get("resource_type") or "") == "AWS::S3::Bucket"
                        and str(reference.get("physical_id") or "") == physical_id
                        and str(reference.get("status") or "") not in {"DELETE_COMPLETE", "DELETE_SKIPPED"}
                        for reference in valid_references
                    )
                if not parent_proven:
                    issues.append(ScanIssue(
                        "cloudformation",
                        stack.region,
                        "ownership_unknown",
                        "UnprovenStackManagedChild",
                        f"{cfn_type} has no proven owning resource in its CloudFormation stack",
                    ))
                    continue
                stack_managed_children_by_stack.setdefault(stack_id, []).append({
                    "logical_id": logical_id,
                    "resource_type": cfn_type,
                    "physical_id": physical_id,
                })
                continue

            mapped_type = CFN_RESOURCE_TYPE_MAP.get(cfn_type)
            if mapped_type is None:
                issues.append(ScanIssue("cloudformation", stack.region, "ownership_unknown", "UnsupportedCloudFormationType", f"No safe ownership mapping for {cfn_type or 'unknown type'}"))
                continue
            if status in {"DELETE_COMPLETE", "DELETE_SKIPPED"}:
                continue
            expected_region = "global" if mapped_type.startswith("IAM") or mapped_type in {
                "CloudFrontDistribution", "CloudFrontFunction", "Route53HostedZone"
            } else stack.region
            matches: list[Resource] = []
            for resource in resources:
                if resource.resource_type != mapped_type or resource.region != expected_region:
                    continue
                aliases = resource.metadata.get("identity_aliases")
                candidates = {resource.resource_id, resource.arn or ""}
                if isinstance(aliases, list):
                    candidates.update(str(alias) for alias in aliases)
                if physical_id in candidates:
                    matches.append(resource)
            if not matches and raw_reference.get("confirmed_absent_by_api") is True:
                confirmed_absent_by_stack.setdefault(stack_id, []).append({
                    "logical_id": logical_id,
                    "resource_type": cfn_type,
                    "physical_id": physical_id,
                    "proof": "service_get_describe_not_found",
                })
                continue
            if len(matches) != 1:
                issues.append(ScanIssue(
                    "cloudformation",
                    stack.region,
                    "ownership_unknown" if not matches else "ownership_ambiguous",
                    "CloudFormationReferenceMatchCount",
                    f"{cfn_type} physical resource must match exactly one inventory item; matched {len(matches)}",
                ))
                continue
            owner_ids_by_key.setdefault(matches[0].key, set()).add(stack_id)

    related: list[Resource] = []
    for resource in resources:
        metadata = dict(resource.metadata)
        owners = owner_ids_by_key.get(resource.key, set())
        if len(owners) > 1:
            issues.append(ScanIssue("cloudformation", resource.region, "ownership_ambiguous", "MultipleStackOwners", "Resource matched more than one CloudFormation stack"))
        if resource.resource_type == "CloudFormationStack":
            metadata["confirmed_absent_owned_resources"] = confirmed_absent_by_stack.get(resource.resource_id, [])
            metadata["stack_managed_non_inventory_resources"] = stack_managed_children_by_stack.get(resource.resource_id, [])
            parent_ids = metadata.get("parent_stack_ids")
            if isinstance(parent_ids, list) and parent_ids:
                metadata["delete_via_stack"] = True
                metadata["cfn_owner_stack_ids"] = [str(item) for item in parent_ids]
                if any(bool(stacks.get(str(item)) and stacks[str(item)].metadata.get("preserve")) for item in parent_ids):
                    metadata["preserve"] = True
                    metadata["preserve_reason"] = "protected_stack_closure"
        elif owners:
            metadata["cfn_owner_stack_ids"] = sorted(owners)
            if any(bool(stacks[owner].metadata.get("preserve")) for owner in owners if owner in stacks):
                metadata["preserve"] = True
                metadata["preserve_reason"] = "managed_by_preserved_stack"
            else:
                metadata["delete_via_stack"] = True
        if resource.resource_type in {"IAMRole", "IAMInstanceProfile", "IAMCustomerManagedPolicy"} and metadata.get("preserve"):
            metadata["preserve"] = True
        related.append(dataclasses.replace(resource, metadata=metadata))
    return related, issues


DEPENDENCIES: Final[dict[str, list[str]]] = {
    "CloudFormationStack": ["stack-managed resources; protected-role stacks are skipped"],
    "ResourceExplorerIndex": ["Resource Explorer views in the same Region"],
    "EKSCluster": ["EKS add-ons", "node groups", "Fargate profiles"],
    "ECSCluster": ["services", "tasks", "container instances"],
    "RDSCluster": ["cluster DB instances"],
    "RDSSubnetGroup": ["RDS instances and clusters"],
    "StepFunctionsStateMachine": ["running Standard Workflow executions; Express executions cannot be enumerated"],
    "ELBv2TargetGroup": ["ELBv2 listeners and load balancers"],
    "EC2Volume": ["EC2 instance attachment"],
    "EC2ElasticIP": ["network interface association", "NAT gateway"],
    "EC2NetworkInterface": ["service-owned resource or attachment"],
    "EC2Subnet": ["NAT gateways", "interfaces", "RDS subnet groups", "load balancers"],
    "EC2SecurityGroup": ["network interfaces and service resources"],
    "EC2Vpc": ["all VPC-scoped resources"],
    "ACMCertificate": ["CloudFront, load balancer, or API association"],
    "WAFv2WebACL": ["regional or CloudFront association"],
    "KMSKey": ["all encrypted resources; deletion remains pending for 7 days"],
    "IAMRole": ["all resources and instance profiles using the role"],
    "IAMCustomerManagedPolicy": ["users, groups, and non-preserved roles"],
}


def classify_resource(resource: Resource) -> tuple[str, str, list[str]]:
    notes: list[str] = []
    if resource.resource_type in MANUAL_TYPES or resource.resource_type == "Route53RegisteredDomain":
        return "manual", "none", ["Cannot be safely removed automatically"]
    if is_scheduled_kms(resource):
        return "scheduled", "none", ["KMS deletion is already scheduled; physical deletion is delayed"]
    if resource.resource_type == "KMSKey":
        return "schedule", "schedule_deletion_7_days", ["Key material is not immediately deleted"]
    if is_default_vpc_baseline(resource):
        return "allowed_residual", "preserve", ["Exact AWS-created default VPC baseline"]
    if resource.metadata.get("preserve"):
        reason = str(resource.metadata.get("preserve_reason") or "Preservation closure")
        if resource.resource_type in {"IAMRole", "IAMInstanceProfile", "IAMCustomerManagedPolicy"}:
            return "allowed_residual", "preserve", [reason]
        return "protected_residual", "none", [f"Auto-delete forbidden, but resource still blocks completion: {reason}"]
    if resource.metadata.get("delete_via_stack"):
        return "dependency_managed", "delete_via_stack", ["CloudFormation owner must delete this resource"]
    if resource.resource_type in {"EC2SecurityGroup", "EC2RouteTable", "EC2NetworkAcl"} and (
        resource.metadata.get("default") or resource.metadata.get("main")
    ):
        return "dependency_managed", "delete_with_non_default_vpc_only", ["AWS default dependency of a non-default VPC"]
    if resource.resource_type == "EventBridgeRule" and resource.metadata.get("managed_by"):
        return "dependency_managed", "delete_with_owning_service", ["AWS-managed rule"]
    return "delete", "delete", notes


def plan_for_inventory(inventory: Inventory, config: AppConfig) -> dict[str, JsonValue]:
    entries: list[dict[str, JsonValue]] = []
    for resource in sorted_resources(inventory.resources):
        disposition, action, notes = classify_resource(resource)
        if resource.resource_type == "StepFunctionsStateMachine" and resource.metadata.get("workflow_type") == "EXPRESS":
            notes.append("AWS cannot enumerate running Express executions; deletion prevents new starts, but in-flight runs may continue for up to five minutes")
        entries.append(
            {
                **resource.to_dict(),
                "disposition": disposition,
                "action": action,
                "asynchronous": resource.resource_type in ASYNC_TYPES,
                "dependencies": DEPENDENCIES.get(resource.resource_type, []),
                "notes": notes,
            }
        )
    summary = Counter(str(entry["disposition"]) for entry in entries)
    return {
        "account_id": inventory.account_id,
        "credential_path": inventory.credential_path,
        "generated_at": utc_now().isoformat(),
        "read_only": True,
        "coverage_contract_version": COVERAGE_CONTRACT_VERSION,
        "coverage_complete": inventory.coverage_complete,
        "coverage_expected": [
            {"scanner_id": scanner_id, "region": region}
            for scanner_id, region in sorted(inventory.expected_coverage_keys)
        ],
        "coverage_gaps": sorted(inventory.coverage_gaps),
        "coverage": [item.to_dict() for item in inventory.coverage],
        "summary": dict(sorted(summary.items())),
        "scan_issues": [issue.to_dict() for issue in inventory.issues],
        "manual_checks": inventory.manual_checks,
        "resources": entries,
        "safety": {
            "payer_blocklist_enforced": True,
            "live_organizations_preflight_required_for_nuke": True,
            "preserved_roles": sorted(config.preserved_roles),
            "service_linked_roles_preserved": True,
            "organizations_account_close": False,
            "domain_registration_changes": False,
            "kms_deletion_window_days": 7,
            "nuke_allowed": inventory.coverage_complete and not inventory.issues,
        },
    }


DELETE_ORDER: Final[dict[str, int]] = {
    "CloudFormationStack": 10,
    "WAFv2WebACL": 20,
    "EventBridgeRule": 25,
    "APIGatewayRestApi": 30,
    "APIGatewayV2Api": 30,
    "StepFunctionsExecution": 34,
    "StepFunctionsStateMachine": 35,
    "StepFunctionsActivity": 36,
    "EKSAddon": 40,
    "EKSNodegroup": 41,
    "EKSFargateProfile": 42,
    "EKSCluster": 43,
    "ECSService": 45,
    "ECSTask": 46,
    "ECSContainerInstance": 47,
    "ECSCluster": 48,
    "ECSTaskDefinition": 49,
    "ECSCapacityProvider": 49,
    "LambdaFunction": 50,
    "ResourceExplorerView": 52,
    "ResourceExplorerIndex": 53,
    "CloudFrontDistribution": 55,
    "CloudFrontFunction": 56,
    "CloudFrontKeyGroup": 57,
    "CloudFrontPublicKey": 58,
    "CloudFrontOriginAccessIdentity": 59,
    "CloudFrontOriginAccessControl": 59,
    "ELBv2LoadBalancer": 60,
    "ClassicELB": 61,
    "ELBv2TargetGroup": 62,
    "RDSInstance": 70,
    "RDSCluster": 71,
    "RDSManualSnapshot": 72,
    "RDSManualClusterSnapshot": 73,
    "DynamoDBTable": 75,
    "S3Bucket": 80,
    "ECRRepository": 82,
    "SNSSubscription": 85,
    "SNSTopic": 86,
    "SQSQueue": 87,
    "SecretsManagerSecret": 88,
    "SSMAssociation": 89,
    "SSMParameter": 90,
    "CloudWatchLogGroup": 91,
    "GuardDutyDetector": 92,
    "EC2Instance": 100,
    "EC2NatGateway": 101,
    "EC2VpcEndpoint": 102,
    "EC2Volume": 103,
    "EC2AMI": 104,
    "EC2Snapshot": 105,
    "EC2ElasticIP": 106,
    "EC2NetworkInterface": 107,
    "EC2LaunchTemplate": 108,
    "EC2KeyPair": 109,
    "RDSSubnetGroup": 110,
    "EC2InternetGateway": 111,
    "EC2Route": 112,
    "EC2Subnet": 113,
    "EC2RouteTable": 114,
    "EC2SecurityGroup": 115,
    "EC2NetworkAcl": 116,
    "EC2Vpc": 117,
    "ACMCertificate": 120,
    "WAFv2RuleGroup": 125,
    "WAFv2IPSet": 126,
    "WAFv2RegexPatternSet": 127,
    "Route53HostedZone": 130,
    "EventBridgeBus": 135,
    "KMSKey": 140,
    "IAMVirtualMFADevice": 145,
    "IAMServerCertificate": 146,
    "IAMSAMLProvider": 147,
    "IAMOpenIDConnectProvider": 147,
    "IAMInstanceProfile": 148,
    "IAMUser": 150,
    "IAMGroup": 151,
    "IAMRole": 152,
    "IAMCustomerManagedPolicy": 153,
}


class ResourceDeleter:
    """Dependency-ordered, idempotent deletion operations for one asserted account."""

    def __init__(self, config: AppConfig, target: SessionPath, account_id: str) -> None:
        self.config = config
        self.target = target
        self.account_id = account_id

    def delete_round(
        self,
        resources: Sequence[Resource],
        *,
        inventory_context: Sequence[Resource] | None = None,
    ) -> list[ActionResult]:
        def order_key(resource: Resource) -> tuple[int, int, str, str]:
            kms_priority = 0 if resource.resource_type == "KMSKey" and resource.metadata.get("multi_region_key_type") == "REPLICA" else 1
            return (DELETE_ORDER.get(resource.resource_type, 999), kms_priority, resource.region, resource.resource_id)

        ordered = sorted(resources, key=order_key)
        context_resources = inventory_context if inventory_context is not None else resources
        deletable_service_resources_remain = any(
            classify_resource(resource)[0] == "delete"
            and resource.service != "iam"
            and resource.resource_type != "KMSKey"
            for resource in context_resources
        )
        protected_service_resources_remain = any(
            classify_resource(resource)[0] == "protected_residual"
            and resource.service != "iam"
            and resource.resource_type != "KMSKey"
            for resource in context_resources
        )
        results: list[ActionResult] = []
        for resource in ordered:
            disposition = classify_resource(resource)[0]
            if resource.service == "iam" and deletable_service_resources_remain:
                results.append(ActionResult(resource.key, "waiting", "defer_until_service_resources_are_gone", "dependency"))
                continue
            if resource.resource_type == "KMSKey" and (deletable_service_resources_remain or protected_service_resources_remain):
                results.append(ActionResult(resource.key, "waiting", "defer_until_service_resources_are_gone", "dependency"))
                continue
            if disposition in {"allowed_residual", "dependency_managed", "manual", "scheduled"}:
                results.append(self.delete(resource))
                continue
            results.append(self.delete(resource))
        return results

    def _client(self, service: str, region: str) -> Any:
        actual_region = "us-east-1" if region == "global" else region
        return self.target.session.client(service, region_name=actual_region, config=AWS_CONFIG)

    def _run(self, resource: Resource, operation: str, function: Callable[[], None], success: str = "deleted") -> ActionResult:
        try:
            function()
            return ActionResult(resource.key, success, operation)
        except (ClientError, BotoCoreError, CleanupError, ValueError, KeyError) as exc:
            category = classify_error(exc)
            if category == "not_found":
                return ActionResult(resource.key, "deleted", operation, category, error_code(exc), "Resource already absent")
            status = "access_denied" if category == "access_denied" else "waiting" if category in {"waiting", "unsupported_region"} else "failed"
            return ActionResult(resource.key, status, operation, category, error_code(exc), safe_error_message(exc))

    def delete(self, resource: Resource) -> ActionResult:
        disposition, action, notes = classify_resource(resource)
        message = "; ".join(notes) if notes else None
        if disposition == "manual":
            return ActionResult(resource.key, "manual", "none", "manual", message=message)
        if disposition == "allowed_residual":
            return ActionResult(resource.key, "preserved", "none", message=message)
        if disposition == "protected_residual":
            return ActionResult(resource.key, "skipped_unsafe", "none", "protected", message=message)
        if disposition == "scheduled":
            return ActionResult(resource.key, "scheduled", "none", "asynchronous", message=message)
        if disposition == "dependency_managed":
            return ActionResult(resource.key, "waiting", action, "dependency", message=message)
        method = getattr(self, f"_delete_{resource.resource_type}", None)
        if method is None:
            return ActionResult(resource.key, "skipped_unsafe", "none", "unsupported", message="No safe automatic deleter")
        return method(resource)

    def _delete_CloudFormationStack(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("status") == "DELETE_IN_PROGRESS":
            return ActionResult(resource.key, "waiting", "delete_stack", "asynchronous")
        client = self._client("cloudformation", resource.region)
        return self._run(resource, "delete_stack", lambda: client.delete_stack(StackName=resource.resource_id), "triggered")

    def _delete_LambdaFunction(self, resource: Resource) -> ActionResult:
        client = self._client("lambda", resource.region)
        return self._run(resource, "delete_function", lambda: client.delete_function(FunctionName=resource.resource_id))

    def _delete_ResourceExplorerView(self, resource: Resource) -> ActionResult:
        client = self._client("resource-explorer-2", resource.region)
        return self._run(
            resource,
            "delete_view",
            lambda: client.delete_view(ViewArn=resource.resource_id),
        )

    def _delete_ResourceExplorerIndex(self, resource: Resource) -> ActionResult:
        client = self._client("resource-explorer-2", resource.region)
        return self._run(
            resource,
            "delete_index",
            lambda: client.delete_index(Arn=resource.resource_id),
            "triggered",
        )

    def _delete_ELBv2LoadBalancer(self, resource: Resource) -> ActionResult:
        client = self._client("elbv2", resource.region)
        return self._run(resource, "delete_load_balancer", lambda: client.delete_load_balancer(LoadBalancerArn=resource.resource_id), "triggered")

    def _delete_ELBv2TargetGroup(self, resource: Resource) -> ActionResult:
        client = self._client("elbv2", resource.region)
        return self._run(resource, "delete_target_group", lambda: client.delete_target_group(TargetGroupArn=resource.resource_id))

    def _delete_ClassicELB(self, resource: Resource) -> ActionResult:
        client = self._client("elb", resource.region)
        return self._run(resource, "delete_load_balancer", lambda: client.delete_load_balancer(LoadBalancerName=resource.resource_id), "triggered")

    def _delete_RDSInstance(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("status") == "deleting":
            return ActionResult(resource.key, "waiting", "delete_db_instance", "asynchronous")
        client = self._client("rds", resource.region)
        return self._run(resource, "delete_db_instance", lambda: client.delete_db_instance(DBInstanceIdentifier=resource.resource_id, SkipFinalSnapshot=True, DeleteAutomatedBackups=True), "triggered")

    def _delete_RDSCluster(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("status") == "deleting":
            return ActionResult(resource.key, "waiting", "delete_db_cluster", "asynchronous")
        client = self._client("rds", resource.region)
        return self._run(resource, "delete_db_cluster", lambda: client.delete_db_cluster(DBClusterIdentifier=resource.resource_id, SkipFinalSnapshot=True), "triggered")

    def _delete_RDSManualSnapshot(self, resource: Resource) -> ActionResult:
        client = self._client("rds", resource.region)
        return self._run(resource, "delete_db_snapshot", lambda: client.delete_db_snapshot(DBSnapshotIdentifier=resource.resource_id), "triggered")

    def _delete_RDSManualClusterSnapshot(self, resource: Resource) -> ActionResult:
        client = self._client("rds", resource.region)
        return self._run(resource, "delete_db_cluster_snapshot", lambda: client.delete_db_cluster_snapshot(DBClusterSnapshotIdentifier=resource.resource_id), "triggered")

    def _delete_RDSSubnetGroup(self, resource: Resource) -> ActionResult:
        client = self._client("rds", resource.region)
        return self._run(resource, "delete_db_subnet_group", lambda: client.delete_db_subnet_group(DBSubnetGroupName=resource.resource_id))

    def _delete_ECSService(self, resource: Resource) -> ActionResult:
        client = self._client("ecs", resource.region)
        cluster = str(resource.metadata.get("cluster") or "")
        def operation() -> None:
            client.update_service(cluster=cluster, service=resource.resource_id, desiredCount=0)
            client.delete_service(cluster=cluster, service=resource.resource_id, force=True)
        return self._run(resource, "drain_and_delete_service", operation, "triggered")

    def _delete_ECSTask(self, resource: Resource) -> ActionResult:
        client = self._client("ecs", resource.region)
        cluster = str(resource.metadata.get("cluster") or "")
        return self._run(resource, "stop_task", lambda: client.stop_task(cluster=cluster, task=resource.resource_id, reason="Account cleanup confirmed"), "triggered")

    def _delete_ECSContainerInstance(self, resource: Resource) -> ActionResult:
        client = self._client("ecs", resource.region)
        cluster = str(resource.metadata.get("cluster") or "")
        return self._run(resource, "deregister_container_instance", lambda: client.deregister_container_instance(cluster=cluster, containerInstance=resource.resource_id, force=True), "triggered")

    def _delete_ECSCluster(self, resource: Resource) -> ActionResult:
        client = self._client("ecs", resource.region)
        return self._run(resource, "delete_cluster", lambda: client.delete_cluster(cluster=resource.resource_id), "triggered")

    def _delete_ECSTaskDefinition(self, resource: Resource) -> ActionResult:
        client = self._client("ecs", resource.region)
        if resource.metadata.get("status") == "ACTIVE":
            return self._run(resource, "deregister_task_definition", lambda: client.deregister_task_definition(taskDefinition=resource.resource_id), "triggered")
        return self._run(resource, "delete_task_definitions", lambda: client.delete_task_definitions(taskDefinitions=[resource.resource_id]), "triggered")

    def _delete_ECSCapacityProvider(self, resource: Resource) -> ActionResult:
        client = self._client("ecs", resource.region)
        return self._run(resource, "delete_capacity_provider", lambda: client.delete_capacity_provider(capacityProvider=resource.resource_id), "triggered")

    def _delete_ECRRepository(self, resource: Resource) -> ActionResult:
        client = self._client("ecr", resource.region)
        return self._run(resource, "delete_repository_force", lambda: client.delete_repository(repositoryName=resource.resource_id, force=True))

    def _delete_EKSAddon(self, resource: Resource) -> ActionResult:
        client = self._client("eks", resource.region)
        cluster = str(resource.metadata.get("cluster") or "")
        name = str(resource.metadata.get("name") or "")
        if resource.metadata.get("status") == "DELETING":
            return ActionResult(resource.key, "waiting", "delete_addon", "asynchronous")
        return self._run(resource, "delete_addon", lambda: client.delete_addon(clusterName=cluster, addonName=name, preserve=False), "triggered")

    def _delete_EKSNodegroup(self, resource: Resource) -> ActionResult:
        client = self._client("eks", resource.region)
        cluster = str(resource.metadata.get("cluster") or "")
        name = str(resource.metadata.get("name") or "")
        if resource.metadata.get("status") == "DELETING":
            return ActionResult(resource.key, "waiting", "delete_nodegroup", "asynchronous")
        return self._run(resource, "delete_nodegroup", lambda: client.delete_nodegroup(clusterName=cluster, nodegroupName=name), "triggered")

    def _delete_EKSFargateProfile(self, resource: Resource) -> ActionResult:
        client = self._client("eks", resource.region)
        cluster = str(resource.metadata.get("cluster") or "")
        name = str(resource.metadata.get("name") or "")
        if resource.metadata.get("status") == "DELETING":
            return ActionResult(resource.key, "waiting", "delete_fargate_profile", "asynchronous")
        return self._run(resource, "delete_fargate_profile", lambda: client.delete_fargate_profile(clusterName=cluster, fargateProfileName=name), "triggered")

    def _delete_EKSCluster(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("status") == "DELETING":
            return ActionResult(resource.key, "waiting", "delete_cluster", "asynchronous")
        client = self._client("eks", resource.region)
        name = str(resource.metadata.get("name") or "")
        return self._run(resource, "delete_cluster", lambda: client.delete_cluster(name=name), "triggered")

    def _delete_DynamoDBTable(self, resource: Resource) -> ActionResult:
        client = self._client("dynamodb", resource.region)
        name = str(resource.metadata.get("name") or "")
        if resource.metadata.get("status") == "DELETING":
            return ActionResult(resource.key, "waiting", "delete_table", "asynchronous")
        return self._run(resource, "delete_table", lambda: client.delete_table(TableName=name), "triggered")

    def _delete_SQSQueue(self, resource: Resource) -> ActionResult:
        client = self._client("sqs", resource.region)
        return self._run(resource, "delete_queue", lambda: client.delete_queue(QueueUrl=resource.resource_id))

    def _delete_SNSSubscription(self, resource: Resource) -> ActionResult:
        client = self._client("sns", resource.region)
        return self._run(resource, "unsubscribe", lambda: client.unsubscribe(SubscriptionArn=resource.resource_id))

    def _delete_SNSTopic(self, resource: Resource) -> ActionResult:
        client = self._client("sns", resource.region)
        return self._run(resource, "delete_topic", lambda: client.delete_topic(TopicArn=resource.resource_id))

    def _delete_CloudWatchLogGroup(self, resource: Resource) -> ActionResult:
        client = self._client("logs", resource.region)
        return self._run(resource, "delete_log_group", lambda: client.delete_log_group(logGroupName=resource.resource_id))

    def _delete_EventBridgeRule(self, resource: Resource) -> ActionResult:
        client = self._client("events", resource.region)
        bus = str(resource.metadata.get("event_bus") or "default")
        name = str(resource.metadata.get("name") or "")
        def operation() -> None:
            target_ids = [target["Id"] for page in paginate(client, "list_targets_by_rule", Rule=name, EventBusName=bus) for target in page.get("Targets", [])]
            for start in range(0, len(target_ids), 10):
                response = client.remove_targets(Rule=name, EventBusName=bus, Ids=target_ids[start : start + 10], Force=True)
                if response.get("FailedEntryCount"):
                    raise CleanupError("EventBridge target removal returned failed entries")
            client.delete_rule(Name=name, EventBusName=bus, Force=True)
        return self._run(resource, "remove_targets_and_delete_rule", operation)

    def _delete_EventBridgeBus(self, resource: Resource) -> ActionResult:
        client = self._client("events", resource.region)
        return self._run(resource, "delete_event_bus", lambda: client.delete_event_bus(Name=resource.resource_id))

    def _delete_StepFunctionsExecution(self, resource: Resource) -> ActionResult:
        client = self._client("stepfunctions", resource.region)
        return self._run(resource, "stop_execution", lambda: client.stop_execution(executionArn=resource.resource_id, error="AccountCleanup", cause="Confirmed member-account resource cleanup"), "triggered")

    def _delete_StepFunctionsStateMachine(self, resource: Resource) -> ActionResult:
        client = self._client("stepfunctions", resource.region)
        state_machine_arn = resource.resource_id
        def operation() -> None:
            if resource.metadata.get("workflow_type") == "STANDARD":
                running: list[str] = []
                for page in paginate(client, "list_executions", stateMachineArn=state_machine_arn, statusFilter="RUNNING"):
                    running.extend(item["executionArn"] for item in page.get("executions", []))
                for execution_arn in running:
                    client.stop_execution(executionArn=execution_arn, error="AccountCleanup", cause="Confirmed member-account resource cleanup")
                if running:
                    raise CleanupWaitingError("Running Standard Workflow executions were stopped; waiting before state-machine deletion")
            client.delete_state_machine(stateMachineArn=state_machine_arn)
        return self._run(resource, "stop_running_executions_and_delete_state_machine", operation, "triggered")

    def _delete_StepFunctionsActivity(self, resource: Resource) -> ActionResult:
        client = self._client("stepfunctions", resource.region)
        return self._run(resource, "delete_activity", lambda: client.delete_activity(activityArn=resource.resource_id))

    def _delete_SecretsManagerSecret(self, resource: Resource) -> ActionResult:
        client = self._client("secretsmanager", resource.region)
        if resource.metadata.get("scheduled_deletion"):
            return ActionResult(resource.key, "waiting", "delete_secret", "asynchronous")
        return self._run(resource, "force_delete_secret", lambda: client.delete_secret(SecretId=resource.resource_id, ForceDeleteWithoutRecovery=True), "triggered")

    def _delete_SSMAssociation(self, resource: Resource) -> ActionResult:
        client = self._client("ssm", resource.region)
        return self._run(
            resource,
            "delete_association",
            lambda: client.delete_association(AssociationId=resource.resource_id),
        )

    def _delete_SSMParameter(self, resource: Resource) -> ActionResult:
        client = self._client("ssm", resource.region)
        return self._run(resource, "delete_parameter", lambda: client.delete_parameter(Name=resource.resource_id))

    def _delete_APIGatewayRestApi(self, resource: Resource) -> ActionResult:
        client = self._client("apigateway", resource.region)
        return self._run(resource, "delete_rest_api", lambda: client.delete_rest_api(restApiId=resource.resource_id))

    def _delete_APIGatewayV2Api(self, resource: Resource) -> ActionResult:
        client = self._client("apigatewayv2", resource.region)
        return self._run(resource, "delete_api", lambda: client.delete_api(ApiId=resource.resource_id))

    def _delete_ACMCertificate(self, resource: Resource) -> ActionResult:
        client = self._client("acm", resource.region)
        return self._run(resource, "delete_certificate", lambda: client.delete_certificate(CertificateArn=resource.resource_id))

    def _delete_GuardDutyDetector(self, resource: Resource) -> ActionResult:
        client = self._client("guardduty", resource.region)
        return self._run(resource, "delete_detector", lambda: client.delete_detector(DetectorId=resource.resource_id))

    def _delete_EC2Instance(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("state") in {"shutting-down", "terminated"}:
            return ActionResult(resource.key, "waiting", "terminate_instances", "asynchronous")
        client = self._client("ec2", resource.region)
        return self._run(resource, "terminate_instances", lambda: client.terminate_instances(InstanceIds=[resource.resource_id]), "triggered")

    def _delete_EC2Volume(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_volume", lambda: client.delete_volume(VolumeId=resource.resource_id))

    def _delete_EC2Snapshot(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_snapshot", lambda: client.delete_snapshot(SnapshotId=resource.resource_id))

    def _delete_EC2AMI(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        return self._run(resource, "deregister_image", lambda: client.deregister_image(ImageId=resource.resource_id))

    def _delete_EC2ElasticIP(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        association_id = str(resource.metadata.get("association_id") or "")
        def operation() -> None:
            if association_id:
                client.disassociate_address(AssociationId=association_id)
            if resource.resource_id.startswith("eipalloc-"):
                client.release_address(AllocationId=resource.resource_id)
            else:
                client.release_address(PublicIp=resource.resource_id)
        return self._run(resource, "disassociate_and_release_address", operation)

    def _delete_EC2NatGateway(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("state") == "deleting":
            return ActionResult(resource.key, "waiting", "delete_nat_gateway", "asynchronous")
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_nat_gateway", lambda: client.delete_nat_gateway(NatGatewayId=resource.resource_id), "triggered")

    def _delete_EC2VpcEndpoint(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        def operation() -> None:
            response = client.delete_vpc_endpoints(VpcEndpointIds=[resource.resource_id])
            if response.get("Unsuccessful"):
                raise CleanupError("VPC endpoint deletion returned unsuccessful entries")
        return self._run(resource, "delete_vpc_endpoints", operation, "triggered")

    def _delete_EC2NetworkInterface(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("requester_managed") or resource.metadata.get("status") != "available":
            return ActionResult(resource.key, "waiting", "delete_network_interface", "dependency", message="Service-managed or attached interface")
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_network_interface", lambda: client.delete_network_interface(NetworkInterfaceId=resource.resource_id))

    def _delete_EC2LaunchTemplate(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_launch_template", lambda: client.delete_launch_template(LaunchTemplateId=resource.resource_id))

    def _delete_EC2KeyPair(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        key_name = str(resource.metadata.get("name") or "")
        kwargs = {"KeyPairId": resource.resource_id} if resource.resource_id.startswith("key-") else {"KeyName": key_name or resource.resource_id}
        return self._run(resource, "delete_key_pair", lambda: client.delete_key_pair(**kwargs))

    def _delete_EC2InternetGateway(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        vpc_ids = [str(item) for item in resource.metadata.get("vpc_ids", [])] if isinstance(resource.metadata.get("vpc_ids"), list) else []
        def operation() -> None:
            for vpc_id in vpc_ids:
                if vpc_id:
                    client.detach_internet_gateway(InternetGatewayId=resource.resource_id, VpcId=vpc_id)
            client.delete_internet_gateway(InternetGatewayId=resource.resource_id)
        return self._run(resource, "detach_and_delete_internet_gateway", operation)

    def _delete_EC2Route(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        destination_type = str(resource.metadata.get("destination_type") or "")
        destination = str(resource.metadata.get("destination") or "")
        route_table_id = str(resource.metadata.get("route_table_id") or "")
        if destination_type not in {"DestinationCidrBlock", "DestinationIpv6CidrBlock", "DestinationPrefixListId"} or not destination or not route_table_id:
            return ActionResult(resource.key, "skipped_unsafe", "none", "invalid_metadata", message="Route deletion metadata is incomplete")
        return self._run(resource, "delete_route", lambda: client.delete_route(RouteTableId=route_table_id, **{destination_type: destination}))

    def _delete_EC2Subnet(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("default_for_az"):
            vpc_id = str(resource.metadata.get("vpc_id") or "")
            try:
                response = self._client("ec2", resource.region).describe_vpcs(VpcIds=[vpc_id])
                if response.get("Vpcs", [{}])[0].get("IsDefault"):
                    return ActionResult(resource.key, "preserved", "none", message="Default VPC subnet allowed")
            except (ClientError, BotoCoreError, IndexError):
                return ActionResult(resource.key, "skipped_unsafe", "none", message="Could not prove subnet belongs to a non-default VPC")
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_subnet", lambda: client.delete_subnet(SubnetId=resource.resource_id))

    def _delete_EC2RouteTable(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("main"):
            return ActionResult(resource.key, "preserved", "none", message="Main route table is deleted with non-default VPC")
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_route_table", lambda: client.delete_route_table(RouteTableId=resource.resource_id))

    def _delete_EC2SecurityGroup(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("default"):
            return ActionResult(resource.key, "preserved", "none", message="Default security group is deleted with non-default VPC or allowed with default VPC")
        client = self._client("ec2", resource.region)

        def referenced_permissions(permissions: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
            filtered: list[dict[str, Any]] = []
            pair_keys = {"Description", "GroupId", "GroupName", "UserId", "VpcId", "VpcPeeringConnectionId"}
            for permission in permissions:
                pairs = [
                    {key: value for key, value in pair.items() if key in pair_keys}
                    for pair in permission.get("UserIdGroupPairs", [])
                    if pair.get("GroupId") == resource.resource_id
                ]
                if not pairs:
                    continue
                item: dict[str, Any] = {"IpProtocol": permission["IpProtocol"], "UserIdGroupPairs": pairs}
                if permission.get("FromPort") is not None:
                    item["FromPort"] = permission["FromPort"]
                if permission.get("ToPort") is not None:
                    item["ToPort"] = permission["ToPort"]
                filtered.append(item)
            return filtered

        def operation() -> None:
            vpc_id = str(resource.metadata.get("vpc_id") or "")
            filters = [{"Name": "vpc-id", "Values": [vpc_id]}] if vpc_id else []
            for page in paginate(client, "describe_security_groups", Filters=filters):
                for group in page.get("SecurityGroups", []):
                    group_id = group["GroupId"]
                    ingress = referenced_permissions(group.get("IpPermissions", []))
                    egress = referenced_permissions(group.get("IpPermissionsEgress", []))
                    if ingress:
                        client.revoke_security_group_ingress(GroupId=group_id, IpPermissions=ingress)
                    if egress:
                        client.revoke_security_group_egress(GroupId=group_id, IpPermissions=egress)
            client.delete_security_group(GroupId=resource.resource_id)

        return self._run(resource, "revoke_group_references_and_delete_security_group", operation)

    def _delete_EC2NetworkAcl(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("default"):
            return ActionResult(resource.key, "waiting", "delete_with_non_default_vpc_only", "dependency", message="Default network ACL is deleted with its non-default VPC")
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_network_acl", lambda: client.delete_network_acl(NetworkAclId=resource.resource_id))

    def _delete_EC2Vpc(self, resource: Resource) -> ActionResult:
        client = self._client("ec2", resource.region)
        return self._run(resource, "delete_vpc", lambda: client.delete_vpc(VpcId=resource.resource_id))

    def _delete_S3Bucket(self, resource: Resource) -> ActionResult:
        client = self._client("s3", resource.region)
        bucket = resource.resource_id
        def delete_batch(objects: list[dict[str, str]]) -> None:
            for offset in range(0, len(objects), 1000):
                response = client.delete_objects(Bucket=bucket, Delete={"Objects": objects[offset : offset + 1000], "Quiet": True})
                if response.get("Errors"):
                    raise CleanupError("S3 object deletion returned errors; retention and Object Lock are not bypassed")
        def operation() -> None:
            while True:
                page = client.list_object_versions(Bucket=bucket, MaxKeys=1000)
                versions = [
                    {"Key": item["Key"], "VersionId": item["VersionId"]}
                    for item in [*page.get("Versions", []), *page.get("DeleteMarkers", [])]
                ]
                if not versions:
                    break
                delete_batch(versions)
            while True:
                page = client.list_objects_v2(Bucket=bucket, MaxKeys=1000)
                current = [{"Key": item["Key"]} for item in page.get("Contents", [])]
                if not current:
                    break
                delete_batch(current)
            for page in paginate(client, "list_multipart_uploads", Bucket=bucket):
                for upload in page.get("Uploads", []):
                    client.abort_multipart_upload(Bucket=bucket, Key=upload["Key"], UploadId=upload["UploadId"])
            client.delete_bucket(Bucket=bucket)
        return self._run(resource, "empty_versions_markers_multipart_and_delete_bucket", operation)

    def _delete_CloudFrontDistribution(self, resource: Resource) -> ActionResult:
        client = self._client("cloudfront", "global")
        def operation() -> None:
            response = client.get_distribution_config(Id=resource.resource_id)
            config = response["DistributionConfig"]
            etag = response["ETag"]
            if config.get("Enabled"):
                config["Enabled"] = False
                client.update_distribution(Id=resource.resource_id, IfMatch=etag, DistributionConfig=config)
                return
            distribution = client.get_distribution(Id=resource.resource_id).get("Distribution", {})
            if distribution.get("Status") != "Deployed":
                raise CleanupWaitingError("CloudFront distribution disablement is still deploying")
            fresh = client.get_distribution_config(Id=resource.resource_id)
            client.delete_distribution(Id=resource.resource_id, IfMatch=fresh["ETag"])
        return self._run(resource, "disable_then_delete_distribution", operation, "triggered")

    def _delete_CloudFrontFunction(self, resource: Resource) -> ActionResult:
        client = self._client("cloudfront", "global")
        def operation() -> None:
            response = client.describe_function(Name=resource.resource_id, Stage="DEVELOPMENT")
            client.delete_function(Name=resource.resource_id, IfMatch=response["ETag"])
        return self._run(resource, "delete_function", operation)

    def _delete_CloudFrontKeyGroup(self, resource: Resource) -> ActionResult:
        client = self._client("cloudfront", "global")
        def operation() -> None:
            response = client.get_key_group(Id=resource.resource_id)
            client.delete_key_group(Id=resource.resource_id, IfMatch=response["ETag"])
        return self._run(resource, "delete_key_group", operation)

    def _delete_CloudFrontPublicKey(self, resource: Resource) -> ActionResult:
        client = self._client("cloudfront", "global")
        def operation() -> None:
            response = client.get_public_key(Id=resource.resource_id)
            client.delete_public_key(Id=resource.resource_id, IfMatch=response["ETag"])
        return self._run(resource, "delete_public_key", operation)

    def _delete_CloudFrontOriginAccessIdentity(self, resource: Resource) -> ActionResult:
        client = self._client("cloudfront", "global")
        def operation() -> None:
            response = client.get_cloud_front_origin_access_identity(Id=resource.resource_id)
            client.delete_cloud_front_origin_access_identity(Id=resource.resource_id, IfMatch=response["ETag"])
        return self._run(resource, "delete_origin_access_identity", operation)

    def _delete_CloudFrontOriginAccessControl(self, resource: Resource) -> ActionResult:
        client = self._client("cloudfront", "global")
        def operation() -> None:
            response = client.get_origin_access_control(Id=resource.resource_id)
            client.delete_origin_access_control(Id=resource.resource_id, IfMatch=response["ETag"])
        return self._run(resource, "delete_origin_access_control", operation)

    def _delete_Route53HostedZone(self, resource: Resource) -> ActionResult:
        client = self._client("route53", "global")
        zone_id = resource.resource_id
        def operation() -> None:
            deletions: list[dict[str, Any]] = []
            for page in paginate(client, "list_resource_record_sets", HostedZoneId=zone_id):
                for record in page.get("ResourceRecordSets", []):
                    if record.get("Type") in {"SOA", "NS"} and str(record.get("Name", "")).rstrip(".") == str(resource.metadata.get("name", "")).rstrip("."):
                        continue
                    deletions.append({"Action": "DELETE", "ResourceRecordSet": record})
            for offset in range(0, len(deletions), 1000):
                client.change_resource_record_sets(HostedZoneId=zone_id, ChangeBatch={"Changes": deletions[offset : offset + 1000]})
            if deletions:
                raise CleanupWaitingError("Route 53 record deletion is propagating")
            client.delete_hosted_zone(Id=zone_id)
        return self._run(resource, "delete_records_then_hosted_zone", operation, "triggered")

    def _delete_WAFv2WebACL(self, resource: Resource) -> ActionResult:
        return self._delete_waf_item(resource, "delete_web_acl", "WebACL")

    def _delete_WAFv2RuleGroup(self, resource: Resource) -> ActionResult:
        return self._delete_waf_item(resource, "delete_rule_group", "RuleGroup")

    def _delete_WAFv2IPSet(self, resource: Resource) -> ActionResult:
        return self._delete_waf_item(resource, "delete_ip_set", "IPSet")

    def _delete_WAFv2RegexPatternSet(self, resource: Resource) -> ActionResult:
        return self._delete_waf_item(resource, "delete_regex_pattern_set", "RegexPatternSet")

    def _delete_waf_item(self, resource: Resource, operation_name: str, response_key: str) -> ActionResult:
        client = self._client("wafv2", "us-east-1" if resource.metadata.get("scope") == "CLOUDFRONT" else resource.region)
        scope = str(resource.metadata.get("scope") or "REGIONAL")
        name = str(resource.metadata.get("name") or "")
        get_name = "get_" + operation_name.removeprefix("delete_")
        def operation() -> None:
            response = getattr(client, get_name)(Name=name, Scope=scope, Id=resource.resource_id)
            getattr(client, operation_name)(Name=name, Scope=scope, Id=resource.resource_id, LockToken=response["LockToken"])
        return self._run(resource, operation_name, operation)

    def _delete_KMSKey(self, resource: Resource) -> ActionResult:
        state = str(resource.metadata.get("state") or "")
        if state in KMS_SCHEDULED_STATES:
            return ActionResult(resource.key, "scheduled", "none", "asynchronous", message="KMS deletion is already scheduled")
        if state in {"PendingImport", "Unavailable"}:
            return ActionResult(resource.key, "skipped_unsafe", "none", "invalid_state", message="KMS key state is not safe to alter")
        replica_arns = resource.metadata.get("replica_key_arns")
        if resource.metadata.get("multi_region_key_type") == "PRIMARY" and isinstance(replica_arns, list) and replica_arns:
            return ActionResult(resource.key, "waiting", "schedule_key_deletion_7_days", "dependency", message="Multi-Region replicas must enter deletion first")
        client = self._client("kms", resource.region)
        return self._run(resource, "schedule_key_deletion_7_days", lambda: client.schedule_key_deletion(KeyId=resource.resource_id, PendingWindowInDays=7), "triggered")

    def _delete_IAMVirtualMFADevice(self, resource: Resource) -> ActionResult:
        client = self._client("iam", "global")
        return self._run(resource, "delete_unassigned_virtual_mfa_device", lambda: client.delete_virtual_mfa_device(SerialNumber=resource.resource_id))

    def _delete_IAMServerCertificate(self, resource: Resource) -> ActionResult:
        client = self._client("iam", "global")
        return self._run(resource, "delete_server_certificate", lambda: client.delete_server_certificate(ServerCertificateName=resource.resource_id))

    def _delete_IAMSAMLProvider(self, resource: Resource) -> ActionResult:
        client = self._client("iam", "global")
        return self._run(resource, "delete_saml_provider", lambda: client.delete_saml_provider(SAMLProviderArn=resource.resource_id))

    def _delete_IAMOpenIDConnectProvider(self, resource: Resource) -> ActionResult:
        client = self._client("iam", "global")
        return self._run(resource, "delete_open_id_connect_provider", lambda: client.delete_open_id_connect_provider(OpenIDConnectProviderArn=resource.resource_id))

    def _delete_IAMInstanceProfile(self, resource: Resource) -> ActionResult:
        if resource.metadata.get("preserve"):
            return ActionResult(resource.key, "skipped_unsafe", "none", message="Instance profile contains a preserved role")
        client = self._client("iam", "global")
        profile = resource.resource_id
        role_names = [str(item) for item in resource.metadata.get("roles", [])] if isinstance(resource.metadata.get("roles"), list) else []
        def operation() -> None:
            for role in role_names:
                client.remove_role_from_instance_profile(InstanceProfileName=profile, RoleName=role)
            client.delete_instance_profile(InstanceProfileName=profile)
        return self._run(resource, "remove_roles_and_delete_instance_profile", operation)

    def _delete_IAMUser(self, resource: Resource) -> ActionResult:
        client = self._client("iam", "global")
        user = resource.resource_id
        def operation() -> None:
            user_details = client.get_user(UserName=user).get("User", {})
            if user_details.get("PermissionsBoundary"):
                client.delete_user_permissions_boundary(UserName=user)
            try:
                client.delete_login_profile(UserName=user)
            except ClientError as exc:
                if error_code(exc) not in NOT_FOUND_CODES:
                    raise
            for page in paginate(client, "list_access_keys", UserName=user):
                for item in page.get("AccessKeyMetadata", []):
                    client.delete_access_key(UserName=user, AccessKeyId=item["AccessKeyId"])
            for page in paginate(client, "list_mfa_devices", UserName=user):
                for item in page.get("MFADevices", []):
                    serial = item["SerialNumber"]
                    client.deactivate_mfa_device(UserName=user, SerialNumber=serial)
                    if str(serial).startswith("arn:"):
                        try:
                            client.delete_virtual_mfa_device(SerialNumber=serial)
                        except ClientError as exc:
                            if error_code(exc) not in NOT_FOUND_CODES:
                                raise
            for page in paginate(client, "list_ssh_public_keys", UserName=user):
                for item in page.get("SSHPublicKeys", []):
                    client.delete_ssh_public_key(UserName=user, SSHPublicKeyId=item["SSHPublicKeyId"])
            for page in paginate(client, "list_service_specific_credentials", UserName=user):
                for item in page.get("ServiceSpecificCredentials", []):
                    client.delete_service_specific_credential(UserName=user, ServiceSpecificCredentialId=item["ServiceSpecificCredentialId"])
            for page in paginate(client, "list_signing_certificates", UserName=user):
                for item in page.get("Certificates", []):
                    client.delete_signing_certificate(UserName=user, CertificateId=item["CertificateId"])
            for page in paginate(client, "list_user_policies", UserName=user):
                for name in page.get("PolicyNames", []):
                    client.delete_user_policy(UserName=user, PolicyName=name)
            for page in paginate(client, "list_attached_user_policies", UserName=user):
                for policy in page.get("AttachedPolicies", []):
                    client.detach_user_policy(UserName=user, PolicyArn=policy["PolicyArn"])
            for page in paginate(client, "list_groups_for_user", UserName=user):
                for group in page.get("Groups", []):
                    client.remove_user_from_group(GroupName=group["GroupName"], UserName=user)
            client.delete_user(UserName=user)
        return self._run(resource, "delete_all_user_credentials_policies_groups_and_user", operation)

    def _delete_IAMGroup(self, resource: Resource) -> ActionResult:
        client = self._client("iam", "global")
        group = resource.resource_id
        def operation() -> None:
            for page in paginate(client, "get_group", GroupName=group):
                for user in page.get("Users", []):
                    client.remove_user_from_group(GroupName=group, UserName=user["UserName"])
            for page in paginate(client, "list_group_policies", GroupName=group):
                for name in page.get("PolicyNames", []):
                    client.delete_group_policy(GroupName=group, PolicyName=name)
            for page in paginate(client, "list_attached_group_policies", GroupName=group):
                for policy in page.get("AttachedPolicies", []):
                    client.detach_group_policy(GroupName=group, PolicyArn=policy["PolicyArn"])
            client.delete_group(GroupName=group)
        return self._run(resource, "detach_dependencies_and_delete_group", operation)

    def _delete_IAMRole(self, resource: Resource) -> ActionResult:
        if is_preserved_role(resource.resource_id, path=str(resource.metadata.get("path") or ""), config=self.config):
            return ActionResult(resource.key, "preserved", "none", message="Preserved role")
        client = self._client("iam", "global")
        role = resource.resource_id
        def operation() -> None:
            role_details = client.get_role(RoleName=role).get("Role", {})
            if role_details.get("PermissionsBoundary"):
                client.delete_role_permissions_boundary(RoleName=role)
            for page in paginate(client, "list_instance_profiles_for_role", RoleName=role):
                for profile in page.get("InstanceProfiles", []):
                    name = profile["InstanceProfileName"]
                    client.remove_role_from_instance_profile(InstanceProfileName=name, RoleName=role)
                    client.delete_instance_profile(InstanceProfileName=name)
            for page in paginate(client, "list_role_policies", RoleName=role):
                for name in page.get("PolicyNames", []):
                    client.delete_role_policy(RoleName=role, PolicyName=name)
            for page in paginate(client, "list_attached_role_policies", RoleName=role):
                for policy in page.get("AttachedPolicies", []):
                    client.detach_role_policy(RoleName=role, PolicyArn=policy["PolicyArn"])
            client.delete_role(RoleName=role)
        return self._run(resource, "detach_dependencies_and_delete_role", operation)

    def _delete_IAMCustomerManagedPolicy(self, resource: Resource) -> ActionResult:
        client = self._client("iam", "global")
        policy_arn = resource.resource_id
        def operation() -> None:
            users: list[str] = []
            groups: list[str] = []
            roles: list[str] = []
            boundary_users: list[str] = []
            boundary_roles: list[str] = []
            for page in paginate(client, "list_entities_for_policy", PolicyArn=policy_arn, PolicyUsageFilter="PermissionsPolicy"):
                users.extend(item["UserName"] for item in page.get("PolicyUsers", []))
                groups.extend(item["GroupName"] for item in page.get("PolicyGroups", []))
                roles.extend(item["RoleName"] for item in page.get("PolicyRoles", []))
            for page in paginate(client, "list_entities_for_policy", PolicyArn=policy_arn, PolicyUsageFilter="PermissionsBoundary"):
                boundary_users.extend(item["UserName"] for item in page.get("PolicyUsers", []))
                boundary_roles.extend(item["RoleName"] for item in page.get("PolicyRoles", []))
            preserved_attachments = [
                role for role in [*roles, *boundary_roles]
                if is_preserved_role(role, config=self.config)
            ]
            if preserved_attachments:
                raise CleanupError("Policy remains attached to or bounds a preserved role")
            for user in boundary_users:
                client.delete_user_permissions_boundary(UserName=user)
            for role in boundary_roles:
                client.delete_role_permissions_boundary(RoleName=role)
            for user in users:
                client.detach_user_policy(UserName=user, PolicyArn=policy_arn)
            for group in groups:
                client.detach_group_policy(GroupName=group, PolicyArn=policy_arn)
            for role in roles:
                client.detach_role_policy(RoleName=role, PolicyArn=policy_arn)
            for page in paginate(client, "list_policy_versions", PolicyArn=policy_arn):
                for version in page.get("Versions", []):
                    if not version.get("IsDefaultVersion"):
                        client.delete_policy_version(PolicyArn=policy_arn, VersionId=version["VersionId"])
            client.delete_policy(PolicyArn=policy_arn)
        return self._run(resource, "detach_entities_versions_and_delete_policy", operation)


def allowed_residual(resource: Resource) -> bool:
    return classify_resource(resource)[0] == "allowed_residual"


def command_probe(manager: CredentialManager, config: AppConfig, account_ids: Sequence[str]) -> dict[str, JsonValue]:
    results: list[dict[str, JsonValue]] = []
    for account_id in account_ids:
        item: dict[str, JsonValue] = {"account_id": account_id}
        try:
            record, _ = manager.validate_member(account_id)
            item["cache"] = {
                "found": True,
                "payer_mapped": True,
                "joined_method": record.joined_method,
            }
            try:
                target = manager.assume_admin(account_id)
                assert_account(target.session, account_id, "probe-admin", config.region)
                item["admin"] = {"available": True, "path": target.description}
            except (ClientError, BotoCoreError, CleanupError) as exc:
                item["admin"] = {"available": False, "error": {"category": classify_error(exc), "code": error_code(exc), "message": safe_error_message(exc)}}
            item["support"] = manager.probe_support(account_id)
            item["safe_to_scan"] = bool(isinstance(item.get("admin"), dict) and item["admin"].get("available"))
        except CleanupError as exc:
            item["error"] = {"category": "safety", "code": exc.__class__.__name__, "message": safe_error_message(exc)}
            item["safe_to_scan"] = False
        results.append(item)
    return {"command": "probe", "read_only": True, "results": results}


def make_scanner(manager: CredentialManager, config: AppConfig, account_id: str, phase: str) -> tuple[SessionPath, InventoryScanner]:
    validate_target(account_id, config)
    target = manager.assume_admin(account_id)
    assert_account(target.session, account_id, phase, config.region)
    return target, InventoryScanner(config, manager, target, account_id)


def command_scan(manager: CredentialManager, config: AppConfig, account_id: str) -> dict[str, JsonValue]:
    _, scanner = make_scanner(manager, config, account_id, "scan-stage")
    inventory = scanner.scan(include_costs=True)
    return {"command": "scan", "read_only": True, **inventory.to_dict(include_resources=True)}


def command_plan(manager: CredentialManager, config: AppConfig, account_id: str) -> dict[str, JsonValue]:
    _, scanner = make_scanner(manager, config, account_id, "plan-stage")
    inventory = scanner.scan(include_costs=True)
    return {"command": "plan", **plan_for_inventory(inventory, config)}


def command_verify(manager: CredentialManager, config: AppConfig, account_id: str) -> dict[str, JsonValue]:
    _, scanner = make_scanner(manager, config, account_id, "verify-stage")
    inventory = scanner.scan(include_costs=False)
    allowed = [resource for resource in inventory.resources if allowed_residual(resource)]
    scheduled_kms = [resource for resource in inventory.resources if is_scheduled_kms(resource)]
    residual = [
        resource for resource in inventory.resources
        if not allowed_residual(resource) and not is_scheduled_kms(resource)
    ]
    clean_within_coverage = not residual and not inventory.issues
    clean = clean_within_coverage and inventory.coverage_complete
    return {
        "command": "verify",
        "read_only": True,
        "account_id": account_id,
        "credential_path": inventory.credential_path,
        "generated_at": inventory.generated_at,
        "coverage_contract_version": COVERAGE_CONTRACT_VERSION,
        "coverage_complete": inventory.coverage_complete,
        "coverage_expected": [
            {"scanner_id": scanner_id, "region": region}
            for scanner_id, region in sorted(inventory.expected_coverage_keys)
        ],
        "coverage_gaps": sorted(inventory.coverage_gaps),
        "coverage": [item.to_dict() for item in inventory.coverage],
        "clean": clean,
        "clean_within_coverage": clean_within_coverage,
        "fully_deleted": clean and not scheduled_kms,
        "summary": {
            "residual_count": len(residual),
            "allowed_residual_count": len(allowed),
            "scheduled_kms_count": len(scheduled_kms),
            "scan_issue_count": len(inventory.issues),
            "coverage_gap_count": len(inventory.coverage_gaps),
        },
        "allowed_residuals": [resource.to_dict() for resource in sorted_resources(allowed)],
        "scheduled_kms_deletions": [resource.to_dict() for resource in sorted_resources(scheduled_kms)],
        "residuals": [resource.to_dict() for resource in sorted_resources(residual)],
        "issues": [issue.to_dict() for issue in inventory.issues],
        "manual_checks": inventory.manual_checks,
    }


def command_nuke(manager: CredentialManager, config: AppConfig, account_id: str, confirmation: str) -> dict[str, JsonValue]:
    validate_target(account_id, config)
    if confirmation != account_id:
        raise CleanupError("--confirm must exactly equal the single target account ID")
    manager.assert_destructive_membership(account_id)
    target, scanner = make_scanner(manager, config, account_id, "nuke-stage")
    deleter = ResourceDeleter(config, target, account_id)
    rounds: list[dict[str, JsonValue]] = []
    prior_fingerprint: str | None = None
    unchanged_rounds = 0
    triggered_seen: set[str] = set()
    async_first_seen: dict[str, float] = {}
    try:
        max_rounds = int(os.environ.get("AWS_CLEANUP_MAX_ROUNDS", "40"))
        wait_seconds = int(os.environ.get("AWS_CLEANUP_WAIT_SECONDS", "30"))
        max_unchanged = int(os.environ.get("AWS_CLEANUP_MAX_UNCHANGED_ROUNDS", "3"))
        async_deadline_seconds = int(os.environ.get("AWS_CLEANUP_ASYNC_DEADLINE_SECONDS", "900"))
    except ValueError as exc:
        raise CleanupError("Cleanup loop environment limits must be integers") from exc
    if (
        not 1 <= max_rounds <= 100
        or not 5 <= wait_seconds <= 300
        or not 2 <= max_unchanged <= 60
        or not 300 <= async_deadline_seconds <= 86400
    ):
        raise CleanupError("Cleanup loop environment limits are outside safe bounds")
    if (max_rounds - 1) * wait_seconds < async_deadline_seconds:
        raise CleanupError("Cleanup round budget must cover the full asynchronous deadline")

    stop_reason = "max_rounds"
    for round_number in range(1, max_rounds + 1):
        manager.assert_destructive_membership(account_id)
        assert_account(target.session, account_id, f"nuke-round-{round_number}", config.region)
        inventory = scanner.scan(include_costs=False)
        if inventory.issues or not inventory.coverage_complete:
            stop_reason = "blocking_scan_or_coverage_issues"
            rounds.append(
                {
                    "round": round_number,
                    "resource_count": len(inventory.resources),
                    "blocked_before_deletion": True,
                    "actions": [],
                    "coverage_complete": inventory.coverage_complete,
                    "coverage_gaps": sorted(inventory.coverage_gaps),
                    "coverage": [item.to_dict() for item in inventory.coverage],
                    "scan_issues": [issue.to_dict() for issue in inventory.issues],
                }
            )
            break
        deletable = [
            resource for resource in inventory.resources
            if classify_resource(resource)[0] in {"delete", "schedule"}
        ]
        if not deletable:
            stop_reason = "no_deletable_resources"
            rounds.append({"round": round_number, "resource_count": 0, "actions": [], "scan_issues": []})
            break

        now = time.monotonic()
        current_async = {resource.key for resource in deletable if resource.resource_type in ASYNC_TYPES}
        for resource_key in current_async:
            async_first_seen.setdefault(resource_key, now)
        for resource_key in set(async_first_seen) - current_async:
            async_first_seen.pop(resource_key, None)
        expired_async = sorted(
            resource_key for resource_key, first_seen in async_first_seen.items()
            if now - first_seen > async_deadline_seconds
        )
        if expired_async:
            stop_reason = "async_deadline_exceeded"
            rounds.append({
                "round": round_number,
                "resource_count": len(deletable),
                "blocked_before_deletion": True,
                "actions": [],
                "async_deadline_exceeded": expired_async,
            })
            break

        actions = deleter.delete_round(deletable, inventory_context=inventory.resources)
        new_triggers = {action.resource_key for action in actions if action.status == "triggered"} - triggered_seen
        triggered_seen.update(action.resource_key for action in actions if action.status == "triggered")
        if inventory.fingerprint == prior_fingerprint and not new_triggers:
            unchanged_rounds += 1
        else:
            unchanged_rounds = 0
        prior_fingerprint = inventory.fingerprint
        status_counts = Counter(action.status for action in actions)
        rounds.append(
            {
                "round": round_number,
                "resource_count": len(deletable),
                "fingerprint": inventory.fingerprint,
                "status_counts": dict(sorted(status_counts.items())),
                "actions": [action.to_dict() for action in actions],
                "scan_issues": [],
                "unchanged_rounds": unchanged_rounds,
            }
        )
        if unchanged_rounds >= max_unchanged and not current_async:
            stop_reason = "consecutive_no_progress"
            break
        time.sleep(wait_seconds)

    manager.assert_destructive_membership(account_id)
    assert_account(target.session, account_id, "nuke-final-verify", config.region)
    final_inventory = scanner.scan(include_costs=False)
    scheduled_kms = [resource for resource in final_inventory.resources if is_scheduled_kms(resource)]
    residual = [
        resource for resource in final_inventory.resources
        if not allowed_residual(resource) and not is_scheduled_kms(resource)
    ]
    complete = (
        not residual
        and not final_inventory.issues
        and final_inventory.coverage_complete
    )
    return {
        "command": "nuke",
        "account_id": account_id,
        "credential_path": target.description,
        "confirmed": True,
        "stop_reason": stop_reason,
        "coverage_contract_version": COVERAGE_CONTRACT_VERSION,
        "complete": complete,
        "fully_deleted": complete and not scheduled_kms,
        "rounds": rounds,
        "final": {
            "coverage_complete": final_inventory.coverage_complete,
            "coverage_gaps": sorted(final_inventory.coverage_gaps),
            "coverage": [item.to_dict() for item in final_inventory.coverage],
            "residual_count": len(residual),
            "scheduled_kms_count": len(scheduled_kms),
            "allowed_residual_count": sum(1 for resource in final_inventory.resources if allowed_residual(resource)),
            "scan_issue_count": len(final_inventory.issues),
            "residuals": [resource.to_dict() for resource in sorted_resources(residual)],
            "scheduled_kms_deletions": [resource.to_dict() for resource in sorted_resources(scheduled_kms)],
            "issues": [issue.to_dict() for issue in final_inventory.issues],
            "manual_checks": final_inventory.manual_checks,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cleanup.py",
        description="Safely probe, scan, plan, delete, and verify one AWS member account.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe = subparsers.add_parser("probe", help="Read-only credential-path probe for one or more member accounts")
    probe.add_argument("ids", nargs="+", metavar="ACCOUNT_ID", help="12-digit member account ID")

    for command, help_text in (
        ("scan", "Read-only all-region inventory and month-to-date cost summary"),
        ("plan", "Read-only deletion plan with dependencies and manual items"),
        ("verify", "Independent read-only all-region residual-resource verification"),
    ):
        child = subparsers.add_parser(command, help=help_text)
        child.add_argument("id", metavar="ACCOUNT_ID", help="12-digit member account ID")

    nuke = subparsers.add_parser("nuke", help="Delete resources in exactly one confirmed member account")
    nuke.add_argument("id", metavar="ACCOUNT_ID", help="12-digit member account ID")
    nuke.add_argument("--confirm", required=True, metavar="ACCOUNT_ID", help="Must exactly repeat the target account ID")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        validate_runtime()
        config, records, restricted = load_state()
        manager = CredentialManager(config, records, restricted)
        if args.command == "probe":
            payload = command_probe(manager, config, args.ids)
        elif args.command == "scan":
            payload = command_scan(manager, config, args.id)
        elif args.command == "plan":
            payload = command_plan(manager, config, args.id)
        elif args.command == "verify":
            payload = command_verify(manager, config, args.id)
        elif args.command == "nuke":
            payload = command_nuke(manager, config, args.id, args.confirm)
        else:  # argparse keeps this unreachable
            raise CleanupError("Unknown command")
        emit({"ok": True, **payload})
        if args.command == "verify" and not payload.get("clean"):
            return 2
        if args.command == "nuke" and not payload.get("complete"):
            return 2
        return 0
    except CleanupError as exc:
        emit({"ok": False, "error": {"category": "safety_or_configuration", "code": exc.__class__.__name__, "message": safe_error_message(exc)}})
        return 2
    except KeyboardInterrupt:
        emit({"ok": False, "error": {"category": "interrupted", "code": "KeyboardInterrupt", "message": "Operation interrupted; run verify before retrying"}})
        return 130
    except (ClientError, BotoCoreError) as exc:
        emit({"ok": False, "error": {"category": classify_error(exc), "code": error_code(exc), "message": safe_error_message(exc)}})
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
