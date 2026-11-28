/**
 * modules/pages/structure/services/node-mutation.ts
 * Virtual tree node creation, folder materialization, move, rename, and delete helpers.
 */

import { Logger, NotFoundException } from '@nestjs/common';
import {
  DuplicateNodePathError,
  InvalidNodeNameError,
  NodeNotFoundError,
  StructureError,
} from '@/modules/pages/structure/domain/structure.errors';
import { FileTreeBuilder } from '@/modules/pages/structure/domain/tree-builder';
import type { StructureRepository } from '@/modules/pages/structure/structure.repository';
import { NodePathVo } from '@/modules/pages/core/utils/node-path';
import { PageNodeEntity } from '@/modules/pages/structure/domain/node.entity';
import { CreateNodeDto, MoveNodeDto, RenameNodeDto } from '../dto/node.dto';
import { PageDomainEventBus } from '@/modules/pages/core/events/event-bus.service';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';

export interface NodeMutationContext {
  readonly repository: StructureRepository;
  readonly logger: Logger;
  readonly domainEventBus: PageDomainEventBus;
  readonly realtimeService?: RealtimeFacade;
  readonly filestoreService?: FilestoreService;
  readonly docstoreService?: DocstoreService;
}

export async function mkdirpInternalHelper(
  repository: StructureRepository,
  projectId: string,
  dirPath: string,
  pageId?: string,
): Promise<PageNodeEntity> {
  const parsed = NodePathVo.parse(dirPath);
  if (parsed.normalizedPath === '/') {
    throw new StructureError('Cannot mkdirp root directory');
  }

  const segmentEntries: Array<{ segment: string; path: string }> = [];
  let runningPath = '';
  for (const segment of parsed.segments) {
    runningPath = NodePathVo.join(runningPath, segment);
    segmentEntries.push({ segment, path: runningPath });
  }

  const existingNodes = await Promise.all(
    segmentEntries.map((entry) =>
      repository.findByPath(projectId, entry.path, pageId),
    ),
  );

  let parentNode: PageNodeEntity | null = null;

  for (let i = 0; i < segmentEntries.length; i++) {
    const { segment, path: currentPath } = segmentEntries[i];
    let found = existingNodes[i];

    if (found && !found.isFolder()) {
      throw new DuplicateNodePathError(currentPath);
    }

    if (!found) {
      try {
        found = await repository.createNode({
          projectId,
          ...(pageId && pageId !== projectId ? { pageId } : {}),
          parentId: parentNode ? parentNode.id : null,
          type: 'FOLDER',
          name: segment,
          path: currentPath,
        });
      } catch (err: unknown) {
        const errObj = err as { code?: string; message?: string } | null;
        if (
          errObj?.code === 'P2002' ||
          errObj?.message?.includes('P2002') ||
          err instanceof DuplicateNodePathError
        ) {
          found = await repository.findByPath(projectId, currentPath, pageId);
          if (!found || !found.isFolder()) {
            throw new DuplicateNodePathError(currentPath);
          }
        } else {
          throw err;
        }
      }
    }

    parentNode = found;
  }

  return parentNode!;
}

export async function resolveOrMaterializeParentFolder(
  repository: StructureRepository,
  projectId: string,
  options: {
    parentId?: string | null;
    explicitPath?: string;
    leafName: string;
    parentRoleLabel?: string;
    pageId?: string;
  },
): Promise<{
  parentNode: PageNodeEntity | null;
  computedPath: string;
}> {
  const roleLabel = options.parentRoleLabel || 'Parent node';
  if (options.parentId) {
    const parentNode = await repository.findById(projectId, options.parentId);
    if (!parentNode) {
      throw new NodeNotFoundError(options.parentId);
    }
    if (
      options.pageId &&
      parentNode.pageId &&
      parentNode.pageId !== options.pageId
    ) {
      throw new InvalidNodeNameError(
        options.parentId,
        'Parent folder belongs to a different page',
      );
    }
    parentNode.assertCanContainChildren(roleLabel);
    return {
      parentNode,
      computedPath: NodePathVo.join(parentNode.path, options.leafName),
    };
  }

  if (options.explicitPath) {
    const parsed = NodePathVo.parse(options.explicitPath);
    if (parsed.parentPath === '/') {
      return { parentNode: null, computedPath: parsed.normalizedPath };
    }
    const existingParent = await repository.findByPath(
      projectId,
      parsed.parentPath,
      options.pageId,
    );
    if (existingParent) {
      existingParent.assertCanContainChildren(roleLabel);
      return {
        parentNode: existingParent,
        computedPath: parsed.normalizedPath,
      };
    }
    const createdParent = await mkdirpInternalHelper(
      repository,
      projectId,
      parsed.parentPath,
      options.pageId,
    );
    return {
      parentNode: createdParent,
      computedPath: parsed.normalizedPath,
    };
  }

  return {
    parentNode: null,
    computedPath: NodePathVo.join('/', options.leafName),
  };
}

