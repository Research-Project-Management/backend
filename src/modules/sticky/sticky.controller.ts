import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
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
  GetStickiesQueryDto,
} from './dto/sticky.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';

@ApiTags('Sticky Notes')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class StickyController {
  constructor(private readonly stickyService: StickyService) {}

  @Get(['me/stickies', 'stickies', 'projects/:projectId/stickies'])
  @ApiOperation({ summary: 'Get stickies (personal or project-scoped)' })
  async getStickies(
    @CurrentUser('id') userId: string,
    @Query() query: GetStickiesQueryDto,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = paramProjectId || query.projectId;
    return this.stickyService.getStickies(userId, projectId, query.search);
  }

  @Post(['me/stickies', 'stickies', 'projects/:projectId/stickies'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create sticky (personal or project-scoped)' })
  async createSticky(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
    @Param('projectId') paramProjectId?: string,
  ) {
    if (paramProjectId && !dto.projectId) {
      dto.projectId = paramProjectId;
    }
    return this.stickyService.createSticky(userId, dto);
  }

  @Put([
    'me/stickies/reorder',
    'stickies/reorder',
    'projects/:projectId/stickies/reorder',
  ])
  @ApiOperation({ summary: 'Reorder stickies' })
  async reorderStickies(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderStickiesDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const projectId = paramProjectId || queryProjectId;
    return this.stickyService.reorderStickies(dto.stickyIds, userId, projectId);
  }

  @Put('stickies/:stickyId')
  @ApiOperation({ summary: 'Update user sticky' })
  async updateSticky(
    @Param('stickyId') stickyId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStickyDto,
  ) {
    return this.stickyService.updateSticky(stickyId, userId, dto);
  }

  @Delete('stickies/:stickyId')
  @ApiOperation({ summary: 'Delete user sticky' })
  async deleteSticky(
    @Param('stickyId') stickyId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.deleteSticky(stickyId, userId);
  }
}
