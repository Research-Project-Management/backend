import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { DuplicateService } from './services/duplicate.service';
import { QualityService } from './services/quality.service';
import { MergeDuplicatesDto } from './dto/curation.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';

@Controller('api/v1/library/curation')
@UseGuards(JwtAuthGuard)
export class CurationController {
  constructor(
    private readonly duplicateService: DuplicateService,
    private readonly qualityService: QualityService,
  ) {}

  @Get('duplicates')
  async getDuplicates(@CurrentUser('id') userId: string) {
    return this.duplicateService.detectDuplicates(userId);
  }

  @Post('merge')
  async mergeDuplicates(
    @CurrentUser('id') userId: string,
    @Body() dto: MergeDuplicatesDto,
  ) {
    return this.duplicateService.mergeDuplicates(userId, dto);
  }

  @Get(['quality-audit', 'quality', 'integrity'])
  async getQualityAudit(@CurrentUser('id') userId: string) {
    return this.qualityService.getQualityAudit(userId);
  }
}
