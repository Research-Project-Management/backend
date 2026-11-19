/**
 * modules/pages/clsi/services/clsi-synctex-wordcount.helper.ts
 * SyncTeX lookup and multi-file TeX word count helpers for ClsiService.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ClsiWordCountDto } from '../dto/clsi.dto';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import {
  ReverseSyncPoint,
  SyncPoint,
  WordCountStats,
} from '../domain/clsi.ports';
import { WorkspaceRepository } from '../repositories/workspace.repository';
import { SyncTexProcessor } from '../domain/synctex.parser';
import { TexWordCounter } from '../domain/tex-word.counter';
import { RemoteClsiClientAdapter } from './remote-clsi.client';
import { WorkspacePlannerService } from './workspace-planner.service';

export interface SynctexDiskCacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

export interface ClsiSynctexWordCountContext {
  readonly workspace: WorkspaceRepository;
  readonly synctexParser: SyncTexProcessor;
  readonly wordCounter: TexWordCounter;
  readonly synctexDiskCache: Map<string, SynctexDiskCacheEntry>;
  readonly remoteClient: RemoteClsiClientAdapter;
  readonly workspacePlanner: WorkspacePlannerService;
}

export async function loadSynctexContentHelper(
  ctx: Pick<
    ClsiSynctexWordCountContext,
    'workspace' | 'synctexParser' | 'synctexDiskCache'
  >,
  projectId: string,
  inlineSynctexBase64?: string,
): Promise<string | null> {
  if (inlineSynctexBase64) {
    const buffer = Buffer.from(inlineSynctexBase64, 'base64');
    return await ctx.synctexParser.decompress(buffer);
  }

  const scratchDir = ctx.workspace.getScratchDir(projectId);
  for (const filename of ['output.synctex.gz', 'output.synctex']) {
    try {
      const safePath = path.join(scratchDir, filename);
      const stat = await fs.lstat(safePath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;

      const cacheKey = `${projectId}:${filename}`;
      const cached = ctx.synctexDiskCache.get(cacheKey);
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size
      ) {
        return cached.content;
      }

      const buf = await ctx.workspace.readAuxFile(projectId, filename);
      if (!buf) continue;
      const content = filename.endsWith('.gz')
        ? await ctx.synctexParser.decompress(buf)
        : buf.toString('utf8');
      if (content) {
        if (ctx.synctexDiskCache.size >= 16) {
          const oldestKey = ctx.synctexDiskCache.keys().next().value;
          if (oldestKey) ctx.synctexDiskCache.delete(oldestKey);
        }
        ctx.synctexDiskCache.set(cacheKey, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          content,
        });
        return content;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function forwardSyncHelper(
  ctx: ClsiSynctexWordCountContext,
  dto: ForwardSyncDto,
  authorizedProjectId?: string,
): Promise<{
  success: boolean;
  result?: SyncPoint;
  error?: string;
}> {
  const { spaceId, pageId } =
    await ctx.workspacePlanner.resolvePageCompileContext(
      dto,
      authorizedProjectId,
    );
  const scratchId = pageId || spaceId;

  const remoteRes = await ctx.remoteClient.tryRemoteForwardSync(dto);
  if (remoteRes) return remoteRes;

  let synctexContent = await loadSynctexContentHelper(
    ctx,
    scratchId,
    dto.synctex,
  );
  if (!synctexContent && pageId && spaceId && pageId !== spaceId) {
    synctexContent = await loadSynctexContentHelper(ctx, spaceId);
  }
  if (!synctexContent) {
    return {
      success: false,
      error:
        'SyncTeX data not available. Compile the manuscript first to generate SyncTeX mapping.',
    };
  }

  const point = ctx.synctexParser.forwardLookup(
    synctexContent,
    dto.file || 'main.tex',
    dto.line,
    dto.column,
  );

  if (!point) {
    return {
      success: false,
      error: `No PDF coordinate match found for ${dto.file || 'main.tex'}:${dto.line}`,
    };
  }

  return { success: true, result: point };
}

export async function reverseSyncHelper(
  ctx: ClsiSynctexWordCountContext,
  dto: ReverseSyncDto,
  authorizedProjectId?: string,
): Promise<{
  success: boolean;
  result?: ReverseSyncPoint;
  error?: string;
}> {
  const { spaceId, pageId } =
    await ctx.workspacePlanner.resolvePageCompileContext(
      dto,
      authorizedProjectId,
    );
  const scratchId = pageId || spaceId;

  const remoteRes = await ctx.remoteClient.tryRemoteReverseSync(dto);
  if (remoteRes) return remoteRes;

  let synctexContent = await loadSynctexContentHelper(
    ctx,
    scratchId,
    dto.synctex,
  );
  if (!synctexContent && pageId && spaceId && pageId !== spaceId) {
    synctexContent = await loadSynctexContentHelper(ctx, spaceId);
  }
  if (!synctexContent) {
    return {
      success: false,
      error:
        'SyncTeX data not available. Compile the manuscript first to generate SyncTeX mapping.',
    };
  }

  const point = ctx.synctexParser.reverseLookup(
    synctexContent,
    dto.page,
    dto.x,
    dto.y,
  );

  if (!point) {
    return {
      success: false,
      error: `No source line match found at Page ${dto.page} (${dto.x}, ${dto.y})`,
    };
  }

  return { success: true, result: point };
}

export async function getWordCountHelper(
  ctx: Pick<ClsiSynctexWordCountContext, 'workspacePlanner' | 'wordCounter'>,
  dto: ClsiWordCountDto,
  authorizedProjectId?: string,
): Promise<{
  success: boolean;
  stats?: WordCountStats;
  error?: string;
}> {
  const { spaceId: resolvedSpaceId, pageId: resolvedPageId } =
    await ctx.workspacePlanner.resolvePageCompileContext(
      dto,
      authorizedProjectId,
    );
  const projectId =
    resolvedSpaceId && resolvedSpaceId !== 'default'
      ? resolvedSpaceId
      : undefined;
  const manuscriptPageId = resolvedPageId ?? dto.pageId;
  const scratchScopeId = manuscriptPageId || projectId || 'default';

  // Multi-file project word count if files map is provided or projectId is provided without explicit single-file source
  if (
    (dto.files && Object.keys(dto.files).length > 0) ||
    (projectId && projectId !== 'default' && dto.source === undefined)
  ) {
    let stringFiles: Record<string, string> = {};
    let rootFile = dto.filename || 'main.tex';

    if (projectId && projectId !== 'default') {
      try {
        const plan = await ctx.workspacePlanner.planFiles(
          projectId,
          {
            spaceId: projectId,
            pageId: manuscriptPageId,
            files: dto.files,
          },
          manuscriptPageId,
        );
        rootFile = plan.mainFile || rootFile;
        const hydrated = await ctx.workspacePlanner.hydrateFiles(
          projectId,
          plan,
          scratchScopeId,
        );
        for (const [filePath, val] of Object.entries(hydrated)) {
          if (typeof val === 'string') {
            stringFiles[filePath] = val;
          }
        }
      } catch {
        if (dto.files) {
          stringFiles = { ...dto.files };
        }
      }
    } else if (dto.files) {
      stringFiles = { ...dto.files };
    }

    const stats = ctx.wordCounter.countProject(stringFiles, {
      rootFile,
      includeBib: dto.includeBib,
    });

    // If single source was also passed along with files, compute single-file stats for `stats` while attaching `perFileStats`
    if (dto.source !== undefined) {
      const singleStats = ctx.wordCounter.count(
        dto.source,
        dto.filename || rootFile,
        { includeBib: dto.includeBib },
      );
      return {
        success: true,
        stats: {
          ...singleStats,
          perFileStats: stats.perFileStats,
        },
      };
    }

    return {
      success: true,
      stats,
    };
  }

  if (!dto.source || !dto.source.trim()) {
    return {
      success: true,
      stats: {
        wordsInText: 0,
        wordsInHeaders: 0,
        wordsInCaptions: 0,
        wordsInBibliography: 0,
        headers: 0,
        floats: 0,
        mathInlines: 0,
        mathDisplayed: 0,
        totalWords: 0,
        charactersWithSpaces: 0,
        charactersNoSpaces: 0,
        cjkCharacters: 0,
        readingTimeMinutes: 0,
        sections: [],
        rawOutput: 'Empty document (0 words)',
      },
    };
  }

  const stats = ctx.wordCounter.count(
    dto.source,
    dto.filename || 'document.tex',
    { includeBib: dto.includeBib },
  );

  if (projectId && projectId !== 'default') {
    try {
      const plan = await ctx.workspacePlanner.planFiles(
        projectId,
        {
          spaceId: projectId,
          pageId: manuscriptPageId,
          files: dto.files,
        },
        manuscriptPageId,
      );
      const hydrated = await ctx.workspacePlanner.hydrateFiles(
        projectId,
        plan,
        scratchScopeId,
      );
      const stringFiles: Record<string, string> = {};
      for (const [filePath, val] of Object.entries(hydrated)) {
        if (typeof val === 'string') {
          stringFiles[filePath] = val;
        }
      }
      if (Object.keys(stringFiles).length > 0) {
        const projectStats = ctx.wordCounter.countProject(stringFiles, {
          rootFile: plan.mainFile,
          includeBib: dto.includeBib,
        });
        stats.perFileStats = projectStats.perFileStats;
      }
    } catch {
      // Ignore project hydration failure when counting single source
    }
  }

  return {
    success: true,
    stats,
  };
}
