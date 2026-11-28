/**
 * modules/pages/structure/services/project-symbols.helper.ts
 * Project-wide LaTeX symbol extraction, outline generation, and compiler payload building helpers.
 */

import { Logger } from '@nestjs/common';
import {
  FileTreeBuilder,
  IStructureRepository,
  LatexOutlineEntryDto,
  LatexOutlineExtractor,
  NodePathVo,
  PageNodeEntity,
  RootDocNotFoundError,
} from '../domain';
import {
  CompilationPayload,
  WorkspaceFile,
} from '@/modules/pages/core/types/workspace-file';
import { filterRecordsByPageScope } from '@/modules/pages/core/utils/page-scope';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { BibtexParser } from '@/modules/pages/citations/domain/bibtex.domain';

export interface ProjectSymbolLabelDto {
  key: string;
  file: string;
  line: number;
  context?: string;
}

export interface ProjectSymbolCitationDto {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  volume?: string;
  number?: string;
  pages?: string;
  file: string;
  line: number;
  raw?: string;
}

export interface ProjectSymbolCommandDto {
  name: string;
  argCount?: number;
  hasDefault?: boolean;
  defaultValue?: string;
  expansion?: string;
  file: string;
  line: number;
  signature: string;
}

export interface ProjectSymbolEnvironmentDto {
  name: string;
  argCount?: number;
  file: string;
  line: number;
}

export interface ProjectSymbolPackageDto {
  name: string;
  options?: string;
  file: string;
  line: number;
}

export interface ProjectSymbolOutlineDto {
  title: string;
  level: number;
  levelName: string;
  file: string;
  line: number;
  from: number;
  children?: ProjectSymbolOutlineDto[];
}

export interface ProjectSymbolsResponseDto {
  rootDocPath: string | null;
  labels: ProjectSymbolLabelDto[];
  citations: ProjectSymbolCitationDto[];
  customCommands: ProjectSymbolCommandDto[];
  customEnvironments: ProjectSymbolEnvironmentDto[];
  packages: ProjectSymbolPackageDto[];
  bibliographies: string[];
  includedFiles: string[];
  imageFiles: string[];
  files: string[];
  images: string[];
  outline: ProjectSymbolOutlineDto[];
}

export interface CachedDocSymbols {
  readonly labels: ProjectSymbolLabelDto[];
  readonly citations: ProjectSymbolCitationDto[];
  readonly customCommands: ProjectSymbolCommandDto[];
  readonly customEnvironments: ProjectSymbolEnvironmentDto[];
  readonly packages: ProjectSymbolPackageDto[];
  readonly bibliographies: string[];
  readonly includedFiles: string[];
  readonly outline: ProjectSymbolOutlineDto[];
}

export interface ProjectSymbolsContext {
  readonly repository: IStructureRepository;
  readonly logger: Logger;
  readonly docstoreService?: DocstoreService;
  readonly filestoreService?: FilestoreService;
  readonly autoDetectRootDoc: (
    projectId: string,
    docContents: Map<string, string[]>,
    existingNodes?: PageNodeEntity[],
    pageId?: string | null,
  ) => Promise<PageNodeEntity | null>;
}

