import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CitationService } from './citation.service';
import { FormatCitationDto, FormatBatchCitationDto } from './dto/citation.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/citation',
  'api/library/references',
  'api/library/cite',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CitationController {
  constructor(private readonly citationService: CitationService) {}

  @Get('styles')
  getStyles() {
    return {
      success: true,
      data: this.citationService.getAvailableStyles(),
    };
  }

  @Post('format')
  format(@Body() dto: FormatCitationDto) {
    const result = this.citationService.formatItem(
      dto.item,
      dto.styleId || 'apa-7th',
      dto.index || 1,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Post('batch')
  formatBatch(@Body() dto: FormatBatchCitationDto) {
    const result = this.citationService.formatBatch(
      dto.items || [],
      dto.styleId || 'apa-7th',
    );
    return {
      success: true,
      data: result,
    };
  }
}
