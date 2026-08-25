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
import { JwtAuthGuard } from '@/modules/iam/authentication';

@ApiTags('Library - Related Items & Knowledge Graph')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/knowledge')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Get(':workspaceId/:paperId')
  @ApiOperation({ summary: 'Get all papers related to a specific paper' })
  async getRelatedPapers(
    @Param('workspaceId') workspaceId: string,
    @Param('paperId') paperId: string,
  ) {
    return this.knowledgeService.getRelatedPapers(workspaceId, paperId);
  }

  @Post(':workspaceId/:paperId/link')
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

  @Delete(':workspaceId/:paperId/link/:targetPaperId')
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

  @Get(':workspaceId/graph')
  @ApiOperation({
    summary:
      'Get full knowledge graph (nodes and semantic edges) for the workspace library',
  })
  async getWorkspaceKnowledgeGraph(@Param('workspaceId') workspaceId: string) {
    return this.knowledgeService.getWorkspaceKnowledgeGraph(workspaceId);
  }
}
