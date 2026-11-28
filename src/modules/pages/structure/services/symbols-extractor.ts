/**
 * modules/pages/structure/services/symbols-extractor.ts
 * Project-wide LaTeX symbol extraction and outline generation helpers.
 */

import { Logger } from '@nestjs/common';
import {
  NodePathVo,
  filterRecordsByPageScope,
  parseBibtexEntries,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import {
  LatexOutlineEntryDto,
  LatexOutlineExtractor,
} from '../domain/latex-outline.extractor';
import { PageNodeEntity } from '../domain/node.entity';
import type { StructureRepository } from '../structure.repository';
import type {
  ProjectSymbolLabelDto,
  ProjectSymbolCitationDto,
  ProjectSymbolCommandDto,
  ProjectSymbolEnvironmentDto,
  ProjectSymbolPackageDto,
  ProjectSymbolOutlineDto,
  ProjectSymbolsResponseDto,
} from '../dto/symbols.dto';

export type {
  ProjectSymbolLabelDto,
  ProjectSymbolCitationDto,
  ProjectSymbolCommandDto,
  ProjectSymbolEnvironmentDto,
  ProjectSymbolPackageDto,
  ProjectSymbolOutlineDto,
  ProjectSymbolsResponseDto,
};

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
  readonly repository: StructureRepository;
  readonly logger: Logger;
  readonly docstoreService?: DocstoreService;
  readonly autoDetectRootDoc: (
    projectId: string,
    docContents: Map<string, string[]>,
    existingNodes?: PageNodeEntity[],
    pageId?: string | null,
  ) => Promise<PageNodeEntity | null>;
}

export function extractSingleDocSymbols(
  filePath: string,
  lines: string[],
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
    const parsedEntries = parseBibtexEntries(rawContent);
    for (const entry of parsedEntries) {
      docCitations.push({
        key: entry.key,
        type: entry.type,
        title: entry.title,
        author: entry.author,
        year: entry.year,
        journal: entry.journal,
        booktitle: entry.booktitle,
        publisher: entry.publisher,
        doi: entry.doi,
        url: entry.url,
        abstract: entry.abstract,
        volume: entry.volume,
        number: entry.number,
        pages: entry.pages,
        file: filePath,
        line: 1,
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
    const cleanLine = LatexOutlineExtractor.stripComment(rawLine);

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
  const allDocs = pageId
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
  const rootDocPath = rootNode ? NodePathVo.toRelative(rootNode.path) : null;

  const docsToScan = new Map<string, string[]>();
  const docHashByPath = new Map<string, string>();
  for (const node of nodes) {
    if (!node.isDoc()) continue;
    const relPath = NodePathVo.toRelative(node.path);
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

  // Collect all known file paths from structure tree
  for (const node of nodes) {
    if (node.isFolder()) continue;
    const relPath = NodePathVo.toRelative(node.path);
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
      cached = extractSingleDocSymbols(filePath, lines);
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
        ? NodePathVo.toRelative(matchingNode.path)
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
