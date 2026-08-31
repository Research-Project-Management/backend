import * as fs from 'fs';
import * as path from 'path';

function getFilesRecursively(
  dir: string,
  predicate: (fileName: string) => boolean,
): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Library Type & Code Quality Invariants (T008)', () => {
  const rootSrcDir = path.resolve(__dirname, '../../src');
  const libraryDir = path.join(rootSrcDir, 'modules/library');

  it('Rule 1: New type definitions and ports must not use explicit any', () => {
    const portAndPureTypeFiles = getFilesRecursively(
      libraryDir,
      (f) =>
        (f.endsWith('.port.ts') ||
          f === 'creator.types.ts' ||
          f === 'identifier.types.ts' ||
          f === 'relation.types.ts') &&
        !f.endsWith('.spec.ts'),
    );

    const violations: { file: string; line: string }[] = [];

    for (const file of portAndPureTypeFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (/(:\s*any\b|<any>|\bas\s+any\b)/.test(line)) {
          violations.push({
            file: path.relative(rootSrcDir, file),
            line: line.trim(),
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('Rule 2: Production source code must not contain hardcoded fake or dummy IDs', () => {
    const sourceFiles = getFilesRecursively(
      libraryDir,
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    );

    const fakeIdPatterns = [
      /['"`]fake-[a-zA-Z0-9_-]+['"`]/i,
      /['"`]temp-[a-zA-Z0-9_-]+['"`]/i,
      /['"`]dummy-[a-zA-Z0-9_-]+['"`]/i,
      /['"`]00000000-0000-0000-0000-000000000000['"`]/,
    ];

    const violations: { file: string; match: string }[] = [];

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const cleanLine = line.trim();
        if (cleanLine.startsWith('//') || cleanLine.startsWith('*')) continue;

        for (const pattern of fakeIdPatterns) {
          if (pattern.test(cleanLine)) {
            violations.push({
              file: path.relative(rootSrcDir, file),
              match: cleanLine,
            });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('Rule 3: Catalog, Ports, and New Capabilities must never silently discard errors with empty catch blocks', () => {
    // Known legacy file with speculative execution catch debt scheduled for Phase 7 (US3) cleanup
    const legacyDebtAllowlist = new Set([
      path.normalize('modules/library/ingestion/ingestion.service.ts'),
    ]);

    const sourceFiles = getFilesRecursively(
      libraryDir,
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    );

    const emptyCatchRegex = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

    const violations: { file: string; match: string }[] = [];

    for (const file of sourceFiles) {
      const relPath = path.normalize(path.relative(rootSrcDir, file));
      if (legacyDebtAllowlist.has(relPath)) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.match(emptyCatchRegex);
      if (matches) {
        violations.push({
          file: relPath,
          match: matches.join(', '),
        });
      }
    }

    expect(violations).toEqual([]);
  });
});
