import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ExportService } from './export.service';
import { ExportDocumentDto } from './dto/export.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Document - Export')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Post(['pages/:pageId/export', 'projects/:projectId/pages/:pageId/export'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Export document to PDF, Markdown, LaTeX source or bundle',
  })
  async exportDocument(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ExportDocumentDto,
  ) {
    return this.exportService.exportDocument(pageId, userId, dto);
  }
}
