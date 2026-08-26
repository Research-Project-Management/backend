import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';
import { DiscoveryService } from './discovery.service';
import {
  SearchDiscoveryDto,
  CreateSavedSearchDto,
  PageAnchorSearchDto,
} from './dto/discovery.dto';

@Controller('api/v1/workspaces/:workspaceId/library/discovery')
@UseGuards(JwtAuthGuard)
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('search')
  async search(
    @Param('workspaceId') workspaceId: string,
    @Query() dto: SearchDiscoveryDto,
  ) {
    const result = await this.discoveryService.search(workspaceId, dto);
    return {
      success: true,
      data: result.items,
      meta: {
        ...result.meta,
        facets: result.facets,
      },
    };
  }

  @Get('page-anchors')
  async searchPageAnchors(@Query() dto: PageAnchorSearchDto) {
    const matches = await this.discoveryService.searchPageAnchors(
      dto.attachmentId,
      dto.term,
      dto.pageIndex,
    );
    return {
      success: true,
      data: matches,
    };
  }

  @Get('saved-searches')
  async listSavedSearches(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
  ) {
    const saved = await this.discoveryService.listSavedSearches(
      workspaceId,
      userId || 'system',
    );
    return {
      success: true,
      data: saved,
    };
  }

  @Post('saved-searches')
  async createSavedSearch(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSavedSearchDto,
  ) {
    const created = await this.discoveryService.createSavedSearch(
      workspaceId,
      userId || 'system',
      dto,
    );
    return {
      success: true,
      data: created,
    };
  }

  @Delete('saved-searches/:id')
  async deleteSavedSearch(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    const deleted = await this.discoveryService.deleteSavedSearch(
      workspaceId,
      userId || 'system',
      id,
    );
    if (!deleted) {
      throw new NotFoundException(`SavedSearch ${id} not found`);
    }
    return {
      success: true,
      data: { id, deleted: true },
    };
  }
}
