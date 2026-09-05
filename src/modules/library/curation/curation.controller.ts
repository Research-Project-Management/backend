import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { DuplicateService } from './duplicate.service';
import { QualityService } from './quality.service';
import { MergeDuplicatesDto } from './curation.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentWorkspace } from '../../../modules/iam/authz/decorators/current-workspace.decorator';

@Controller('api/v1/workspaces/:workspaceId/library/curation')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CurationController {
  constructor(
    private readonly duplicateService: DuplicateService,
    private readonly qualityService: QualityService,
  ) {}

  @Get('duplicates')
  async getDuplicates(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
  ) {
    return this.duplicateService.detectDuplicates(
      currentWorkspaceId || workspaceId,
    );
  }

  @Post('merge')
  async mergeDuplicates(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
    @Body() dto: MergeDuplicatesDto,
  ) {
    return this.duplicateService.mergeDuplicates(
      currentWorkspaceId || workspaceId,
      dto,
    );
  }

  @Get(['quality-audit', 'quality', 'integrity'])
  async getQualityAudit(
    @Param('workspaceId') workspaceId: string,
    @CurrentWorkspace() currentWorkspaceId: string,
  ) {
    return this.qualityService.getQualityAudit(
      currentWorkspaceId || workspaceId,
    );
  }
}
