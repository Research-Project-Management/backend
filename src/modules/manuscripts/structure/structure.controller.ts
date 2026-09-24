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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { StructureService } from './structure.service';
import { CreateNodeDto, MoveNodeDto, RenameNodeDto, ReorderNodeDto, TreeNodeDto } from './dto/node.dto';
import {
  NodeNotFoundError,
  DuplicateNodePathError,
  CyclicMoveError,
  InvalidNodeNameError,
  CannotDeleteRootFolderError,
  RootDocNotFoundError,
} from './core/domain/structure-errors';

@ApiTags('Manuscripts - Project Structure & File Tree')
@Controller([
  'manuscripts/projects/:projectId/structure',
  'api/manuscripts/projects/:projectId/structure',
  'projects/:projectId/structure',
  'api/projects/:projectId/structure',
])
export class StructureController {
  constructor(private readonly structureService: StructureService) {}

  private handleError(error: any): never {
    if (error instanceof NodeNotFoundError || error instanceof RootDocNotFoundError) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof DuplicateNodePathError) {
      throw new ConflictException(error.message);
    }
    if (
      error instanceof CyclicMoveError ||
      error instanceof InvalidNodeNameError ||
      error instanceof CannotDeleteRootFolderError
    ) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get('tree')
  @ApiOperation({ summary: 'Get hierarchical recursive file tree for IDE sidebar' })
  @ApiResponse({ status: 200, type: [TreeNodeDto] })
  async getFileTree(@Param('projectId') projectId: string) {
    try {
      return await this.structureService.getFileTree(projectId);
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('nodes')
  @ApiOperation({ summary: 'Get flat list of all nodes in project' })
  async getAllNodes(@Param('projectId') projectId: string) {
    try {
      const nodes = await this.structureService.getAllNodes(projectId);
      return nodes.map((n) => n.toJSON());
    } catch (err) {
      this.handleError(err);
    }
  }

  @Get('nodes/:nodeId')
  @ApiOperation({ summary: 'Get single node metadata by ID' })
  async getNodeById(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string
  ) {
    try {
      const node = await this.structureService.getNodeById(projectId, nodeId);
      if (!node) {
        throw new NodeNotFoundError(nodeId);
      }
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('nodes')
  @ApiOperation({ summary: 'Create new file, document, or folder with auto-mkdirp' })
  async createNode(
    @Param('projectId') projectId: string,
    @Body() dto: CreateNodeDto
  ) {
    try {
      const node = await this.structureService.createNode(projectId, dto);
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('nodes/:nodeId/move')
  @ApiOperation({ summary: 'Move node to destination folder or path (with cycle detection)' })
  async moveNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: MoveNodeDto
  ) {
    try {
      const node = await this.structureService.moveNode(projectId, nodeId, dto);
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Patch('nodes/:nodeId/rename')
  @ApiOperation({ summary: 'Rename node (cascades path updates to all children if folder)' })
  async renameNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: RenameNodeDto
  ) {
    try {
      const node = await this.structureService.renameNode(projectId, nodeId, dto);
      return node.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Delete('nodes/:nodeId')
  @ApiOperation({ summary: 'Delete node and all nested descendants' })
  async deleteNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string
  ) {
    try {
      const deleted = await this.structureService.deleteNode(projectId, nodeId);
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
  async getRootDoc(@Param('projectId') projectId: string) {
    try {
      const rootDoc = await this.structureService.getRootDoc(projectId);
      if (!rootDoc) {
        throw new RootDocNotFoundError(projectId);
      }
      return rootDoc.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('root-doc/:nodeId')
  @ApiOperation({ summary: 'Explicitly set the master LaTeX entrypoint' })
  async setRootDoc(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string
  ) {
    try {
      const rootDoc = await this.structureService.setRootDoc(projectId, nodeId);
      return rootDoc.toJSON();
    } catch (err) {
      this.handleError(err);
    }
  }

  @Post('nodes/:nodeId/reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Update sort order index for display' })
  async reorderNode(
    @Param('projectId') projectId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: ReorderNodeDto
  ) {
    try {
      await this.structureService.reorderNode(projectId, nodeId, dto.sortOrder);
    } catch (err) {
      this.handleError(err);
    }
  }
}
