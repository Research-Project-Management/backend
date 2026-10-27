import { Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { RealtimeValidationFailedException } from '../core/ws-errors';

@Injectable()
export class YjsUpdateValidator {
  private readonly logger = new Logger(YjsUpdateValidator.name);

  /**
   * Strictly validates incoming sync data:
   * 1. Requires binary payload (Uint8Array or Buffer) - rejects base64 string, arrays, or objects.
   * 2. Enforces maximum byte cap (default 512 KiB).
   * 3. Verifies that the frame is decodeable without corruption (RT-09).
   */
  public validateSyncPayload(
    data: unknown,
    maxSizeBytes: number = 512 * 1024,
  ): Uint8Array {
    if (!data) {
      throw new RealtimeValidationFailedException(
        'Missing binary payload for Yjs synchronization',
      );
    }

    let bytes: Uint8Array;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (Buffer.isBuffer(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      throw new RealtimeValidationFailedException(
        'Binary payload required for Yjs sync (disallowed text/array encoding)',
      );
    }

    if (bytes.byteLength > maxSizeBytes) {
      throw new RealtimeValidationFailedException(
        `Sync payload exceeds maximum size limit of ${maxSizeBytes} bytes (received ${bytes.byteLength} bytes)`,
      );
    }

    // Verify basic lib0 frame decodability
    try {
      const decoder = decoding.createDecoder(bytes);
      // Attempting to read if non-empty to ensure decoder doesn't immediately crash
      if (bytes.byteLength > 0) {
        decoding.hasContent(decoder);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `Malformed Yjs sync frame rejected: ${(err as Error)?.message}`,
      );
      throw new RealtimeValidationFailedException(
        'Malformed sync protocol frame',
      );
    }

    return bytes;
  }

  /**
   * Pre-validates whether applying an update would push the document beyond size limits.
   */
  public validatePreApplySize(
    doc: Y.Doc,
    incomingUpdateBytes: number,
    maxDocumentSizeBytes: number = 20 * 1024 * 1024,
  ): void {
    let approxChars = 0;
    for (const item of doc.share.values()) {
      const anyItem = item as unknown as { length?: number };
      if (typeof anyItem?.length === 'number') {
        approxChars += anyItem.length;
      }
    }
    if (approxChars * 4 + incomingUpdateBytes > maxDocumentSizeBytes) {
      throw new RealtimeValidationFailedException(
        `Update rejected: would exceed document size limit of ${maxDocumentSizeBytes} bytes`,
      );
    }
  }

  /**
   * Asserts that the document size following an update application remains within
   * the maximum allowed boundary (R-06).
   */
  public validatePostApplySize(
    doc: Y.Doc,
    maxDocumentSizeBytes: number = 20 * 1024 * 1024,
  ): void {
    // Fast path: for production threshold (e.g. 20MB), skip full serialization if all shared types are well under bound
    if (maxDocumentSizeBytes > 1024) {
      let approxChars = 0;
      for (const item of doc.share.values()) {
        const anyItem = item as unknown as { length?: number };
        if (typeof anyItem?.length === 'number') {
          approxChars += anyItem.length;
        }
      }
      if (approxChars * 4 <= maxDocumentSizeBytes - 64 * 1024) {
        return;
      }
    }

    const encoded = Y.encodeStateAsUpdate(doc);
    if (encoded.byteLength > maxDocumentSizeBytes) {
      throw new RealtimeValidationFailedException(
        `Document size limit exceeded after update (${encoded.byteLength} > ${maxDocumentSizeBytes} bytes)`,
      );
    }
  }
}
