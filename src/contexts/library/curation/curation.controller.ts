import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { CurationService } from './curation.service';
import { MergeDuplicatesDto } from './dto/curation.dto';

@Controller('api/v1/workspaces/:workspaceId/library/curation')
@UseGuards(JwtAuthGuard)
export class CurationController {
  constructor(private readonly curationService: CurationService) {}

  @Get('duplicates')
  async getDuplicates(@Param('workspaceId') workspaceId: string) {
    const clusters = await this.curationService.detectDuplicates(workspaceId);
    return {
      success: true,
      data: clusters,
    };
  }

  @Post('merge')
  async mergeDuplicates(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: MergeDuplicatesDto,
  ) {
    const merged = await this.curationService.mergeDuplicates(workspaceId, dto);
    return {
      success: true,
      data: merged,
    };
  }

  @Get('quality-audit')
  async getQualityAudit(@Param('workspaceId') workspaceId: string) {
    const report = await this.curationService.getQualityAudit(workspaceId);
    return {
      success: true,
      data: report,
    };
  }
}
