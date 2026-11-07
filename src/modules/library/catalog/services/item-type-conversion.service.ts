import { Injectable, Inject, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { TypesService, ItemCacheCoordinator } from './schema-validator.service';
import { ItemTransformer } from '@/modules/library/catalog/services/item.transformer';
import { ItemsMapper } from '@/modules/library/core';
import {
  ItemDetail,
  TypeConversionPreview,
  ConvertTypeOptions,
} from '@/modules/library/core/types/bibliographic.types';
import {
  normalizeProjectScopeId,
  LIBRARY_EVENT_TYPES,
  TransactionHelpers,
  UNIT_OF_WORK,
  IUnitOfWork,
} from '@/modules/library/core';
import { buildTypeConversionUpdatePayload } from '../domain/type-conversion.policy';

/**
 * ItemTypeConversionService — Dedicated Domain Service for Item Type conversions.
 * Delegates pure conversion preview, CSL Base Field remapping, and Unmapped Field Tombstone
 * (`__unmapped_*`) payload construction to `type-conversion.policy.ts`.
 */
@Injectable()
export class ItemTypeConversionService {
  constructor(
    private readonly query: QueryRepository,
    private readonly command: CommandRepository,
    private readonly typesService: TypesService,
    private readonly transformer: ItemTransformer,
    @Optional() @Inject(UNIT_OF_WORK) private readonly libraryTx?: IUnitOfWork,
    @Optional() private readonly cacheCoordinator?: ItemCacheCoordinator,
  ) {}

  /**
   * Generates a deterministic preview of item-type conversion without modifying DB state.
   */
  previewTypeConversion(
    rawItem: Record<string, unknown>,
    targetType: string,
    options: { retainUnmappedInExtra?: boolean } = {},
  ): TypeConversionPreview {
    return this.transformer.previewConversion(rawItem, targetType, options);
  }

  /**
   * Executes type conversion transactionally in the database.
   */
  async convertItemType(
    userId: string,
    itemId: string,
    targetType: string,
    options: ConvertTypeOptions = {},
    projectId?: string,
    tx?: Prisma.TransactionClient,
    helpers?: TransactionHelpers,
  ) {
    const rawExisting = await this.query.findById(
      userId,
      itemId,
      projectId,
      tx,
    );
    if (!rawExisting) {
      throw new NotFoundException(`Item ${itemId} not found in user library`);
    }
    const existing = ItemsMapper.toDomain<ItemDetail>(rawExisting);
    if (
      rawExisting.itemType === 'preprint' &&
      rawExisting.publicationTitle == null
    ) {
      const rawMeta =
        rawExisting.metadata &&
        typeof rawExisting.metadata === 'object' &&
        !Array.isArray(rawExisting.metadata)
          ? (rawExisting.metadata as Record<string, unknown>)
          : {};
      if (rawMeta.publicationTitle == null) {
        delete (existing as unknown as Record<string, unknown>)
          .publicationTitle;
      }
      if (rawMeta.publisher == null) {
        delete (existing as unknown as Record<string, unknown>).publisher;
      }
    }

    const preview = this.previewTypeConversion(existing, targetType, {
      retainUnmappedInExtra: options.retainUnmappedInExtra ?? true,
    });

    const targetFields = this.typesService.getOrderedFields(targetType);
    const updatePayload = buildTypeConversionUpdatePayload(
      targetType,
      existing,
      preview,
      targetFields,
      this.transformer,
      { retainUnmappedInExtra: options.retainUnmappedInExtra ?? true },
    );

    const effectiveProjectId =
      normalizeProjectScopeId(projectId ?? existing.projectId) ?? undefined;
    const eventScope = {
      userId,
      projectId: effectiveProjectId,
    };

    const recordConversionEvents = async (
      res: { version: number; [key: string]: unknown },
      activeHelpers?: TransactionHelpers,
    ) => {
      if (!activeHelpers) return;
      const domainRes = ItemsMapper.toDomain(res);
      const sharedData = ItemsMapper.stripPersonalOverlayForSharedScope(
        domainRes,
        effectiveProjectId,
      );
      await activeHelpers.appendChange(eventScope, {
        entityType: 'Item',
        entityId: itemId,
        action: 'update',
        version: res.version,
        data: sharedData,
      });
      await activeHelpers.publishOutbox(
        eventScope,
        itemId,
        LIBRARY_EVENT_TYPES.ITEM_UPDATED,
        sharedData,
      );
    };

    let ranPostCommitHook = Boolean(helpers?.onAfterCommit);
    const updated =
      !tx && this.libraryTx
        ? await this.libraryTx.executeInTransaction(
            async (
              innerTx: Prisma.TransactionClient,
              innerHelpers: TransactionHelpers,
            ) => {
              ranPostCommitHook = Boolean(innerHelpers?.onAfterCommit);
              const expectedVersion =
                options.expectedVersion ?? rawExisting.version;
              const res = await this.command.update(
                userId,
                itemId,
                expectedVersion,
                updatePayload,
                innerTx,
                projectId,
              );
              await recordConversionEvents(res, innerHelpers);
              innerHelpers?.onAfterCommit?.(() =>
                this.cacheCoordinator?.invalidateItemCache(
                  itemId,
                  userId,
                  effectiveProjectId,
                ),
              );
              return res;
            },
          )
        : await (async () => {
            const expectedVersion =
              options.expectedVersion ?? rawExisting.version;
            const res = await this.command.update(
              userId,
              itemId,
              expectedVersion,
              updatePayload,
              tx,
              projectId,
            );
            await recordConversionEvents(res, helpers);
            helpers?.onAfterCommit?.(() =>
              this.cacheCoordinator?.invalidateItemCache(
                itemId,
                userId,
                effectiveProjectId,
              ),
            );
            return res;
          })();

    if (!ranPostCommitHook) {
      await this.cacheCoordinator?.invalidateItemCache(
        itemId,
        userId,
        effectiveProjectId,
      );
    }

    return {
      success: true,
      item: ItemsMapper.toDomain(updated),
      conversionReport: preview,
    };
  }
}
