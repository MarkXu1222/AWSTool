export const ACCOUNT_IMPORT_LIMITS = {
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxArchiveEntryCount: 1_000,
  maxEntryUncompressedBytes: 12 * 1024 * 1024,
  maxTotalUncompressedBytes: 24 * 1024 * 1024,
  maxCellCount: 50_000,
  parseTimeoutMs: 20_000,
} as const;
