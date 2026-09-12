import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/tags.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';

@ApiTags('Library Tags')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  @ApiOperation({ summary: 'List library tags' })
  async getTags(
    @CurrentUser('id') userId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.tagsService.getTags(userId, {
      includeInactive: includeInactive === 'true',
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or get tag' })
  async createTag(
    @CurrentUser('id') userId: string,
    @Body() body: CreateTagDto,
  ) {
    return this.tagsService.createOrGetTag(
      userId,
      body.name,
      body.color,
      body.type,
    );
  }

  @Delete('automatic')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete automatic tags' })
  async deleteAutomaticTags(@CurrentUser('id') userId: string) {
    return this.tagsService.deleteAutomaticTags(userId);
  }

  @Delete(':tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a tag' })
  async deleteTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
  ) {
    const deleted = await this.tagsService.deleteTag(userId, tagId);
    if (!deleted) {
      throw new NotFoundException(`Tag ${tagId} not found`);
    }
  }

  @Post(':tagId/items/:itemId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Assign tag to an item' })
  async assignTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
  ) {
    await this.tagsService.assignTag(userId, tagId, itemId);
    return { success: true };
  }

  @Delete(':tagId/items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove tag from an item' })
  async removeTag(
    @CurrentUser('id') userId: string,
    @Param('tagId') tagId: string,
    @Param('itemId') itemId: string,
  ) {
    await this.tagsService.removeTag(userId, tagId, itemId);
  }
}
