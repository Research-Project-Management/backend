import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  PageDomainEventBus,
  getRecordSpaceId,
} from '@/modules/pages/core';
import { DocstoreService, ScopeRepository } from '@/modules/pages/docstore';
import { PageService } from '@/modules/pages/page';
import { TrackChange } from '../domain/change.domain';
import { LinePatcher, PatchResult } from '../domain/patcher.domain';
import { PatchConflictError } from '../domain/review.errors';

export interface DocPatchOutcome {
  lines: string[];
  version: number;
  rev: number;
  spaceId: string;
}

@Injectable()
export class DocPatcher {
  private readonly liveCollab: LiveCollaborationPort;

  constructor(
    private readonly docstoreService: DocstoreService,
    @Optional() private readonly pageService?: PageService,
    @Optional() private readonly scopeRepo?: ScopeRepository,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() private readonly domainEventBus?: PageDomainEventBus,
  ) {
    this.liveCollab =
      liveCollab && typeof liveCollab.flushDocs === 'function'
        ? liveCollab
        : NOOP_LIVE_COLLABORATION;
  }

  private isConflictError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const candidate = err as {
      status?: number;
      statusCode?: number;
      name?: string;
    };
    return (
      candidate.status === 409 ||
      candidate.statusCode === 409 ||
      candidate.name === 'ConflictException' ||
      candidate.name === 'DocRevisionConflictException' ||
      candidate.name === 'DocModifiedError'
    );
  }

  public async patchDoc(
    spaceId: string,
    docId: string,
    computePatch: (currentLines: readonly string[]) => PatchResult,
  ): Promise<DocPatchOutcome | null> {
    await this.liveCollab.flushDocs(spaceId, [docId]).catch(() => []);

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let targetDocId = docId;
      let docSpaceId = spaceId;
      let currentLines: string[] = [];
      let currentVersion = 0;
      let currentRev = 0;

      if (this.scopeRepo) {
        const record = await this.scopeRepo.findDocInProject(spaceId, docId);
        if (!record) return null;
        targetDocId = record.id;
        docSpaceId = getRecordSpaceId(record) || spaceId;
        currentLines = this.pageService
          ? await this.pageService.getHydratedDocLines(record)
          : Array.isArray(record.lines)
            ? (record.lines as string[])
            : [];
        currentVersion = record.version ?? 0;
        currentRev = record.rev ?? 0;
      } else {
        const doc = await this.docstoreService.getDoc(spaceId, docId);
        docSpaceId = doc.projectId || spaceId;
        currentLines = doc.lines || [''];
        currentVersion = doc.version ?? 0;
        currentRev = doc.rev ?? 0;
      }

      const { lines: nextLines, mutated } = computePatch(currentLines);
      if (!mutated) {
        return {
          lines: nextLines,
          version: currentVersion,
          rev: currentRev,
          spaceId: docSpaceId,
        };
      }

      try {
        const updateRes = await this.docstoreService.updateDoc(
          docSpaceId,
          targetDocId,
          {
            lines: nextLines,
            version: currentVersion + 1,
            expectedRev: currentRev,
          },
        );
        const finalVersion = updateRes?.doc?.version ?? currentVersion + 1;
        const finalRev =
          updateRes?.rev ?? updateRes?.doc?.rev ?? currentRev + 1;
        const persistedLines = updateRes?.doc?.lines ?? nextLines;

        if (this.domainEventBus) {
          await this.domainEventBus.publish({
            type: 'manuscript.document.mutated',
            projectId: docSpaceId,
            docId: targetDocId,
            lines: persistedLines,
            rev: finalRev,
            version: finalVersion,
            source: 'track-changes',
            occurredAt: Date.now(),
          });
        } else {
          await this.liveCollab
            .applyExternalText(
              docSpaceId,
              targetDocId,
              persistedLines.join('\n'),
            )
            .catch(() => false);
        }

        return {
          lines: persistedLines,
          version: finalVersion,
          rev: finalRev,
          spaceId: docSpaceId,
        };
      } catch (err: unknown) {
        if (this.isConflictError(err) && attempt < maxAttempts - 1) {
          continue;
        }
        throw err;
      }
    }

    throw new PatchConflictError(docId);
  }

  public applyChange(
    spaceId: string,
    docId: string,
    change: TrackChange,
  ): Promise<DocPatchOutcome | null> {
    return this.patchDoc(spaceId, docId, (lines) =>
      LinePatcher.computeAcceptedPatch(lines, change),
    );
  }

  public revertChange(
    spaceId: string,
    docId: string,
    change: TrackChange,
  ): Promise<DocPatchOutcome | null> {
    return this.patchDoc(spaceId, docId, (lines) =>
      LinePatcher.computeRejectedPatch(lines, change),
    );
  }

  public applyBatch(
    spaceId: string,
    docId: string,
    changes: TrackChange[],
    isAccept: boolean,
  ): Promise<DocPatchOutcome | null> {
    if (changes.length === 0) return Promise.resolve(null);
    return this.patchDoc(spaceId, docId, (initialLines) => {
      let lines = [...initialLines];
      let mutated = false;
      for (const change of changes) {
        const res = isAccept
          ? LinePatcher.computeAcceptedPatch(lines, change)
          : LinePatcher.computeRejectedPatch(lines, change);
        lines = res.lines;
        if (res.mutated) mutated = true;
      }
      return { lines, mutated };
    });
  }
}
