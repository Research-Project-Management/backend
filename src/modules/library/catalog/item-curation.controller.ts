import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Headers,
  UseGuards,
  NotFoundException,
  BadRequestException,
  Optional,
  Header,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { isUUID } from 'class-validator';
import { ParseCitationsDto } from './dto/items.dto';
import { ItemsService } from './core/services/items.service';
import { GetFulltextUseCase } from './core/use-cases/get-fulltext.use-case';
import { ParseCitationsUseCase } from './core/use-cases/parse-citations.use-case';
import { ReindexItemUseCase } from './core/use-cases/reindex-item.use-case';
import { ConvertItemTypeUseCase } from './core/use-cases/convert-item-type.use-case';
import { PreviewTypeConversionUseCase } from './core/use-cases/preview-type-conversion.use-case';
import { ManageRelationsUseCase } from './core/use-cases/manage-relations.use-case';
import { SetMyPublicationUseCase } from './core/use-cases/set-my-publication.use-case';
import { GetItemUseCase } from './core/use-cases/get-item.use-case';
import {
  CatalogDomainException,
  ItemConcurrencyDomainException,
} from './core/domain/item-domain.exception';
import { VersionMismatchException } from '../shared-kernel/core/errors/version-mismatch.exception';
import { toValidProjectId } from '../shared-kernel';

