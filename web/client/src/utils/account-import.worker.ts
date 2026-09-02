import { Unzip, UnzipInflate } from 'fflate';
import readXlsxFile from 'read-excel-file/browser';
import { ACCOUNT_IMPORT_LIMITS } from './account-import-config';
import type { AccountWorkbookScanResult } from './account-import';

interface AccountImportWorkerScope {
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  postMessage(message: unknown): void;
}

const workerScope = self as unknown as AccountImportWorkerScope;

function verifyActualUncompressedSizes(buffer: ArrayBuffer): void {
  let totalUncompressedBytes = 0;
  const unzipper = new Unzip(file => {
    let entryUncompressedBytes = 0;
    file.ondata = (error, chunk) => {
      if (error) throw error;
      entryUncompressedBytes += chunk.byteLength;
      totalUncompressedBytes += chunk.byteLength;
      if (entryUncompressedBytes > ACCOUNT_IMPORT_LIMITS.maxEntryUncompressedBytes) {
        throw new Error('Excel 内单个工作表或资源实际解压后超过 12 MB，请拆分文件');
      }
      if (totalUncompressedBytes > ACCOUNT_IMPORT_LIMITS.maxTotalUncompressedBytes) {
        throw new Error('Excel 实际解压后内容超过 24 MB，请拆分文件');
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  unzipper.push(new Uint8Array(buffer), true);
}

function extractAccountIds(cell: unknown): string[] {
  if (typeof cell === 'number') {
    return Number.isSafeInteger(cell) && /^\d{12}$/.test(String(cell)) ? [String(cell)] : [];
  }
  if (typeof cell !== 'string') return [];

  const ids: string[] = [];
  const pattern = /(?:^|\D)(\d{12})(?!\d)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cell)) !== null) ids.push(match[1]);
  return ids;
}

workerScope.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    verifyActualUncompressedSizes(event.data);
    const sheets = await readXlsxFile(event.data);
    const uniqueAccountIds = new Set<string>();
    let occurrenceCount = 0;
    let scannedCellCount = 0;

    for (const sheet of sheets) {
      for (const row of sheet.data) {
        scannedCellCount += row.length;
        if (scannedCellCount > ACCOUNT_IMPORT_LIMITS.maxCellCount) {
          throw new Error('Excel 内容超过 50,000 个单元格，请拆分文件后重试');
        }
        for (const cell of row) {
          for (const accountId of extractAccountIds(cell)) {
            occurrenceCount += 1;
            uniqueAccountIds.add(accountId);
          }
        }
      }
    }

    const result: AccountWorkbookScanResult = {
      accountIds: [...uniqueAccountIds],
      duplicateCount: Math.max(0, occurrenceCount - uniqueAccountIds.size),
      scannedCellCount,
      sheetCount: sheets.length,
    };
    workerScope.postMessage({ ok: true, result });
  } catch (error: unknown) {
    workerScope.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Excel 识别失败，请检查文件格式',
    });
  }
};

export {};
