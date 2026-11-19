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
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ExperimentsService } from '../services/experiments.service';
import { TrashService } from '../services/trash.service';
import { FileScope } from '../domain/node.domain';
import {
  ExperimentsAccessPolicy,
  normalizeExperimentProjectId,
} from '../domain/access.policy';
import {
  buildPaginatedExperimentsResponse,
  parsePagination,
  parseTypesQuery,
} from '../domain/experiments.mapper';
import { BatchFileIdsDto } from '../dto/experiments.dto';

@ApiTags('Experiments')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/experiments/files')
@UseGuards(JwtAuthGuard)
export class TrashController {
  constructor(
    private readonly experimentsService: ExperimentsService,
    private readonly trashService: TrashService,
    private readonly accessPolicy: ExperimentsAccessPolicy,
  ) {}

  private async assertBatchTrashAccess(
    userId: string | undefined,
    ids: string[],
  ): Promise<void> {
    if (!userId) return;
    await Promise.all(
      ids.map((id) =>
        this.accessPolicy.assertCanAccess(userId, id, 'delete', {
          allowTrashed: true,
        }),
      ),
    );
  }

  @Get('trash')
  @ApiOperation({ summary: 'List files and folders currently in trash' })
  async getTrash(
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
    @Query('type') type?: string,
    @Query('types') types?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const pagination = parsePagination(limit, offset, page);
    const parsedTypes = parseTypesQuery(types, type);
    const normalizedProjectId = normalizeExperimentProjectId(spaceId, userId);

    if (normalizedProjectId && userId) {
      await this.accessPolicy.assertCanAccessProject(
        userId,
        normalizedProjectId,
        'read',
      );
    }

    const result = await this.experimentsService.list({
      userId: normalizedProjectId ? undefined : userId,
      projectId: normalizedProjectId,
      scope: normalizedProjectId ? FileScope.Project : undefined,
      trashedOnly: true,
      search: search?.trim() || undefined,
      sortBy: sortBy || undefined,
      sortOrder: sortOrder || 'asc',
      types: parsedTypes,
      limit: pagination.take,
      offset: pagination.skip,
    });
    return buildPaginatedExperimentsResponse(result, pagination);
  }

  @Post(':id/restore')
  @Put(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore file from trash' })
  async restoreFile(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'delete', {
        allowTrashed: true,
      });
    }
    const count = await this.trashService.restore(id);
    return { success: true, count };
  }

  @Delete(':id/permanent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Permanently delete file and reclaim quota' })
  async permanentDelete(
    @Param('id') id: string,
    @CurrentUser('id') userId?: string,
  ) {
    if (userId) {
      await this.accessPolicy.assertCanAccess(userId, id, 'delete', {
        allowTrashed: true,
      });
    }
    await this.trashService.permanentDelete(id);
    return { success: true };
  }

  @Post('batch/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch restore files from trash' })
  async batchRestore(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchFileIdsDto,
  ) {
    await this.assertBatchTrashAccess(userId, dto.ids);
    const count = await this.trashService.batchRestore(dto.ids);
    return { success: true, count };
  }

  @Post('batch/permanent')
  @Delete('batch/permanent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch permanently delete files from trash' })
  async batchPermanentDelete(
    @CurrentUser('id') userId: string,
    @Body() dto: BatchFileIdsDto,
  ) {
    await this.assertBatchTrashAccess(userId, dto.ids);
    const count = await this.trashService.batchPermanentDelete(dto.ids);
    return { success: true, count };
  }
}