export async function buildCompilerPayloadHelper(
  ctx: ProjectSymbolsContext,
  projectId: string,
  docContentsMap: Map<string, { lines: string[]; hash?: string | null }>,
  pageId?: string,
): Promise<CompilationPayload> {
  const nodes = await ctx.repository.getAllNodes(projectId, pageId);

  let rootNode = nodes.find((n) => n.isRootDoc) ?? null;
  if (!rootNode) {
    const linesMap = new Map<string, string[]>();
    for (const [id, val] of docContentsMap.entries()) {
      linesMap.set(id, val.lines);
    }
    rootNode = await ctx.autoDetectRootDoc(projectId, linesMap, nodes, pageId);
  }

  if (!rootNode) {
    throw new RootDocNotFoundError(projectId);
  }

  const nonFolderNodes = nodes.filter((n) => !n.isFolder());
  const files: WorkspaceFile[] = new Array(nonFolderNodes.length);
  const STREAM_CONCURRENCY = 8;

  for (let i = 0; i < nonFolderNodes.length; i += STREAM_CONCURRENCY) {
    const batch = nonFolderNodes.slice(i, i + STREAM_CONCURRENCY);
    await Promise.all(
      batch.map(async (node, idx) => {
        const targetIndex = i + idx;
        const relativePath = FileTreeBuilder.toRelativeCompilerPath(node.path);

        if (node.isDoc()) {
          const docData =
            docContentsMap.get(node.id) ||
            (node.docId ? docContentsMap.get(node.docId) : undefined);
          const content = docData ? docData.lines.join('\n') : '';
          const hash = docData?.hash || node.hash || undefined;

          files[targetIndex] = {
            path: relativePath,
            content,
            hash,
          };
        } else {
          let binaryContent: Buffer | string = '';
          if (node.fileId && ctx.filestoreService) {
            try {
              const { stream } = await ctx.filestoreService.openReadStream(
                projectId,
                node.fileId,
              );
              const chunks: Buffer[] = [];
              for await (const chunk of stream) {
                chunks.push(
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
                );
              }
              binaryContent = Buffer.concat(chunks);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.logger.warn(
                `Failed to read binary file ${node.fileId} (${relativePath}) from filestore: ${msg}`,
              );
            }
          }

          files[targetIndex] = {
            path: relativePath,
            content: binaryContent,
            hash: node.hash || undefined,
          };
        }
      }),
    );
  }

  return {
    rootDocPath: FileTreeBuilder.toRelativeCompilerPath(rootNode.path),
    files: files.filter(Boolean),
  };
}

