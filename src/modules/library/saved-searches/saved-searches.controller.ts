import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { SavedSearchesService } from './saved-searches.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';
import {
  CreateSavedSearchDto,
  UpdateSavedSearchDto,
  PreviewSavedSearchDto,
  ExecuteSavedSearchQueryDto,
} from './dto/saved-search.dto';

@Controller('api/v1/library/saved-searches')
@UseGuards(JwtAuthGuard)
export class SavedSearchesController {
  constructor(private readonly service: SavedSearchesService) {}

  @Get()
  async findAll(@CurrentUser('id') userId: string) {
    return this.service.findAll(userId);
  }

  @Post()
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSavedSearchDto,
  ) {
    return this.service.create(userId, dto);
  }

  @Post('preview')
  async preview(
    @CurrentUser('id') userId: string,
    @Body() dto: PreviewSavedSearchDto,
  ) {
    return this.service.preview(userId, dto);
  }

  @Get(':id')
  async findById(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.findById(userId, id);
  }

  @Patch(':id')
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateSavedSearchDto,
  ) {
    return this.service.update(userId, id, dto);
  }

  @Delete(':id')
  async delete(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    return this.service.delete(userId, id);
  }

  @Get(':id/results')
  async execute(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ExecuteSavedSearchQueryDto,
  ) {
    return this.service.execute(userId, id, query);
  }
}

