/**
 * citations/core/adapters/external/manuscript-bib-aggregator.adapter.ts
 * Adapter implementing ICitationsAggregatorPort.
 * Discovers and collects all *.bib files via StructureService & DocstoreService,
 * and handles appending newly resolved BibTeX entries to the project.
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ICitationsAggregatorPort } from '../../ports/citations-aggregator.port';
import {
  IBibtexParserPort,
  BIBTEX_PARSER_PORT,
} from '../../ports/bibtex-parser.port';
import { BibliographyFile } from '../../domain/entities/bibliography-file.entity';
import { BibEntry } from '../../domain/entities/bib-entry.entity';
import { StructureService } from '../../../../structure/structure.service';
import { DocstoreService } from '../../../../docstore/docstore.service';
import { ManuscriptNodeEntity } from '../../../../structure/core/domain/manuscript-node.entity';

@Injectable()
export class ManuscriptBibAggregatorAdapter implements ICitationsAggregatorPort {
  private readonly logger = new Logger(ManuscriptBibAggregatorAdapter.name);

  constructor(
    @Inject(forwardRef(() => StructureService))
    private readonly structureService: StructureService,
    @Inject(forwardRef(() => DocstoreService))
    private readonly docstoreService: DocstoreService,
    @Inject(BIBTEX_PARSER_PORT)
    private readonly bibParser: IBibtexParserPort,
  ) {}

  public async collectBibFiles(projectId: string): Promise<BibliographyFile[]> {
    const bibFiles: BibliographyFile[] = [];

    try {
      const nodes = await this.structureService.getAllNodes(projectId);
      const bibNodes = nodes.filter(
        (n: ManuscriptNodeEntity) =>
          n.isDoc() && n.name.toLowerCase().endsWith('.bib'),
      );

      for (const node of bibNodes) {
        if (!node.docId) continue;
        try {
          const doc = await this.docstoreService.getDoc(projectId, node.docId);
          const rawText = (doc.lines || []).join('\n');
          const entries = this.bibParser.parse(rawText);
          bibFiles.push(
            new BibliographyFile({
              path: node.path,
              entries,
            }),
          );
        } catch (err: any) {
          this.logger.warn(
            `Failed to read doc ${node.docId} for ${node.path}: ${err.message}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Error scanning bib nodes for project ${projectId}: ${err.message}`,
      );
    }

    return bibFiles;
  }

  public async appendEntryToBib(
    projectId: string,
    entry: BibEntry,
    targetFilename = 'references.bib',
  ): Promise<string> {
    const cleanFilename = targetFilename
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
    const cleanPath = `/${cleanFilename}`;

    const nodes = await this.structureService.getAllNodes(projectId);
    const targetNode = nodes.find(
      (n: ManuscriptNodeEntity) =>
        n.path === cleanPath || n.name === cleanFilename,
    );

    const bibString = entry.toBibtexString();
    const entryLines = bibString.split('\n');

    if (targetNode && targetNode.docId) {
      // Upsert into existing document (replace entry with same citation key, else append)
      const doc = await this.docstoreService.getDoc(
        projectId,
        targetNode.docId,
      );
      const currentLines = doc.lines || [];
      const currentText = currentLines.join('\n');
      const updatedText = this.upsertEntryText(
        currentText,
        entry.key.value,
        bibString,
      );

      if (updatedText === currentText) {
        // Identical entry already present: avoid a no-op write / version bump.
        return targetNode.path;
      }

      await this.docstoreService.updateDoc(projectId, targetNode.docId, {
        lines: updatedText.split('\n'),
        version: (doc.version ?? 0) + 1,
        expectedRev: doc.rev,
      });

      return targetNode.path;
    }

    // Create new .bib document if not found
    const createdDoc = await this.docstoreService.createDoc(projectId, {
      path: cleanPath,
      lines: entryLines,
    });

    const newNode = await this.structureService.createNode(projectId, {
      path: cleanPath,
      name: cleanFilename,
      type: 'DOC',
      docId: createdDoc._id,
      parentId: null,
    });

    return newNode.path;
  }

  /**
   * Replace the entry block whose citation key matches `key` (case-insensitive,
   * as biber treats keys) with `bibString`. Any further blocks with the same key
   * (duplicates left by earlier blind appends) are removed. If no block matches,
   * the entry is appended at the end separated by a blank line.
   */
  private upsertEntryText(
    text: string,
    key: string,
    bibString: string,
  ): string {
    const targetKey = key.trim().toLowerCase();
    const ranges: Array<{ start: number; end: number }> = [];
    const entryStartRegex = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;

    let match: RegExpExecArray | null;
    while ((match = entryStartRegex.exec(text)) !== null) {
      const entryType = match[1].toLowerCase();
      if (
        entryType === 'comment' ||
        entryType === 'preamble' ||
        entryType === 'string'
      ) {
        continue;
      }
      const openIdx = match.index + match[0].indexOf('{');
      const closeIdx = this.findMatchingClosingBrace(text, openIdx);
      if (closeIdx === -1) break; // malformed tail: stop scanning, append below

      if (match[2].trim().toLowerCase() === targetKey) {
        ranges.push({ start: match.index, end: closeIdx + 1 });
      }
      entryStartRegex.lastIndex = closeIdx + 1;
    }

    if (ranges.length === 0) {
      const trimmed = text.replace(/\s+$/, '');
      return trimmed ? `${trimmed}\n\n${bibString}\n` : `${bibString}\n`;
    }

    // Rebuild text: first match replaced, later duplicates removed (with trailing blank lines).
    let result = '';
    let cursor = 0;
    ranges.forEach((r, idx) => {
      result += text.slice(cursor, r.start);
      if (idx === 0) {
        result += bibString;
        cursor = r.end;
      } else {
        // Drop the duplicate block and the whitespace that followed it
        const after = text.slice(r.end);
        const ws = after.match(/^\s*/)?.[0].length ?? 0;
        cursor = r.end + ws;
      }
    });
    result += text.slice(cursor);
    return result;
  }

  private findMatchingClosingBrace(text: string, openBraceIdx: number): number {
    let depth = 0;
    for (let i = openBraceIdx; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') {
        i++; // skip escaped character (e.g. \{ or \})
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
}
