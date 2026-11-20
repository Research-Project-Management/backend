import { Logger } from '@nestjs/common';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { RealtimeConfigService } from '../../core/realtime.config';
import { RealtimeException } from '../../core/ws-errors';
import { YjsUpdateValidator } from './yjs-update.validator';
import type { ActiveDocSession, SyncMessageResult } from './yjs.types';

export class YjsSyncProtocol {
  constructor(
    private readonly validator: YjsUpdateValidator,
    private readonly logger: Logger,
    private readonly config?: RealtimeConfigService,
  ) {}

  public normalizeToUint8Array(data: unknown): Uint8Array {
    return this.validator.validateSyncPayload(
      data,
      this.config?.getMaxYjsUpdateSizeBytes() ?? 512 * 1024,
    );
  }

  public assertPostApplySizeBeforeMutation(
    session: ActiveDocSession,
    applyAction: (targetDoc: Y.Doc) => void,
    incomingBytes = 0,
  ): void {
    const doc = session.doc;
    const maxDocSize =
      this.config?.getMaxDocumentSizeBytes() ?? 20 * 1024 * 1024;
    let approxChars = 0;
    for (const item of doc.share.values()) {
      const anyItem = item as unknown as { length?: number };
      if (typeof anyItem?.length === 'number') {
        approxChars += anyItem.length;
      }
    }
    const approxCumulative = (session.approxEncodedBytes ?? 0) + incomingBytes;
    if (
      maxDocSize <= 1024 ||
      approxChars * 4 + approxCumulative > maxDocSize / 2
    ) {
      const tempDoc = new Y.Doc();
      tempDoc.getText('latex');
      Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(doc));
      applyAction(tempDoc);
      this.validator.validatePostApplySize(
        tempDoc,
        maxDocSize,
        approxCumulative,
      );
      tempDoc.destroy();
    }
  }

  public handleSyncMessage(
    session: ActiveDocSession,
    projectId: string,
    docId: string,
    data: unknown,
    origin: string,
  ): SyncMessageResult {
    const rawBytes = this.normalizeToUint8Array(data);
    if (!rawBytes || rawBytes.length === 0) {
      return { reply: null, broadcastUpdate: null };
    }

    try {
      const peekDec = decoding.createDecoder(rawBytes);
      const peekMsgType = decoding.readVarUint(peekDec);
      if (
        peekMsgType === syncProtocol.messageYjsUpdate ||
        peekMsgType === syncProtocol.messageYjsSyncStep2
      ) {
        this.validator.validatePreApplySize(
          session.doc,
          rawBytes.byteLength,
          this.config?.getMaxDocumentSizeBytes(),
        );
        this.assertPostApplySizeBeforeMutation(
          session,
          (tempDoc) => {
            const tempDec = decoding.createDecoder(rawBytes);
            const tempEnc = encoding.createEncoder();
            syncProtocol.readSyncMessage(tempDec, tempEnc, tempDoc, origin);
          },
          rawBytes.byteLength,
        );
      }

      const decoder = decoding.createDecoder(rawBytes);
      const encoder = encoding.createEncoder();
      const msgType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        session.doc,
        origin,
      );

      let reply: Buffer | null = null;
      if (encoding.length(encoder) > 0) {
        reply = Buffer.from(encoding.toUint8Array(encoder));
      }

      let broadcastUpdate: Buffer | null = null;
      if (
        msgType === syncProtocol.messageYjsUpdate ||
        msgType === syncProtocol.messageYjsSyncStep2
      ) {
        session.approxEncodedBytes =
          (session.approxEncodedBytes ?? 0) + rawBytes.byteLength;
        this.validator.validatePostApplySize(
          session.doc,
          this.config?.getMaxDocumentSizeBytes(),
          session.approxEncodedBytes,
        );
        const updateEncoder = encoding.createEncoder();
        const rawUpdate = this.extractRawUpdateIfPresent(rawBytes, msgType);
        if (rawUpdate) {
          syncProtocol.writeUpdate(updateEncoder, rawUpdate);
          broadcastUpdate = Buffer.from(encoding.toUint8Array(updateEncoder));
        }
      }

      return { reply, broadcastUpdate, msgType };
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
      this.logger.warn(
        `Failed to decode or process sync message for ${projectId}:${docId}: ${(err as Error)?.message}`,
      );
      return { reply: null, broadcastUpdate: null };
    }
  }

  public handleSyncStep1(
    session: ActiveDocSession,
    stateVector: unknown,
  ): Buffer {
    const rawVector = this.normalizeToUint8Array(stateVector);
    try {
      let stateVectorToUse = rawVector;
      try {
        const dec = decoding.createDecoder(rawVector);
        const msgType = decoding.readVarUint(dec);
        if (msgType === syncProtocol.messageYjsSyncStep1) {
          stateVectorToUse = decoding.readVarUint8Array(dec);
        }
      } catch {
        // Direct raw state vector
      }

      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep2(encoder, session.doc, stateVectorToUse);
      syncProtocol.writeSyncStep1(encoder, session.doc);
      return Buffer.from(encoding.toUint8Array(encoder));
    } catch (err: unknown) {
      this.logger.warn(`handleSyncStep1 error: ${(err as Error)?.message}`);
      return Buffer.alloc(0);
    }
  }

  public handleSyncStep2(
    session: ActiveDocSession,
    update: unknown,
    origin: string,
  ): void {
    const rawUpdate = this.normalizeToUint8Array(update);
    if (!rawUpdate || rawUpdate.length === 0) return;

    this.validator.validatePreApplySize(
      session.doc,
      rawUpdate.byteLength,
      this.config?.getMaxDocumentSizeBytes(),
    );

    try {
      const dec = decoding.createDecoder(rawUpdate);
      const msgType = decoding.readVarUint(dec);
      if (
        msgType === syncProtocol.messageYjsSyncStep2 ||
        msgType === syncProtocol.messageYjsUpdate
      ) {
        const innerUpdate = decoding.readVarUint8Array(dec);
        this.assertPostApplySizeBeforeMutation(session, (tempDoc) => {
          Y.applyUpdate(tempDoc, innerUpdate, origin);
        });
        Y.applyUpdate(session.doc, innerUpdate, origin);
        this.validator.validatePostApplySize(
          session.doc,
          this.config?.getMaxDocumentSizeBytes(),
        );
        return;
      }
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
    }

    try {
      this.assertPostApplySizeBeforeMutation(session, (tempDoc) => {
        Y.applyUpdate(tempDoc, rawUpdate, origin);
      });
      Y.applyUpdate(session.doc, rawUpdate, origin);
      this.validator.validatePostApplySize(
        session.doc,
        this.config?.getMaxDocumentSizeBytes(),
      );
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
      this.logger.warn(`handleSyncStep2 error: ${(err as Error)?.message}`);
    }
  }

  public handleSyncUpdate(
    session: ActiveDocSession,
    update: unknown,
    origin: string,
  ): Buffer {
    const rawBytes = this.normalizeToUint8Array(update);
    if (!rawBytes || rawBytes.length === 0) return Buffer.alloc(0);

    this.validator.validatePreApplySize(
      session.doc,
      rawBytes.byteLength,
      this.config?.getMaxDocumentSizeBytes(),
    );

    try {
      let updateToApply: Uint8Array = rawBytes;
      try {
        const dec = decoding.createDecoder(rawBytes);
        const msgType = decoding.readVarUint(dec);
        if (
          msgType === syncProtocol.messageYjsUpdate ||
          msgType === syncProtocol.messageYjsSyncStep2
        ) {
          const candidate = decoding.readVarUint8Array(dec);
          if (dec.pos === rawBytes.length) {
            updateToApply = candidate;
          }
        }
      } catch {
        // Direct update bytes
      }

      this.assertPostApplySizeBeforeMutation(session, (tempDoc) => {
        try {
          Y.applyUpdate(tempDoc, updateToApply, origin);
        } catch (applyErr) {
          if (updateToApply !== rawBytes) {
            Y.applyUpdate(tempDoc, rawBytes, origin);
          } else {
            throw applyErr;
          }
        }
      });

      try {
        Y.applyUpdate(session.doc, updateToApply, origin);
      } catch (applyErr) {
        if (updateToApply !== rawBytes) {
          Y.applyUpdate(session.doc, rawBytes, origin);
          updateToApply = rawBytes;
        } else {
          throw applyErr;
        }
      }

      this.validator.validatePostApplySize(
        session.doc,
        this.config?.getMaxDocumentSizeBytes(),
      );

      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, updateToApply);
      return Buffer.from(encoding.toUint8Array(encoder));
    } catch (err: unknown) {
      if (err instanceof RealtimeException) {
        throw err;
      }
      this.logger.warn(`handleSyncUpdate error: ${(err as Error)?.message}`);
      return Buffer.alloc(0);
    }
  }

  private extractRawUpdateIfPresent(
    rawBytes: Uint8Array,
    msgType: number,
  ): Uint8Array | null {
    try {
      const dec = decoding.createDecoder(rawBytes);
      const readType = decoding.readVarUint(dec);
      if (readType === msgType) {
        return decoding.readVarUint8Array(dec);
      }
    } catch {
      // Fallback
    }
    return null;
  }
}
