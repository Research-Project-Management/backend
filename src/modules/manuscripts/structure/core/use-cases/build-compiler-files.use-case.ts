/**
 * modules/manuscripts/structure/core/use-cases/build-compiler-files.use-case.ts
 * Integrates Structure tree and Docstore lines into WorkspaceFile[] for CLSI compilation.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { IStructureRepository } from '@/modules/manuscripts/structure/core/ports/structure-repository.port';
import { ResolveRootDocUseCase } from './resolve-root-doc.use-case';
import { WorkspaceFile } from '@/modules/manuscripts/clsi/domain';
import { RootDocNotFoundError } from '@/modules/manuscripts/structure/core/domain/structure-errors';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';

export interface CompilationPayload {
  rootDocPath: string;
  files: WorkspaceFile[];
}

@Injectable()
export class BuildCompilerFilesUseCase {
  private readonly logger = new Logger(BuildCompilerFilesUseCase.name);

  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly resolveRootDocUseCase: ResolveRootDocUseCase,
    @Optional() private readonly filestoreService?: FilestoreService,
  ) {}

  public async execute(
    projectId: string,
    docContentsMap: Map<string, { lines: string[]; hash?: string | null }>,
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
      rootNode = await this.resolveRootDocUseCase.autoDetectAndSetRootDoc(
        projectId,
        linesMap,
      );
    }

    if (!rootNode) {
      throw new RootDocNotFoundError(projectId);
    }

    // 2. Package WorkspaceFile[] for CLSI
    const files: WorkspaceFile[] = [];

    for (const node of nodes) {
      if (node.isFolder()) continue; // Directory nodes are represented by file paths

      // Strip leading '/' and './' for relative compiler paths inside workspace
      const relativePath = node.path
        .trim()
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/^\/+/, '');

      if (node.isDoc()) {
        const docData =
          docContentsMap.get(node.id) ||
          (node.docId ? docContentsMap.get(node.docId) : undefined);
        const content = docData ? docData.lines.join('\n') : '';
        const hash = docData?.hash || node.hash || undefined;

        files.push({
          path: relativePath,
          content,
          hash,
        });
      } else if (node.isFile()) {
        let binaryContent: Buffer | string = '';
        if (node.fileId && this.filestoreService) {
          try {
            const { stream } = await this.filestoreService.openReadStream(
              projectId,
              node.fileId,
            );
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            binaryContent = Buffer.concat(chunks);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to read binary file ${node.fileId} (${relativePath}) from filestore: ${msg}`,
            );
          }
        }

        files.push({
          path: relativePath,
          content: binaryContent,
          hash: node.hash || undefined,
        });
      }
    }

    const relativeRootPath = rootNode.path
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');

    return {
      rootDocPath: relativeRootPath,
      files,
    };
  }
}
