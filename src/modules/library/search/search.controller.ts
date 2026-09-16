import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { SearchService } from './search.service';
import { SemanticSearchService } from './services/semantic-search.service';
import { SearchItemsQueryDto } from './dto/search.dto';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';

@Controller('api/v1/library/search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly semanticSearch: SemanticSearchService,
  ) {}

  @Get()
  async searchItems(
    @CurrentUser('id') userId: string,
    @Query() dto: SearchItemsQueryDto,
  ) {
    return this.searchService.search(userId, dto);
  }

  @Post('semantic')
  async searchSemantic(
    @CurrentUser('id') userId: string,
    @Body() dto: SemanticSearchDto,
  ) {
    return this.semanticSearch.searchSemantic(userId, dto);
  }

  @Get('items/:id/related')
  async getRelatedItems(
    @CurrentUser('id') userId: string,
    @Param('id') itemId: string,
    @Query('limit') limit?: string,
    @Query('projectId') projectId?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 5;
    return this.semanticSearch.findRelatedItems(
      userId,
      itemId,
      parsedLimit,
      projectId,
    );
  }

  @Post('index-all')
  async indexAll(
    @CurrentUser('id') userId: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.semanticSearch.indexLibrary(userId, projectId);
  }

  @Get('attachments/:attachmentId/anchors')
  async searchAnchors(
    @CurrentUser('id') userId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('term') term: string,
    @Query('pageIndex') pageIndex?: string,
  ) {
    const parsedPage =
      pageIndex !== undefined ? parseInt(pageIndex, 10) : undefined;
    return this.searchService.searchPageAnchors(
      userId,
      attachmentId,
      term,
      parsedPage,
    );
  }
}