export async function createNodeHelper(
  ctx: NodeMutationContext,
  projectId: string,
  dto: CreateNodeDto,
  pageId?: string,
): Promise<PageNodeEntity> {
  const rawTarget = dto.path && dto.path.trim() !== '' ? dto.path : dto.name;
  const parsedTarget = NodePathVo.parse(rawTarget);
  const leafName = parsedTarget.leafName || NodePathVo.parse(dto.name).leafName;
  NodePathVo.validateFilename(leafName);

  const candidatePageId = (pageId || dto.pageId || '').trim() || undefined;
  const resolvedInputPageId = candidatePageId;

  const currentCount = await ctx.repository.countNodes(
    projectId,
    resolvedInputPageId,
  );
  FileTreeBuilder.validateProjectFileLimit(currentCount);

  const explicitPath =
    dto.path && dto.path.trim() !== ''
      ? dto.path
      : !dto.parentId && parsedTarget.folderSegments.length > 0
        ? parsedTarget.normalizedPath
        : undefined;

  const { parentNode, computedPath } = await resolveOrMaterializeParentFolder(
    ctx.repository,
    projectId,
    {
      parentId: dto.parentId,
      explicitPath,
      leafName,
      parentRoleLabel: 'Parent node',
      pageId: resolvedInputPageId,
    },
  );

  const parentScopedPageId = parentNode?.pageId || undefined;
  const effectivePageId = resolvedInputPageId || parentScopedPageId;

  const existing = await ctx.repository.findByPath(
    projectId,
    computedPath,
    effectivePageId,
  );
  if (existing) {
    if (dto.type === 'FILE' && dto.fileId && existing.fileId === dto.fileId) {
      ctx.realtimeService?.broadcastFileTreeChange(projectId, {
        action: 'create',
        node: existing,
      });
      return existing;
    }
    throw new DuplicateNodePathError(computedPath);
  }

  if (dto.type === 'FILE' && dto.fileId && ctx.repository.findByFileId) {
    const preSyncedNode = await ctx.repository.findByFileId(
      projectId,
      dto.fileId,
      effectivePageId,
    );
    if (preSyncedNode) {
      await ctx.repository.moveSubtree(
        projectId,
        preSyncedNode.path,
        computedPath,
        parentNode ? parentNode.id : null,
        { nodeId: preSyncedNode.id, pageId: effectivePageId },
      );
      const movedNode =
        (await ctx.repository.findById(projectId, preSyncedNode.id)) ??
        preSyncedNode;
      ctx.realtimeService?.broadcastFileTreeChange(projectId, {
        action: 'create',
        node: movedNode,
      });
      return movedNode;
    }
  }

  let resolvedDocId = dto.docId;
  let resolvedSizeBytes: number | undefined;
  let resolvedHash: string | null | undefined;

  if (resolvedDocId && ctx.repository.docExistsInProject) {
    const exists = await ctx.repository.docExistsInProject(
      projectId,
      resolvedDocId,
      effectivePageId,
    );
    if (!exists) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'Document not found in page',
      });
    }
  } else if (dto.type === 'DOC' && !resolvedDocId && ctx.docstoreService) {
    const initialLines =
      dto.content && dto.content.length > 0 ? dto.content.split(/\r?\n/) : [''];
    const createdDoc = await ctx.docstoreService.createDoc(projectId, {
      ...(effectivePageId ? { pageId: effectivePageId } : {}),
      path: NodePathVo.toRelative(computedPath),
      lines: initialLines,
    });
    resolvedDocId = createdDoc.id;
    resolvedSizeBytes = createdDoc.sizeBytes;
    resolvedHash = createdDoc.hash;
  }

  if (dto.fileId && ctx.repository.fileExistsInProject) {
    const exists = await ctx.repository.fileExistsInProject(
      projectId,
      dto.fileId,
      effectivePageId,
    );
    if (!exists) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
        message: 'File asset not found in page',
      });
    }
  }

  try {
    let shouldSetRootDoc = Boolean(dto.isRootDoc && dto.type === 'DOC');
    if (
      !shouldSetRootDoc &&
      dto.type === 'DOC' &&
      /\.(tex|rtex|rnw)$/i.test(leafName)
    ) {
      const existingRoot = await ctx.repository
        .getRootDoc(projectId, effectivePageId)
        .catch(() => null);
      if (!existingRoot) {
        shouldSetRootDoc = true;
      }
    }
    const node = await ctx.repository.createNode({
      projectId,
      ...(effectivePageId ? { pageId: effectivePageId } : {}),
      parentId: parentNode ? parentNode.id : null,
      type: dto.type,
      name: leafName,
      path: computedPath,
      docId: resolvedDocId,
      fileId: dto.fileId,
      isRootDoc: shouldSetRootDoc,
      ...(resolvedSizeBytes !== undefined
        ? { sizeBytes: resolvedSizeBytes }
        : {}),
      ...(resolvedHash !== undefined ? { hash: resolvedHash } : {}),
    });

    if (shouldSetRootDoc) {
      try {
        await ctx.repository.setRootDoc(projectId, node.id);
        node.markAsRootDoc(true);
      } catch (rootErr: unknown) {
        ctx.logger.warn(
          `Failed to set root doc for newly created node ${node.id} in project ${projectId}: ${String(rootErr)}`,
        );
      }
    }

    ctx.realtimeService?.broadcastFileTreeChange(projectId, {
      action: 'create',
      node,
    });
    return node;
  } catch (err: unknown) {
    if (resolvedDocId && !dto.docId) {
      try {
        if (ctx.docstoreService) {
          if (typeof ctx.docstoreService.deleteDoc === 'function') {
            await ctx.docstoreService.deleteDoc(projectId, resolvedDocId, {
              soft: false,
            });
          } else {
            await ctx.docstoreService.patchDoc(projectId, resolvedDocId, {
              deleted: true,
              deletedAt: new Date().toISOString(),
            });
          }
        }
      } catch (rollbackErr) {
        ctx.logger.warn(
          `Failed to delete orphan backing doc ${resolvedDocId} after createNode error: ${String(rollbackErr)}`,
        );
      }
    }
    const errObj = err as { code?: string; message?: string } | null;
    if (errObj?.code === 'P2002' || errObj?.message?.includes('P2002')) {
      throw new DuplicateNodePathError(computedPath);
    }
    throw err;
  }
}

