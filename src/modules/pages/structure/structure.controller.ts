/**
 * modules/manuscripts/structure/structure.controller.ts
 * REST API Controller for Manuscript Project File Tree & Hierarchy.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpStatus,
  HttpCode,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  ProjectAccessGuard,
  RequireRole,
  Role,
  ResolvedProject,
} from '@/modules/project/access';
import { StructureService } from './structure.service';
import {
  CreateNodeDto,
  MoveNodeDto,
  RenameNodeDto,
  ReorderNodeDto,
  TreeNodeDto,
} from './dto/node.dto';
import { NodeNotFoundError, StructureError } from './domain';

@ApiTags('Manuscripts - Project Structure & File Tree')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages',
  'api/v1/manuscripts',
  'api/v1/pages/projects/:projectId/structure',
  'api/v1/pages/:projectId/structure',
  'api/v1/pages/docs/:projectId/structure',
  'api/v1/manuscripts/projects/:projectId/structure',
  'api/v1/manuscripts/pages/:projectId/structure',
  'api/v1/manuscripts/docs/:projectId/structure',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class StructureController {
  constructor(private readonly structureService: StructureService) {}

  private handleError(error: unknown): never {
    if (error instanceof StructureError) {
      if (error.httpStatus === HttpStatus.NOT_FOUND) {
        throw new NotFoundException(error.message);
      }
      if (error.httpStatus === HttpStatus.CONFLICT) {
        throw new ConflictException(error.message);
      }
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  private resolveCoordinates(
    paramProjectId: string,
    resolvedProject?: string | { id?: string } | null,
    queryPageId?: string,
  ): { spaceId: string; pageId?: string } {
    const authorized =
      typeof resolvedProject === 'string'
        ? resolvedProject
        : resolvedProject?.id;
    const spaceId = authorized || paramProjectId;
    const cleanQueryPageId = queryPageId?.trim() || undefined;
    const pageId =
      cleanQueryPageId && cleanQueryPageId !== spaceId
        ? cleanQueryPageId
        : authorized && paramProjectId && paramProjectId !== authorized
          ? paramProjectId
          : undefined;
    return { spaceId, pageId };
  }

  private resolveScope(
    paramProjectId: string,
    resolvedProject?: string | { id?: string } | null,
  ): string {
    return this.resolveCoordinates(paramProjectId, resolvedProject).spaceId;
  }

  private async execute<T>(
    projectId: string,
    resolvedProject: string | { id?: string } | null | undefined,
    fn: (targetId: string, pageId?: string) => Promise<T>,
    queryPageId?: string,
  ): Promise<T> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        projectId,
        resolvedProject,
        queryPageId,
      );
      return await fn(spaceId, pageId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('tree')
  @ApiOperation({
    summary: 'Get hierarchical recursive file tree for IDE sidebar',
  })
  @ApiResponse({ status: 200, type: [TreeNodeDto] })
  async getFileTree(
    @Param('projectId') projectId: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(
      projectId,
      resolvedProject,
      (targetId, pageId) => this.structureService.getFileTree(targetId, pageId),
      queryPageId,
    );
  }

  @Get('symbols')
  @ApiOperation({
    summary:
      'Get unified project symbol catalog (labels, citations, commands, environments, packages, outline, files)',
  })
  async getProjectSymbols(
    @Param('projectId') projectId: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(
      projectId,
      resolvedProject,
      (targetId, pageId) =>
        this.structureService.getProjectSymbols(targetId, pageId),
      queryPageId,
    );
  }

  @Get('outline')
  @ApiOperation({
    summary:
      'Get structured LaTeX document outline (sections, figures, tables, slides, appendices)',
  })
  async getProjectOutline(
    @Param('projectId') projectId: string,
    @Query('filePath') filePath?: string,
    @Query('docId') docId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(
      projectId,
      resolvedProject,
      (targetId, pageId) =>
        this.structureService.getProjectOutline(
          targetId,
          { filePath, docId },
          pageId,
        ),
      queryPageId,
    );
  }

  @Post('outline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Extract structured LaTeX document outline from live buffer or project file',
  })
  async extractOutline(
    @Param('projectId') projectId: string,
    @Body()
    body: {
      content?: string;
      filePath?: string;
      docId?: string;
      pageId?: string;
    },
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(
      projectId,
      resolvedProject,
      (targetId, pageId) =>
        this.structureService.getProjectOutline(targetId, body, pageId),
      body?.pageId || queryPageId,
    );
  }

  @Get('nodes')
  @ApiOperation({ summary: 'Get flat list of all nodes in project' })
  async getAllNodes(
    @Param('projectId') projectId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
    @Query('parentId') parentId?: string,
    @Query('pageId') queryPageId?: string,
  ) {
    return this.execute(
      projectId,
      resolvedProject,
      async (targetId, pageId) => {
        const nodes = parentId
          ? await this.structureService.getAllNodes(targetId, parentId, pageId)
          : await this.structureService.getAllNodes(
              targetId,
              undefined,
              pageId,
            );
        return nodes.map((n) => n.toJSON());
      },
      queryPageId,
    );
  }

  @Get('nodes/:nodeId')
  @ApiOperation({ summary: 'Get single node metadata by ID' })
  async getNodeById(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(projectId, resolvedProject, async (targetId) => {
      const node = await this.structureService.getNodeById(targetId, nodeId);
      if (!node) {
        throw new NodeNotFoundError(nodeId);
      }
      return node.toJSON();
    });
  }

  @Post('nodes')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Create new file, document, or folder with auto-mkdirp',
  })
  async createNode(
    @Param('projectId') projectId: string,
    @Body() dto: CreateNodeDto,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(
      projectId,
      resolvedProject,
      async (targetId, pageId) => {
        const node = await this.structureService.createNode(
          targetId,
          dto,
          pageId,
        );
        return node.toJSON();
      },
      dto?.pageId || queryPageId,
    );
  }

  @Patch('nodes/:nodeId/move')
  @Post('nodes/:nodeId/move')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Move node to destination folder or path (with cycle detection)',
  })
  async moveNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: MoveNodeDto,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(projectId, resolvedProject, async (targetId) => {
      const node = await this.structureService.moveNode(targetId, nodeId, dto);
      return node.toJSON();
    });
  }

  @Patch('nodes/:nodeId/rename')
  @Post('nodes/:nodeId/rename')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Rename node (cascades path updates to all children if folder)',
  })
  async renameNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: RenameNodeDto,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(projectId, resolvedProject, async (targetId) => {
      const node = await this.structureService.renameNode(
        targetId,
        nodeId,
        dto,
      );
      return node.toJSON();
    });
  }

  @Delete('nodes/:nodeId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Delete node and all nested descendants' })
  async deleteNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(projectId, resolvedProject, async (targetId) => {
      const deleted = await this.structureService.deleteNode(targetId, nodeId);
      return {
        deletedCount: deleted.length,
        nodes: deleted.map((n) => n.toJSON()),
      };
    });
  }

  @Get('root-doc')
  @ApiOperation({ summary: 'Get current root compilation document (main.tex)' })
  async getRootDoc(
    @Param('projectId') projectId: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(
      projectId,
      resolvedProject,
      async (targetId, pageId) => {
        const rootDoc = await this.structureService.getRootDoc(
          targetId,
          pageId,
        );
        return rootDoc ? rootDoc.toJSON() : null;
      },
      queryPageId,
    );
  }

  @Post('root-doc/:nodeId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Explicitly set the master LaTeX entrypoint' })
  async setRootDoc(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(projectId, resolvedProject, async (targetId) => {
      const rootDoc = await this.structureService.setRootDoc(targetId, nodeId);
      return rootDoc.toJSON();
    });
  }

  @Post('nodes/:nodeId/reorder')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Update sort order index for display' })
  async reorderNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: ReorderNodeDto,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    return this.execute(projectId, resolvedProject, async (targetId) => {
      await this.structureService.reorderNode(targetId, nodeId, dto.sortOrder);
    });
  }
}
