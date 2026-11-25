/**
 * modules/pages/clsi/services/synctex.service.ts
 * Forward and reverse SyncTeX coordinate lookup service.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { ForwardSyncDto, ReverseSyncDto } from '../dto/synctex.dto';
import { ReverseSyncPoint, SyncPoint } from '../domain/ports';
import { ClsiRepository } from '../clsi.repository';
import { SynctexParser } from '../domain/synctex.parser';
import { BoundedLruCache } from '../domain/lru-cache';
import { ClsiRuntimeAdapter } from '../adapters/clsi-runtime.adapter';
import { CompileSourceService } from './compile-source.service';

interface SynctexDiskCacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

@Injectable()
export class SynctexService {
  private readonly synctexParser = new SynctexParser();
  private readonly synctexDiskCache = new BoundedLruCache<
    string,
    SynctexDiskCacheEntry
  >(16);

  constructor(
    private readonly workspace: ClsiRepository,
    private readonly runtime: ClsiRuntimeAdapter,
    private readonly compileSource: CompileSourceService,
  ) {}

  private async loadSynctexContent(
    scratchId: string,
    inlineSynctexBase64?: string,
  ): Promise<string | null> {
    if (inlineSynctexBase64) {
      const buffer = Buffer.from(inlineSynctexBase64, 'base64');
      return await this.synctexParser.decompress(buffer);
    }

    const scratchDir = this.workspace.getScratchDir(scratchId);
    for (const filename of ['output.synctex.gz', 'output.synctex']) {
      try {
        const safePath = path.join(scratchDir, filename);
        const stat = await fs.lstat(safePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;

        const cacheKey = `${scratchId}:${filename}`;
        const cached = this.synctexDiskCache.get(cacheKey);
        if (
          cached &&
          cached.mtimeMs === stat.mtimeMs &&
          cached.size === stat.size
        ) {
          return cached.content;
        }

        const buf = await this.workspace.readAuxFile(scratchId, filename);
        if (!buf) continue;
        const content = filename.endsWith('.gz')
          ? await this.synctexParser.decompress(buf)
          : buf.toString('utf8');
        if (content) {
          this.synctexDiskCache.set(cacheKey, {
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

  public async forwardSync(
    dto: ForwardSyncDto,
    authorizedSpaceId?: string,
  ): Promise<{
    success: boolean;
    result?: SyncPoint;
    error?: string;
  }> {
    const { spaceId, pageId } =
      await this.compileSource.resolvePageCompileContext(
        dto,
        authorizedSpaceId,
      );
    const scratchId = pageId || spaceId;

    const remoteRes = await this.runtime.tryRemoteForwardSync(dto, {
      spaceId,
      pageId,
    });
    if (remoteRes) return remoteRes;

    const synctexContent = await this.loadSynctexContent(
      scratchId,
      dto.synctex,
    );
    if (!synctexContent) {
      return {
        success: false,
        error:
          'SyncTeX data not available. Compile the document first to generate SyncTeX mapping.',
      };
    }

    const point = this.synctexParser.forwardLookup(
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

  public async reverseSync(
    dto: ReverseSyncDto,
    authorizedSpaceId?: string,
  ): Promise<{
    success: boolean;
    result?: ReverseSyncPoint;
    error?: string;
  }> {
    const { spaceId, pageId } =
      await this.compileSource.resolvePageCompileContext(
        dto,
        authorizedSpaceId,
      );
    const scratchId = pageId || spaceId;

    const remoteRes = await this.runtime.tryRemoteReverseSync(dto, {
      spaceId,
      pageId,
    });
    if (remoteRes) return remoteRes;

    const synctexContent = await this.loadSynctexContent(
      scratchId,
      dto.synctex,
    );
    if (!synctexContent) {
      return {
        success: false,
        error:
          'SyncTeX data not available. Compile the document first to generate SyncTeX mapping.',
      };
    }

    const point = this.synctexParser.reverseLookup(
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
}
