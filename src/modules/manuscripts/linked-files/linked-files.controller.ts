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
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  RequireOperator,
  OperatorGuard,
  NoProjectContext,
} from '@/modules/project/access';
import { LinkedFilesService } from './linked-files.service';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import {
  CreateLinkedFileDto,
  LinkedFileResponseDto,
} from './dto/linked-file.dto';

@ApiTags('Manuscripts - Linked Files')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts')
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
export class LinkedFilesController {
  constructor(private readonly linkedFilesService: LinkedFilesService) {}

  @Post('projects/:projectId/linked-files')
  @RequireRole(Role.CONTRIBUTOR)
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

  @Get('projects/:projectId/linked-files')
  @RequireRole(Role.REVIEWER)
  @ApiOperation({ summary: 'List all linked files for a manuscript project' })
  @ApiResponse({ status: 200, type: [LinkedFileResponseDto] })
  public async listLinkedFiles(
    @Param('projectId') projectId: string,
  ): Promise<LinkedFileResponseDto[]> {
    return await this.linkedFilesService.list(projectId);
  }

  @Post('projects/:projectId/linked-files/:id/refresh')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('linked-file')
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

  @Delete('projects/:projectId/linked-files/:id')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unlink a linked file from the manuscript project' })
  public async deleteLinkedFile(
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Query('deleteNode') deleteNode?: string,
  ): Promise<void> {
    await this.linkedFilesService.delete(projectId, id, deleteNode === 'true');
  }

  @Post('projects/:projectId/linked-files/refresh-all')
  @UseGuards(UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('linked-file')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh all linked files in a manuscript project immediately',
  })
  public async refreshAllProjectLinkedFiles(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId?: string,
  ) {
    return await this.linkedFilesService.refreshAllByProject(projectId, userId);
  }

  @Post('linked-files/refresh-all')
  @UseGuards(OperatorGuard, UserRateLimitGuard)
  @RequireOperator()
  @NoProjectContext()
  @UserRateLimit('linked-file')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger background refresh for all auto-refresh linked files',
  })
  public async refreshAllAutoRefresh() {
    return await this.linkedFilesService.refreshAllAutoRefresh();
  }
}
