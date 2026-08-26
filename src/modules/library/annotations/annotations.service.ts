import { Injectable, NotFoundException } from '@nestjs/common';
import { ItemsRepository } from '../items/items.repository';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
} from './dto/annotations.dto';
import {
  PdfAnnotation,
  ExtractedLiteratureNote,
} from './types/annotations.types';
import { groupAnnotationsByPage } from './utils/annotations.util';

import { randomUUID } from 'crypto';

@Injectable()
export class AnnotationsService {
  constructor(private readonly itemsRepo: ItemsRepository) {}

  async getAnnotations(
    workspaceId: string,
    itemId: string,
  ): Promise<{ annotations: PdfAnnotation[]; total: number }> {
    const item = await this.resolveItem(workspaceId, itemId);
    const annotations = await this.itemsRepo.getAnnotations(item.id);
    return { annotations, total: annotations.length };
  }

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
      itemId: item.id,
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

    await this.itemsRepo.putAnnotation(item.id, annotation);
    return { annotation };
  }

  async updateAnnotation(
    workspaceId: string,
    itemId: string,
    annotationId: string,
    dto: UpdateAnnotationDto,
  ): Promise<{ annotation: PdfAnnotation }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const updated = await this.itemsRepo.replaceAnnotation(
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

  async deleteAnnotation(
    workspaceId: string,
    itemId: string,
    annotationId: string,
  ): Promise<{ deleted: boolean; remainingCount: number }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const remaining = await this.itemsRepo.removeAnnotation(
      item.id,
      annotationId,
    );

    if (remaining === -1) {
      throw new NotFoundException('Annotation not found');
    }

    return { deleted: true, remainingCount: remaining };
  }

  async extractNotesFromAnnotations(
    workspaceId: string,
    itemId: string,
    _userId: string,
  ): Promise<{ literatureNote: ExtractedLiteratureNote }> {
    const item = await this.resolveItem(workspaceId, itemId);

    const annotations = await this.itemsRepo.getAnnotations(item.id);
    if (annotations.length === 0) {
      throw new NotFoundException(
        'No annotations found on this catalog item to extract',
      );
    }

    const pageMap = groupAnnotationsByPage(annotations);

    const lines: string[] = [];
    lines.push(`# 📖 Literature Notes: ${item.title}`);
    lines.push(
      `*Extracted on ${new Date().toLocaleDateString()} from ${annotations.length} annotations*\n`,
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

    await this.itemsRepo.updateItem(item.id, { notes: existingNotes });

    return {
      literatureNote: {
        title: noteTitle,
        content: markdownContent,
        annotationCount: annotations.length,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async extractLiteratureNotes(
    workspaceId: string,
    itemId: string,
    userId: string = 'system',
  ) {
    return this.extractNotesFromAnnotations(workspaceId, itemId, userId);
  }

  private async resolveItem(workspaceId: string, itemId: string) {
    const targetWsId = await this.itemsRepo.resolveWorkspaceId(workspaceId);

    const item = await this.itemsRepo.findItemByIdInWorkspace(
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
