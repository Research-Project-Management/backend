import { Injectable } from '@nestjs/common';
import { CatalogRepository } from './catalog.repository';
import { PdfAnnotation } from '../attachments/annotations/annotations.types';
import { StoredRelation } from '../knowledge/types/knowledge.types';

/**
 * CatalogExtraStore — the single authoritative module for reading and mutating
 * all data stored in the `paper.extra` JSON field.
 *
 * This module exists because Annotations and Relations both live in `paper.extra`
 * and previously duplicated the same JSON parse/mutate logic in two separate services.
 * See ADR-0001: data stays in paper.extra; only the access path is centralised here.
 *
 * Interface contract (deep module — small interface, all complexity inside):
 *   Annotations: getAnnotations · putAnnotation · removeAnnotation
 *   Relations:   getRelations   · putRelation   · removeRelation
 *
 * Every mutating operation is atomic via CatalogRepository.mutatePaperExtra()
 * which wraps the read-modify-write in a Prisma $transaction.
 */
@Injectable()
export class CatalogExtraStore {
  constructor(private readonly paperRepo: CatalogRepository) {}

  // ─── Annotations ──────────────────────────────────────────────────────────

  /**
   * Read all Annotations for a Paper from paper.extra.
   * Returns an empty array if paper.extra is absent or contains no annotations key.
   */
  async getAnnotations(paperId: string): Promise<PdfAnnotation[]> {
    const paper = await this.paperRepo.findItemById(paperId);
    return this.parseAnnotations(paper?.extra ?? null);
  }

  /**
   * Append a new Annotation to paper.extra atomically.
   * Returns the full updated annotations list.
   */
  async putAnnotation(
    paperId: string,
    annotation: PdfAnnotation,
  ): Promise<PdfAnnotation[]> {
    const { extraObj } = await this.paperRepo.mutatePaperExtra(
      paperId,
      (extra) => {
        const list: PdfAnnotation[] = Array.isArray(extra.annotations)
          ? extra.annotations
          : [];
        extra.annotations = [...list, annotation];
        return extra;
      },
    );
    return Array.isArray(extraObj.annotations) ? extraObj.annotations : [];
  }

  /**
   * Replace an existing Annotation (matched by id) in paper.extra atomically.
   * Returns the updated Annotation, or null if not found.
   */
  async replaceAnnotation(
    paperId: string,
    annotationId: string,
    updates: Partial<Pick<PdfAnnotation, 'comment' | 'color' | 'updatedAt'>>,
  ): Promise<PdfAnnotation | null> {
    let updated: PdfAnnotation | null = null;

    await this.paperRepo.mutatePaperExtra(paperId, (extra) => {
      const list: PdfAnnotation[] = Array.isArray(extra.annotations)
        ? extra.annotations
        : [];

      const idx = list.findIndex((a) => a.id === annotationId);
      if (idx === -1) return extra;

      updated = { ...list[idx], ...updates };
      list[idx] = updated;
      extra.annotations = list;
      return extra;
    });

    return updated;
  }

  /**
   * Remove an Annotation by id from paper.extra atomically.
   * Returns the remaining count, or -1 if the annotation was not found.
   */
  async removeAnnotation(
    paperId: string,
    annotationId: string,
  ): Promise<number> {
    let remaining = -1;

    await this.paperRepo.mutatePaperExtra(paperId, (extra) => {
      const list: PdfAnnotation[] = Array.isArray(extra.annotations)
        ? extra.annotations
        : [];

      const filtered = list.filter((a) => a.id !== annotationId);
      if (filtered.length === list.length) return extra; // not found — no-op

      remaining = filtered.length;
      extra.annotations = filtered;
      return extra;
    });

    return remaining;
  }

  // ─── Relations ────────────────────────────────────────────────────────────

  /**
   * Read all Relations for a Paper from paper.extra.
   */
  async getRelations(paperId: string): Promise<StoredRelation[]> {
    const paper = await this.paperRepo.findItemById(paperId);
    return this.parseRelations(paper?.extra ?? null);
  }

  /**
   * Upsert a Relation in paper.extra atomically.
   * If a relation to targetPaperId already exists it is replaced;
   * otherwise the new relation is appended. Returns the stored relation.
   */
  async putRelation(
    paperId: string,
    relation: StoredRelation,
  ): Promise<StoredRelation> {
    await this.paperRepo.mutatePaperExtra(paperId, (extra) => {
      const list: StoredRelation[] = Array.isArray(extra.relations)
        ? extra.relations.filter(
            (r: StoredRelation) => r.targetPaperId !== relation.targetPaperId,
          )
        : [];
      extra.relations = [...list, relation];
      return extra;
    });

    return relation;
  }

  /**
   * Remove a Relation to targetPaperId from paper.extra atomically.
   */
  async removeRelation(paperId: string, targetPaperId: string): Promise<void> {
    await this.paperRepo.mutatePaperExtra(paperId, (extra) => {
      if (Array.isArray(extra.relations)) {
        extra.relations = extra.relations.filter(
          (r: StoredRelation) =>
            r.targetPaperId !== targetPaperId &&
            r.targetItemId !== targetPaperId,
        );
      }
      return extra;
    });
  }

  async deleteRelation(paperId: string, targetPaperId: string): Promise<void> {
    return this.removeRelation(paperId, targetPaperId);
  }

  // ─── Private parse helpers ────────────────────────────────────────────────

  private parseAnnotations(extraString: string | null): PdfAnnotation[] {
    if (!extraString?.trim()) return [];
    try {
      const parsed = JSON.parse(extraString);
      return Array.isArray(parsed.annotations) ? parsed.annotations : [];
    } catch {
      return [];
    }
  }

  private parseRelations(extraString: string | null): StoredRelation[] {
    if (!extraString?.trim()) return [];
    try {
      const parsed = JSON.parse(extraString);
      return Array.isArray(parsed.relations) ? parsed.relations : [];
    } catch {
      return [];
    }
  }

  // ─── Bulk read (for Knowledge Graph) ──────────────────────────────────────

  /**
   * Returns a Map<paperId, StoredRelation[]> for all given IDs in a single DB call.
   * Use this instead of calling getRelations() in a loop to avoid the N+1 query problem
   * when building the workspace Knowledge Graph.
   */
  async getBulkRelations(
    paperIds: string[],
  ): Promise<Map<string, StoredRelation[]>> {
    if (paperIds.length === 0) return new Map();

    const papers = await this.paperRepo.findItems({ id: { in: paperIds } });
    const result = new Map<string, StoredRelation[]>();

    for (const paper of papers) {
      result.set(paper.id, this.parseRelations(paper.extra ?? null));
    }

    // Ensure every requested ID has an entry (even if empty)
    for (const id of paperIds) {
      if (!result.has(id)) result.set(id, []);
    }

    return result;
  }
}
