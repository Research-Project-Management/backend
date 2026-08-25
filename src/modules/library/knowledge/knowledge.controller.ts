import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { KnowledgeService } from './knowledge.service';
import { LinkPaperDto } from './dto/knowledge.dto';
import { JwtAuthGuard } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authz';

@ApiTags('Library - Related Items & Knowledge Graph')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Get([
    'workspace/:workspaceId/library/knowledge/graph',
    'workspace/:workspaceId/library/graph',
    'library/knowledge/:workspaceId/graph',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Get full knowledge graph (nodes and semantic edges) for the workspace library',
  })
  async getWorkspaceKnowledgeGraph(@Param('workspaceId') workspaceId: string) {
    return this.knowledgeService.getWorkspaceKnowledgeGraph(workspaceId);
  }

  @Get([
    'workspace/:workspaceId/library/items/:paperId/related',
    'library/knowledge/:workspaceId/:paperId',
  ])
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all papers related to a specific paper' })
  async getRelatedPapers(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
  ) {
    return this.knowledgeService.getRelatedPapers(workspaceId, paperId);
  }

  @Post([
    'workspace/:workspaceId/library/items/:paperId/related',
    'library/knowledge/:workspaceId/:paperId/link',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a symmetric bi-directional relationship between two papers with semantic type',
  })
  async linkPapers(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @Body() dto: LinkPaperDto,
  ) {
    return this.knowledgeService.linkPapers(workspaceId, paperId, dto);
  }

  @Delete([
    'workspace/:workspaceId/library/items/:paperId/related/:targetPaperId',
    'library/knowledge/:workspaceId/:paperId/link/:targetPaperId',
  ])
  @WorkspaceRoles('owner', 'admin', 'member')
  @ApiOperation({
    summary: 'Remove a bi-directional relationship between two papers',
  })
  async unlinkPapers(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
    @Param('targetPaperId') targetPaperId: string,
  ) {
    return this.knowledgeService.unlinkPapers(
      workspaceId,
      paperId,
      targetPaperId,
    );
  }
}
