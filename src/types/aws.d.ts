export interface AwsAccount {
  Id: string;
  Name: string;
  Email: string;
  Status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_CLOSURE';
  JoinedMethod: 'INVITED' | 'CREATED';
  JoinedTimestamp: string;
  Arn: string;
}

export interface ServiceQuota {
  ServiceCode: string;
  ServiceName: string;
  QuotaCode: string;
  QuotaName: string;
  Value: number;
  Unit: string;
  Adjustable: boolean;
  GlobalQuota: boolean;
}

export interface QuotaChangeRequest {
  Id: string;
  ServiceCode: string;
  QuotaCode: string;
  QuotaName: string;
  DesiredValue: number;
  Status: 'PENDING' | 'CASE_OPENED' | 'APPROVED' | 'DENIED' | 'CASE_CLOSED';
  Created: string;
  _accountId?: string;
  QuotaValue?: number;
}

export interface LocalQuotaRequest {
  id: string;
  accountId: string;
  serviceCode: string;
  quotaCode: string;
  quotaName: string;
  desiredValue: number;
  status: string;
  currentValue: number | null;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScannedResource {
  type: string;
  id: string;
  name: string;
  arn: string;
  details: string;
}

export interface DeleteResult {
  id: string;
  success: boolean;
  error?: string;
}

export interface CostResult {
  TimePeriod: { Start: string; End: string };
  Groups: {
    Keys: string[];
    Metrics: { UnblendedCost: { Amount: string; Unit: string } };
  }[];
  Total?: { UnblendedCost: { Amount: string; Unit: string } };
}

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

export interface AccountDetail {
  cost: { total: number; period: string } | null;
  services: { name: string; cost: number }[];
  mfa: { root: boolean; users: { user: string; hasMFA: boolean }[] } | null;
  iamSummary: Record<string, number> | null;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  warning?: string;
}

declare global {
  interface Window {
    awsAPI: {
      configureCredentials: (config: { accessKeyId: string; secretAccessKey: string; region: string; payers: { roleArn: string; name: string }[]; childRoleName?: string }) => Promise<ApiResponse<void>>;
      testConnection: () => Promise<ApiResponse<CallerIdentity>>;
      hasCredentials: () => Promise<ApiResponse<boolean>>;
      getSavedConfig: () => Promise<ApiResponse<any>>;
      clearCredentials: () => Promise<ApiResponse<void>>;
      listAccounts: (forceRefresh?: boolean) => Promise<ApiResponse<AwsAccount[]>>;
      getAccountInfo: (accountId: string) => Promise<ApiResponse<AwsAccount>>;
      getAccountDetail: (accountId: string) => Promise<ApiResponse<AccountDetail>>;
      listServiceQuotas: (accountId: string, serviceCode: string, region?: string) => Promise<ApiResponse<ServiceQuota[]>>;
      requestQuotaIncrease: (accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, quotaName?: string) => Promise<ApiResponse<any>>;
      listQuotaRequests: (accountId: string) => Promise<ApiResponse<QuotaChangeRequest[]>>;
      listAllQuotaRequests: (accountIds: string[]) => Promise<ApiResponse<QuotaChangeRequest[]>>;
      getLocalQuotaRequests: () => Promise<ApiResponse<LocalQuotaRequest[]>>;
      syncQuotaRequests: () => Promise<ApiResponse<LocalQuotaRequest[]>>;
      scanResources: (accountId: string, region: string) => Promise<ApiResponse<ScannedResource[]>>;
      cleanupResources: (accountId: string, region: string, resources: { type: string; id: string }[]) => Promise<ApiResponse<DeleteResult[]>>;
      getCostSummary: (startDate: string, endDate: string) => Promise<ApiResponse<CostResult[]>>;
      getCostByAccount: (startDate: string, endDate: string) => Promise<ApiResponse<CostResult[]>>;
      getCostByService: (accountId: string, startDate: string, endDate: string) => Promise<ApiResponse<CostResult[]>>;
    };
  }
}
