/**
 * citations/core/adapters/external/manuscript-bib-aggregator.adapter.ts
 * Adapter implementing ICitationsAggregatorPort.
 * Discovers and collects all *.bib files via StructureService & DocstoreService,
 * and handles appending newly resolved BibTeX entries to the project.
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ICitationsAggregatorPort } from '../../ports/citations-aggregator.port';
import { IBibtexParserPort, BIBTEX_PARSER_PORT } from '../../ports/bibtex-parser.port';
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
    private readonly bibParser: IBibtexParserPort
  ) {}

  public async collectBibFiles(projectId: string): Promise<BibliographyFile[]> {
    const bibFiles: BibliographyFile[] = [];

    try {
      const nodes = await this.structureService.getAllNodes(projectId);
      const bibNodes = nodes.filter(
        (n: ManuscriptNodeEntity) => n.isDoc() && n.name.toLowerCase().endsWith('.bib')
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
            })
          );
        } catch (err: any) {
          this.logger.warn(`Failed to read doc ${node.docId} for ${node.path}: ${err.message}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`Error scanning bib nodes for project ${projectId}: ${err.message}`);
    }

    return bibFiles;
  }

  public async appendEntryToBib(
    projectId: string,
    entry: BibEntry,
    targetFilename = 'references.bib'
  ): Promise<string> {
    const cleanFilename = targetFilename.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    const cleanPath = `/${cleanFilename}`;

    const nodes = await this.structureService.getAllNodes(projectId);
    const targetNode = nodes.find(
      (n: ManuscriptNodeEntity) => n.path === cleanPath || n.name === cleanFilename
    );

    const bibString = entry.toBibtexString();
    const entryLines = bibString.split('\n');

    if (targetNode && targetNode.docId) {
      // Append to existing document
      const doc = await this.docstoreService.getDoc(projectId, targetNode.docId);
      const currentLines = doc.lines || [];
      const updatedLines = [...currentLines, '', ...entryLines];

      await this.docstoreService.updateDoc(projectId, targetNode.docId, {
        lines: updatedLines,
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
}