export function extractSingleDocSymbols(
  filePath: string,
  lines: string[],
  bibParser: BibtexParser,
): CachedDocSymbols {
  const lowerPath = filePath.toLowerCase();
  const docLabels: ProjectSymbolLabelDto[] = [];
  const docCitations: ProjectSymbolCitationDto[] = [];
  const docCommands: ProjectSymbolCommandDto[] = [];
  const docEnvs: ProjectSymbolEnvironmentDto[] = [];
  const docPackages: ProjectSymbolPackageDto[] = [];
  const docBibliographies: string[] = [];
  const docIncludedFiles: string[] = [];
  const docOutline: ProjectSymbolOutlineDto[] = [];

  const SECTION_LEVELS: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
    paragraph: 5,
    subparagraph: 6,
  };

  if (lowerPath.endsWith('.bib')) {
    docBibliographies.push(filePath);
    const rawContent = lines.join('\n');
    const parsedEntries = bibParser.parse(rawContent);
    for (const entry of parsedEntries) {
      const json = entry.toJSON(filePath);
      docCitations.push({
        key: json.key,
        type: json.type,
        title: json.title,
        author: entry.authors.toDisplayString(),
        year: json.year,
        journal: json.journal,
        booktitle: json.booktitle,
        publisher: json.publisher,
        doi: json.doi,
        url: json.url,
        abstract: json.abstract,
        volume: json.volume,
        number: json.number,
        pages: json.pages,
        file: filePath,
        line: 1,
        raw: entry.toBibtexString(),
      });
    }
    return {
      labels: docLabels,
      citations: docCitations,
      customCommands: docCommands,
      customEnvironments: docEnvs,
      packages: docPackages,
      bibliographies: docBibliographies,
      includedFiles: docIncludedFiles,
      outline: docOutline,
    };
  }

  if (
    !lowerPath.endsWith('.tex') &&
    !lowerPath.endsWith('.sty') &&
    !lowerPath.endsWith('.cls') &&
    !lowerPath.endsWith('.ltx')
  ) {
    return {
      labels: docLabels,
      citations: docCitations,
      customCommands: docCommands,
      customEnvironments: docEnvs,
      packages: docPackages,
      bibliographies: docBibliographies,
      includedFiles: docIncludedFiles,
      outline: docOutline,
    };
  }

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const lineNum = i + 1;
    let cleanLine = rawLine;
    for (let c = 0; c < rawLine.length; c++) {
      if (rawLine[c] === '%' && (c === 0 || rawLine[c - 1] !== '\\')) {
        cleanLine = rawLine.slice(0, c);
        break;
      }
    }

    if (cleanLine.trim().length > 0) {
      const labelRe = /\\label\s*\{\s*([^}]+?)\s*\}/g;
      let m: RegExpExecArray | null;
      while ((m = labelRe.exec(cleanLine)) !== null) {
        const key = m[1].trim();
        if (key) {
          docLabels.push({
            key,
            file: filePath,
            line: lineNum,
            context: cleanLine.trim().slice(0, 120),
          });
        }
      }

      const cmdRe =
        /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*(\\[a-zA-Z@]+)\s*\}?(?:\s*\[(\d+)\])?(?:\s*\[([^\]]*)\])?/g;
      while ((m = cmdRe.exec(cleanLine)) !== null) {
        const name = m[1].trim();
        const argCount = m[2] ? parseInt(m[2], 10) : 0;
        const hasDefault = m[3] !== undefined;
        const defaultValue = m[3];
        const signature =
          argCount > 0
            ? `${name}${hasDefault ? `[${defaultValue}]` : ''}${'{...}'.repeat(Math.max(0, argCount - (hasDefault ? 1 : 0)))}`
            : name;
        docCommands.push({
          name,
          argCount,
          hasDefault,
          defaultValue,
          file: filePath,
          line: lineNum,
          signature,
        });
      }

      const mathOpRe =
        /\\DeclareMathOperator\*?\s*\{\s*(\\[a-zA-Z@]+)\s*\}\s*\{\s*([^}]*)\s*\}/g;
      while ((m = mathOpRe.exec(cleanLine)) !== null) {
        const name = m[1].trim();
        docCommands.push({
          name,
          argCount: 0,
          expansion: m[2]?.trim(),
          file: filePath,
          line: lineNum,
          signature: name,
        });
      }

      const defRe = /\\(?:g?def|edef|xdef)\s*(\\[a-zA-Z@]+)(?:#\d+)*/g;
      while ((m = defRe.exec(cleanLine)) !== null) {
        const name = m[1].trim();
        docCommands.push({
          name,
          argCount: 0,
          file: filePath,
          line: lineNum,
          signature: name,
        });
      }

      const envRe =
        /\\(?:newenvironment|renewenvironment)\*?\s*\{\s*([^}]+?)\s*\}(?:\s*\[(\d+)\])?/g;
      while ((m = envRe.exec(cleanLine)) !== null) {
        const name = m[1].trim();
        const argCount = m[2] ? parseInt(m[2], 10) : 0;
        docEnvs.push({
          name,
          argCount,
          file: filePath,
          line: lineNum,
        });
      }

      const pkgRe =
        /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{\s*([^}]+?)\s*\}/g;
      while ((m = pkgRe.exec(cleanLine)) !== null) {
        const options = m[1]?.trim();
        const pkgList = m[2]
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        for (const pkgName of pkgList) {
          docPackages.push({
            name: pkgName,
            options,
            file: filePath,
            line: lineNum,
          });
        }
      }

      const includeRe =
        /\\(?:input|include|subfile|includeonly)\s*\{\s*([^}]+?)\s*\}/g;
      while ((m = includeRe.exec(cleanLine)) !== null) {
        const rawInc = m[1].trim();
        if (rawInc) {
          docIncludedFiles.push(
            rawInc.endsWith('.tex') ? rawInc : `${rawInc}.tex`,
          );
        }
      }

      const bibCmdRe =
        /\\(?:bibliography|addbibresource|nobibliography)\s*(?:\[[^\]]*\])?\s*\{\s*([^}]+?)\s*\}/g;
      while ((m = bibCmdRe.exec(cleanLine)) !== null) {
        const bibTargets = m[1]
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean);
        for (const b of bibTargets) {
          docBibliographies.push(b.endsWith('.bib') ? b : `${b}.bib`);
        }
      }

      const secRe =
        /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g;
      while ((m = secRe.exec(cleanLine)) !== null) {
        const levelName = m[1];
        const title = m[2].trim();
        docOutline.push({
          title: title || levelName,
          level: SECTION_LEVELS[levelName] ?? 2,
          levelName,
          file: filePath,
          line: lineNum,
          from: offset + m.index,
        });
      }

      const bibitemRe = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{\s*([^}]+?)\s*\}/g;
      while ((m = bibitemRe.exec(cleanLine)) !== null) {
        const key = m[1].trim();
        if (key) {
          docCitations.push({
            key,
            type: 'bibitem',
            title: key,
            file: filePath,
            line: lineNum,
          });
        }
      }
    }

    offset += rawLine.length + 1;
  }

  return {
    labels: docLabels,
    citations: docCitations,
    customCommands: docCommands,
    customEnvironments: docEnvs,
    packages: docPackages,
    bibliographies: docBibliographies,
    includedFiles: docIncludedFiles,
    outline: docOutline,
  };
}

