import { ACCOUNT_IMPORT_LIMITS } from './account-import-config';

const {
  maxFileSizeBytes: MAX_XLSX_FILE_SIZE_BYTES,
  maxArchiveEntryCount: MAX_XLSX_ENTRY_COUNT,
  maxEntryUncompressedBytes: MAX_XLSX_ENTRY_SIZE_BYTES,
  maxTotalUncompressedBytes: MAX_XLSX_UNCOMPRESSED_SIZE_BYTES,
  parseTimeoutMs: XLSX_PARSE_TIMEOUT_MS,
} = ACCOUNT_IMPORT_LIMITS;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

export interface AccountWorkbookScanResult {
  accountIds: string[];
  duplicateCount: number;
  scannedCellCount: number;
  sheetCount: number;
}

interface AccountWorkbookWorkerResponse {
  ok: boolean;
  result?: AccountWorkbookScanResult;
  error?: string;
}

function validateXlsxArchive(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;

  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Excel 文件不是有效的 .xlsx 压缩包');

  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralDirectorySize = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error('不支持分卷 Excel 文件');
  }
  if (totalEntries === ZIP64_SENTINEL_16
    || centralDirectorySize === ZIP64_SENTINEL_32
    || centralDirectoryOffset === ZIP64_SENTINEL_32) {
    throw new Error('Excel 文件结构过大，请拆分后重试');
  }
  if (totalEntries === 0 || totalEntries > MAX_XLSX_ENTRY_COUNT) {
    throw new Error(`Excel 压缩包文件项数量必须在 1–${MAX_XLSX_ENTRY_COUNT} 之间`);
  }
  if (centralDirectoryOffset + centralDirectorySize > endOffset) {
    throw new Error('Excel 压缩包目录损坏');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entryNames = new Set<string>();
  let totalUncompressedSize = 0;
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new Error('Excel 压缩包目录项损坏');
    }

    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nextOffset = offset + 46 + fileNameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0) throw new Error('不支持加密的 Excel 文件');
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32) {
      throw new Error('Excel 文件结构过大，请拆分后重试');
    }
    if (nextOffset > endOffset) throw new Error('Excel 压缩包目录项越界');
    if (uncompressedSize > MAX_XLSX_ENTRY_SIZE_BYTES) {
      throw new Error('Excel 内单个工作表或资源解压后超过 12 MB，请拆分文件');
    }

    totalUncompressedSize += uncompressedSize;
    if (totalUncompressedSize > MAX_XLSX_UNCOMPRESSED_SIZE_BYTES) {
      throw new Error('Excel 解压后内容超过 24 MB，请拆分文件');
    }

    entryNames.add(decoder.decode(bytes.subarray(offset + 46, offset + 46 + fileNameLength)));
    offset = nextOffset;
  }

  if (offset > centralDirectoryOffset + centralDirectorySize
    || !entryNames.has('[Content_Types].xml')
    || !entryNames.has('xl/workbook.xml')) {
    throw new Error('文件缺少必要的 Excel 工作簿结构');
  }
}

function parseWorkbookInWorker(buffer: ArrayBuffer): Promise<AccountWorkbookScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./account-import.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error('Excel 解析超过 20 秒，已终止；请精简文件后重试'));
    }, XLSX_PARSE_TIMEOUT_MS);

    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<AccountWorkbookWorkerResponse>) => {
      if (settled) return;
      settled = true;
      finish();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error || 'Excel 识别失败，请检查文件格式'));
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      finish();
      reject(new Error('Excel 解析进程异常，请检查文件格式'));
    };
    worker.postMessage(buffer, [buffer]);
  });
}

export async function scanAccountIdsFromXlsx(file: File): Promise<AccountWorkbookScanResult> {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    throw new Error('仅支持 .xlsx 格式的 Excel 文件');
  }
  if (file.size === 0) throw new Error('Excel 文件为空');
  if (file.size > MAX_XLSX_FILE_SIZE_BYTES) {
    throw new Error('Excel 文件不能超过 5 MB');
  }

  const buffer = await file.arrayBuffer();
  validateXlsxArchive(buffer);
  return parseWorkbookInWorker(buffer);
}
