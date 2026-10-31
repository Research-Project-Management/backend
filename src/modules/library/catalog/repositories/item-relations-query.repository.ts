import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { ConfigurationException } from '@/modules/library/core/errors/domain.exception';

export type PrismaClientOrTx = Prisma.TransactionClient | PrismaService;

@Injectable()
export class ItemRelationsQueryRepository {
  constructor(
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  private getClient(client?: PrismaClientOrTx): PrismaClientOrTx {
    const c = client ?? this.prisma;
    if (!c) {
      throw new ConfigurationException(
        'No Prisma client or transaction provided',
      );
    }
    return c;
  }

  async getRelations(
    client: PrismaClientOrTx | undefined,
    itemId: string,
  ): Promise<Record<string, unknown>[]> {
    if (!isUuid(itemId)) return [];
    const activeClient = this.getClient(client);
    const relations = await activeClient.itemRelation.findMany({
      where: {
        OR: [
          { sourceItemId: itemId, targetItem: { deletedAt: null } },
          { targetItemId: itemId, sourceItem: { deletedAt: null } },
        ],
      },
      include: {
        sourceItem: {
          include: {
            contributors: {
              where: { creatorType: 'author' },
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
        targetItem: {
          include: {
            contributors: {
              where: { creatorType: 'author' },
              orderBy: { orderIndex: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (relations && relations.length > 0) {
      const seenPeerIds = new Set<string>();
      const result: Record<string, unknown>[] = [];

      for (const r of relations) {
        const isOutgoing = r.sourceItemId === itemId;
        const peerItem = isOutgoing ? r.targetItem : r.sourceItem;
        if (!peerItem || peerItem.id === itemId) continue;
        if (seenPeerIds.has(peerItem.id)) continue;
        seenPeerIds.add(peerItem.id);

        let effectiveRelationType = r.relationType as string;
        if (!isOutgoing) {
          // Reciprocal semantic mapping when viewing from target perspective
          if (r.relationType === 'cites') {
            effectiveRelationType = 'cited_by';
          } else if (r.relationType === 'cited_by') {
            effectiveRelationType = 'cites';
          } else if (r.relationType === 'is_preprint_of') {
            effectiveRelationType = 'is_published_version_of';
          } else if (r.relationType === 'is_published_version_of') {
            effectiveRelationType = 'is_preprint_of';
          } else if (r.relationType === 'rebuts') {
            effectiveRelationType = 'rebutted_by';
          } else if (r.relationType === 'extends') {
            effectiveRelationType = 'extended_by';
          } else if (r.relationType === 'replicates') {
            effectiveRelationType = 'replicated_by';
          } else if (r.relationType === 'uses_dataset') {
            effectiveRelationType = 'dataset_used_by';
          } else if (r.relationType === 'survey_of') {
            effectiveRelationType = 'reviewed_in';
          } else if (r.relationType === 'supplements') {
            effectiveRelationType = 'supplemented_by';
          } else if (r.relationType === 'is_translation_of') {
            effectiveRelationType = 'translated_as';
          }
        }

        const authorNames = (peerItem.contributors || [])
          .map(
            (c: {
              fullName: string | null;
              firstName: string | null;
              lastName: string | null;
            }) =>
              c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
          )
          .filter(Boolean);

        result.push({
          id: peerItem.id,
          relationId: r.id,
          targetItemId: peerItem.id,
          title: peerItem.title || 'Untitled Item',
          authors: authorNames,
          year: peerItem.year,
          doi: peerItem.doi,
          itemType: peerItem.itemType,
          citationKey: peerItem.citationKey,
          relationType: effectiveRelationType,
          direction: isOutgoing ? 'outgoing' : 'incoming',
          description: r.description || '',
          linkedAt: r.createdAt ? r.createdAt.toISOString() : undefined,
          targetItem: peerItem,
        });
      }

      if (result.length > 0) {
        return result;
      }
    }

    return [];
  }
}