export async function moveNodeHelper(
  ctx: NodeMutationContext,
  projectId: string,
  nodeId: string,
  dto: MoveNodeDto,
): Promise<PageNodeEntity> {
  const targetNode = await ctx.repository.findById(projectId, nodeId);
  if (!targetNode) {
    throw new NodeNotFoundError(nodeId);
  }
  targetNode.assertMutableTarget();

  const nodePageId = targetNode.pageId || undefined;

  const targetParentId =
    dto.destParentId !== undefined ? dto.destParentId : dto.parentId;
  if (!targetParentId && dto.destPath) {
    const parsedCandidate = NodePathVo.parse(dto.destPath);
    targetNode.validateMoveTo(parsedCandidate.normalizedPath);
    const preConflict = await ctx.repository.findByPath(
      projectId,
      parsedCandidate.normalizedPath,
      nodePageId,
    );
    if (preConflict && preConflict.id !== targetNode.id) {
      throw new DuplicateNodePathError(parsedCandidate.normalizedPath);
    }
  }
  const { parentNode: destParent, computedPath: destPath } =
    await resolveOrMaterializeParentFolder(ctx.repository, projectId, {
      parentId: targetParentId,
      explicitPath: targetParentId ? undefined : dto.destPath,
      leafName: targetNode.name,
      parentRoleLabel: 'Destination parent',
      pageId: nodePageId,
    });
  const newParentId = destParent ? destParent.id : null;

  targetNode.validateMoveTo(destPath);

  const existing = await ctx.repository.findByPath(
    projectId,
    destPath,
    nodePageId,
  );
  if (existing && existing.id !== targetNode.id) {
    throw new DuplicateNodePathError(destPath);
  }

  const oldPath = targetNode.path;
  await ctx.repository.moveSubtree(projectId, oldPath, destPath, newParentId, {
    nodeId: targetNode.id,
    pageId: nodePageId ?? null,
  });

  const node = (await ctx.repository.findById(projectId, targetNode.id))!;

  ctx.realtimeService?.broadcastFileTreeChange(projectId, {
    action: 'move',
    node,
  });
  return node;
}

