import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ListDriveUseCase } from '../../application/use-cases/drive/list-drive.use-case';
import { SoftDeleteUseCase } from '../../application/use-cases/trash/soft-delete.use-case';
import { RestoreNodeUseCase } from '../../application/use-cases/trash/restore-node.use-case';
import { PermanentDeleteUseCase } from '../../application/use-cases/trash/permanent-delete.use-case';
import { StorageNode } from '../../domain/entities/storage-node.entity';
import { BatchFileIdsDto } from '../dto/file.dto';

@ApiTags('Storage & Trash')
@ApiBearerAuth('JWT-auth')
@Controller(['api/v1/storage/files', 'api/files', 'api/file'])
@UseGuards(JwtAuthGuard)
export class TrashController {
  constructor(
    private readonly listDriveUseCase: ListDriveUseCase,
    private readonly softDeleteUseCase: SoftDeleteUseCase,
    private readonly restoreNodeUseCase: RestoreNodeUseCase,
    private readonly permanentDeleteUseCase: PermanentDeleteUseCase,
  ) {}

  private mapNodeToDto(node: StorageNode) {
    return {
      id: node.id,
      filename: node.name,
      name: node.name,
      size: Number(node.size),
      mimeType: node.mimeType,
      isFolder: node.isFolder,
      starred: node.starred,
      isStarred: node.starred,
      parentId: node.parentId,
      parent: node.parentId,
      url: `/api/files/${encodeURIComponent(node.id)}/content`,
      thumbnail: (node.metadata as any)?.thumbnail || null,
      metaData: node.metadata || {},
      trashedAt: node.trashedAt ? node.trashedAt.toISOString() : null,
      author: {
        id: node.authorId,
        name: 'Researcher',
        email: '',
        avatar: '',
      },
      createdAt: node.createdAt
        ? node.createdAt.toISOString()
        : new Date().toISOString(),
      updatedAt: node.updatedAt
        ? node.updatedAt.toISOString()
        : new Date().toISOString(),
    };
  }

  @Get('trash')
  @ApiOperation({ summary: 'List files and folders currently in trash' })
  async getTrash(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('page') page?: number,
  ) {
    const take = limit ? Number(limit) : 100;
    const skip =
      offset !== undefined
        ? Number(offset)
        : page
          ? (Number(page) - 1) * take
          : 0;
    const currentPage = page ? Number(page) : Math.floor(skip / take) + 1;

    const result = await this.listDriveUseCase.execute({
      userId,
      trashedOnly: true,
      limit: take,
      offset: skip,
    });
    const files = (result.nodes || []).map((node) => this.mapNodeToDto(node));
    return {
      files,
      items: files,
      total: result.total,
      page: currentPage,
      limit: take,
      hasMore: skip + files.length < result.total,
    };
  }

  @Post(':id/trash')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete file to trash' })
  async moveToTrash(@Param('id') id: string) {
    const count = await this.softDeleteUseCase.execute(id);
    return { success: true, count };
  }

  @Post(':id/restore')
  @Put(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore file from trash' })
  async restoreFile(@Param('id') id: string) {
    const count = await this.restoreNodeUseCase.execute(id);
    return { success: true, count };
  }

  @Delete(':id/permanent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Permanently delete file and reclaim quota' })
  async permanentDelete(@Param('id') id: string) {
    await this.permanentDeleteUseCase.execute(id);
    return { success: true };
  }

  @Post('batch/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch restore files from trash' })
  async batchRestore(@Body() dto: BatchFileIdsDto) {
    let count = 0;
    for (const id of dto.ids) {
      try {
        await this.restoreNodeUseCase.execute(id);
        count++;
      } catch {}
    }
    return { success: true, count };
  }

  @Post('batch/permanent')
  @Delete('batch/permanent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch permanently delete files from trash' })
  async batchPermanentDelete(@Body() dto: BatchFileIdsDto) {
    let count = 0;
    for (const id of dto.ids) {
      try {
        await this.permanentDeleteUseCase.execute(id);
        count++;
      } catch {}
    }
    return { success: true, count };
  }
}
