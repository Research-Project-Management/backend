/**
 * track-changes/core/adapters/external/docstore-patcher.adapter.ts
 * Driven Adapter implementing IDocstorePatcherPort to mutate text lines in DocstoreService upon accept/reject.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IDocstorePatcherPort, PatcherResult } from '../../ports/docstore-patcher.port';
import { TrackChange } from '../../domain/entities/track-change.entity';
import { TextRangeVo } from '../../domain/value-objects/text-range.vo';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';

@Injectable()
export class DocstorePatcherAdapter extends IDocstorePatcherPort {
  private readonly logger = new Logger(DocstorePatcherAdapter.name);

  constructor(private readonly docstoreService: DocstoreService) {
    super();
  }

  public async applyChange(
    projectId: string,
    docId: string,
    change: TrackChange,
  ): Promise<PatcherResult> {
    const doc = await this.docstoreService.getDoc(projectId, docId);
    let lines = [...doc.lines];

    if (change.type === 'insert') {
      // Inserted text is accepted: permanently kept as is
      return {
        lines,
        newRev: doc.rev,
      };
    }

    // Delete change accepted: purge the text span from document
    lines = this.removeRange(lines, change.range);
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
    let lines = [...doc.lines];

    if (change.type === 'insert') {
      // Insert change rejected: remove the inserted text span
      lines = this.removeRange(lines, change.range);
      const updated = await this.docstoreService.updateDoc(projectId, docId, {
        lines,
        version: doc.version,
      });
      return {
        lines: updated.doc.lines,
        newRev: updated.doc.rev,
      };
    }

    // Delete change rejected: restore the deleted text at range
    lines = this.insertRange(lines, change.range, change.text);
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
    const startLine = range.startLine;
    const endLine = range.endLine;
    const startCol = range.startCol;
    const endCol = range.endCol;

    if (startLine >= lines.length) return lines;

    if (startLine === endLine) {
      const line = lines[startLine];
      lines[startLine] = line.slice(0, startCol) + line.slice(endCol);
    } else {
      const first = (lines[startLine] || '').slice(0, startCol);
      const last = (lines[endLine] || '').slice(endCol);
      const merged = first + last;
      lines.splice(startLine, endLine - startLine + 1, merged);
    }

    return lines;
  }

  public insertRange(lines: string[], range: TextRangeVo, textToInsert: string): string[] {
    const startLine = range.startLine;
    const startCol = range.startCol;

    while (startLine >= lines.length) {
      lines.push('');
    }

    const currentLine = lines[startLine];
    const prefix = currentLine.slice(0, startCol);
    const suffix = currentLine.slice(startCol);

    if (!textToInsert.includes('\n')) {
      lines[startLine] = prefix + textToInsert + suffix;
    } else {
      const insertedLines = textToInsert.split('\n');
      const newFirstLine = prefix + insertedLines[0];
      const newLastLine = insertedLines[insertedLines.length - 1] + suffix;
      const middleLines = insertedLines.slice(1, -1);
      lines.splice(startLine, 1, newFirstLine, ...middleLines, newLastLine);
    }

    return lines;
  }
}
