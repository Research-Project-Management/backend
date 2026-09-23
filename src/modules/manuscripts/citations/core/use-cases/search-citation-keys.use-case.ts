/**
 * citations/core/use-cases/search-citation-keys.use-case.ts
 * Inbound Use Case: Searches all .bib files in the project to power editor \cite{...} autocompletion.
 */

import { ICitationsAggregatorPort } from '../ports/citations-aggregator.port';
import { BibEntry } from '../domain/entities/bib-entry.entity';

export interface SearchCitationKeysCommand {
  projectId: string;
  query?: string;
  limit?: number;
}

export class SearchCitationKeysUseCase {
  constructor(private readonly aggregator: ICitationsAggregatorPort) {}

  public async execute(command: SearchCitationKeysCommand): Promise<BibEntry[]> {
    const bibFiles = await this.aggregator.collectBibFiles(command.projectId);
    const limit = command.limit && command.limit > 0 ? command.limit : 50;

    const allMatches: BibEntry[] = [];
    const seenKeys = new Set<string>();

    for (const file of bibFiles) {
      const matches = file.findMatches(command.query);
      for (const m of matches) {
        const lowerKey = m.key.value.toLowerCase();
        if (!seenKeys.has(lowerKey)) {
          seenKeys.add(lowerKey);
          allMatches.push(m);
        }
        if (allMatches.length >= limit) {
          break;
        }
      }
      if (allMatches.length >= limit) {
        break;
      }
    }

    return allMatches;
  }
}
