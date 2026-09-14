import { Controller, Get, Param, Query, UseGuards, Res } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { ExportService } from './export.service';
import { ExportWorkItemsQueryDto } from './dto/export-query.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Work Item Export')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get([
    'projects/:projectId/work-items/export',
    'project/:projectId/work-items/export',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({
    summary: 'Export work items for a project in CSV or JSON format',
  })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  @ApiResponse({
    status: 200,
    description: 'File download stream (CSV or JSON)',
  })
  async exportProjectWorkItems(
    @Param('projectId') projectId: string,
    @Query() query: ExportWorkItemsQueryDto,
    @Res() reply: FastifyReply,
  ) {
    const result = await this.exportService.exportProjectWorkItems(
      projectId,
      query,
    );

    reply
      .header('Content-Type', result.contentType)
      .header(
        'Content-Disposition',
        `attachment; filename="${result.filename}"`,
      )
      .send(result.data);
  }
}
