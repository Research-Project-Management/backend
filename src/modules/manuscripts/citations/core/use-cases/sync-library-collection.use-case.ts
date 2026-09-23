/**
 * citations/core/use-cases/sync-library-collection.use-case.ts
 * Inbound Use Case: Synchronizes an external reference collection (Zotero / Flux Library) into the project.
 */

import { ILibrarySyncPort } from '../ports/library-sync.port';
import { IBibtexParserPort } from '../ports/bibtex-parser.port';
import { ICitationsAggregatorPort } from '../ports/citations-aggregator.port';

export interface SyncLibraryCollectionCommand {
  projectId: string;
  userId: string;
  collectionId: string;
  targetFilename?: string;
}

export interface SyncLibraryCollectionResult {
  collectionId: string;
  syncedCount: number;
  filePath: string;
}

export class SyncLibraryCollectionUseCase {
  constructor(
    private readonly librarySync: ILibrarySyncPort,
    private readonly bibParser: IBibtexParserPort,
    private readonly aggregator: ICitationsAggregatorPort
  ) {}

  public async execute(
    command: SyncLibraryCollectionCommand
  ): Promise<SyncLibraryCollectionResult> {
    const rawBibtex = await this.librarySync.fetchCollectionBibtex(
      command.userId,
      command.collectionId
    );

    const entries = this.bibParser.parse(rawBibtex);
    const targetFile = command.targetFilename || 'references.bib';

    let lastPath = targetFile;
    for (const entry of entries) {
      lastPath = await this.aggregator.appendEntryToBib(
        command.projectId,
        entry,
        targetFile
      );
    }

    return {
      collectionId: command.collectionId,
      syncedCount: entries.length,
      filePath: lastPath,
    };
  }

  public async listUserCollections(userId: string) {
    return this.librarySync.listCollections(userId);
  }
}