export async function loadProjectDocsContextHelper(
  ctx: ProjectSymbolsContext,
  projectId: string,
  pageId?: string,
  preloadedNodes?: PageNodeEntity[],
): Promise<{
  nodes: PageNodeEntity[];
  allDocs: Awaited<ReturnType<DocstoreService['getAllDocs']>>;
  docContentsMap: Map<string, string[]>;
  docsToScan: Map<string, string[]>;
  docHashByPath: Map<string, string>;
  docIdByPath: Map<string, string>;
  rootDocPath: string | null;
}> {
  const [nodes, rawDocs] = await Promise.all([
    preloadedNodes
      ? Promise.resolve(preloadedNodes)
      : ctx.repository.getAllNodes(projectId, pageId),
    ctx.docstoreService
      ? ctx.docstoreService.getAllDocs(projectId, pageId).catch(() => [])
      : Promise.resolve([]),
  ]);
  const allDocs =
    pageId && pageId !== projectId
      ? filterRecordsByPageScope(rawDocs, pageId, projectId)
      : rawDocs;

  const docContentsMap = new Map<string, string[]>();
  const docHashByIdOrPath = new Map<string, string>();
  const docIdByPath = new Map<string, string>();
  for (const d of allDocs) {
    const dId = d.id || d._id;
    const hashTag = d.hash ? `${d.hash}:${d.rev ?? 0}` : '';
    if (dId && Array.isArray(d.lines)) {
      docContentsMap.set(dId, d.lines);
      if (hashTag) docHashByIdOrPath.set(dId, hashTag);
    }
    if (d.path && Array.isArray(d.lines)) {
      const cleanPath = NodePathVo.toRelative(d.path);
      if (!docContentsMap.has(cleanPath)) {
        docContentsMap.set(cleanPath, d.lines);
      }
      if (hashTag && !docHashByIdOrPath.has(cleanPath)) {
        docHashByIdOrPath.set(cleanPath, hashTag);
      }
      if (dId && !docIdByPath.has(cleanPath)) {
        docIdByPath.set(cleanPath, dId);
      }
    }
  }

  let rootNode = nodes.find((n) => n.isRootDoc) ?? null;
  if (!rootNode) {
    rootNode = await ctx
      .autoDetectRootDoc(projectId, docContentsMap, nodes, pageId)
      .catch(() => null);
  }
  const rootDocPath = rootNode
    ? FileTreeBuilder.toRelativeCompilerPath(rootNode.path)
    : null;

  const docsToScan = new Map<string, string[]>();
  const docHashByPath = new Map<string, string>();
  for (const node of nodes) {
    if (!node.isDoc()) continue;
    const relPath = FileTreeBuilder.toRelativeCompilerPath(node.path);
    const lines =
      (node.docId ? docContentsMap.get(node.docId) : undefined) ||
      docContentsMap.get(node.id) ||
      docContentsMap.get(relPath);
    if (lines) {
      docsToScan.set(relPath, lines);
      if (node.docId) {
        docIdByPath.set(relPath, node.docId);
      }
      const h =
        (node.docId ? docHashByIdOrPath.get(node.docId) : undefined) ||
        docHashByIdOrPath.get(node.id) ||
        docHashByIdOrPath.get(relPath) ||
        node.hash ||
        '';
      if (h) docHashByPath.set(relPath, h);
    }
  }
  for (const d of allDocs) {
    const relPath = NodePathVo.toRelative(d.path || '');
    if (relPath && Array.isArray(d.lines) && !docsToScan.has(relPath)) {
      docsToScan.set(relPath, d.lines);
      const h = docHashByIdOrPath.get(relPath) || d.hash || '';
      if (h) docHashByPath.set(relPath, h);
    }
  }

  return {
    nodes,
    allDocs,
    docContentsMap,
    docsToScan,
    docHashByPath,
    docIdByPath,
    rootDocPath,
  };
}

