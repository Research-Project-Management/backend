import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SearchService } from './search.service';
import {
  SearchDocumentQueryDto,
  BatchReplaceDocumentDto,
  SearchResultResponse,
  BatchReplaceResultResponse,
} from './dto/search-document.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Document - Search')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get([
    'projects/:projectId/documents/search',
    'projects/:projectId/search',
    'pages/:pageId/search',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Search documents across a project or page hierarchy' })
  async searchDocuments(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Query() queryDto: SearchDocumentQueryDto,
  ): Promise<SearchResultResponse> {
    const targetId = projectId || pageId;
    return this.searchService.searchProjectDocuments(targetId, queryDto);
  }

  @Post([
    'projects/:projectId/documents/search',
    'projects/:projectId/search',
    'pages/:pageId/search',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Search documents across a project (POST query body)' })
  async searchDocumentsPost(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @Body() queryDto: SearchDocumentQueryDto,
  ): Promise<SearchResultResponse> {
    const targetId = projectId || pageId;
    return this.searchService.searchProjectDocuments(targetId, queryDto);
  }

  @Post([
    'projects/:projectId/documents/replace',
    'projects/:projectId/replace',
    'pages/:pageId/replace',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Batch replace text across project documents' })
  async batchReplaceDocuments(
    @Param('projectId') projectId: string,
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() replaceDto: BatchReplaceDocumentDto,
  ): Promise<BatchReplaceResultResponse> {
    const targetId = projectId || pageId;
    return this.searchService.batchReplaceProjectDocuments(
      targetId,
      userId,
      replaceDto,
    );
  }
}
