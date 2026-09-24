/**
 * realtime/core/adapters/external/document-updater-bridge.adapter.ts
 * Driven Adapter implementing IDocumentUpdaterBridgePort by calling DocumentUpdaterService.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  IDocumentUpdaterBridgePort,
  BridgeUpdateResult,
} from '../../ports/document-updater-bridge.port';
import { ClientUpdatePayloadVo } from '../../domain/value-objects/client-update-payload.vo';
import { DocumentUpdaterService } from '@/modules/manuscripts/document-updater/document-updater.service';

@Injectable()
export class DocumentUpdaterBridgeAdapter extends IDocumentUpdaterBridgePort {
  private readonly logger = new Logger(DocumentUpdaterBridgeAdapter.name);

  constructor(private readonly documentUpdaterService: DocumentUpdaterService) {
    super();
  }

  public async forwardUpdate(payload: ClientUpdatePayloadVo): Promise<BridgeUpdateResult> {
    const res = await this.documentUpdaterService.queueUpdate(
      payload.projectId,
      payload.docId,
      {
        lines: payload.lines || undefined,
        splice: payload.splice || undefined,
        clientRev: payload.clientRev,
        userId: payload.userId || undefined,
        debounceMs: payload.debounceMs,
      },
    );

    return {
      serverRev: res.rev,
      clientRev: payload.clientRev,
      version: res.inFlightSeq,
      inFlightSeq: res.inFlightSeq,
    };
  }
}