export async function renameNodeHelper(
  ctx: NodeMutationContext,
  projectId: string,
  nodeId: string,
  dto: RenameNodeDto,
): Promise<PageNodeEntity> {
  const existingNode = await ctx.repository.findById(projectId, nodeId);
  if (!existingNode) {
    throw new NodeNotFoundError(nodeId);
  }
  existingNode.assertMutableTarget();

  const nodePageId = existingNode.pageId || undefined;

  // If caller passes a relative or absolute path (e.g. "sections/new_name.tex" or "/new_name.tex"),
  // extract the leaf name when the parent folder is unchanged, or delegate to move+rename when the parent folder changes.
  const rawInput = (dto.name || '').trim();
  if (rawInput.includes('/') || rawInput.includes('\\')) {
    const parsed = NodePathVo.parse(rawInput);
    const currentParentPath = NodePathVo.dirname(existingNode.path);
    if (parsed.parentPath !== currentParentPath) {
      existingNode.validateMoveTo(parsed.normalizedPath);
      const preConflict = await ctx.repository.findByPath(
        projectId,
        parsed.normalizedPath,
        nodePageId,
      );
      if (preConflict && preConflict.id !== existingNode.id) {
        throw new DuplicateNodePathError(parsed.normalizedPath);
      }
      const { parentNode: destParent, computedPath: destPath } =
        await resolveOrMaterializeParentFolder(ctx.repository, projectId, {
          explicitPath: parsed.normalizedPath,
          leafName: parsed.leafName,
          parentRoleLabel: 'Destination parent',
          pageId: nodePageId,
        });
      existingNode.validateMoveTo(destPath);
      const conflict = await ctx.repository.findByPath(
        projectId,
        destPath,
        nodePageId,
      );
      if (conflict && conflict.id !== existingNode.id) {
        throw new DuplicateNodePathError(destPath);
      }
      await ctx.repository.moveSubtree(
        projectId,
        existingNode.path,
        destPath,
        destParent ? destParent.id : null,
        { nodeId: existingNode.id, pageId: nodePageId ?? null },
      );
      const movedAndRenamed = (await ctx.repository.findById(
        projectId,
        existingNode.id,
      ))!;
      ctx.realtimeService?.broadcastFileTreeChange(projectId, {
        action: 'rename',
        node: movedAndRenamed,
      });
      return movedAndRenamed;
    }
    dto = { ...dto, name: parsed.leafName };
  }

  const newName = dto.name;
  NodePathVo.validateFilename(newName);

  let node: PageNodeEntity;
  if (existingNode.name === newName) {
    node = existingNode;
  } else {
    const { oldPath, newPath } = existingNode.renameTo(newName);

    const conflict = await ctx.repository.findByPath(
      projectId,
      newPath,
      nodePageId,
    );
    if (conflict && conflict.id !== existingNode.id) {
      throw new DuplicateNodePathError(newPath);
    }

    if (existingNode.isFolder()) {
      await ctx.repository.moveSubtree(
        projectId,
        oldPath,
        newPath,
        existingNode.parentId,
        { nodeId: existingNode.id, pageId: nodePageId ?? null },
      );
      node = (await ctx.repository.findById(projectId, existingNode.id))!;
    } else {
      node = await ctx.repository.renameNode(
        projectId,
        existingNode.id,
        newName,
        newPath,
      );
    }
  }

  ctx.realtimeService?.broadcastFileTreeChange(projectId, {
    action: 'rename',
    node,
  });
  return node;
}

export async function deleteNodeHelper(
  ctx: NodeMutationContext,
  projectId: string,
  nodeId: string,
  autoDetectRootDocFn: (
    projectId: string,
    docContents: Map<string, string[]>,
    existingNodes?: PageNodeEntity[],
    pageId?: string | null,
  ) => Promise<PageNodeEntity | null>,
): Promise<PageNodeEntity[]> {
  const node = await ctx.repository.findById(projectId, nodeId);
  if (!node) {
    throw new NodeNotFoundError(nodeId);
  }
  node.assertMutableTarget();

  const nodePageId = node.pageId || undefined;

  const deletedNodes = await ctx.repository.deleteSubtree(
    projectId,
    node.path,
    nodePageId ?? null,
  );

  const docIds = Array.from(
    new Set(
      deletedNodes
        .map((n) => n.docId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  const fileIds = Array.from(
    new Set(
      deletedNodes
        .map((n) => n.fileId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  const hadRootDoc = deletedNodes.some((n) => n.isRootDoc);

  // NOTE: Soft-deleting nodes/subtrees preserves FileBlob ref-counts and SpaceQuota
  // while files remain restorable in Trash; reclamation happens strictly on permanent purge.

  await ctx.domainEventBus.publish({
    type: 'manuscript.nodes.deleted',
    projectId,
    deletedDocIds: docIds,
    deletedFileIds: fileIds,
    hadRootDoc,
    occurredAt: Date.now(),
  });

  if (hadRootDoc) {
    await ctx.repository.unsetRootDoc(projectId, nodePageId ?? null);
    const docContentsMap = new Map<string, string[]>();
    if (ctx.docstoreService) {
      try {
        const allDocs = await ctx.docstoreService.getAllDocs(
          projectId,
          nodePageId,
        );
        for (const d of allDocs) {
          const dId = d.id || d._id;
          if (dId && Array.isArray(d.lines)) {
            docContentsMap.set(dId, d.lines);
          }
        }
      } catch {
        // non-blocking fallback to filename-based root detection
      }
    }
    await autoDetectRootDocFn(
      projectId,
      docContentsMap,
      undefined,
      nodePageId ?? null,
    ).catch(() => null);
  }

  ctx.realtimeService?.broadcastFileTreeChange(projectId, {
    action: 'delete',
    node: { id: nodeId },
  });
  return deletedNodes;
}
