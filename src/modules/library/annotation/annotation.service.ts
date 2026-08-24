import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PaperRepository } from '../paper/paper.repository';
import { CreateAnnotationDto, UpdateAnnotationDto } from './dto/annotation.dto';
import { PdfAnnotation, ExtractedLiteratureNote } from './types/annotation.types';
import { randomUUID } from 'crypto';

@Injectable()
export class AnnotationService {
  private readonly logger = new Logger(AnnotationService.name);

  constructor(private readonly paperRepo: PaperRepository) {}

  /**
   * Helper: Parse annotations from paper.extra safely
   */
  private parseStoredAnnotations(extraString: string | null): PdfAnnotation[] {
    if (!extraString || !extraString.trim()) return [];
    try {
      const parsed = JSON.parse(extraString);
      if (Array.isArray(parsed.annotations)) {
        return parsed.annotations;
      }
    } catch {
      // Return empty if parsing fails
    }
    return [];
  }

  /**
   * Get all PDF annotations for a paper
   */
  async getAnnotations(
    workspaceId: string,
    paperId: string,
  ): Promise<{ annotations: PdfAnnotation[]; total: number }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    const annotations = this.parseStoredAnnotations(paper.extra);
    return {
      annotations,
      total: annotations.length,
    };
  }

  /**
   * Create a new PDF highlight / note / box annotation (concurrency-safe)
   */
  async createAnnotation(
    workspaceId: string,
    paperId: string,
    userId: string,
    dto: CreateAnnotationDto,
  ): Promise<{ annotation: PdfAnnotation }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    let newAnnotation: PdfAnnotation | null = null;
    const now = new Date().toISOString();

    await this.paperRepo.mutatePaperExtra(paperId, (extraObj) => {
      const annotations: PdfAnnotation[] = Array.isArray(extraObj.annotations)
        ? extraObj.annotations
        : [];

      newAnnotation = {
        id: randomUUID(),
        paperId,
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

      extraObj.annotations = [...annotations, newAnnotation];
      return extraObj;
    });

    return { annotation: newAnnotation! };
  }

  /**
   * Update an annotation's comment or color (concurrency-safe)
   */
  async updateAnnotation(
    workspaceId: string,
    paperId: string,
    annotationId: string,
    dto: UpdateAnnotationDto,
  ): Promise<{ annotation: PdfAnnotation }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    let updatedAnnotation: PdfAnnotation | null = null;

    await this.paperRepo.mutatePaperExtra(paperId, (extraObj) => {
      const annotations: PdfAnnotation[] = Array.isArray(extraObj.annotations)
        ? extraObj.annotations
        : [];
      const targetIndex = annotations.findIndex((a) => a.id === annotationId);
      if (targetIndex === -1) {
        throw new NotFoundException('Annotation not found');
      }

      const current = { ...annotations[targetIndex] };
      if (dto.comment !== undefined) current.comment = dto.comment;
      if (dto.color !== undefined) current.color = dto.color;
      current.updatedAt = new Date().toISOString();

      annotations[targetIndex] = current;
      extraObj.annotations = annotations;
      updatedAnnotation = current;
      return extraObj;
    });

    return { annotation: updatedAnnotation! };
  }

  /**
   * Delete an annotation (concurrency-safe)
   */
  async deleteAnnotation(
    workspaceId: string,
    paperId: string,
    annotationId: string,
  ): Promise<{ deleted: boolean; remainingCount: number }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    let remainingCount = 0;

    await this.paperRepo.mutatePaperExtra(paperId, (extraObj) => {
      const annotations: PdfAnnotation[] = Array.isArray(extraObj.annotations)
        ? extraObj.annotations
        : [];
      const filtered = annotations.filter((a) => a.id !== annotationId);
      if (filtered.length === annotations.length) {
        throw new NotFoundException('Annotation not found');
      }
      extraObj.annotations = filtered;
      remainingCount = filtered.length;
      return extraObj;
    });

    return {
      deleted: true,
      remainingCount,
    };
  }

  /**
   * Zotero 7 Parity: "Add Note from Annotations"
   * Synthesizes all highlights, underlines, and comments into an organized Markdown Literature Note
   * and appends it to paper.notes
   */
  async extractNotesFromAnnotations(
    workspaceId: string,
    paperId: string,
    userId: string,
  ): Promise<{ literatureNote: ExtractedLiteratureNote }> {
    const ws = await this.paperRepo.resolveWorkspace(workspaceId);
    const targetWsId = ws?.id || workspaceId;

    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper || paper.deletedAt || paper.workspaceId !== targetWsId) {
      throw new NotFoundException('Paper not found in this workspace');
    }

    const annotations = this.parseStoredAnnotations(paper.extra);
    if (annotations.length === 0) {
      throw new NotFoundException('No annotations found on this paper to extract');
    }

    // Sort annotations by page number ascending
    const sorted = [...annotations].sort((a, b) => a.pageNumber - b.pageNumber);

    // Group by page number
    const pageMap = new Map<number, PdfAnnotation[]>();
    for (const ann of sorted) {
      const list = pageMap.get(ann.pageNumber) || [];
      list.push(ann);
      pageMap.set(ann.pageNumber, list);
    }

    const lines: string[] = [];
    lines.push(`# 📖 Literature Notes: ${paper.title}`);
    lines.push(`*Extracted on ${new Date().toLocaleDateString()} from ${sorted.length} annotations*\n`);

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

    // Append to paper.notes array
    const existingNotes: Array<{ title: string; content: string }> = Array.isArray(paper.notes)
      ? [...(paper.notes as any[])]
      : [];

    const newNoteRecord = {
      title: noteTitle,
      content: markdownContent,
    };

    existingNotes.push(newNoteRecord);

    await this.paperRepo.updatePaper(paperId, {
      notes: existingNotes as any,
    });

    return {
      literatureNote: {
        title: noteTitle,
        content: markdownContent,
        annotationCount: sorted.length,
        createdAt: new Date().toISOString(),
      },
    };
  }
}
