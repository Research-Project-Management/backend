/**
 * realtime/core/ports/document-updater-bridge.port.ts
 * Outbound Port (SPI) for forwarding client keystrokes and line splices into DocumentUpdater In-Flight buffer.
 */

import { ClientUpdatePayloadVo } from '../domain/value-objects/client-update-payload.vo';

export interface BridgeUpdateResult {
  serverRev: number;
  clientRev: number;
  version: number;
  inFlightSeq: number;
}

export abstract class IDocumentUpdaterBridgePort {
  /**
   * Forwards client edit operations to DocumentUpdaterService.queueUpdate().
   */
  abstract forwardUpdate(payload: ClientUpdatePayloadVo): Promise<BridgeUpdateResult>;
}
