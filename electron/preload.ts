import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('awsAPI', {
  // Credentials
  configureCredentials: (config: { accessKeyId: string; secretAccessKey: string; region: string; payers: { roleArn: string; name: string }[]; childRoleName?: string }) =>
    ipcRenderer.invoke('aws:configure-credentials', config),
  testConnection: () => ipcRenderer.invoke('aws:test-connection'),
  hasCredentials: () => ipcRenderer.invoke('aws:has-credentials'),
  getSavedConfig: () => ipcRenderer.invoke('aws:get-saved-config'),
  clearCredentials: () => ipcRenderer.invoke('aws:clear-credentials'),

  // Organizations
  listAccounts: (forceRefresh?: boolean) => ipcRenderer.invoke('aws:list-accounts', forceRefresh),
  getAccountInfo: (accountId: string) => ipcRenderer.invoke('aws:get-account-info', accountId),
  getAccountDetail: (accountId: string) => ipcRenderer.invoke('aws:get-account-detail', accountId),

  // Service Quotas
  listServiceQuotas: (accountId: string, serviceCode: string, region?: string) =>
    ipcRenderer.invoke('aws:list-service-quotas', accountId, serviceCode, region),
  requestQuotaIncrease: (accountId: string, serviceCode: string, quotaCode: string, desiredValue: number, quotaName?: string) =>
    ipcRenderer.invoke('aws:request-quota-increase', accountId, serviceCode, quotaCode, desiredValue, quotaName),
  listQuotaRequests: (accountId: string) =>
    ipcRenderer.invoke('aws:list-quota-requests', accountId),
  listAllQuotaRequests: (accountIds: string[]) =>
    ipcRenderer.invoke('aws:list-all-quota-requests', accountIds),
  getLocalQuotaRequests: () =>
    ipcRenderer.invoke('aws:get-local-quota-requests'),
  syncQuotaRequests: () =>
    ipcRenderer.invoke('aws:sync-quota-requests'),

  // Resource Cleanup
  scanResources: (accountId: string, region: string) =>
    ipcRenderer.invoke('aws:scan-resources', accountId, region),
  cleanupResources: (accountId: string, region: string, resources: { type: string; id: string }[]) =>
    ipcRenderer.invoke('aws:cleanup-resources', accountId, region, resources),

  // Billing
  getCostSummary: (startDate: string, endDate: string) =>
    ipcRenderer.invoke('aws:get-cost-summary', startDate, endDate),
  getCostByAccount: (startDate: string, endDate: string) =>
    ipcRenderer.invoke('aws:get-cost-by-account', startDate, endDate),
  getCostByService: (accountId: string, startDate: string, endDate: string) =>
    ipcRenderer.invoke('aws:get-cost-by-service', accountId, startDate, endDate),
});
