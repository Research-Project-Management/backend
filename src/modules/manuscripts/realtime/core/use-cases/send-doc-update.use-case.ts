/**
 * realtime/core/use-cases/send-doc-update.use-case.ts
 * Inbound Use Case processing real-time keystroke updates and line splices.
 * Bridges immediately into DocumentUpdater write-behind buffer and broadcasts deltas to collaborators.
 */

import { Injectable } from '@nestjs/common';
import { IDocumentUpdaterBridgePort, BridgeUpdateResult } from '../ports/document-updater-bridge.port';
import { IRealtimeBroadcasterPort } from '../ports/realtime-broadcaster.port';
import { IProjectAccessVerifierPort } from '../ports/project-access-verifier.port';
import { ClientUpdatePayloadVo, LineSplice } from '../domain/value-objects/client-update-payload.vo';
import { UnauthorizedProjectException } from '../domain/exceptions/unauthorized-project.exception';

export interface SendDocUpdateInput {
  projectId: string;
  docId: string;
  socketId: string;
  userId: string;
  clientRev: number;
  lines?: string[] | null;
  splice?: LineSplice | null;
  debounceMs?: number;
}

@Injectable()
export class SendDocUpdateUseCase {
  constructor(
    private readonly updaterBridge: IDocumentUpdaterBridgePort,
    private readonly broadcaster: IRealtimeBroadcasterPort,
    private readonly accessVerifier: IProjectAccessVerifierPort,
  ) {}

  public async execute(input: SendDocUpdateInput): Promise<BridgeUpdateResult> {
    const { projectId, docId, socketId, userId, clientRev, lines, splice, debounceMs } = input;

    // 1. Verify user has write permissions
    const access = await this.accessVerifier.verifyProjectAccess(userId, projectId);
    if (!access.canWrite) {
      throw new UnauthorizedProjectException(userId, projectId);
    }

    // 2. Validate payload VO
    const payload = ClientUpdatePayloadVo.create({
      projectId,
      docId,
      clientRev,
      lines,
      splice,
      userId,
      debounceMs,
    });

    // 3. Forward to DocumentUpdater Write-Behind buffer
    const updateResult = await this.updaterBridge.forwardUpdate(payload);

    // 4. Broadcast delta to other collaborating peers in this doc
    this.broadcaster.broadcastToDoc(
      projectId,
      docId,
      'doc:update',
      {
        docId,
        clientRev: payload.clientRev,
        serverRev: updateResult.serverRev,
        version: updateResult.version,
        inFlightSeq: updateResult.inFlightSeq,
        lines: payload.lines,
        splice: payload.splice,
        userId,
      },
      socketId,
    );

    // 5. Send ACK with persistent server rev to sender socket
    this.broadcaster.sendToSocket(socketId, 'doc:update-ack', {
      docId,
      clientRev: payload.clientRev,
      serverRev: updateResult.serverRev,
      version: updateResult.version,
      inFlightSeq: updateResult.inFlightSeq,
    });

    return updateResult;
  }
}
