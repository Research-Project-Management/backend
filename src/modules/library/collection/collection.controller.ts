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
import { CollectionService } from './collection.service';
import { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library')
@ApiBearerAuth('JWT-auth')
@Controller('api/library')
@UseGuards(JwtAuthGuard)
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  @Get(['collections/:workspaceId', ':workspaceId/collections'])
  async getCollections(@Param('workspaceId') workspaceId: string) {
    return this.collectionService.getCollections(workspaceId);
  }

  @Post(['collections/:workspaceId', ':workspaceId/collections'])
  @HttpCode(HttpStatus.CREATED)
  async createCollection(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collectionService.createCollection(workspaceId, userId, dto);
  }

  @Get([
    'collections/:workspaceId/:collectionId',
    ':workspaceId/collections/:collectionId',
  ])
  async getCollectionById(@Param('collectionId') collectionId: string) {
    return this.collectionService.getCollectionById(collectionId);
  }

  @Put([
    'collections/:workspaceId/:collectionId',
    ':workspaceId/collections/:collectionId',
  ])
  async updateCollection(
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collectionService.updateCollection(collectionId, dto);
  }

  @Delete([
    'collections/:workspaceId/:collectionId',
    ':workspaceId/collections/:collectionId',
  ])
  async deleteCollection(@Param('collectionId') collectionId: string) {
    return this.collectionService.deleteCollection(collectionId);
  }
}