@ApiTags('Library Items - Curation & Scholarly Enrichment')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/items',
  'api/v1/me/library/items',
  'api/v1/projects/:projectId/library/items',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ItemCurationController {
  constructor(
    @Optional() protected readonly getFulltextUseCase?: GetFulltextUseCase,
    @Optional()
    protected readonly parseCitationsUseCase?: ParseCitationsUseCase,
    @Optional() protected readonly reindexItemUseCase?: ReindexItemUseCase,
    @Optional()
    protected readonly convertItemTypeUseCase?: ConvertItemTypeUseCase,
    @Optional()
    protected readonly previewTypeConversionUseCase?: PreviewTypeConversionUseCase,
    @Optional()
    protected readonly manageRelationsUseCase?: ManageRelationsUseCase,
    @Optional()
    protected readonly setMyPublicationUseCase?: SetMyPublicationUseCase,
    @Optional() protected readonly getItemUseCase?: GetItemUseCase,
    @Optional() protected readonly itemsService?: ItemsService,
  ) {}

  @Post('citations/parse')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'Parse raw unformatted citation strings via GROBID CRF model',
    description:
      'Extracts structured title, authors, venue, year, volume, and DOI from unstructured raw text strings without needing a PDF file.',
  })
  async parseCitations(@Body() dto: ParseCitationsDto) {
    if (!this.parseCitationsUseCase) {
      throw new BadRequestException(
        'Citation parser service is not configured',
      );
    }
    const result = await this.parseCitationsUseCase.execute({
      rawCitations: dto.citations,
    });
    return {
      success: true,
      count: result.count,
      data: result.references,
    };
  }

  @Get(':id/fulltext')
  @Header('Cache-Control', 'private, max-age=300, stale-while-revalidate=3600')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get fulltext of an item' })
  async getFulltext(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!this.getFulltextUseCase) {
      throw new NotFoundException('Fulltext service is not configured');
    }
    const fulltext = await this.getFulltextUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    return { success: true, data: fulltext, ...fulltext };
  }

  @Post(':id/reindex')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Reindex a library item' })
  async reindexItem(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!this.reindexItemUseCase) {
      throw new BadRequestException('Reindex service is not configured');
    }
    return this.reindexItemUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
  }

  @Post(':id/convert-type/preview')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Preview type conversion of an item' })
  async previewTypeConversion(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { targetType: string; retainUnmappedInExtra?: boolean },
    @Param('projectId') projectId?: string,
  ) {
    if (!this.getItemUseCase || !this.previewTypeConversionUseCase) {
      throw new BadRequestException(
        'Type conversion service is not configured',
      );
    }
    const item = await this.getItemUseCase.execute({
      userId,
      itemId: id,
      projectId: toValidProjectId(projectId),
    });
    if (!item) {
      throw new NotFoundException(`Item ${id} not found in library`);
    }
    try {
      const preview = this.previewTypeConversionUseCase.execute({
        item,
        targetType: body.targetType,
        options: {
          retainUnmappedInExtra: body.retainUnmappedInExtra ?? true,
        },
      });
      return { success: true, preview, data: preview };
    } catch (err: any) {
      if (err instanceof CatalogDomainException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Post(':id/convert-type')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Convert item type' })
  async convertItemType(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
    @Body()
    body?: {
      targetType: string;
      expectedVersion?: number;
      retainUnmappedInExtra?: boolean;
    },
    @Param('projectId') projectId?: string,
  ) {
    if (!this.convertItemTypeUseCase) {
      throw new BadRequestException(
        'Type conversion service is not configured',
      );
    }
    const expectedVersion =
      body?.expectedVersion !== undefined
        ? body.expectedVersion
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;
    try {
      const result = await this.convertItemTypeUseCase.execute({
        userId,
        itemId: id,
        targetType: body?.targetType || 'journalArticle',
        options: {
          expectedVersion,
          retainUnmappedInExtra: body?.retainUnmappedInExtra ?? true,
        },
        projectId: toValidProjectId(projectId),
      });

      return {
        success: true,
        data: result.item,
        item: result.item,
        conversionReport: result.conversionReport,
      };
    } catch (err: any) {
      if (err instanceof ItemConcurrencyDomainException) {
        throw new VersionMismatchException(
          err.itemId,
          err.currentVersion,
          err.expectedVersion,
        );
      }
      if (err instanceof CatalogDomainException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Get(':id/relations')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get related items' })
  async getRelatedItems(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!this.manageRelationsUseCase) {
      return [];
    }
    return this.manageRelationsUseCase.getRelatedItems(
      userId,
      id,
      toValidProjectId(projectId),
    );
  }

  @Post([':id/relations', ':id/link'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Link two or more items together' })
  async linkItems(
    @Param('id') id: string,
    @Body()
    body: {
      targetItemId?: string;
      targetItemIds?: string[];
      relationType?: string;
      note?: string;
    },
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!this.manageRelationsUseCase) {
      throw new BadRequestException('Relations service is not configured');
    }
    return this.manageRelationsUseCase.linkItems({
      userId,
      sourceItemId: id,
      data: body,
      projectId: toValidProjectId(projectId),
    });
  }

  @Delete([':id/relations/:targetId', ':id/link/:targetId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unlink items' })
  async unlinkItems(
    @Param('id') id: string,
    @Param('targetId') targetItemId: string,
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId?: string,
  ) {
    if (!this.manageRelationsUseCase) {
      throw new BadRequestException('Relations service is not configured');
    }
    return this.manageRelationsUseCase.unlinkItems({
      userId,
      sourceItemId: id,
      targetItemId,
      projectId: toValidProjectId(projectId),
    });
  }

  @Post(':id/my-publication')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Mark an item as my publication' })
  async markMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    if (this.itemsService) {
      const item = await this.itemsService.setMyPublication(userId, id, true);
      return { success: true, data: item, item };
    }
    if (!this.setMyPublicationUseCase) {
      throw new BadRequestException('Publication service is not configured');
    }
    const item = await this.setMyPublicationUseCase.execute({
      userId,
      itemId: id,
      isMyPublication: true,
    });
    return { success: true, data: item, item };
  }

  @Delete(':id/my-publication')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Unmark an item as my publication' })
  async unmarkMyPublication(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    if (this.itemsService) {
      const item = await this.itemsService.setMyPublication(userId, id, false);
      return { success: true, data: item, item };
    }
    if (!this.setMyPublicationUseCase) {
      throw new BadRequestException('Publication service is not configured');
    }
    const item = await this.setMyPublicationUseCase.execute({
      userId,
      itemId: id,
      isMyPublication: false,
    });
    return { success: true, data: item, item };
  }
}