export async function getProjectSymbolsHelper(
  ctx: ProjectSymbolsContext,
  docSymbolsCache: Map<string, CachedDocSymbols>,
  maxCacheEntries: number,
  projectId: string,
  pageId?: string,
  preloadedNodes?: PageNodeEntity[],
): Promise<ProjectSymbolsResponseDto> {
  const { nodes, docsToScan, docHashByPath, docIdByPath, rootDocPath } =
    await loadProjectDocsContextHelper(ctx, projectId, pageId, preloadedNodes);

  const labelsMap = new Map<string, ProjectSymbolLabelDto>();
  const citationsMap = new Map<string, ProjectSymbolCitationDto>();
  const commandsMap = new Map<string, ProjectSymbolCommandDto>();
  const envsMap = new Map<string, ProjectSymbolEnvironmentDto>();
  const packagesMap = new Map<string, ProjectSymbolPackageDto>();
  const bibliographiesSet = new Set<string>();
  const includedFilesSet = new Set<string>();
  const imageFilesSet = new Set<string>();
  const allFilesSet = new Set<string>(docsToScan.keys());
  const outline: ProjectSymbolOutlineDto[] = [];

  const IMAGE_EXT_RE = /\.(png|jpe?g|pdf|eps|svg|gif|bmp|webp|tikz)$/i;
  const bibParser = new BibtexParser();

  // Collect all known file paths from structure tree
  for (const node of nodes) {
    if (node.isFolder()) continue;
    const relPath = FileTreeBuilder.toRelativeCompilerPath(node.path);
    if (!relPath) continue;
    allFilesSet.add(relPath);
    if (IMAGE_EXT_RE.test(relPath)) {
      imageFilesSet.add(relPath);
    }
    if (relPath.toLowerCase().endsWith('.bib')) {
      bibliographiesSet.add(relPath);
    }
  }

  for (const [filePath, lines] of docsToScan.entries()) {
    const docHash =
      docHashByPath.get(filePath) ||
      `${lines.length}:${lines[0]?.length ?? 0}:${lines[lines.length - 1] ?? ''}`;
    const docIdTag = docIdByPath.get(filePath) || filePath;
    const cacheKey = `${docIdTag}:${docHash}`;
    let cached = docSymbolsCache.get(cacheKey);
    if (!cached) {
      cached = extractSingleDocSymbols(filePath, lines, bibParser);
      if (docSymbolsCache.size >= maxCacheEntries) {
        const oldestKey = docSymbolsCache.keys().next().value;
        if (oldestKey !== undefined) {
          docSymbolsCache.delete(oldestKey);
        }
      }
      docSymbolsCache.set(cacheKey, cached);
    }

    for (const lbl of cached.labels) {
      if (!labelsMap.has(lbl.key)) labelsMap.set(lbl.key, lbl);
    }
    for (const cit of cached.citations) {
      if (cit.type === 'bibitem') {
        if (!citationsMap.has(cit.key)) citationsMap.set(cit.key, cit);
      } else {
        citationsMap.set(cit.key, cit);
      }
    }
    for (const cmd of cached.customCommands) {
      if (
        cmd.signature === cmd.name &&
        !cmd.expansion &&
        commandsMap.has(cmd.name)
      ) {
        continue;
      }
      commandsMap.set(cmd.name, cmd);
    }
    for (const env of cached.customEnvironments) {
      envsMap.set(env.name, env);
    }
    for (const pkg of cached.packages) {
      if (!packagesMap.has(pkg.name)) packagesMap.set(pkg.name, pkg);
    }
    for (const bib of cached.bibliographies) {
      bibliographiesSet.add(bib);
    }
    for (const inc of cached.includedFiles) {
      includedFilesSet.add(inc);
    }
    outline.push(...cached.outline);
  }

  const files = Array.from(allFilesSet);
  const imageFiles = Array.from(imageFilesSet);

  return {
    rootDocPath,
    labels: Array.from(labelsMap.values()),
    citations: Array.from(citationsMap.values()),
    customCommands: Array.from(commandsMap.values()),
    customEnvironments: Array.from(envsMap.values()),
    packages: Array.from(packagesMap.values()),
    bibliographies: Array.from(bibliographiesSet),
    includedFiles: Array.from(includedFilesSet),
    imageFiles,
    files,
    images: imageFiles,
    outline,
  };
}

