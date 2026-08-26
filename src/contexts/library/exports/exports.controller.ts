import { Controller, Post, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { ExportsService } from './exports.service';
import { ExportLibraryDto } from './dto/export.dto';

@Controller('api/v1/workspaces/:workspaceId/library/exports')
@UseGuards(JwtAuthGuard)
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Post()
  async exportLibrary(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ExportLibraryDto,
  ) {
    const result = await this.exportsService.exportLibrary(workspaceId, dto);
    return {
      success: true,
      data: result,
    };
  }
}
