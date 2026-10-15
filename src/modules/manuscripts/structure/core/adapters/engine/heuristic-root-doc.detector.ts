/**
 * modules/manuscripts/structure/core/adapters/engine/heuristic-root-doc.detector.ts
 * Adapter delegating Overleaf-grade heuristic algorithm (_rootDocSort) to pure FileTreeBuilder.
 */

import { Injectable } from '@nestjs/common';
import { IRootDocDetector } from '@/modules/manuscripts/structure/core/ports/root-doc-detector.port';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';
import { FileTreeBuilder } from '@/modules/manuscripts/structure/domain/file-tree.builder';

@Injectable()
export class HeuristicRootDocDetector implements IRootDocDetector {
  public detectRootDoc(
    nodes: ManuscriptNodeEntity[],
    docContents: Map<string, string[]>,
  ): ManuscriptNodeEntity | null {
    return FileTreeBuilder.detectRootDoc(nodes, docContents);
  }

  public rootDocSort(a: ManuscriptNodeEntity, b: ManuscriptNodeEntity): number {
    return FileTreeBuilder.rootDocSort(a, b);
  }
}
