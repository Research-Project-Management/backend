import * as fs from 'fs/promises';

export const MAX_PARSE_LOG_BYTES = 1024 * 1024;
export const MAX_BIB_LOG_BYTES = 256 * 1024;
export const MAX_INLINE_LOG_BYTES = 256 * 1024;

export async function readBoundedLogFile(
  filePath: string,
  maxBytes: number = MAX_PARSE_LOG_BYTES,
  headBytes: number = Math.min(256 * 1024, Math.floor(maxBytes / 4)),
): Promise<{ content: string; sizeBytes: number; truncated: boolean } | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const sizeBytes = stat.size;
    if (sizeBytes === 0) {
      return { content: '', sizeBytes: 0, truncated: false };
    }
    if (sizeBytes <= maxBytes) {
      const buffer = await fs.readFile(filePath);
      return { content: buffer.toString('utf8'), sizeBytes, truncated: false };
    }

    const headSize = Math.min(headBytes, maxBytes);
    const tailSize = Math.max(0, maxBytes - headSize);
    const omittedBytes = Math.max(0, sizeBytes - headSize - tailSize);
    const handle = await fs.open(filePath, 'r');
    try {
      const head = Buffer.alloc(headSize);
      if (headSize > 0) {
        await handle.read(head, 0, headSize, 0);
      }
      const tail = Buffer.alloc(tailSize);
      if (tailSize > 0) {
        await handle.read(tail, 0, tailSize, sizeBytes - tailSize);
      }
      const marker = `\n... [truncated ${omittedBytes} bytes of ${sizeBytes}-byte log] ...\n`;
      return {
        content: `${head.toString('utf8')}${marker}${tail.toString('utf8')}`,
        sizeBytes,
        truncated: true,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function boundInlineLogText(
  rawText: string,
  totalFileSizeBytes?: number,
  maxBytes: number = MAX_INLINE_LOG_BYTES,
): { text: string; sizeBytes: number; truncated: boolean } {
  const byteLength = Buffer.byteLength(rawText || '', 'utf8');
  const sizeBytes = Math.max(byteLength, totalFileSizeBytes ?? 0);
  if (byteLength <= maxBytes) {
    return {
      text: rawText || '',
      sizeBytes,
      truncated: Boolean(totalFileSizeBytes && totalFileSizeBytes > byteLength),
    };
  }
  const buffer = Buffer.from(rawText, 'utf8');
  const headSize = Math.min(64 * 1024, Math.floor(maxBytes / 4));
  const tailSize = Math.max(0, maxBytes - headSize);
  const omittedBytes = Math.max(0, sizeBytes - headSize - tailSize);
  const marker = `\n... [truncated ${omittedBytes} bytes — download full output.log for complete details] ...\n`;
  return {
    text: `${buffer.subarray(0, headSize).toString('utf8')}${marker}${buffer.subarray(buffer.length - tailSize).toString('utf8')}`,
    sizeBytes,
    truncated: true,
  };
}
