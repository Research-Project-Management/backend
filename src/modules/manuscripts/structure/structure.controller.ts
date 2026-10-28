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
import {
  NodeNotFoundError,
  DuplicateNodePathError,
  CyclicMoveError,
  InvalidNodeNameError,
  CannotDeleteRootFolderError,
  RootDocNotFoundError,
  MaxProjectFilesExceededError,
} from './domain';

@ApiTags('Manuscripts - Project Structure & File Tree')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/manuscripts/projects/:projectId/structure',
  'api/v1/manuscripts/pages/:projectId/structure',
  'api/v1/manuscripts/docs/:projectId/structure',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class StructureController {
  constructor(private readonly structureService: StructureService) {}

  private handleError(error: unknown): never {
    if (
      error instanceof NodeNotFoundError ||
      error instanceof RootDocNotFoundError
    ) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof DuplicateNodePathError) {
      throw new ConflictException(error.message);
    }
    if (
      error instanceof CyclicMoveError ||
      error instanceof InvalidNodeNameError ||
      error instanceof CannotDeleteRootFolderError ||
      error instanceof MaxProjectFilesExceededError
    ) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  private resolveScope(
    paramProjectId: string,
    resolvedProject?: string | { id?: string } | null,
  ): string {
    const authorized =
      typeof resolvedProject === 'string'
        ? resolvedProject
        : resolvedProject?.id;
    return authorized || paramProjectId;
  }

  @Get('tree')
  @ApiOperation({
    summary: 'Get hierarchical recursive file tree for IDE sidebar',
  })
  @ApiResponse({ status: 200, type: [TreeNodeDto] })
  async getFileTree(
    @Param('projectId') projectId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      return await this.structureService.getFileTree(targetId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('nodes')
  @ApiOperation({ summary: 'Get flat list of all nodes in project' })
  async getAllNodes(
    @Param('projectId') projectId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const nodes = await this.structureService.getAllNodes(targetId);
      return nodes.map((n) => n.toJSON());
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('nodes/:nodeId')
  @ApiOperation({ summary: 'Get single node metadata by ID' })
  async getNodeById(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const node = await this.structureService.getNodeById(targetId, nodeId);
      if (!node) {
        throw new NodeNotFoundError(nodeId);
      }
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('nodes')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Create new file, document, or folder with auto-mkdirp',
  })
  async createNode(
    @Param('projectId') projectId: string,
    @Body() dto: CreateNodeDto,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const node = await this.structureService.createNode(targetId, dto);
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
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
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const node = await this.structureService.moveNode(targetId, nodeId, dto);
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
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
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const node = await this.structureService.renameNode(
        targetId,
        nodeId,
        dto,
      );
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('nodes/:nodeId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Delete node and all nested descendants' })
  async deleteNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const deleted = await this.structureService.deleteNode(targetId, nodeId);
      return {
        deletedCount: deleted.length,
        nodes: deleted.map((n) => n.toJSON()),
      };
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('root-doc')
  @ApiOperation({ summary: 'Get current root compilation document (main.tex)' })
  async getRootDoc(
    @Param('projectId') projectId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const rootDoc = await this.structureService.getRootDoc(targetId);
      if (!rootDoc) {
        return null;
      }
      return rootDoc.toJSON();
    } catch (err) {
      if (err instanceof RootDocNotFoundError) {
        return null;
      }
      this.handleError(err);
    }
  }

  @Post('root-doc/:nodeId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Explicitly set the master LaTeX entrypoint' })
  async setRootDoc(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @ResolvedProject() resolvedProject?: string | { id?: string },
  ) {
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      const rootDoc = await this.structureService.setRootDoc(targetId, nodeId);
      return rootDoc.toJSON();
    } catch (err) {
      this.handleError(err);
    }
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
    try {
      const targetId = this.resolveScope(projectId, resolvedProject);
      await this.structureService.reorderNode(targetId, nodeId, dto.sortOrder);
    } catch (err) {
      this.handleError(err);
    }
  }
}
