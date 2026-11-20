/**
 * track-changes/adapters/track-changes.adapters.ts
 * Driven Cross-Context Adapters for Track Changes & Review Comment Threads:
 * - DocstorePatcherAdapter (Port: IDocstorePatcherPort)
 * - RealtimeNotifierAdapter (Port: IRealtimeNotifierPort)
 */

import { Injectable, Inject, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  LiveCollaborationPort,
  LIVE_COLLABORATION_PORT,
  NOOP_LIVE_COLLABORATION,
  PageDomainEventBus,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import {
  IDocstorePatcherPort,
  IRealtimeNotifierPort,
  PatcherResult,
  TrackChange,
  CommentThread,
  CommentReply,
  LinePatcher,
  LinePatchComputation,
  TrackChangePatchConflictException,
} from '../domain';

@Injectable()
export class DocstorePatcherAdapter extends IDocstorePatcherPort {
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollabOrLegacyRef?: LiveCollaborationPort | unknown,
    @Optional() private readonly domainEventBus?: PageDomainEventBus,
    @Optional()
    liveCollab?: LiveCollaborationPort,
  ) {
    super();
    const candidate = liveCollab ?? liveCollabOrLegacyRef;
    this.liveCollab =
      candidate &&
      typeof (candidate as LiveCollaborationPort).flushDocs === 'function'
        ? (candidate as LiveCollaborationPort)
        : NOOP_LIVE_COLLABORATION;
  }

  private getLiveCollab(): LiveCollaborationPort {
    return this.liveCollab;
  }

  /**
   * Template Method: Centralizes live-doc flushing, line-patch evaluation,
   * conditional DB persistence (preventing no-op version increments), and domain event propagation.
   */
  private async executeDocPatch(
    projectId: string,
    docId: string,
    computePatch: (currentLines: readonly string[]) => LinePatchComputation,
  ): Promise<PatcherResult> {
    const live = this.getLiveCollab();
    await live.flushDocs(projectId, [docId]).catch(() => []);

    const maxAttempts = 3;
    let updated: Awaited<ReturnType<DocstoreService['updateDoc']>> | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const doc = await this.docstoreService.getDoc(projectId, docId);
      const { lines, mutated } = computePatch(doc.lines);

      if (!mutated) {
        return {
          lines,
          newRev: doc.rev,
        };
      }

      try {
        updated = await this.docstoreService.updateDoc(projectId, docId, {
          lines,
          version: (doc.version ?? 0) + 1,
          expectedRev: doc.rev,
        });
        break;
      } catch (err: unknown) {
        const status = (err as { status?: number; statusCode?: number })
          ?.status;
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const name = (err as { name?: string })?.name;
        const isConflict =
          status === 409 ||
          statusCode === 409 ||
          name === 'ConflictException' ||
          name === 'DocRevisionConflictException' ||
          name === 'DocModifiedError';
        if (isConflict && attempt < maxAttempts - 1) {
          continue;
        }
        throw err;
      }
    }

    if (!updated) {
      throw new TrackChangePatchConflictException(docId);
    }

    if (this.domainEventBus) {
      await this.domainEventBus.publish({
        type: 'manuscript.document.mutated',
        projectId,
        docId,
        lines: updated.doc.lines || [''],
        rev: updated.doc.rev,
        version: updated.doc.version,
        source: 'track-changes',
        occurredAt: Date.now(),
      });
    } else {
      await live
        .applyExternalText(
          projectId,
          docId,
          (updated.doc.lines || ['']).join('\n'),
        )
        .catch(() => false);
    }

    return {
      lines: updated.doc.lines,
      newRev: updated.doc.rev,
    };
  }

  public async applyChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    return this.executeDocPatch(projectId, docId, (lines) =>
      LinePatcher.computeAcceptedPatch(lines, change),
    );
  }

  public async revertChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    return this.executeDocPatch(projectId, docId, (lines) =>
      LinePatcher.computeRejectedPatch(lines, change),
    );
  }

  public async applyBatchChanges(
    projectId: string,
    docId: string,
    changes: TrackChange[],
    isAccept: boolean,
  ): Promise<PatcherResult | null> {
    if (changes.length === 0) {
      return null;
    }

    return this.executeDocPatch(projectId, docId, (initialLines) => {
      let currentLines = [...initialLines];
      let anyMutated = false;

      for (const change of changes) {
        const res = isAccept
          ? LinePatcher.computeAcceptedPatch(currentLines, change)
          : LinePatcher.computeRejectedPatch(currentLines, change);
        currentLines = res.lines;
        if (res.mutated) anyMutated = true;
      }

      return { lines: currentLines, mutated: anyMutated };
    });
  }
}

@Injectable()
export class RealtimeNotifierAdapter extends IRealtimeNotifierPort {
  constructor(@Optional() private readonly eventEmitter?: EventEmitter2) {
    super();
  }

  private emitEvent(projectId: string, eventName: string, data: unknown): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit('manuscripts.track-changes.event', {
      projectId,
      eventName,
      data,
    });
  }

  public notifyChangeRecorded(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): void {
    this.emitEvent(projectId, 'track-changes:recorded', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyChangeResolved(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): void {
    this.emitEvent(projectId, 'track-changes:resolved', {
      docId,
      change: change.toJSON(),
    });
  }

  public notifyCommentCreated(
    projectId: string,
    docId: string,
    thread: CommentThread,
  ): void {
    this.emitEvent(projectId, 'comment:created', {
      docId,
      thread: thread.toJSON(),
    });
  }

  public notifyCommentReplied(
    projectId: string,
    docId: string,
    threadId: string,
    reply: CommentReply,
    _threadOwnerId?: string | null,
  ): void {
    this.emitEvent(projectId, 'comment:replied', {
      docId,
      threadId,
      reply: reply.toJSON(),
    });
  }

  public notifyCommentResolved(
    projectId: string,
    docId: string,
    thread: CommentThread,
  ): void {
    this.emitEvent(projectId, 'comment:resolved', {
      docId,
      thread: thread.toJSON(),
    });
  }
}
