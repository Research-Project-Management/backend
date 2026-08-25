import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchCatalogQueryDto } from './dto/search.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';

@ApiTags('Library - Search')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get(':workspaceId')
  @ApiOperation({
    summary: 'Full-text search across catalog items in a workspace',
  })
  async searchCatalog(
    @Param('workspaceId') workspaceId: string,
    @Query() dto: SearchCatalogQueryDto,
  ) {
    return this.searchService.searchCatalog(workspaceId, dto);
  }
}
