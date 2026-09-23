/**
 * citations/core/use-cases/validate-project-bibtex.use-case.ts
 * Inbound Use Case: Scans project bibliography files for duplicate keys, missing metadata, and syntax issues.
 */

import { ICitationsAggregatorPort } from '../ports/citations-aggregator.port';

export interface ValidateProjectBibtexResult {
  valid: boolean;
  totalFiles: number;
  totalEntries: number;
  duplicateKeys: string[];
  warnings: string[];
}

export class ValidateProjectBibtexUseCase {
  constructor(private readonly aggregator: ICitationsAggregatorPort) {}

  public async execute(projectId: string): Promise<ValidateProjectBibtexResult> {
    const bibFiles = await this.aggregator.collectBibFiles(projectId);

    const allKeysMap = new Map<string, string[]>(); // key -> [file1, file2, ...]
    const warnings: string[] = [];
    let totalEntries = 0;

    for (const file of bibFiles) {
      totalEntries += file.totalCount;

      for (const entry of file.entries) {
        const k = entry.key.value;
        const existing = allKeysMap.get(k) || [];
        existing.push(file.path);
        allKeysMap.set(k, existing);

        // Check for missing basic metadata fields
        if (!entry.title) {
          warnings.push(`Entry '${k}' in ${file.path} is missing a title.`);
        }
        if (!entry.authors.authors.length) {
          warnings.push(`Entry '${k}' in ${file.path} is missing an author.`);
        }
        if (!entry.year) {
          warnings.push(`Entry '${k}' in ${file.path} is missing a publication year.`);
        }
      }
    }

    // Find all duplicate keys across any files
    const duplicateKeys: string[] = [];
    for (const [k, files] of allKeysMap.entries()) {
      if (files.length > 1) {
        duplicateKeys.push(k);
        warnings.push(`Duplicate citation key '${k}' appears ${files.length} times in: ${files.join(', ')}`);
      }
    }

    const isValid = duplicateKeys.length === 0;

    return {
      valid: isValid,
      totalFiles: bibFiles.length,
      totalEntries,
      duplicateKeys,
      warnings,
    };
  }
}
