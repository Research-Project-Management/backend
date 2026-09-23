/**
 * modules/manuscripts/structure/core/adapters/engine/heuristic-root-doc.detector.ts
 * Adapter implementing Overleaf-grade heuristic algorithm (_rootDocSort)
 * to automatically detect the main LaTeX compilation document.
 */

import { Injectable } from '@nestjs/common';
import { IRootDocDetector } from '../../ports/root-doc-detector.port';
import { ManuscriptNodeEntity } from '../../domain/manuscript-node.entity';

const VALID_ROOT_EXTENSIONS = ['.tex', '.rtex', '.rnw'];

@Injectable()
export class HeuristicRootDocDetector implements IRootDocDetector {
  public detectRootDoc(
    nodes: ManuscriptNodeEntity[],
    docContents: Map<string, string[]>
  ): ManuscriptNodeEntity | null {
    // 1. Filter candidates: Must be DOC and have valid TeX extension
    const candidates = nodes.filter((n) => {
      if (!n.isDoc()) return false;
      const lowerName = n.name.toLowerCase();
      return VALID_ROOT_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
    });

    if (candidates.length === 0) {
      return null;
    }

    // 2. Sort candidates using Overleaf _rootDocSort logic
    const sorted = [...candidates].sort((a, b) => this.rootDocSort(a, b));

    // 3. Find first candidate with \documentclass declaration
    for (const candidate of sorted) {
      const lines = docContents.get(candidate.id) || (candidate.docId ? docContents.get(candidate.docId) : undefined);
      if (lines && this.contentHasDocumentclass(lines)) {
        return candidate;
      }
    }

    // 4. Fallback: If none have \documentclass, return top-sorted candidate in root folder
    return sorted[0] || null;
  }

  /**
   * Port of Overleaf _rootDocSort:
   * 1. Depth: Folders closer to root '/' are prioritized
   * 2. Canonical name: 'main.tex' is prioritized over other filenames
   * 3. Size: Smaller files are prioritized (LaTeX master documents are usually concise)
   * 4. Lexicographical: Alphabetical order
   */
  public rootDocSort(a: ManuscriptNodeEntity, b: ManuscriptNodeEntity): number {
    // Priority 1: Folder depth
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }

    // Priority 2: main.tex name match
    const aLower = a.name.toLowerCase();
    const bLower = b.name.toLowerCase();
    if (aLower === 'main.tex' && bLower !== 'main.tex') return -1;
    if (aLower !== 'main.tex' && bLower === 'main.tex') return 1;

    // Priority 3: Smaller file size (prefer master index files that \input subfiles)
    if (a.sizeBytes !== b.sizeBytes) {
      return a.sizeBytes - b.sizeBytes;
    }

    // Priority 4: Alphabetical tie-breaker
    return a.path.localeCompare(b.path);
  }

  private contentHasDocumentclass(lines: string[]): boolean {
    const documentclassRegex = /\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]+\}/;
    for (const line of lines) {
      // Ignore LaTeX comments
      const cleanLine = line.split(/(?<!\\)%/)[0];
      if (documentclassRegex.test(cleanLine)) {
        return true;
      }
    }
    return false;
  }
}
