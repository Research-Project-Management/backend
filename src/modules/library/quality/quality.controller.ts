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
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library - Quality & Duplicates')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/quality')
@UseGuards(JwtAuthGuard)
export class QualityController {
  constructor(private readonly qualityService: QualityService) {}

  @Get(':workspaceId/duplicates')
  @ApiOperation({
    summary:
      'Get 2-tier duplicate paper groups in workspace (DOI and Fuzzy Title/Year/Author matching)',
  })
  async getDuplicateGroups(@Param('workspaceId') workspaceId: string) {
    return this.qualityService.getDuplicateGroups(workspaceId);
  }

  @Post(':workspaceId/merge')
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

  @Get(':workspaceId/integrity')
  @ApiOperation({
    summary:
      'Scan library metadata integrity and return diagnostic health report',
  })
  async getIntegrityReport(@Param('workspaceId') workspaceId: string) {
    return this.qualityService.getIntegrityReport(workspaceId);
  }
}
