import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { CheckQuotaUseCase } from '../../application/use-cases/quota/check-quota.use-case';

function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

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
      usedBytes: result.usedBytes,
      limitBytes: result.maxBytes,
      usedFormatted: formatBytes(result.usedBytes),
      limitFormatted: formatBytes(result.maxBytes),
      scope: projectId ? 'project' : 'personal',
    };
  }
}
