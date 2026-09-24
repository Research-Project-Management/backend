import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  Optional,
} from '@nestjs/common';
import { TransactionService } from '../../../shared-kernel/outbox/transaction.service';
import {
  BIBLIOGRAPHY_FACADE,
  IBibliographyFacade,
} from '../../../bibliography/bibliography.facade';
import { READER_FACADE, IReaderFacade } from '../../../reader/reader.facade';
import { IngestionRepository } from '../../infrastructure/repositories/ingestion.repository';
import { MergeDuplicatesDto } from '../dtos/curation.dto';
import {
  DuplicateClusterResult,
  ALLOWED_MERGE_METADATA_FIELDS,
} from '../../domain/types/curation.types';
import {
  UserId,
  ProjectId,
} from '../../../shared-kernel/core/types/branded.types';
import {
  normalizeTitleForDedupe,
  extractFirstAuthorFamily,
  extractContributorAuthors,
  generateDedupeBucketKey,
} from '../utils/curation.utils';
import {
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '../utils/metadata.utils';
import { LIBRARY_EVENT_TYPES } from '../../../shared-kernel/outbox/outbox.events';

@Injectable()
export class DuplicateService {
  private readonly logger = new Logger(DuplicateService.name);

  constructor(
    private readonly libraryTx: TransactionService,
    @Optional()
    @Inject(BIBLIOGRAPHY_FACADE)
    private readonly bibliographyFacade?: IBibliographyFacade,
    @Optional()
    @Inject(READER_FACADE)
    private readonly readerFacade?: IReaderFacade,
    @Optional()
    private readonly ingestionRepo?: IngestionRepository,
  ) {}

  /**
   * Scans active items and clusters duplicate candidates.
   * Tier 0: Ingestion Pipeline suspects (real-time flagged from reviewData).
   * Tier 1: Exact normalized Academic Identifiers (DOI, arXiv ID, PMID, ISBN).
   * Tier 2: Normalized title + publication year (+/- 1) + first author family name.
   */
  async detectDuplicates(
    userId: UserId | string,
    projectId?: ProjectId | string,
  ): Promise<DuplicateClusterResult[]> {
    const items = this.bibliographyFacade
      ? await this.bibliographyFacade.findDuplicateCandidateItems(
          userId,
          2000,
          projectId,
        )
      : [];

    const getItemAuthors = (item: any): string[] =>
      extractContributorAuthors(item);

    const clusters: DuplicateClusterResult[] = [];
    const groupedItemIds = new Set<string>();

    // ── Tier 0: Ingestion-Suspect Pairs (High Priority from Pipeline) ────────
    if (this.ingestionRepo) {
      try {
        const suspects = await this.ingestionRepo.findIngestionDuplicateSuspects({
          userId: String(userId),
          projectId: projectId ? String(projectId) : undefined,
        });

        const itemsMap = new Map<string, any>(
          items.map((it: any) => [it.id, it]),
        );

        for (const suspect of suspects) {
          const itemA = itemsMap.get(suspect.createdItemId);
          const itemB = itemsMap.get(suspect.targetItemId);

          if (
            itemA &&
            itemB &&
            !groupedItemIds.has(itemA.id) &&
            !groupedItemIds.has(itemB.id)
          ) {
            groupedItemIds.add(itemA.id);
            groupedItemIds.add(itemB.id);

            clusters.push({
              clusterId: `ingest-${suspect.runId.substring(0, 8)}-${itemA.id.substring(0, 8)}`,
              matchReason: 'INGESTION_SUSPECT',
              confidence: suspect.confidence,
              items: [itemA, itemB].map((m: any) => ({
                id: m.id,
                title: m.title,
                doi: m.doi ?? undefined,
                year: m.year ?? undefined,
                authors: getItemAuthors(m),
                citationKey: m.citationKey ?? undefined,
              })),
            });
          }
        }
      } catch (err) {
        this.logger.warn(
          `Could not load ingestion duplicate suspects: ${(err as Error).message}`,
        );
      }
    }

    // ── Tier 1: Exact Academic Identifiers (DOI, arXiv, PMID, ISBN) ─────────
    const clusterByIdentifier = (
      idType: string,
      getIdFn: (it: any) => string | null | undefined,
      matchReason: 'EXACT_DOI' | 'EXACT_ARXIV' | 'EXACT_PMID' | 'EXACT_ISBN',
    ) => {
      const map = new Map<string, any[]>();
      for (const item of items) {
        if (groupedItemIds.has(item.id)) continue;
        const rawId = getIdFn(item);
        if (!rawId) continue;
        const clean = String(rawId).toLowerCase().trim();
        if (!clean) continue;
        const existing = map.get(clean) || [];
        existing.push(item);
        map.set(clean, existing);
      }

      map.forEach((matchedItems, idVal) => {
        if (matchedItems.length > 1) {
          matchedItems.forEach((m: any) => groupedItemIds.add(m.id));
          clusters.push({
            clusterId: `${idType}-${idVal.replace(/[^a-z0-9]/g, '-').substring(0, 32)}`,
            matchReason,
            confidence: 1.0,
            items: matchedItems.map((m: any) => ({
              id: m.id,
              title: m.title,
              doi: m.doi ?? undefined,
              year: m.year ?? undefined,
              authors: getItemAuthors(m),
              citationKey: m.citationKey ?? undefined,
            })),
          });
        }
      });
    };

    // 1. DOI
    clusterByIdentifier(
      'doi',
      (it) => normalizeDoi(it.doi) || it.doi,
      'EXACT_DOI',
    );

    // 2. arXiv ID
    clusterByIdentifier(
      'arxiv',
      (it) =>
        normalizeArxivId(it.arxivId || it.metadata?.arxivId, {
          stripVersion: true,
        }),
      'EXACT_ARXIV',
    );

    // 3. PMID
    clusterByIdentifier(
      'pmid',
      (it) => normalizePmid(it.pmid || it.metadata?.pmid),
      'EXACT_PMID',
    );

    // 4. ISBN
    clusterByIdentifier(
      'isbn',
      (it) => normalizeIsbn(it.isbn || it.metadata?.isbn),
      'EXACT_ISBN',
    );

    // ── Tier 2: Fuzzy Title + Year (+/-1) + First Author ─────────────────────────
    const remainingItems = items.filter(
      (item: any) => !groupedItemIds.has(item.id),
    );

    const fuzzyBuckets = new Map<string, typeof remainingItems>();

    for (const item of remainingItems) {
      const normTitle = normalizeTitleForDedupe(item.title);
      if (normTitle.length < 5) continue;

      const bucketKey = generateDedupeBucketKey(
        item.title,
        getItemAuthors(item),
      );
      const bucket = fuzzyBuckets.get(bucketKey) || [];
      bucket.push(item);
      fuzzyBuckets.set(bucketKey, bucket);
    }

    fuzzyBuckets.forEach((bucket, key) => {
      if (bucket.length <= 1) return;

      const visited = new Set<string>();

      for (let i = 0; i < bucket.length; i++) {
        const itemA = bucket[i];
        if (visited.has(itemA.id) || groupedItemIds.has(itemA.id)) continue;

        const group = [itemA];
        for (let j = i + 1; j < bucket.length; j++) {
          const itemB = bucket[j];
          if (visited.has(itemB.id) || groupedItemIds.has(itemB.id)) continue;

          const yearA = itemA.year;
          const yearB = itemB.year;
          const yearMatch =
            yearA == null || yearB == null || Math.abs(yearA - yearB) <= 1;

          if (yearMatch) {
            group.push(itemB);
            visited.add(itemB.id);
          }
        }

        if (group.length > 1) {
          group.forEach((g) => groupedItemIds.add(g.id));
          clusters.push({
            clusterId: `fuzzy-${key.replace(/[^a-z0-9]/g, '-').substring(0, 24)}-${itemA.id.substring(0, 8)}`,
            matchReason: 'FUZZY_TITLE_YEAR_AUTHOR',
            confidence: 0.85,
            items: group.map((m) => ({
              id: m.id,
              title: m.title,
              doi: m.doi ?? undefined,
              year: m.year ?? undefined,
              authors: getItemAuthors(m),
              citationKey: m.citationKey ?? undefined,
            })),
          });
        }
      }
    });

    return clusters;
  }

  /**
   * Non-destructive, atomic merge of duplicate items into a primary item.
   */
  async mergeDuplicates(
    userId: UserId | string,
    dto: MergeDuplicatesDto,
    projectId?: ProjectId | string,
  ) {
    if (!dto.primaryItemId) {
      throw new BadRequestException('primaryItemId is required');
    }
    if (!dto.duplicateItemIds || dto.duplicateItemIds.length === 0) {
      throw new BadRequestException('duplicateItemIds must not be empty');
    }

    const uniqueDupIds = Array.from(new Set(dto.duplicateItemIds));
    if (uniqueDupIds.includes(dto.primaryItemId)) {
      throw new BadRequestException(
        'primaryItemId cannot be included in duplicateItemIds',
      );
    }

    // Validate field selections against allowlist
    if (dto.fieldSelections) {
      for (const field of Object.keys(dto.fieldSelections)) {
        if (!ALLOWED_MERGE_METADATA_FIELDS.has(field)) {
          throw new BadRequestException(
            `Field "${field}" is not allowed in merge fieldSelections`,
          );
        }
      }
    }

    const effectiveProjectId = projectId || dto.projectId;
    const allItemIds = [dto.primaryItemId, ...uniqueDupIds];
    const items = this.bibliographyFacade
      ? await this.bibliographyFacade.findByIds(
          userId,
          allItemIds,
          effectiveProjectId,
        )
      : [];

    if (items.length !== allItemIds.length) {
      throw new NotFoundException(
        `One or more items do not exist, are already deleted, or belong to another user`,
      );
    }

    const primary = items.find((it: any) => it.id === dto.primaryItemId)!;
    const duplicates = items.filter((it: any) => it.id !== dto.primaryItemId);

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const now = new Date();

      // ── 0. Advisory Transaction Lock (Deterministic Hashing on Primary Item ID) ──
      if (typeof (tx as any).$executeRaw === 'function') {
        try {
          const hashStr = (str: string) => {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
              hash = (hash << 5) - hash + str.charCodeAt(i);
              hash |= 0;
            }
            return Math.abs(hash);
          };
          const lockKey = hashStr(primary.id);
          await (tx as any).$executeRaw`
            SELECT pg_advisory_xact_lock(${lockKey})
          `;
        } catch (err) {
          this.logger.warn(
            `Could not acquire pg_advisory_xact_lock: ${(err as Error).message}`,
          );
        }
      }

      // ── 1 & 2. Reassign Attachments & Notes (Delegated to ReaderFacade) ──
      if (this.readerFacade) {
        await this.readerFacade.reassignContentToItem(
          uniqueDupIds,
          primary.id,
          tx,
        );
      }

      // ── 3 & 4. Consolidate Tags, Collections & States (Delegated to BibliographyFacade) ──
      if (this.bibliographyFacade) {
        await this.bibliographyFacade.mergeItems(tx, uniqueDupIds, primary.id);
      }

      // ── 5. Rewire Item Relations ──────────────────────────────────────────────
      const existingRelations = await tx.itemRelation.findMany({
        where: {
          OR: [
            { sourceItemId: { in: [primary.id, ...uniqueDupIds] } },
            { targetItemId: { in: [primary.id, ...uniqueDupIds] } },
          ],
        },
      });

      const primaryExistingPairs = new Set<string>();
      for (const rel of existingRelations) {
        if (
          rel.sourceItemId === primary.id ||
          rel.targetItemId === primary.id
        ) {
          primaryExistingPairs.add(
            `${rel.sourceItemId}::${rel.targetItemId}::${rel.relationType}`,
          );
        }
      }

      for (const rel of existingRelations) {
        const isSourceDup = uniqueDupIds.includes(rel.sourceItemId);
        const isTargetDup = uniqueDupIds.includes(rel.targetItemId);

        if (!isSourceDup && !isTargetDup) continue;

        const newSourceId = isSourceDup ? primary.id : rel.sourceItemId;
        const newTargetId = isTargetDup ? primary.id : rel.targetItemId;

        // Delete self-relations
        if (newSourceId === newTargetId) {
          await tx.itemRelation.delete({ where: { id: rel.id } });
          continue;
        }

        const candidateKey = `${newSourceId}::${newTargetId}::${rel.relationType}`;
        if (primaryExistingPairs.has(candidateKey)) {
          // Already exists on primary, delete duplicate relation
          await tx.itemRelation.delete({ where: { id: rel.id } });
        } else {
          await tx.itemRelation.update({
            where: { id: rel.id },
            data: {
              sourceItemId: newSourceId,
              targetItemId: newTargetId,
            },
          });
          primaryExistingPairs.add(candidateKey);
        }
      }

      // ── 5.1 Consolidate User Publications ("My Publications") ────────────────
      if (typeof (tx as any).userPublication?.findMany === 'function') {
        const dupPublications = await (tx as any).userPublication.findMany({
          where: { itemId: { in: uniqueDupIds } },
        });

        for (const pub of dupPublications) {
          const existingPrimaryPub =
            await (tx as any).userPublication.findUnique({
              where: {
                userId_itemId: {
                  userId: pub.userId,
                  itemId: primary.id,
                },
              },
            });

          if (!existingPrimaryPub) {
            await (tx as any).userPublication.create({
              data: {
                userId: pub.userId,
                itemId: primary.id,
                contributorId: pub.contributorId,
                isPublic: pub.isPublic,
                openAccessLicense: pub.openAccessLicense,
                addedAt: pub.addedAt,
              },
            });
          } else {
            await (tx as any).userPublication.update({
              where: {
                userId_itemId: {
                  userId: pub.userId,
                  itemId: primary.id,
                },
              },
              data: {
                isPublic: existingPrimaryPub.isPublic || pub.isPublic,
                openAccessLicense:
                  existingPrimaryPub.openAccessLicense || pub.openAccessLicense,
                contributorId:
                  existingPrimaryPub.contributorId || pub.contributorId,
              },
            });
          }

          await (tx as any).userPublication.delete({
            where: {
              userId_itemId: {
                userId: pub.userId,
                itemId: pub.itemId,
              },
            },
          });
        }
      }

      // ── 5.2 Re-parent Upstream Raw Metadata Snapshots (ItemMetadata) ──────────
      const metadataModel =
        (tx as any).itemMetadata || (tx as any).metadataSourceRecord;
      if (typeof metadataModel?.updateMany === 'function') {
        await metadataModel.updateMany({
          where: { itemId: { in: uniqueDupIds } },
          data: { itemId: primary.id },
        });
      }

      // ── 6. Provenance & Alias Citation Keys ──────────────────────────────────
      const extraObj: Record<string, any> =
        primary.metadata?.extra ?? primary.metadata ?? {};
      const existingAliases: string[] = Array.isArray(
        extraObj.mergedCitationKeys,
      )
        ? extraObj.mergedCitationKeys
        : [];
      const dupCitationKeys = duplicates
        .map((d: any) => d.citationKey)
        .filter((k: any): k is string =>
          Boolean(k?.trim() && k !== primary.citationKey),
        );
      extraObj.mergedCitationKeys = Array.from(
        new Set([...existingAliases, ...dupCitationKeys]),
      );

      // ── 7. Contributors (Authors) Synchronization ────────────────────────────
      const rawSelections = (dto.fieldSelections || {}) as Record<string, any>;
      const {
        authors: selectedAuthors,
        creators: selectedCreators,
        contributors: selectedContributors,
        ...scalarSelections
      } = rawSelections;

      const chosenContributors =
        selectedContributors || selectedAuthors || selectedCreators;

      if (Array.isArray(chosenContributors) && chosenContributors.length > 0) {
        // Explicit contributor selection from DTO
        if (typeof (tx as any).contributor?.deleteMany === 'function') {
          await (tx as any).contributor.deleteMany({
            where: { itemId: primary.id },
          });
          await (tx as any).contributor.createMany({
            data: chosenContributors.map((c: any, idx: number) => ({
              itemId: primary.id,
              creatorType: c.creatorType || 'author',
              firstName: c.firstName || '',
              lastName: c.lastName || '',
              fullName:
                c.fullName ||
                c.name ||
                [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                (typeof c === 'string' ? c : ''),
              orderIndex: c.orderIndex ?? idx,
            })),
          });
        }
      } else {
        // If primary has no contributors, borrow from the richest duplicate
        if (typeof (tx as any).contributor?.count === 'function') {
          const primaryContribCount = await (tx as any).contributor.count({
            where: { itemId: primary.id },
          });

          if (primaryContribCount === 0) {
            const donorWithContribs = duplicates.find(
              (d: any) =>
                Array.isArray(d.contributors) && d.contributors.length > 0,
            );
            if (donorWithContribs) {
              await (tx as any).contributor.createMany({
                data: donorWithContribs.contributors.map(
                  (c: any, idx: number) => ({
                    itemId: primary.id,
                    creatorType: c.creatorType || 'author',
                    firstName: c.firstName || '',
                    lastName: c.lastName || '',
                    fullName:
                      c.fullName ||
                      c.name ||
                      [c.firstName, c.lastName].filter(Boolean).join(' ') ||
                      '',
                    orderIndex: c.orderIndex ?? idx,
                  }),
                ),
              });
            }
          }
        }
      }

      // ── 8. Update Primary Item ───────────────────────────────────────────────
      const primaryMeta = primary.metadata ?? {};
      primaryMeta.extra = extraObj;

      const updatedPrimary = await tx.item.update({
        where: { id: primary.id },
        data: {
          ...scalarSelections,
          metadata: primaryMeta,
          version: { increment: 1 },
        },
      });

      const eventScope = { userId, projectId: effectiveProjectId };

      await helpers.appendChange(eventScope, {
        entityType: 'Item',
        entityId: updatedPrimary.id,
        action: 'update',
        version: updatedPrimary.version,
        data: updatedPrimary,
      });

      await helpers.publishOutbox(
        eventScope,
        primary.id,
        LIBRARY_EVENT_TYPES.ITEM_MERGED,
        {
          primaryItemId: primary.id,
          duplicateItemIds: uniqueDupIds,
          mergedCount: duplicates.length,
          mergedAt: now.toISOString(),
          projectId: effectiveProjectId,
        },
      );

      // ── 9. Soft-Delete Duplicates with Merge Marker ──────────────────────────
      for (const dup of duplicates) {
        const dupMeta = dup.metadata ?? {};
        dupMeta.mergedIntoId = primary.id;
        dupMeta.mergedAt = now.toISOString();

        const softDeleted = await tx.item.update({
          where: { id: dup.id },
          data: {
            deletedAt: now,
            metadata: dupMeta,
            version: { increment: 1 },
          },
        });

        await helpers.recordTombstone(eventScope, {
          entityType: 'Item',
          entityId: dup.id,
        });

        await helpers.appendChange(eventScope, {
          entityType: 'Item',
          entityId: dup.id,
          action: 'delete',
          version: softDeleted.version,
          data: softDeleted,
        });

        await helpers.publishOutbox(
          eventScope,
          dup.id,
          'library.item.merged_into',
          {
            duplicateId: dup.id,
            primaryId: primary.id,
            userId,
            projectId: effectiveProjectId,
          },
        );
      }

      // ── 10. Resolve Ingestion Review Cases ──────────────────────────────────
      if (this.ingestionRepo) {
        try {
          await this.ingestionRepo.resolveReviewCasesForItems(
            allItemIds,
            tx,
          );
        } catch (err) {
          this.logger.warn(
            `Could not resolve ingestion review cases: ${(err as Error).message}`,
          );
        }
      }

      // Reload primary item with full relations so response is complete & normalized
      const reloadedPrimary = await tx.item.findUnique({
        where: { id: primary.id },
        include: {
          contributors: { orderBy: { orderIndex: 'asc' } },
          collectionItems: { include: { collection: true } },
          itemTags: { include: { tag: true } },
          notesList: { where: { deletedAt: null } },
          attachments: { include: { revisions: true } },
        },
      });

      return {
        primaryItem: (reloadedPrimary ?? updatedPrimary) as any,
        mergedCount: duplicates.length,
        softDeletedItemIds: uniqueDupIds,
      };
    });
  }

  /**
   * @deprecated Decommissioned per Zotero Human-in-the-Loop compliance.
   * Automated batch merging poses severe false-positive risks for academic citations
   * and distinct publication versions (e.g. conference vs journal).
   * All duplicate merging must proceed through `mergeDuplicates` with explicit human review.
   */
  async autoResolveCluster(
    userId: UserId | string,
    clusterId: string,
    strategy: 'newest' | 'most_complete' | 'first_created' = 'most_complete',
    projectId?: ProjectId | string,
  ) {
    const clusters = await this.detectDuplicates(userId, projectId);
    const cluster = clusters.find((c) => c.clusterId === clusterId);

    if (!cluster) {
      throw new NotFoundException(
        `Duplicate cluster with ID "${clusterId}" not found`,
      );
    }

    const clusterItemIds = cluster.items.map((i) => i.id);
    const candidateItems = this.bibliographyFacade
      ? await this.bibliographyFacade.findByIds(
          userId,
          clusterItemIds,
          projectId,
        )
      : [];

    if (candidateItems.length < 2) {
      throw new BadRequestException(
        `Cluster "${clusterId}" does not contain at least 2 active items to merge`,
      );
    }

    // Rank candidates according to strategy
    const rankedCandidates = [...candidateItems].sort((a: any, b: any) => {
      if (strategy === 'newest') {
        const timeA = new Date(a.updatedAt ?? a.createdAt).getTime();
        const timeB = new Date(b.updatedAt ?? b.createdAt).getTime();
        return timeB - timeA;
      }

      if (strategy === 'first_created') {
        const timeA = new Date(a.createdAt).getTime();
        const timeB = new Date(b.createdAt).getTime();
        return timeA - timeB;
      }

      // Default: 'most_complete'
      const computeScore = (item: any): number => {
        let score = 0;
        for (const field of ALLOWED_MERGE_METADATA_FIELDS) {
          const val = item[field];
          if (val !== undefined && val !== null && val !== '') {
            score++;
          }
        }
        if (Array.isArray(item.contributors) && item.contributors.length > 0) {
          score += item.contributors.length;
        }
        if (Array.isArray(item.attachments) && item.attachments.length > 0) {
          score += item.attachments.length;
        }
        return score;
      };

      const scoreA = computeScore(a);
      const scoreB = computeScore(b);
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      // Tie breaker: earliest created item
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    const primary = rankedCandidates[0];
    const duplicates = rankedCandidates.slice(1);

    // Build fieldSelections for missing fields in primary
    const fieldSelections: Record<string, unknown> = {};
    for (const field of ALLOWED_MERGE_METADATA_FIELDS) {
      if (
        field === 'authors' ||
        field === 'creators' ||
        field === 'contributors'
      ) {
        continue;
      }
      const primaryVal = primary[field];
      if (
        primaryVal === undefined ||
        primaryVal === null ||
        primaryVal === ''
      ) {
        const donor = duplicates.find(
          (d: any) =>
            d[field] !== undefined && d[field] !== null && d[field] !== '',
        );
        if (donor) {
          fieldSelections[field] = donor[field];
        }
      }
    }

    // Check if primary is missing contributors and borrow from richest duplicate
    const primaryHasContributors =
      Array.isArray(primary.contributors) && primary.contributors.length > 0;
    if (!primaryHasContributors) {
      const donorWithContribs = duplicates.find(
        (d: any) => Array.isArray(d.contributors) && d.contributors.length > 0,
      );
      if (donorWithContribs) {
        fieldSelections.contributors = donorWithContribs.contributors;
      }
    }

    const mergeDto: MergeDuplicatesDto = {
      primaryItemId: primary.id,
      duplicateItemIds: duplicates.map((d: any) => d.id),
      fieldSelections:
        Object.keys(fieldSelections).length > 0 ? fieldSelections : undefined,
      projectId: projectId || undefined,
    };

    return this.mergeDuplicates(userId, mergeDto, projectId);
  }
}
