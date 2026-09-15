import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { CheckQuotaUseCase } from '../../application/use-cases/quota/check-quota.use-case';

@ApiTags('Storage & Quota')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/storage/files', 'api/files', 'api/file'])
@UseGuards(JwtAuthGuard)
export class QuotaController {
  constructor(private readonly checkQuotaUseCase: CheckQuotaUseCase) {}

  @Get('usage')
  @ApiOperation({
    summary: 'Get current user or project storage usage and limit',
  })
  async getUsage(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    const result = await this.checkQuotaUseCase.execute(userId, projectId);
    return {
      ...result,
      totalBytes: result.usedBytes,
    };
  }
}
