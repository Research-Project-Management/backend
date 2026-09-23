/**
 * modules/manuscripts/structure/core/use-cases/resolve-root-doc.use-case.ts
 * Resolves or explicitly assigns the master compilation entrypoint (main.tex).
 */

import { Injectable, Logger } from '@nestjs/common';
import { IStructureRepository } from '../ports/structure-repository.port';
import { IRootDocDetector } from '../ports/root-doc-detector.port';
import { ITreePublisher } from '../ports/tree-publisher.port';
import { ManuscriptNodeEntity } from '../domain/manuscript-node.entity';
import { NodeNotFoundError } from '../domain/structure-errors';

@Injectable()
export class ResolveRootDocUseCase {
  private readonly logger = new Logger(ResolveRootDocUseCase.name);

  constructor(
    private readonly structureRepository: IStructureRepository,
    private readonly rootDocDetector: IRootDocDetector,
    private readonly treePublisher: ITreePublisher
  ) {}

  public async getRootDoc(projectId: string): Promise<ManuscriptNodeEntity | null> {
    return await this.structureRepository.getRootDoc(projectId);
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity> {
    const node = await this.structureRepository.findById(projectId, nodeId);
    if (!node) {
      throw new NodeNotFoundError(nodeId);
    }
    if (!node.isDoc()) {
      throw new Error(`Cannot set node of type ${node.type} as root document. Must be DOC.`);
    }

    await this.structureRepository.setRootDoc(projectId, node.id);
    const updated = (await this.structureRepository.findById(projectId, node.id))!;

    await this.treePublisher.publishTreeMutation({
      projectId,
      action: 'root_doc_changed',
      nodeId: updated.id,
      path: updated.path,
      entityType: updated.type,
    });

    return updated;
  }

  public async autoDetectAndSetRootDoc(
    projectId: string,
    docContents: Map<string, string[]>
  ): Promise<ManuscriptNodeEntity | null> {
    const existing = await this.structureRepository.getRootDoc(projectId);
    if (existing) {
      return existing;
    }

    const allNodes = await this.structureRepository.getAllNodes(projectId);
    const detected = this.rootDocDetector.detectRootDoc(allNodes, docContents);

    if (detected) {
      await this.structureRepository.setRootDoc(projectId, detected.id);
      this.logger.log(`Auto-detected root document '${detected.path}' for project ${projectId}`);

      await this.treePublisher.publishTreeMutation({
        projectId,
        action: 'root_doc_changed',
        nodeId: detected.id,
        path: detected.path,
        entityType: detected.type,
      });

      return (await this.structureRepository.findById(projectId, detected.id))!;
    }

    return null;
  }
}
