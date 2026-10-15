/**
 * track-changes/core/adapters/external/docstore-patcher.adapter.ts
 * Driven Adapter implementing IDocstorePatcherPort by delegating pure line-splicing math
 * to LinePatcher in domain/line-patcher.ts and persisting updates to DocstoreService.
 */

import { Injectable } from '@nestjs/common';
import {
  IDocstorePatcherPort,
  PatcherResult,
} from '@/modules/manuscripts/track-changes/core/ports/docstore-patcher.port';
import { TrackChange } from '@/modules/manuscripts/track-changes/core/domain/entities/track-change.entity';
import { TextRangeVo } from '@/modules/manuscripts/track-changes/core/domain/value-objects/text-range.vo';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { LinePatcher } from '../../../domain/line-patcher';

@Injectable()
export class DocstorePatcherAdapter extends IDocstorePatcherPort {
  constructor(private readonly docstoreService: DocstoreService) {
    super();
  }

  public async applyChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    const doc = await this.docstoreService.getDoc(projectId, docId);
    const { lines, mutated } = LinePatcher.computeAcceptedPatch(
      doc.lines,
      change,
    );

    if (!mutated) {
      return {
        lines,
        newRev: doc.rev,
      };
    }

    const updated = await this.docstoreService.updateDoc(projectId, docId, {
      lines,
      version: doc.version,
    });

    return {
      lines: updated.doc.lines,
      newRev: updated.doc.rev,
    };
  }

  public async revertChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    const doc = await this.docstoreService.getDoc(projectId, docId);
    const { lines } = LinePatcher.computeRejectedPatch(doc.lines, change);

    const updated = await this.docstoreService.updateDoc(projectId, docId, {
      lines,
      version: doc.version,
    });

    return {
      lines: updated.doc.lines,
      newRev: updated.doc.rev,
    };
  }

  public removeRange(lines: string[], range: TextRangeVo): string[] {
    return LinePatcher.removeRange(lines, range);
  }

  public insertRange(
    lines: string[],
    range: TextRangeVo,
    textToInsert: string,
  ): string[] {
    return LinePatcher.insertRange(lines, range, textToInsert);
  }
}
