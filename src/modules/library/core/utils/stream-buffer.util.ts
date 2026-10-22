/**
 * Safe stream buffer reader with backpressure and size guards.
 * Prevents OS process OOM (Out Of Memory) from malicious or oversized HTTP payloads.
 */
export const MAX_SAFE_HTTP_PAYLOAD_BYTES = 100 * 1024 * 1024; // 100 MB upper limit

export class PayloadTooLargeException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeException';
  }
}

export async function readSafeResponseBuffer(
  response: Response,
  maxBytes = MAX_SAFE_HTTP_PAYLOAD_BYTES,
): Promise<Buffer> {
  const contentLengthHeader = response.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declaredLength = parseInt(contentLengthHeader, 10);
    if (!isNaN(declaredLength) && declaredLength > maxBytes) {
      throw new PayloadTooLargeException(
        `Payload size (${(declaredLength / (1024 * 1024)).toFixed(1)} MB) exceeds safe OS limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`,
      );
    }
  }

  // Streaming reader with backpressure if ReadableStream body exists
  if (response.body && typeof (response.body as any).getReader === 'function') {
    const reader = (response.body as any).getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.length;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new PayloadTooLargeException(
              `Stream exceeded safe OS payload limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      if (typeof reader.releaseLock === 'function') {
        reader.releaseLock();
      }
    }

    return Buffer.concat(chunks, totalBytes);
  }

  // Fallback for mocked fetch / in-memory responses
  const arrayBuf = await response.arrayBuffer();
  if (arrayBuf.byteLength > maxBytes) {
    throw new PayloadTooLargeException(
      `Response buffer (${(arrayBuf.byteLength / (1024 * 1024)).toFixed(1)} MB) exceeds safe OS limit of ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`,
    );
  }
  return Buffer.from(arrayBuf);
}
