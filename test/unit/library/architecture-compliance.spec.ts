import * as fs from 'fs';
import * as path from 'path';

function walkSync(dir: string, fileList: string[] = []): string[] {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      walkSync(filePath, fileList);
    } else if (filePath.endsWith('.ts') && !filePath.endsWith('.spec.ts')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

describe('Library Architecture & Design Compliance Guardrails', () => {
  const libraryRoot = path.resolve(__dirname, '../../../src/modules/library');
  const allFiles = walkSync(libraryRoot);

  it('SC-001: Zero process.env usage outside core/config/library.config.ts', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of allFiles) {
      const normalizedPath = file.replace(/\\/g, '/');
      if (normalizedPath.endsWith('/core/config/library.config.ts')) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes('process.env')) {
          violations.push({
            file: path.relative(libraryRoot, file),
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-002: Zero direct PrismaService in controllers, stages, outbox workers, or fulltext providers', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of allFiles) {
      const normalizedPath = file.replace(/\\/g, '/');
      const isBoundaryOrWorker =
        /\/controllers\//.test(normalizedPath) ||
        /\/stages\//.test(normalizedPath) ||
        normalizedPath.endsWith('outbox.worker.ts') ||
        normalizedPath.endsWith('full-text.provider.ts');

      if (!isBoundaryOrWorker) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/PrismaService/.test(line) && !line.trim().startsWith('//')) {
          violations.push({
            file: path.relative(libraryRoot, file),
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-002b: Zero direct repository injection in controllers or facades', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of allFiles) {
      const normalizedPath = file.replace(/\\/g, '/');
      const isControllerOrFacade =
        /\/controllers\//.test(normalizedPath) ||
        normalizedPath.endsWith('.facade.ts');

      if (!isControllerOrFacade) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        // Must not inject repositories directly in controllers or facades
        if (
          /private\s+readonly\s+\w*Repo(sitory)?\s*:\s*[A-Z]\w*Repository/.test(
            line,
          ) &&
          !line.trim().startsWith('//')
        ) {
          violations.push({
            file: path.relative(libraryRoot, file),
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-002c: Core domain & ports purity - no upward dependencies or framework coupling', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of allFiles) {
      const normalizedPath = file.replace(/\\/g, '/');
      const isPureCore =
        normalizedPath.includes('/core/domain/') ||
        normalizedPath.includes('/core/ports/');

      if (!isPureCore) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        // No imports from extraction/ingestion/search/catalog/citation/sync
        // No imports from @nestjs/
        if (
          /from\s+['"]@\/modules\/library\/(catalog|citation|extraction|ingestion|search|sync)/.test(
            line,
          ) ||
          /from\s+['"]@nestjs\//.test(line)
        ) {
          violations.push({
            file: path.relative(libraryRoot, file),
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-003: Zero generic "throw new Error(" in library module (typed domain exceptions only)', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (
          /throw\s+new\s+Error\(/.test(line) &&
          !line.trim().startsWith('//')
        ) {
          violations.push({
            file: path.relative(libraryRoot, file),
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-004: Decompose oversized files (> 750 lines, excluding static data catalogs/lexicons)', () => {
    const oversizedFiles: Array<{ file: string; lines: number }> = [];

    for (const file of allFiles) {
      const normalizedPath = file.replace(/\\/g, '/');
      // Exclude static lookup dictionaries
      if (
        normalizedPath.endsWith('.lexicon.ts') ||
        normalizedPath.endsWith('.catalog.ts') ||
        normalizedPath.endsWith('schema.constants.ts')
      ) {
        continue;
      }

      const content = fs.readFileSync(file, 'utf-8');
      const lineCount = content.split(/\r?\n/).length;
      if (lineCount > 750) {
        oversizedFiles.push({
          file: path.relative(libraryRoot, file),
          lines: lineCount,
        });
      }
    }

    expect(oversizedFiles).toEqual([]);
  });
  it('SC-005: Zero duck-typing degradation shims on core domain services (strict port interfaces required)', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    const domainServiceFiles = allFiles.filter((file) => {
      const normalized = file.replace(/\\/g, '/');
      return (
        normalized.endsWith('/catalog/services/items.service.ts') ||
        normalized.endsWith('/catalog/services/item-query.service.ts') ||
        normalized.endsWith('/catalog/services/collections.service.ts') ||
        normalized.endsWith('/extraction/services/pdf-annotation-importer.service.ts') ||
        normalized.endsWith('/extraction/services/attachment-renamer.service.ts') ||
        normalized.endsWith('/library.facade.ts')
      );
    });

    for (const file of domainServiceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (
          /typeof\s+(this\.\w+|helpers)\.\w+\s*===\s*['"]function['"]/.test(line) &&
          !line.trim().startsWith('//')
        ) {
          violations.push({
            file: path.relative(libraryRoot, file),
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-006: Strict Bounded Context Encapsulation (zero deep imports into another context internal folders)', () => {
    const boundedContexts = [
      'catalog',
      'citation',
      'extraction',
      'ingestion',
      'search',
      'sync',
    ];
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of allFiles) {
      const relPath = path.relative(libraryRoot, file).replace(/\\/g, '/');
      const sourceContext = boundedContexts.find((ctx) =>
        relPath.startsWith(`${ctx}/`),
      );
      if (!sourceContext) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);

      lines.forEach((line, index) => {
        if (line.trim().startsWith('//')) return;
        for (const targetContext of boundedContexts) {
          if (targetContext === sourceContext) continue;
          const deepImportPattern = new RegExp(
            `(?:@/modules/library/${targetContext}|\\.\\./${targetContext})/(?:services|repositories|controllers|domain|providers|stages|policies|parsers|subscribers|types|dto)/`,
          );
          if (deepImportPattern.test(line)) {
            violations.push({
              file: relPath,
              line: index + 1,
              match: line.trim(),
            });
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-007: Zero explicit "any" type annotations or casts across all Library Backend files', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of allFiles) {
      const relPath = path.relative(libraryRoot, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (/\bas\s+any\b|:\s*any\b|<any>|:\s*any\[\]/.test(line)) {
          violations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-008: Frontend Library file size (<= 800 lines, excluding static *.types.ts) & zero explicit "any"', () => {
    const feRoot = path.resolve(
      __dirname,
      '../../../../frontend/src/features/library',
    );
    if (!fs.existsSync(feRoot)) return;

    function walkFrontend(dir: string, list: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walkFrontend(full, list);
        } else if (
          (full.endsWith('.ts') || full.endsWith('.tsx')) &&
          !full.endsWith('.spec.ts') &&
          !full.endsWith('.test.ts')
        ) {
          list.push(full);
        }
      }
      return list;
    }

    const feFiles = walkFrontend(feRoot);
    const sizeViolations: Array<{ file: string; lines: number }> = [];
    const anyViolations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of feFiles) {
      const relPath = path.relative(feRoot, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);

      if (!relPath.endsWith('.types.ts') && lines.length > 800) {
        sizeViolations.push({ file: relPath, lines: lines.length });
      }

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (/\bas\s+any\b|:\s*any\b|<any>|:\s*any\[\]/.test(line)) {
          anyViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        }
      });
    }

    expect(sizeViolations).toEqual([]);
    expect(anyViolations).toEqual([]);
  });

  it('SC-009: Centralization of Data, State, Cache & Business Logic (Backend Repositories & Frontend Coordinators/SDK)', () => {
    // 1. Backend: Zero direct this.prisma calls in domain services (excluding infrastructure transaction.service.ts)
    const beDirectPrismaInServices: Array<{ file: string; line: number; match: string }> = [];
    for (const file of allFiles) {
      const relPath = path.relative(libraryRoot, file).replace(/\\/g, '/');
      if (!relPath.includes('/services/') || relPath.endsWith('sync/services/transaction.service.ts')) {
        continue;
      }
      const content = fs.readFileSync(file, 'utf-8');
      content.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim().startsWith('//') && /this\.prisma\./.test(line)) {
          beDirectPrismaInServices.push({
            file: relPath,
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }
    expect(beDirectPrismaInServices).toEqual([]);

    // 2. Frontend: Zero scattered useQueryClient, useQuery, useMutation, localStorage, or direct *Service.* in UI components
    const feRoot = path.resolve(
      __dirname,
      '../../../../frontend/src/features/library',
    );
    if (!fs.existsSync(feRoot)) return;

    function walkFrontend(dir: string, list: string[] = []): string[] {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walkFrontend(full, list);
        } else if (
          (full.endsWith('.ts') || full.endsWith('.tsx')) &&
          !full.endsWith('.spec.ts') &&
          !full.endsWith('.test.ts')
        ) {
          list.push(full);
        }
      }
      return list;
    }

    const feFiles = walkFrontend(feRoot);
    const feUiViolations: Array<{ file: string; line: number; match: string }> = [];
    const feDomainStorageViolations: Array<{ file: string; line: number; match: string }> = [];

    for (const file of feFiles) {
      const relPath = path.relative(feRoot, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split(/\r?\n/);

      if (relPath.startsWith('ui/')) {
        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (
            /\buseQueryClient\s*\(/.test(line) ||
            /\buseQuery\s*\(/.test(line) ||
            /\buseMutation\s*\(/.test(line) ||
            /\blocalStorage\b/.test(line) ||
            /\b(catalogService|collectionsService|attachmentsService|annotationsService|feedsService|savedSearchesService|relationsService|itemLinksService|libraryIngestionService)\./.test(
              line,
            )
          ) {
            feUiViolations.push({
              file: relPath,
              line: index + 1,
              match: trimmed,
            });
          }
        });
      }

      if (relPath.startsWith('domain/')) {
        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (/\blocalStorage\b/.test(line)) {
            feDomainStorageViolations.push({
              file: relPath,
              line: index + 1,
              match: trimmed,
            });
          }
        });
      }
    }

    expect(feUiViolations).toEqual([]);
    expect(feDomainStorageViolations).toEqual([]);
  });
});
