/**
 * modules/manuscripts/structure/core/ports/root-doc-detector.port.ts
 * Port interface for heuristic detection of the main compilation entrypoint (main.tex).
 */

import { ManuscriptNodeEntity } from '../domain/manuscript-node.entity';

export abstract class IRootDocDetector {
  /**
   * Evaluates project nodes and document lines to detect the master LaTeX document.
   * Priority: Depth -> Name 'main.tex' -> Reverse Size (smaller is better) -> Lexical -> \documentclass scan.
   */
  abstract detectRootDoc(
    nodes: ManuscriptNodeEntity[],
    docContents: Map<string, string[]>
  ): ManuscriptNodeEntity | null;
}
