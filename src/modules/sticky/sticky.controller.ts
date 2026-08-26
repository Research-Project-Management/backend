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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';

@ApiTags('Personal Sticky Notes')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class StickyController {
  constructor(private readonly stickyService: StickyService) {}

  @Get(['workspaces/:workspaceId/stickies', 'workspace/:workspaceId/stickies'])
  @ApiOperation({ summary: 'Get personal stickies in workspace' })
  async getWorkspaceStickies(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.getWorkspaceStickies(workspaceId, userId);
  }

  @Post(['workspaces/:workspaceId/stickies', 'workspace/:workspaceId/stickies'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create personal sticky in workspace' })
  async createWorkspaceSticky(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
  ) {
    return this.stickyService.createWorkspaceSticky(workspaceId, userId, dto);
  }

  @Put([
    'workspaces/:workspaceId/stickies/reorder',
    'workspace/:workspaceId/stickies/reorder',
  ])
  @ApiOperation({ summary: 'Reorder personal stickies in workspace' })
  async reorderWorkspaceStickies(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderStickiesDto,
  ) {
    return this.stickyService.reorderStickies(dto.stickyIds, userId);
  }

  @Get(['projects/:projectId/stickies', 'project/:projectId/stickies'])
  @ApiOperation({ summary: 'Get personal stickies in project' })
  async getProjectStickies(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.getProjectStickies(projectId, userId);
  }

  @Post(['projects/:projectId/stickies', 'project/:projectId/stickies'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create personal sticky in project' })
  async createProjectSticky(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
  ) {
    return this.stickyService.createProjectSticky(projectId, userId, dto);
  }

  @Put([
    'projects/:projectId/stickies/reorder',
    'project/:projectId/stickies/reorder',
  ])
  @ApiOperation({ summary: 'Reorder personal stickies in project' })
  async reorderProjectStickies(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderStickiesDto,
  ) {
    return this.stickyService.reorderStickies(dto.stickyIds, userId);
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
