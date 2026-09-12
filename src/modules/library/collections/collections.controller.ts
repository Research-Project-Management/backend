import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  MoveItemsDto,
  ReorderCollectionsDto,
  AssignItemsToCollectionDto,
} from './dto/collections.dto';
import { CollectionDeleteStrategy } from './types/collections.types';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';

@ApiTags('Library Collections')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/collections')
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  @ApiOperation({ summary: 'List all collections for user' })
  async getCollections(@CurrentUser('id') userId: string) {
    return this.collectionsService.getCollections(userId);
  }

  @Get('tree')
  @ApiOperation({ summary: 'Get collection tree for user' })
  async getCollectionTree(@CurrentUser('id') userId: string) {
    return this.collectionsService.getCollectionTree(userId);
  }

  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder collections' })
  async reorderCollections(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderCollectionsDto,
  ) {
    return this.collectionsService.reorderCollections(
      userId,
      dto.collections,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create collection' })
  async createCollection(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collectionsService.createCollection(userId, dto);
  }

  @Get(':collectionId')
  @ApiOperation({ summary: 'Get collection by ID' })
  async getCollectionById(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
  ) {
    return this.collectionsService.getCollectionById(userId, collectionId);
  }

  @Put(':collectionId')
  @ApiOperation({ summary: 'Update collection' })
  async updateCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collectionsService.updateCollection(
      userId,
      collectionId,
      dto,
    );
  }

  @Delete(':collectionId')
  @ApiOperation({ summary: 'Delete collection' })
  async deleteCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Query('strategy') strategy?: CollectionDeleteStrategy,
  ) {
    return this.collectionsService.deleteCollection(
      userId,
      collectionId,
      strategy,
    );
  }

  @Post(':collectionId/move-items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move items to collection' })
  async moveItems(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: MoveItemsDto,
  ) {
    return this.collectionsService.moveItems(
      userId,
      collectionId,
      dto.itemIds || dto.paperIds || [],
    );
  }

  @Post(':collectionId/items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign items to collection' })
  async assignItemsToCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Body() dto: AssignItemsToCollectionDto,
  ) {
    return this.collectionsService.assignItemsToCollection(
      userId,
      collectionId,
      dto,
    );
  }

  @Delete(':collectionId/items/:itemId')
  @ApiOperation({ summary: 'Detach item from collection' })
  async detachItemFromCollection(
    @CurrentUser('id') userId: string,
    @Param('collectionId') collectionId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.collectionsService.detachItemFromCollection(
      userId,
      collectionId,
      itemId,
    );
  }
}