export async function getProjectOutlineHelper(
  ctx: ProjectSymbolsContext,
  projectId: string,
  options?: { filePath?: string; docId?: string; content?: string },
  pageId?: string,
): Promise<{
  rootDocPath: string | null;
  entries: LatexOutlineEntryDto[];
  tree: LatexOutlineEntryDto[];
}> {
  if (options?.content !== undefined) {
    const targetFile = options.filePath || 'main.tex';
    const entries = LatexOutlineExtractor.extractFromContent(
      options.content,
      targetFile,
    );
    return {
      rootDocPath: targetFile,
      entries,
      tree: LatexOutlineExtractor.buildOutlineTree(entries),
    };
  }

  const { nodes, docContentsMap, docsToScan, rootDocPath } =
    await loadProjectDocsContextHelper(ctx, projectId, pageId);

  if (options?.docId) {
    const lines = docContentsMap.get(options.docId);
    if (lines) {
      const matchingNode = nodes.find(
        (n) => n.docId === options.docId || n.id === options.docId,
      );
      const relPath = matchingNode
        ? FileTreeBuilder.toRelativeCompilerPath(matchingNode.path)
        : options.filePath || 'main.tex';
      const entries = LatexOutlineExtractor.extractFromContent(
        lines.join('\n'),
        relPath,
      );
      return {
        rootDocPath,
        entries,
        tree: LatexOutlineExtractor.buildOutlineTree(entries),
      };
    }
  }

  if (options?.filePath) {
    const cleanFilter = NodePathVo.toRelative(options.filePath);
    const matchedLines =
      docsToScan.get(cleanFilter) ??
      Array.from(docsToScan.entries()).find(
        ([k]) => k === cleanFilter || k.endsWith(`/${cleanFilter}`),
      )?.[1];
    const entries = LatexOutlineExtractor.extractFromContent(
      matchedLines ? matchedLines.join('\n') : '',
      cleanFilter,
    );
    return {
      rootDocPath,
      entries,
      tree: LatexOutlineExtractor.buildOutlineTree(entries),
    };
  }

  const allEntries: LatexOutlineEntryDto[] = [];
  for (const [relPath, lines] of docsToScan.entries()) {
    if (!relPath.toLowerCase().endsWith('.tex')) continue;
    allEntries.push(
      ...LatexOutlineExtractor.extractFromContent(lines.join('\n'), relPath),
    );
  }

  return {
    rootDocPath,
    entries: allEntries,
    tree: LatexOutlineExtractor.buildOutlineTree(allEntries),
  };
}
