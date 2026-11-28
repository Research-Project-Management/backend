/**
 * modules/pages/structure/structure.controller.ts
 * REST API Controller for Page Virtual Tree & Hierarchy.
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
  Req,
  HttpStatus,
  HttpCode,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
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
  ResolvedSpace,
} from '@/modules/project/access';
import { StructureService } from './structure.service';
import {
  CreateNodeDto,
  MoveNodeDto,
  RenameNodeDto,
  ReorderNodeDto,
  TreeNodeDto,
} from './dto/node.dto';
import { NodeNotFoundError, StructureError } from './domain/structure.errors';
import { resolvePageControllerCoordinates } from '@/modules/pages/core';

@ApiTags('Pages - Virtual Tree & Structure')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/pages',
  'api/v1/pages/spaces/:spaceId/structure',
  'api/v1/pages/pages/:pageId/structure',
  'api/v1/pages/:spaceId/structure',
  'api/v1/pages/docs/:docId/structure',
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
    params: { spaceId?: string; pageId?: string; docId?: string },
    resolvedSpace?: string | { id?: string } | null,
    queryPageId?: string,
    req?: FastifyRequest,
  ): { spaceId: string; pageId?: string } {
    return resolvePageControllerCoordinates(
      params,
      resolvedSpace,
      queryPageId,
      req,
    );
  }

  private async execute<T>(
    params: { spaceId?: string; pageId?: string; docId?: string },
    resolvedSpace: string | { id?: string } | null | undefined,
    fn: (targetId: string, pageId?: string) => Promise<T>,
    queryPageId?: string,
    req?: FastifyRequest,
  ): Promise<T> {
    try {
      const { spaceId, pageId } = this.resolveCoordinates(
        params,
        resolvedSpace,
        queryPageId,
        req,
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
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      (targetId, pageId) => this.structureService.getFileTree(targetId, pageId),
      queryPageId,
      req,
    );
  }

  @Get('symbols')
  @ApiOperation({
    summary:
      'Get unified project symbol catalog (labels, citations, commands, environments, packages, outline, files)',
  })
  async getProjectSymbols(
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      (targetId, pageId) =>
        this.structureService.getProjectSymbols(targetId, pageId),
      queryPageId,
      req,
    );
  }

  @Get('outline')
  @ApiOperation({
    summary:
      'Get structured LaTeX document outline (sections, figures, tables, slides, appendices)',
  })
  async getProjectOutline(
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('filePath') filePath?: string,
    @Query('docId') docId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      (targetId, pageId) =>
        this.structureService.getProjectOutline(
          targetId,
          { filePath, docId },
          pageId,
        ),
      queryPageId,
      req,
    );
  }

  @Post('outline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Extract structured LaTeX document outline from live buffer or project file',
  })
  async extractOutline(
    @Body()
    body: {
      content?: string;
      filePath?: string;
      docId?: string;
      pageId?: string;
    },
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      (targetId, pageId) =>
        this.structureService.getProjectOutline(targetId, body, pageId),
      body?.pageId || queryPageId,
      req,
    );
  }

  @Get('nodes')
  @ApiOperation({ summary: 'Get flat list of all nodes in project' })
  async getAllNodes(
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Query('parentId') parentId?: string,
    @Query('pageId') queryPageId?: string,
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
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
      req,
    );
  }

  @Get('nodes/:nodeId')
  @ApiOperation({ summary: 'Get single node metadata by ID' })
  async getNodeById(
    @Param('nodeId') nodeId: string,
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId) => {
        const node = await this.structureService.getNodeById(targetId, nodeId);
        if (!node) {
          throw new NodeNotFoundError(nodeId);
        }
        return node.toJSON();
      },
      queryPageId,
      req,
    );
  }

  @Post('nodes')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Create new file, document, or folder with auto-mkdirp',
  })
  async createNode(
    @Body() dto: CreateNodeDto,
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId, pageId) => {
        const node = await this.structureService.createNode(
          targetId,
          dto,
          pageId,
        );
        return node.toJSON();
      },
      dto?.pageId || queryPageId,
      req,
    );
  }

  @Patch('nodes/:nodeId/move')
  @Post('nodes/:nodeId/move')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Move node to destination folder or path (with cycle detection)',
  })
  async moveNode(
    @Param('nodeId') nodeId: string,
    @Body() dto: MoveNodeDto,
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId) => {
        const node = await this.structureService.moveNode(
          targetId,
          nodeId,
          dto,
        );
        return node.toJSON();
      },
      queryPageId,
      req,
    );
  }

  @Patch('nodes/:nodeId/rename')
  @Post('nodes/:nodeId/rename')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({
    summary: 'Rename node (cascades path updates to all children if folder)',
  })
  async renameNode(
    @Param('nodeId') nodeId: string,
    @Body() dto: RenameNodeDto,
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId) => {
        const node = await this.structureService.renameNode(
          targetId,
          nodeId,
          dto,
        );
        return node.toJSON();
      },
      queryPageId,
      req,
    );
  }

  @Delete('nodes/:nodeId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Delete node and all nested descendants' })
  async deleteNode(
    @Param('nodeId') nodeId: string,
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId) => {
        const deleted = await this.structureService.deleteNode(
          targetId,
          nodeId,
        );
        return {
          deletedCount: deleted.length,
          nodes: deleted.map((n) => n.toJSON()),
        };
      },
      queryPageId,
      req,
    );
  }

  @Get('root-doc')
  @ApiOperation({ summary: 'Get current root compilation document (main.tex)' })
  async getRootDoc(
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId, pageId) => {
        const rootDoc = await this.structureService.getRootDoc(
          targetId,
          pageId,
        );
        return rootDoc ? rootDoc.toJSON() : null;
      },
      queryPageId,
      req,
    );
  }

  @Post('root-doc/:nodeId')
  @RequireRole(Role.CONTRIBUTOR)
  @ApiOperation({ summary: 'Explicitly set the master LaTeX entrypoint' })
  async setRootDoc(
    @Param('nodeId') nodeId: string,
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId) => {
        const rootDoc = await this.structureService.setRootDoc(
          targetId,
          nodeId,
        );
        return rootDoc.toJSON();
      },
      queryPageId,
      req,
    );
  }

  @Post('nodes/:nodeId/reorder')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Update sort order index for display' })
  async reorderNode(
    @Param('nodeId') nodeId: string,
    @Body() dto: ReorderNodeDto,
    @Param('spaceId') spaceId?: string,
    @Param('pageId') paramPageId?: string,
    @Param('docId') paramDocId?: string,
    @Query('pageId') queryPageId?: string,
    @ResolvedSpace() resolvedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    return this.execute(
      { spaceId, pageId: paramPageId, docId: paramDocId },
      resolvedSpace,
      async (targetId) => {
        await this.structureService.reorderNode(
          targetId,
          nodeId,
          dto.sortOrder,
        );
      },
      queryPageId,
      req,
    );
  }
}
