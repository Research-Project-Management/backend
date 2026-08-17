import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { StickyService } from './sticky.service';
import {
  CreateStickyDto,
  UpdateStickyDto,
  ReorderStickiesDto,
} from './dto/sticky.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Personal Sticky Notes')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class StickyController {
  constructor(private readonly stickyService: StickyService) {}

  @Get('workspace/:workspaceId/stickies')
  @ApiOperation({ summary: 'Get personal stickies in workspace' })
  async getWorkspaceStickies(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.getWorkspaceStickies(workspaceId, userId);
  }

  @Post('workspace/:workspaceId/stickies')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create personal sticky in workspace' })
  async createWorkspaceSticky(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
  ) {
    return this.stickyService.createWorkspaceSticky(workspaceId, userId, dto);
  }

  @Put('workspace/:workspaceId/stickies/reorder')
  @ApiOperation({ summary: 'Reorder personal stickies in workspace' })
  async reorderWorkspaceStickies(@Body() dto: ReorderStickiesDto) {
    return this.stickyService.reorderStickies(dto.stickyIds);
  }

  @Get('project/:projectId/stickies')
  @ApiOperation({ summary: 'Get personal stickies in project' })
  async getProjectStickies(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.getProjectStickies(projectId, userId);
  }

  @Post('project/:projectId/stickies')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create personal sticky in project' })
  async createProjectSticky(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
  ) {
    return this.stickyService.createProjectSticky(projectId, userId, dto);
  }

  @Put('project/:projectId/stickies/reorder')
  @ApiOperation({ summary: 'Reorder personal stickies in project' })
  async reorderProjectStickies(@Body() dto: ReorderStickiesDto) {
    return this.stickyService.reorderStickies(dto.stickyIds);
  }

  @Put('stickies/:stickyId')
  @ApiOperation({ summary: 'Update personal sticky' })
  async updateSticky(
    @Param('stickyId') stickyId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStickyDto,
  ) {
    return this.stickyService.updateSticky(stickyId, userId, dto);
  }

  @Delete('stickies/:stickyId')
  @ApiOperation({ summary: 'Delete personal sticky' })
  async deleteSticky(
    @Param('stickyId') stickyId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.deleteSticky(stickyId, userId);
  }
}
