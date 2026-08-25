import { Injectable, NotFoundException } from '@nestjs/common';
import { CatalogRepository } from '../../catalog/catalog.repository';
import { CatalogExtraStore } from '../../catalog/catalog-extra.store';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
} from '../dto/attachments.dto';
import { PdfAnnotation, ExtractedLiteratureNote } from './annotations.types';
import { randomUUID } from 'crypto';

@Injectable()
export class AnnotationsService {
  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly extraStore: CatalogExtraStore,
  ) {}

  /**
   * Get all PDF annotations for a catalog item.
   */
  async getAnnotations(
    workspaceId: string,
    itemId: string,
  ): Promise<{ annotations: PdfAnnotation[]; total: number }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const annotations = await this.extraStore.getAnnotations(item.id);
    return { annotations, total: annotations.length };
  }

  /**
   * Create a new PDF highlight / note / box annotation (concurrency-safe).
   */
  async createAnnotation(
    workspaceId: string,
    itemId: string,
    userId: string,
    dto: CreateAnnotationDto,
  ): Promise<{ annotation: PdfAnnotation }> {
    const item = await this.resolveItem(workspaceId, itemId);
    const now = new Date().toISOString();

    const annotation: PdfAnnotation = {
      id: randomUUID(),
      paperId: item.id,
      attachmentId: dto.attachmentId,
      type: dto.type,
      pageNumber: dto.pageNumber,
      color: dto.color,
      quote: dto.quote || undefined,
      comment: dto.comment || undefined,
      rect: dto.rect || undefined,
      authorId: userId,
      createdAt: now,
      updatedAt: now,
    };

    await this.extraStore.putAnnotation(item.id, annotation);
    return { annotation };
  }

  /**
   * Update an annotation's comment or color (concurrency-safe).
   */
  async updateAnnotation(
    workspaceId: string,
    itemId: string,
    annotationId: string,
    dto: UpdateAnnotationDto,
  ): Promise<{ annotation: PdfAnnotation }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const updated = await this.extraStore.replaceAnnotation(
      item.id,
      annotationId,
      {
        ...(dto.comment !== undefined && { comment: dto.comment }),
        ...(dto.color !== undefined && { color: dto.color }),
        updatedAt: new Date().toISOString(),
      },
    );

    if (!updated) {
      throw new NotFoundException('Annotation not found');
    }

    return { annotation: updated };
  }

  /**
   * Delete an annotation (concurrency-safe).
   */
  async deleteAnnotation(
    workspaceId: string,
    itemId: string,
    annotationId: string,
  ): Promise<{ deleted: boolean; remainingCount: number }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const remaining = await this.extraStore.removeAnnotation(
      item.id,
      annotationId,
    );

    if (remaining === -1) {
      throw new NotFoundException('Annotation not found');
    }

    return { deleted: true, remainingCount: remaining };
  }

  /**
   * Zotero 7 Parity: "Add Note from Annotations".
   * Synthesises all highlights, underlines, and comments into an organised
   * Markdown Literature Note and appends it to item notes.
   */
  async extractNotesFromAnnotations(
    workspaceId: string,
    itemId: string,
    _userId: string,
  ): Promise<{ literatureNote: ExtractedLiteratureNote }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const annotations = await this.extraStore.getAnnotations(item.id);
    if (annotations.length === 0) {
      throw new NotFoundException(
        'No annotations found on this catalog item to extract',
      );
    }

    // Sort by page ascending, then group by page
    const sorted = [...annotations].sort((a, b) => a.pageNumber - b.pageNumber);
    const pageMap = new Map<number, PdfAnnotation[]>();
    for (const ann of sorted) {
      const list = pageMap.get(ann.pageNumber) || [];
      list.push(ann);
      pageMap.set(ann.pageNumber, list);
    }

    const lines: string[] = [];
    lines.push(`# 📖 Literature Notes: ${item.title}`);
    lines.push(
      `*Extracted on ${new Date().toLocaleDateString()} from ${sorted.length} annotations*\n`,
    );

    for (const [page, anns] of pageMap.entries()) {
      lines.push(`### 📄 Page ${page}`);
      for (const ann of anns) {
        if (ann.quote) {
          lines.push(`> "${ann.quote.trim()}" *(p. ${ann.pageNumber})*`);
        }
        if (ann.comment) {
          lines.push(`**Note**: ${ann.comment.trim()}\n`);
        } else {
          lines.push('');
        }
      }
    }

    const markdownContent = lines.join('\n');
    const noteTitle = `Annotations Summary (${new Date().toLocaleDateString()})`;

    const existingNotes = this.parseStoredNotes(item.notes);
    existingNotes.push({ title: noteTitle, content: markdownContent });

    await this.catalogRepo.updateItem(item.id, { notes: existingNotes });

    return {
      literatureNote: {
        title: noteTitle,
        content: markdownContent,
        annotationCount: sorted.length,
        createdAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Alias for extractNotesFromAnnotations
   */
  async extractLiteratureNotes(
    workspaceId: string,
    itemId: string,
    userId: string = 'system',
  ) {
    return this.extractNotesFromAnnotations(workspaceId, itemId, userId);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async resolveItem(workspaceId: string, itemId: string) {
    const targetWsId = await this.catalogRepo.resolveWorkspaceId(workspaceId);

    const item = await this.catalogRepo.findItemByIdInWorkspace(
      targetWsId,
      itemId,
    );
    if (!item || item.deletedAt) {
      throw new NotFoundException('Catalog item not found in this workspace');
    }
    return item;
  }

  private parseStoredNotes(
    notes: unknown,
  ): Array<{ title: string; content: string }> {
    if (!Array.isArray(notes)) return [];

    return notes.flatMap((note) => {
      const record = this.toRecord(note);
      if (!record) return [];

      const title = record.title;
      const content = record.content;

      if (typeof title === 'string' && typeof content === 'string') {
        return [{ title, content }];
      }

      return [];
    });
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) return null;
    return value as Record<string, unknown>;
  }
}
