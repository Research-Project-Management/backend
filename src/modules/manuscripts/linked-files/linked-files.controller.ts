/**
 * linked-files/linked-files.controller.ts
 * REST Controller for Linked Files management (Overleaf parity routes).
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { LinkedFilesService } from './linked-files.service';
import {
  CreateLinkedFileDto,
  LinkedFileResponseDto,
} from './dto/linked-file.dto';

@ApiTags('Manuscripts - Linked Files')
@ApiBearerAuth('JWT-auth')
@Controller()
@UseGuards(JwtAuthGuard)
export class LinkedFilesController {
  constructor(private readonly linkedFilesService: LinkedFilesService) {}

  @Post([
    'api/v1/manuscripts/projects/:projectId/linked-files',
    'project/:projectId/linked_file',
    'projects/:projectId/linked_file',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Link an external URL or reference collection to a manuscript project',
  })
  @ApiResponse({ status: 201, type: LinkedFileResponseDto })
  public async createLinkedFile(
    @Param('projectId') projectId: string,
    @Body() dto: CreateLinkedFileDto,
    @CurrentUser('id') userId?: string,
  ): Promise<LinkedFileResponseDto> {
    return await this.linkedFilesService.create(projectId, dto, userId);
  }

  @Get([
    'api/v1/manuscripts/projects/:projectId/linked-files',
    'project/:projectId/linked_file',
    'projects/:projectId/linked_file',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List all linked files for a manuscript project' })
  @ApiResponse({ status: 200, type: [LinkedFileResponseDto] })
  public async listLinkedFiles(
    @Param('projectId') projectId: string,
  ): Promise<LinkedFileResponseDto[]> {
    return await this.linkedFilesService.list(projectId);
  }

  @Post([
    'api/v1/manuscripts/projects/:projectId/linked-files/:id/refresh',
    'project/:projectId/linked_file/:id/refresh',
    'projects/:projectId/linked_file/:id/refresh',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh and re-synchronize a linked file immediately',
  })
  @ApiResponse({ status: 200, type: LinkedFileResponseDto })
  public async refreshLinkedFile(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ): Promise<LinkedFileResponseDto> {
    return await this.linkedFilesService.refresh(projectId, id, userId);
  }

  @Delete([
    'api/v1/manuscripts/projects/:projectId/linked-files/:id',
    'project/:projectId/linked_file/:id',
    'projects/:projectId/linked_file/:id',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink a linked file from the manuscript project' })
  public async deleteLinkedFile(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Query('deleteNode') deleteNode?: string,
  ): Promise<void> {
    await this.linkedFilesService.delete(projectId, id, deleteNode === 'true');
  }

  @Post('api/v1/manuscripts/linked-files/refresh-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger background refresh for all auto-refresh linked files',
  })
  public async refreshAllAutoRefresh() {
    return await this.linkedFilesService.refreshAllAutoRefresh();
  }
}
