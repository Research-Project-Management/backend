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
  const fileCache = new Map<string, { content: string; lines: string[]; normalizedPath: string; relPath: string }>();
  for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    fileCache.set(file, {
      content,
      lines: content.split(/\r?\n/),
      normalizedPath: file.replace(/\\/g, '/'),
      relPath: path.relative(libraryRoot, file).replace(/\\/g, '/'),
    });
  }

  const feRoot = path.resolve(
    __dirname,
    '../../../../frontend/src/features/library',
  );
  function walkFrontend(dir: string, list: string[] = []): string[] {
    if (!fs.existsSync(dir)) return list;
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
  const feFileCache = new Map<string, { content: string; lines: string[]; relPath: string }>();
  for (const file of feFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    feFileCache.set(file, {
      content,
      lines: content.split(/\r?\n/),
      relPath: path.relative(feRoot, file).replace(/\\/g, '/'),
    });
  }

  it('SC-001: Zero process.env usage outside core/config/library.config.ts', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const [file, { normalizedPath, lines }] of fileCache) {
      if (normalizedPath.endsWith('/core/config/library.config.ts')) {
        continue;
      }

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

    for (const [file, { normalizedPath, lines }] of fileCache) {
      const isBoundaryOrWorker =
        /\/controllers\//.test(normalizedPath) ||
        /\/stages\//.test(normalizedPath) ||
        normalizedPath.endsWith('outbox.worker.ts') ||
        normalizedPath.endsWith('full-text.provider.ts');

      if (!isBoundaryOrWorker) continue;

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

    for (const [file, { normalizedPath, lines }] of fileCache) {
      const isControllerOrFacade =
        /\/controllers\//.test(normalizedPath) ||
        normalizedPath.endsWith('.facade.ts');

      if (!isControllerOrFacade) continue;

      lines.forEach((line, index) => {
        // Must not inject repositories directly in controllers or facades
        if (
          /private\s+readonly\s+\w*Repo(sitory)?\??\s*:\s*[A-Z]\w*Repository/.test(
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

    for (const [file, { normalizedPath, lines }] of fileCache) {
      const isPureCore =
        normalizedPath.includes('/core/domain/') ||
        normalizedPath.includes('/core/ports/');

      if (!isPureCore) continue;

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

    for (const [file, { lines }] of fileCache) {
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

    for (const [file, { normalizedPath, lines }] of fileCache) {
      // Exclude static lookup dictionaries
      if (
        normalizedPath.endsWith('.lexicon.ts') ||
        normalizedPath.endsWith('.catalog.ts') ||
        normalizedPath.endsWith('schema.constants.ts')
      ) {
        continue;
      }

      const lineCount = lines.length;
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
      const normalized = fileCache.get(file)!.normalizedPath;
      return (
        normalized.endsWith('/catalog/services/items.service.ts') ||
        normalized.endsWith('/catalog/services/item-query.service.ts') ||
        normalized.endsWith('/catalog/services/collections.service.ts') ||
        normalized.endsWith('/extraction/services/pdf-annotation-importer.service.ts') ||
        normalized.endsWith('/extraction/services/attachment-renamer.service.ts') ||
        normalized.endsWith('/library.module.ts')
      );
    });

    for (const file of domainServiceFiles) {
      const { lines } = fileCache.get(file)!;
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

  it('SC-006: Strict Bounded Context Encapsulation (zero peer imports or sibling module couplings across non-core sub-modules)', () => {
    const boundedContexts = [
      'catalog',
      'citation',
      'extraction',
      'ingestion',
      'search',
      'sync',
    ];
    const contextModuleMap: Record<string, string> = {
      catalog: 'CatalogModule',
      citation: 'CitationModule',
      extraction: 'ExtractionModule',
      ingestion: 'IngestionModule',
      search: 'SearchModule',
      sync: 'SyncModule',
    };
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const [, { relPath, lines }] of fileCache) {
      const sourceContext = boundedContexts.find((ctx) =>
        relPath.startsWith(`${ctx}/`),
      );
      if (!sourceContext) continue;

      const isContextModuleFile =
        relPath === `${sourceContext}/${sourceContext}.module.ts`;

      lines.forEach((line, index) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        for (const targetContext of boundedContexts) {
          if (targetContext === sourceContext) continue;
          const peerImportPattern = new RegExp(
            `(?:@/modules/library/${targetContext}|\\.\\./${targetContext}|\\.\\./\\.\\./${targetContext})(?:/|['"])`,
          );
          if (peerImportPattern.test(line)) {
            violations.push({
              file: relPath,
              line: index + 1,
              match: line.trim(),
            });
          }

          if (isContextModuleFile) {
            const siblingModuleName = contextModuleMap[targetContext];
            if (new RegExp(`\\b${siblingModuleName}\\b`).test(line)) {
              violations.push({
                file: relPath,
                line: index + 1,
                match: `Sibling module coupling (${siblingModuleName}): ${line.trim()}`,
              });
            }
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it('SC-007: Zero explicit "any" type annotations or casts across all Library Backend files', () => {
    const violations: Array<{ file: string; line: number; match: string }> = [];

    for (const [, { relPath, lines }] of fileCache) {
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

  it('SC-008: Frontend Library file size (<= 750 lines, excluding static *.types.ts) & zero explicit "any"', () => {
    if (!fs.existsSync(feRoot)) return;

    const sizeViolations: Array<{ file: string; lines: number }> = [];
    const anyViolations: Array<{ file: string; line: number; match: string }> = [];

    for (const [, { relPath, lines }] of feFileCache) {
      if (!relPath.endsWith('.types.ts') && lines.length > 750) {
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
    // AND zero PrismaService / RedisCacheService / Repository imports inside /domain/ across all bounded contexts
    const beDirectPrismaInServices: Array<{ file: string; line: number; match: string }> = [];
    const beInfraInDomainViolations: Array<{ file: string; line: number; match: string }> = [];
    const beUpwardLayerViolations: Array<{ file: string; line: number; match: string }> = [];
    for (const [, { relPath, lines }] of fileCache) {
      const isControllerLayer = relPath.includes('/controllers/');
      const isInnerModelLayer =
        relPath.includes('/domain/') ||
        relPath.includes('/dto/') ||
        relPath.includes('/types/') ||
        relPath.includes('/parsers/');
      const isPureDomainLayer =
        relPath.includes('/domain/') ||
        relPath.includes('/policies/') ||
        relPath.includes('/parsers/');
      const isRepositoryLayer = relPath.includes('/repositories/');
      const isServiceOrStageLayer =
        relPath.includes('/services/') ||
        relPath.includes('/stages/') ||
        relPath.includes('/providers/');

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

        if (
          isControllerLayer &&
          /from\s+['"][^'"]*\/(repositories|domain|policies|parsers|providers|stages|extractors)\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          isPureDomainLayer &&
          /from\s+['"][^'"]*\/dto\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          relPath.includes('/domain/') &&
          /from\s+['"][^'"]*\/parsers\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          relPath.includes('/policies/') &&
          /from\s+['"]@\/modules\/library\/ingestion\/domain\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          relPath.includes('/types/') &&
          /from\s+['"][^'"]*\/(domain|policies|parsers|ports)\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          isInnerModelLayer &&
          /from\s+['"][^'"]*\/(controllers|services|repositories|stages|providers)\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          isRepositoryLayer &&
          /from\s+['"][^'"]*\/(controllers|services|stages|dto|parsers)\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          isServiceOrStageLayer &&
          /from\s+['"][^'"]*\/controllers\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          (relPath.includes('/providers/') || relPath.includes('/stages/')) &&
          (/from\s+['"](?!@\/modules\/library\/core\/)[^'"]*\/services\//.test(line) ||
            /from\s+['"][^'"]*\/repositories\//.test(line))
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        } else if (
          relPath === 'index.ts' &&
          /from\s+['"][^'"]*\/controllers\//.test(line)
        ) {
          beUpwardLayerViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        }
      });

      if (relPath.includes('/domain/')) {
        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (
            /\bPrismaService\b/.test(line) ||
            /\bRedisCacheService\b/.test(line) ||
            /from\s+['"][^'"]*\/repositories\//.test(line) ||
            /\b(?:this\.prisma|tx|client)\.(?:item|collection|tag|note|attachment|annotation|userPublication|itemMetadata|contributor|itemIdentifier|itemRelation|outboxEvent|changeLog)\b/.test(
              line,
            )
          ) {
            beInfraInDomainViolations.push({
              file: relPath,
              line: index + 1,
              match: trimmed,
            });
          }
        });
      }

      if (!relPath.includes('/services/') || relPath.endsWith('sync/services/transaction.service.ts')) {
        continue;
      }
      lines.forEach((line, index) => {
        if (
          !line.trim().startsWith('//') &&
          (/this\.prisma\./.test(line) ||
            /private\s+readonly\s+\w*\??\s*:\s*PrismaService/.test(line))
        ) {
          beDirectPrismaInServices.push({
            file: relPath,
            line: index + 1,
            match: line.trim(),
          });
        }
      });
    }
    expect(beDirectPrismaInServices).toEqual([]);
    expect(beInfraInDomainViolations).toEqual([]);
    expect(beUpwardLayerViolations).toEqual([]);

    // 2. Frontend: Zero scattered useQueryClient, useQuery, useMutation, localStorage, or direct *Service.* in UI components
    if (!fs.existsSync(feRoot)) return;

    const feUiViolations: Array<{ file: string; line: number; match: string }> = [];
    const feDomainStorageViolations: Array<{ file: string; line: number; match: string }> = [];
    const feLayerDirectionViolations: Array<{ file: string; line: number; match: string }> = [];

    for (const [, { relPath, lines }] of feFileCache) {
      if (relPath.startsWith('ui/')) {
        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (
            /\buseQueryClient\s*\(/.test(line) ||
            /\buseQuery\s*\(/.test(line) ||
            /\buseMutation\s*\(/.test(line) ||
            /\blocalStorage\b/.test(line) ||
            /\.getState\s*\(/.test(line) ||
            /\b(catalogService|collectionsService|attachmentsService|annotationsService|feedsService|savedSearchesService|relationsService|itemLinksService|libraryIngestionService|ItemsService|CollectionsService|TagsService|NotesService|StateService|SavedSearchesService|RelationsService|CitationService|ExportsService|AttachmentsService|UploadService|AnnotationsService|IngestionService|CurationService|RetractionService|SearchService|SyncService|FeedsService)\./.test(
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
          if (
            /from\s+['"]@\/features\/library\/(core|sdk|ui)\//.test(line) ||
            /from\s+['"]\.\.\/(core|sdk|ui)\//.test(line) ||
            (relPath.startsWith('domain/types/') &&
              (/from\s+['"]\.\.\/[^'"]+['"]/.test(line) ||
                /from\s+['"]@\/features\/library\/domain\/(?!types\/)[^'"]+['"]/.test(line)))
          ) {
            feLayerDirectionViolations.push({
              file: relPath,
              line: index + 1,
              match: trimmed,
            });
          }
        });
      }

      if (relPath.startsWith('ui/')) {
        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (
            /from\s+['"]@\/features\/library\/sdk(?:\/|['"])/.test(line) ||
            /from\s+['"]\.\.\/.*sdk\//.test(line)
          ) {
            feLayerDirectionViolations.push({
              file: relPath,
              line: index + 1,
              match: trimmed,
            });
          }
        });
      }

      if (relPath.startsWith('core/')) {
        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (
            /from\s+['"]@\/features\/library\/ui\//.test(line) ||
            /from\s+['"]@\/features\/library\/sdk(?:\/index)?['"]/.test(line) ||
            /from\s+['"]@\/features\/library\/sdk\/clients\//.test(line) ||
            (relPath.startsWith('core/store/') &&
              (/from\s+['"]@\/features\/library\/(core\/(coordinator|manager)|sdk)\//.test(line) ||
                /import\s*\(\s*['"]@\/features\/library\/(core\/(coordinator|manager)|sdk)\//.test(line) ||
                /from\s+['"]\.\.\/(coordinator|manager)\//.test(line))) ||
            (relPath.startsWith('core/adapters/') &&
              (/from\s+['"]@\/features\/library\/(core\/(coordinator|store|manager)|sdk)\//.test(line) ||
                /from\s+['"]\.\.\/(coordinator|store|manager)\//.test(line)))
          ) {
            feLayerDirectionViolations.push({
              file: relPath,
              line: index + 1,
              match: trimmed,
            });
          }
        });
      }

      if (relPath.startsWith('sdk/')) {
        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (
            /from\s+['"]@\/features\/library\/(core|ui)\//.test(line) ||
            /import\s+['"]@\/features\/library\/(core|ui)\//.test(line) ||
            /from\s+['"]\.\.\/(core|ui)\//.test(line) ||
            /from\s+['"]\.\.\/\.\.\/(core|ui)\//.test(line) ||
            (relPath.startsWith('sdk/queries/') &&
              (/from\s+['"]@\/features\/library\/sdk(?:\/index)?['"]/.test(line) ||
                /export\s+\{[^}]*\b(?:ItemsService|CollectionsService|TagsService|NotesService|LinksService|StateService|SavedSearchesService|CitationService|ExportsService|AttachmentsService|UploadService|AnnotationService|IngestionService|CurationService|RetractionService|FeedsService|SearchService|SyncService|fetchPdfBlob|resolveLibraryUrl|resolveLibraryRawPath)\b[^}]*\}/.test(line))) ||
            ((relPath.startsWith('sdk/clients/') || relPath === 'sdk/query-keys.ts') &&
              (/from\s+['"]@\/features\/library\/sdk\/queries\//.test(line) ||
                /from\s+['"]\.\.?\/queries\//.test(line)))
          ) {
            feLayerDirectionViolations.push({
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
    expect(feLayerDirectionViolations).toEqual([]);

    // 3. End-to-End Tarjan Strongly Connected Components (SCC) Cycle Check across Backend & Frontend Library
    const detectCycles = (
      cache: Map<string, { relPath: string; content: string; lines: string[] }>,
      rootDir: string,
      aliasPrefix: string,
    ): string[][] => {
      const relPaths = new Set<string>();
      for (const [, { relPath }] of cache) relPaths.add(relPath);

      const resolveTarget = (fromRel: string, spec: string): string | null => {
        let candidate = '';
        if (spec.startsWith(aliasPrefix)) {
          candidate = spec.slice(aliasPrefix.length);
        } else if (spec.startsWith('.')) {
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(fromRel), spec),
          );
          if (resolved.startsWith('..')) return null;
          candidate = resolved;
        } else {
          return null;
        }
        for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
          if (relPaths.has(candidate + ext)) return candidate + ext;
        }
        return null;
      };

      const adj = new Map<string, Set<string>>();
      for (const [, { relPath, content }] of cache) {
        const edges = new Set<string>();
        const importExportRe =
          /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        let match: RegExpExecArray | null;
        while ((match = importExportRe.exec(content)) !== null) {
          const spec = match[1] || match[2];
          if (!spec) continue;
          const target = resolveTarget(relPath, spec);
          if (target && target !== relPath) edges.add(target);
        }
        adj.set(relPath, edges);
      }

      let index = 0;
      const indices = new Map<string, number>();
      const lowlink = new Map<string, number>();
      const stack: string[] = [];
      const onStack = new Set<string>();
      const cycles: string[][] = [];

      const strongConnect = (v: string) => {
        indices.set(v, index);
        lowlink.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);

        for (const w of adj.get(v) ?? []) {
          if (!indices.has(w)) {
            strongConnect(w);
            lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
          } else if (onStack.has(w)) {
            lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
          }
        }

        if (lowlink.get(v) === indices.get(v)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== v);
          if (scc.length > 1) {
            cycles.push(scc.reverse());
          }
        }
      };

      for (const node of relPaths) {
        if (!indices.has(node)) strongConnect(node);
      }
      return cycles;
    };

    const beCycles = detectCycles(fileCache, libraryRoot, '@/modules/library/');
    const feCycles = detectCycles(feFileCache, feRoot, '@/features/library/');
    expect(beCycles).toEqual([]);
    expect(feCycles).toEqual([]);

    // 4. Zero `utils` folders or `*util*` files in Backend or Frontend Library (strict Domain-only taxonomy)
    const beUtilsViolations = Array.from(fileCache.values())
      .map((f) => f.relPath)
      .filter((relPath) => /(?:^|\/)utils\//i.test(relPath) || /util/i.test(path.basename(relPath)));
    const feUtilsViolations = Array.from(feFileCache.values())
      .map((f) => f.relPath)
      .filter((relPath) => /(?:^|\/)utils\//i.test(relPath) || /util/i.test(path.basename(relPath)));
    expect(beUtilsViolations).toEqual([]);
    expect(feUtilsViolations).toEqual([]);

    // 5. Strict Domain & Repository File Suffix Taxonomy (.domain.ts, .policy.ts, .mapper.ts, .lexicon.ts, .constants.ts) & Zero data/ or zotero-named files
    const beDomainNamingViolations = Array.from(fileCache.values())
      .map((f) => f.relPath)
      .filter(
        (relPath) =>
          relPath.includes('/domain/') &&
          !/\.(?:domain|policy|mapper|lexicon)\.ts$/.test(relPath),
      );
    const feDomainNamingViolations = Array.from(feFileCache.values())
      .map((f) => f.relPath)
      .filter(
        (relPath) =>
          relPath.startsWith('domain/') &&
          !relPath.startsWith('domain/types/') &&
          !/\.(?:domain|policy|mapper|constants)\.ts$/.test(relPath),
      );
    const beRepoHelperViolations = Array.from(fileCache.values())
      .map((f) => f.relPath)
      .filter((relPath) => relPath.includes('/repositories/') && /\.helper\.ts$/.test(relPath));
    const beDataFolderOrZoteroFileViolations = Array.from(fileCache.values())
      .map((f) => f.relPath)
      .filter((relPath) => /(?:^|\/)data\//i.test(relPath) || /zotero/i.test(path.basename(relPath)));
    const feDataFolderOrZoteroFileViolations = Array.from(feFileCache.values())
      .map((f) => f.relPath)
      .filter((relPath) => /(?:^|\/)data\//i.test(relPath) || /zotero/i.test(path.basename(relPath)));
    expect(beDomainNamingViolations).toEqual([]);
    expect(feDomainNamingViolations).toEqual([]);
    expect(beRepoHelperViolations).toEqual([]);
    expect(beDataFolderOrZoteroFileViolations).toEqual([]);
    expect(feDataFolderOrZoteroFileViolations).toEqual([]);
  });

  it('SC-010: Schema & Query Integrity (soft-delete columns, table names, zero ghost delegates or TransactionClient casts)', () => {
    const schemaDir = path.resolve(
      __dirname,
      '../../../prisma/schema/library',
    );
    const schemaFiles = fs.existsSync(schemaDir)
      ? fs
          .readdirSync(schemaDir)
          .filter((f) => f.endsWith('.prisma'))
          .map((f) => path.join(schemaDir, f))
      : [];
    const combinedSchema = schemaFiles
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');

    const softDeletableModels = [
      'Item',
      'Collection',
      'Note',
      'Attachment',
      'Annotation',
      'SavedSearch',
    ];
    const missingDeletedAtModels: string[] = [];
    for (const modelName of softDeletableModels) {
      const modelBlockRegex = new RegExp(
        `model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`,
      );
      const match = combinedSchema.match(modelBlockRegex);
      if (!match || !/\bdeletedAt\s+DateTime\?/.test(match[1])) {
        missingDeletedAtModels.push(modelName);
      }
    }
    expect(missingDeletedAtModels).toEqual([]);

    const queryAndCastViolations: Array<{
      file: string;
      line: number;
      match: string;
    }> = [];
    for (const [, { relPath, lines }] of fileCache) {
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (
          /"full_text_index"/.test(line) ||
          /\blibraryItem\b/.test(line) ||
          /as\s+unknown\s+as\s+Prisma\.TransactionClient/.test(line)
        ) {
          queryAndCastViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        }
      });
    }

    expect(queryAndCastViolations).toEqual([]);
  });

  it('SC-011: End-to-End Schema -> Backend -> Frontend Contract Integrity (DTO whitelist, ItemsMapper state/relations, prefix query keys)', () => {
    const itemsDtoPath = path.join(libraryRoot, 'catalog/dto/items.dto.ts');
    const itemsDtoContent = fs.readFileSync(itemsDtoPath, 'utf-8');
    for (const requiredDtoField of [
      'collectionId?:',
      'identifiers?:',
      'lockedFields?:',
      'fieldProvenance?:',
      'retractionNature?:',
    ]) {
      expect(itemsDtoContent).toContain(requiredDtoField);
    }

    const itemsMapperPath = path.join(
      libraryRoot,
      'core/domain/items.mapper.ts',
    );
    const itemsMapperContent = fs.readFileSync(itemsMapperPath, 'utf-8');
    for (const requiredMapperField of [
      'lastReadPage',
      'scrollPosition',
      'lastOpenedAt',
      'isCitedBy',
    ]) {
      expect(itemsMapperContent).toContain(requiredMapperField);
    }

    const searchServicePath = path.join(
      libraryRoot,
      'search/services/search.service.ts',
    );
    expect(fs.readFileSync(searchServicePath, 'utf-8')).toContain(
      'mapFlattenedState',
    );

    const feQueryKeysPath = path.resolve(
      __dirname,
      '../../../../frontend/src/features/library/sdk/query-keys.ts',
    );
    if (fs.existsSync(feQueryKeysPath)) {
      const feQueryKeysContent = fs.readFileSync(feQueryKeysPath, 'utf-8');
      expect(feQueryKeysContent).toContain('attachmentsAll:');
      expect(feQueryKeysContent).toContain('annotationsAll:');
      expect(feQueryKeysContent).toContain('relationsAll:');
    }
  });

  it('SC-012: Anti-Patchwork, Anti-Split-Brain & Workflow Order Guardrails (no dead pass-through shims, no multi-user metadata split-brain, no duplicate changelog writes, no double ingestion dispatch)', () => {
    const deletedPassThroughShims = [
      path.join(libraryRoot, 'extraction/domain/snapshot-template.helper.ts'),
      path.join(libraryRoot, 'extraction/extractors/snapshot-template.helper.ts'),
      path.join(libraryRoot, 'extraction/extractors/metadata-quality.gate.ts'),
      path.join(libraryRoot, 'extraction/providers/pdf-bibliography.extractor.ts'),
      path.join(libraryRoot, 'extraction/domain/extraction-tag-key.helper.ts'),
      path.join(libraryRoot, 'ingestion/dto/index.ts'),
      path.join(libraryRoot, 'ingestion/stages/identify-url.resolver.ts'),
      path.join(libraryRoot, 'search/services/fulltext.provider.ts'),
      path.join(libraryRoot, 'sync/services/outbox.metrics.ts'),
      path.join(libraryRoot, 'sync/services/outbox-bull.processor.ts'),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/curation-Duplicates.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/content/use-item-action-handlers.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/reader/reader-attachment.utils.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/sdk/clients/citation-extraction.client.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/sdk/clients/ingestion-sync.client.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/coordinator/reader/annotation-history.command.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/workflows/feed-entry-save.workflow.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/coordinator/panel-resize.coordinator.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/coordinator/inspector-collections.coordinator.ts',
      ),
      path.join(libraryRoot, 'catalog/services/collection-membership.helper.ts'),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/sdk/queries/catalog-placeholder.helper.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/coordinator/reader/use-viewer-search.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/inspector/ReaderInspector.tsx',
      ),
      path.join(libraryRoot, 'core/ports/citation.port.ts'),
      path.join(libraryRoot, 'core/ports/extraction.port.ts'),
      path.join(libraryRoot, 'core/ports/ingestion.port.ts'),
      path.join(libraryRoot, 'core/ports/search.port.ts'),
      path.join(libraryRoot, 'core/ports/sync.port.ts'),
      path.join(libraryRoot, 'core/resilience/rate-limiter.ts'),
      path.join(libraryRoot, 'core/resilience/single-flight.ts'),
      path.join(libraryRoot, 'core/utils/stream-compression.util.ts'),
      path.join(libraryRoot, 'core/utils/uuid.util.ts'),
      path.join(libraryRoot, 'catalog/types/saved-search.types.ts'),
      path.join(libraryRoot, 'catalog/dto/notes.dto.ts'),
      path.join(libraryRoot, 'catalog/dto/tags.dto.ts'),
      path.join(libraryRoot, 'catalog/dto/state.dto.ts'),
      path.join(libraryRoot, 'catalog/dto/item-curation.dto.ts'),
      path.join(libraryRoot, 'catalog/controllers/types.controller.ts'),
      path.join(libraryRoot, 'catalog/controllers/state.controller.ts'),
      path.join(libraryRoot, 'catalog/controllers/tags.controller.ts'),
      path.join(libraryRoot, 'catalog/controllers/saved-searches.controller.ts'),
      path.join(libraryRoot, 'catalog/domain/tree.engine.ts'),
      path.join(libraryRoot, 'catalog/services/types.service.ts'),
      path.join(libraryRoot, 'catalog/services/item-cache.coordinator.ts'),
      path.join(libraryRoot, 'catalog/services/item-fulltext.service.ts'),
      path.join(libraryRoot, 'citation/controllers/exports.controller.ts'),
      path.join(libraryRoot, 'citation/domain/csl-style-registry.ts'),
      path.join(libraryRoot, 'citation/services/csl-locale-loader.service.ts'),
      path.join(libraryRoot, 'extraction/dto/attachments.dto.ts'),
      path.join(libraryRoot, 'extraction/dto/multipart-upload.dto.ts'),
      path.join(libraryRoot, 'extraction/controllers/extraction-telemetry.controller.ts'),
      path.join(libraryRoot, 'ingestion/controllers/retraction.controller.ts'),
      path.join(libraryRoot, 'ingestion/controllers/feeds.controller.ts'),
      path.join(libraryRoot, 'ingestion/dto/submission.dto.ts'),
      path.join(libraryRoot, 'ingestion/dto/capture-url.dto.ts'),
      path.join(libraryRoot, 'ingestion/types/ingestion.errors.ts'),
      path.join(libraryRoot, 'ingestion/domain/candidate-builder.helper.ts'),
      path.join(libraryRoot, 'ingestion/domain/retraction-bloom-filter.domain.ts'),
      path.join(libraryRoot, 'ingestion/parsers/medline-csv-formats.parser.ts'),
      path.join(libraryRoot, 'ingestion/services/retraction-sync.service.ts'),
      path.join(libraryRoot, 'ingestion/services/feeds.engine.ts'),
      path.join(libraryRoot, 'ingestion/services/domain-rate-limiter.service.ts'),
      path.join(libraryRoot, 'ingestion/services/quality.service.ts'),
      path.join(libraryRoot, 'ingestion/services/ingestion-run-reporter.service.ts'),
      path.join(libraryRoot, 'ingestion/providers/dblp.provider.ts'),
      path.join(libraryRoot, 'ingestion/providers/openlibrary.provider.ts'),
      path.join(libraryRoot, 'ingestion/providers/unpaywall.provider.ts'),
      path.join(libraryRoot, 'sync/services/outbox.dispatcher.ts'),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/adapters/reader-storage.adapter.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/manager/library-command-snapshot.helper.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/item-field-coupling.domain.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/saved-search-schema.domain.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/text.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/types/saved-searches.types.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/sdk/clients/ingestion.client.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/sdk/clients/citation-exports.client.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/sdk/queries/cache-filter-matcher.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/inspector/fields/CreatorRowItem.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/inspector/fields/InlineField.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/modals/EditFeedModal.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/reader/ReaderLeftRail.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/reader/ReaderOutlinePanel.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/reader/viewer/TextSelectionToolbar.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/reader/viewer/epub-snapshot-utils.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/sidebar/CollectionContextMenu.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/sidebar/SavedSearchListSection.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/sidebar/SidebarHeader.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/content/ItemContextMenu.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/topbar/TopbarSearch.tsx',
      ),
      // Phase 3 Deep Module Consolidations (Backend)
      path.join(libraryRoot, 'core/constants/redis-keys.constants.ts'),
      path.join(libraryRoot, 'core/events/library-events.ts'),
      path.join(libraryRoot, 'core/domain/item-type.domain.ts'),
      path.join(libraryRoot, 'core/domain/tiptap.domain.ts'),
      path.join(libraryRoot, 'core/services/http.client.ts'),
      path.join(libraryRoot, 'core/types/ingestion.types.ts'),
      path.join(libraryRoot, 'extraction/types/extraction.types.ts'),
      path.join(libraryRoot, 'core/utils/cache-invalidation.helper.ts'),
      path.join(libraryRoot, 'catalog/controllers/item-curation.controller.ts'),
      path.join(libraryRoot, 'catalog/dto/saved-search.dto.ts'),
      path.join(libraryRoot, 'catalog/repositories/state.repository.ts'),
      path.join(libraryRoot, 'catalog/repositories/item-filter-where.builder.ts'),
      path.join(libraryRoot, 'catalog/catalog.facade.ts'),
      path.join(libraryRoot, 'citation/citation.facade.ts'),
      path.join(libraryRoot, 'extraction/extractors/xmp.parser.ts'),
      path.join(libraryRoot, 'extraction/extraction.facade.ts'),
      path.join(libraryRoot, 'extraction/subscribers/item-lifecycle.subscriber.ts'),
      path.join(libraryRoot, 'ingestion/ingestion.facade.ts'),
      path.join(libraryRoot, 'ingestion/providers/retraction-scanner.provider.ts'),
      path.join(libraryRoot, 'ingestion/commands/seed-retractions.command.ts'),
      path.join(libraryRoot, 'ingestion/subscribers/retraction-item-events.subscriber.ts'),
      path.join(libraryRoot, 'ingestion/repositories/metadata.cache.ts'),
      path.join(libraryRoot, 'search/dto/search.dto.ts'),
      path.join(libraryRoot, 'search/search.facade.ts'),
      path.join(libraryRoot, 'search/subscribers/search-events.subscriber.ts'),
      path.join(libraryRoot, 'sync/dto/sync-query.dto.ts'),
      path.join(libraryRoot, 'sync/domain/outbox.domain.ts'),
      // Phase 3 Deep Module Consolidations (Frontend)
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/store/feeds.store.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/sort-items.domain.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/sdk/clients/search-sync-feeds.client.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/content/LibraryEmptyState.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/inspector/AttachmentPdfPreview.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/inspector/fields/DynamicInspectorField.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/modals/RetractionNoticeModal.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/modals/PaperBibtexDialog.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/modals/AddLinkModal.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/modals/CslStyleSearchModal.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/modals/MyPublicationModal.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/sidebar/ProjectLibrariesSection.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/saved-search-evaluator.domain.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/core/coordinator/index.ts',
      ),
      // Final Canonical Structural Consolidations
      path.join(libraryRoot, 'core/utils/transaction-helpers.ts'),
      path.join(libraryRoot, 'core/ports/index.ts'),
      path.join(libraryRoot, 'extraction/extractors/layout.extractor.ts'),
      path.join(libraryRoot, 'library.facade.ts'),
      path.join(libraryRoot, 'ingestion/controllers/curation.controller.ts'),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/domain/types/item-fields.constants.ts',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/inspector/fields/CreatorFields.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/inspector/fields/GeneralFields.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/reader/panel/AnnotationsPanel.tsx',
      ),
      path.resolve(
        __dirname,
        '../../../../frontend/src/features/library/ui/reader/panel/AnnotationsPanelParts.tsx',
      ),
    ];
    for (const shimPath of deletedPassThroughShims) {
      expect(fs.existsSync(shimPath)).toBe(false);
    }

    const commandRelationsPath = path.join(
      libraryRoot,
      'catalog/repositories/command-relations.operations.ts',
    );
    const commandRelationsContent = fs.readFileSync(
      commandRelationsPath,
      'utf-8',
    );
    expect(commandRelationsContent).not.toContain('isMyPublication: isMine');

    const extractionRepoPath = path.join(
      libraryRoot,
      'extraction/repositories/extraction.repository.ts',
    );
    const extractionRepoContent = fs.readFileSync(extractionRepoPath, 'utf-8');
    expect(extractionRepoContent).not.toContain('libraryChange.create');

    const ingestionServicePath = path.join(
      libraryRoot,
      'ingestion/services/ingestion.service.ts',
    );
    const ingestionServiceContent = fs.readFileSync(
      ingestionServicePath,
      'utf-8',
    );
    expect(ingestionServiceContent).toContain('skipAsyncDispatch: true');
  });

  it('SC-013: Hollywood Principle & Zero Shadow Backend Guardrails (Backend port inversion & Frontend server authority)', () => {
    // 1. Backend: Zero concrete ItemCacheCoordinator imports outside catalog/ & Zero legacy architecture vestiges
    const cacheCoordinatorViolations: Array<{ file: string; line: number; match: string }> = [];
    const backendLegacyVestigeViolations: Array<{ file: string; line: number; match: string }> = [];
    for (const [, { relPath, lines }] of fileCache) {
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (!relPath.startsWith('catalog/') && /\bItemCacheCoordinator\b/.test(line)) {
          cacheCoordinatorViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        }
        if (
          /\b(?:rawTei|ClientResolved|preResolvedMetadata|prepareItemAiMetadataPatch|filterAiMetadataPatch|promoteFeedEntryToLibrary|syncTagsToItem|ALL_RECONCILABLE_METADATA_FIELDS)\b/.test(
            line,
          )
        ) {
          backendLegacyVestigeViolations.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        }
      });
    }
    expect(cacheCoordinatorViolations).toEqual([]);
    expect(backendLegacyVestigeViolations).toEqual([]);

    // 2. Frontend: Zero client-metadata-resolver / saved-search-evaluator shadow backend files, zero client-side RSS/Atom XML parser or SavedSearch/SystemView evaluators, and zero N+1 copySubtree
    if (!fs.existsSync(feRoot)) return;

    const deletedShadowBackendFile = path.join(
      feRoot,
      'core/services/client-metadata-resolver.service.ts',
    );
    expect(fs.existsSync(deletedShadowBackendFile)).toBe(false);
    expect(
      fs.existsSync(path.join(feRoot, 'domain/saved-search-evaluator.domain.ts')),
    ).toBe(false);

    const forbiddenShadowBackendSymbols: Array<{ file: string; line: number; match: string }> = [];
    for (const [, { relPath, lines }] of feFileCache) {
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (
          /\b(?:parseFeedXml|evaluateSavedSearch|filterItemsBySavedSearch|filterItemsBySystemView|CollectionTreeComposite|useOcrExtraction|resolveDocumentOcrState|presignUpload|completePresignedUpload|initiateMultipartSession)\b/.test(
            line,
          )
        ) {
          forbiddenShadowBackendSymbols.push({
            file: relPath,
            line: index + 1,
            match: trimmed,
          });
        }
      });
    }
    expect(forbiddenShadowBackendSymbols).toEqual([]);

    const collectionCoordinatorPath = path.join(
      feRoot,
      'core/coordinator/collection.coordinator.ts',
    );
    const collectionCoordinatorContent = fs.readFileSync(
      collectionCoordinatorPath,
      'utf-8',
    );
    expect(
      collectionCoordinatorContent.includes('CollectionsService.copy(') ||
        collectionCoordinatorContent.includes('copyLibraryCollection('),
    ).toBe(true);
    expect(collectionCoordinatorContent).not.toContain('copySubtree');
  });
});
