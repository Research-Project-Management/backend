import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { QualityService } from './quality.service';
import { MergeCatalogItemsDto } from './dto/quality.dto';

import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Quality & Duplicates')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class QualityController {
  constructor(private readonly qualityService: QualityService) {}

  @Get([
    'workspace/:workspaceId/library/quality/duplicates',
    'library/quality/:workspaceId/duplicates',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Get 2-tier duplicate paper groups in workspace (DOI and Fuzzy Title/Year/Author matching)',
  })
  async getDuplicateGroups(@Param('workspaceId') workspaceId: string) {
    return this.qualityService.getDuplicateGroups(workspaceId);
  }

  @Post([
    'workspace/:workspaceId/library/quality/merge',
    'library/quality/:workspaceId/merge',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Execute safe merge: consolidates notes/labels, transfers attachments to master, and soft-deletes sources',
  })
  async mergePapers(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: MergeCatalogItemsDto,
  ) {
    return this.qualityService.mergePapers(workspaceId, userId, dto);
  }

  @Get([
    'workspace/:workspaceId/library/quality/integrity',
    'library/quality/:workspaceId/integrity',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Scan library metadata integrity and return diagnostic health report',
  })
  async getIntegrityReport(@Param('workspaceId') workspaceId: string) {
    return this.qualityService.getIntegrityReport(workspaceId);
  }

  @Get([
    'workspace/:workspaceId/library/quality/missing-metadata',
    'library/quality/:workspaceId/missing-metadata',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'List catalog items missing core academic metadata',
  })
  async getMissingMetadata(@Param('workspaceId') workspaceId: string) {
    return this.qualityService.getMissingMetadata(workspaceId);
  }

  @Get([
    'workspace/:workspaceId/library/quality/missing-attachments',
    'library/quality/:workspaceId/missing-attachments',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary: 'List catalog items missing primary PDF attachments',
  })
  async getMissingAttachments(@Param('workspaceId') workspaceId: string) {
    return this.qualityService.getMissingAttachments(workspaceId);
  }
}
