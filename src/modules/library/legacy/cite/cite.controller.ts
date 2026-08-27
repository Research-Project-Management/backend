import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CiteService as CitationService } from './cite.service';

import {
  ExportBibtexDto,
  ImportBibtexDto,
  FormatCitationQueryDto,
  FormatBatchCitationDto,
} from './dto/cite.dto';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Citations')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CiteController {
  constructor(private readonly citationService: CitationService) {}

  @Get([
    'workspace/:workspaceId/library/citations/items/:itemId',
    'workspace/:workspaceId/library/items/:itemId/citation',
    'library/citations/:workspaceId/items/:itemId/citation',
    'library/references/:workspaceId/papers/:itemId/citation',
    'library/references/:workspaceId/items/:itemId/citation',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Format catalog item into standard citation style (APA, IEEE, Nature, Harvard, Chicago, MLA, Vancouver)',
  })
  async formatCitation(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
    @Query() query: FormatCitationQueryDto,
  ) {
    return this.citationService.formatCitation(
      workspaceId,
      itemId,
      query.style,
    );
  }

  @Post([
    'workspace/:workspaceId/library/citations/batch',
    'library/citations/:workspaceId/batch',
    'library/references/:workspaceId/citations/batch',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Batch format multiple items into standard citation style',
  })
  async formatBatchCitations(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: FormatBatchCitationDto,
  ) {
    return this.citationService.formatBatchCitations(workspaceId, dto);
  }

  @Get([
    'workspace/:workspaceId/library/citations/bibtex',
    'library/citations/:workspaceId/bibtex',
    'library/references/:workspaceId/bibtex',
    'workspace/:workspaceId/library/collections/:collectionId/bibtex',
    'library/collections/:workspaceId/:collectionId/bibtex',
    'library/:workspaceId/collections/:collectionId/bibtex',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'Export workspace or collection items to BibTeX format',
  })
  async exportWorkspaceBibtex(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionIdParam?: string,
    @Query() query?: ExportBibtexDto,
  ) {
    return this.citationService.exportWorkspaceBibtex(
      workspaceId,
      collectionIdParam || query?.collectionId,
    );
  }

  @Get([
    'workspace/:workspaceId/library/collections/:collectionId/export-bundle',
    'library/collections/:workspaceId/:collectionId/export-bundle',
    'library/:workspaceId/collections/:collectionId/export-bundle',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Export complete collection archive bundle (BibTeX + PDF files manifest)',
  })
  async exportCollectionBundle(
    @Param('workspaceId') workspaceId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return await this.citationService.getCollectionExportBundle(
      workspaceId,
      collectionId,
    );
  }

  @Post([
    'workspace/:workspaceId/library/citations/import-bibtex',
    'library/citations/:workspaceId/import-bibtex',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import raw BibTeX text entries into workspace library',
  })
  async importBibtex(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ImportBibtexDto,
  ) {
    return this.citationService.importBibtex(workspaceId, userId, dto);
  }

  @Post([
    'workspace/:workspaceId/library/citations/parse-ris',
    'library/citations/parse-ris',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse raw RIS text without saving' })
  parseRis(@Body('content') content: string) {
    return this.citationService.parseRis(content);
  }

  @Post([
    'workspace/:workspaceId/library/citations/import-ris',
    'library/citations/:workspaceId/import-ris',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk import RIS text entries into workspace library',
  })
  async importRis(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: { content: string; collectionId?: string },
  ) {
    return this.citationService.importRis(workspaceId, userId, dto);
  }

  @Get([
    'workspace/:workspaceId/library/citations/items/:itemId/ris',
    'workspace/:workspaceId/library/items/:itemId/ris',
    'library/citations/:workspaceId/items/:itemId/ris',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Export single item into RIS format' })
  async exportRis(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.citationService.exportRis(workspaceId, itemId);
  }
}

export { CiteController as CitationController };
