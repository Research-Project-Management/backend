/**
 * modules/manuscripts/structure/core/use-cases/build-compiler-files.use-case.ts
 * Integrates Structure tree and Docstore lines into WorkspaceFile[] for CLSI compilation.
 */

import { Injectable } from '@nestjs/common';
import { IStructureRepository } from '../ports/structure-repository.port';
import { ResolveRootDocUseCase } from './resolve-root-doc.use-case';
import { WorkspaceFile } from '../../../clsi/core/ports/workspace.port';
import { RootDocNotFoundError } from '../domain/structure-errors';

export interface CompilationPayload {
  rootDocPath: string;
  files: WorkspaceFile[];
}

@Injectable()
export class BuildCompilerFilesUseCase {
  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly resolveRootDocUseCase: ResolveRootDocUseCase
  ) {}

  public async execute(
    projectId: string,
    docContentsMap: Map<string, { lines: string[]; hash?: string | null }>
  ): Promise<CompilationPayload> {
    const nodes = await this.structureRepository.getAllNodes(projectId);

    // 1. Resolve Root Document
    let rootNode = await this.resolveRootDocUseCase.getRootDoc(projectId);
    if (!rootNode) {
      // Build lines map for detector
      const linesMap = new Map<string, string[]>();
      for (const [id, val] of docContentsMap.entries()) {
        linesMap.set(id, val.lines);
      }
      rootNode = await this.resolveRootDocUseCase.autoDetectAndSetRootDoc(projectId, linesMap);
    }

    if (!rootNode) {
      throw new RootDocNotFoundError(projectId);
    }

    // 2. Package WorkspaceFile[] for CLSI
    const files: WorkspaceFile[] = [];

    for (const node of nodes) {
      if (node.isFolder()) continue; // Directory nodes are represented by file paths

      // Strip leading '/' for relative compiler paths inside workspace
      const relativePath = node.path.startsWith('/') ? node.path.substring(1) : node.path;

      if (node.isDoc()) {
        const docData = docContentsMap.get(node.id) || (node.docId ? docContentsMap.get(node.docId) : undefined);
        const content = docData ? docData.lines.join('\n') : '';
        const hash = docData?.hash || node.hash || undefined;

        files.push({
          path: relativePath,
          content,
          hash,
        });
      } else if (node.isFile()) {
        // Binary files: content or placeholder
        files.push({
          path: relativePath,
          content: '',
          hash: node.hash || undefined,
        });
      }
    }

    const relativeRootPath = rootNode.path.startsWith('/') ? rootNode.path.substring(1) : rootNode.path;

    return {
      rootDocPath: relativeRootPath,
      files,
    };
  }
}
