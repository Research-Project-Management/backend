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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { StickyService } from './sticky.service';
import {
  CreateStickyDto,
  UpdateStickyDto,
  ReorderStickiesDto,
} from './dto/sticky.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Collaboration')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class StickyController {
  constructor(private readonly stickyService: StickyService) {}

  @Get('workspace/:workspaceId/stickies')
  async getWorkspaceStickies(@Param('workspaceId') workspaceId: string) {
    return this.stickyService.getWorkspaceStickies(workspaceId);
  }

  @Post('workspace/:workspaceId/stickies')
  @HttpCode(HttpStatus.CREATED)
  async createWorkspaceSticky(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
  ) {
    return this.stickyService.createWorkspaceSticky(workspaceId, userId, dto);
  }

  @Put('workspace/:workspaceId/stickies/reorder')
  async reorderWorkspaceStickies(@Body() dto: ReorderStickiesDto) {
    return this.stickyService.reorderStickies(dto.stickyIds);
  }

  @Get('project/:projectId/stickies')
  async getProjectStickies(@Param('projectId') projectId: string) {
    return this.stickyService.getProjectStickies(projectId);
  }

  @Post('project/:projectId/stickies')
  @HttpCode(HttpStatus.CREATED)
  async createProjectSticky(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
  ) {
    return this.stickyService.createProjectSticky(projectId, userId, dto);
  }

  @Put('project/:projectId/stickies/reorder')
  async reorderProjectStickies(@Body() dto: ReorderStickiesDto) {
    return this.stickyService.reorderStickies(dto.stickyIds);
  }

  @Put('stickies/:stickyId')
  async updateSticky(
    @Param('stickyId') stickyId: string,
    @Body() dto: UpdateStickyDto,
  ) {
    return this.stickyService.updateSticky(stickyId, dto);
  }

  @Delete('stickies/:stickyId')
  async deleteSticky(@Param('stickyId') stickyId: string) {
    return this.stickyService.deleteSticky(stickyId);
  }
}
