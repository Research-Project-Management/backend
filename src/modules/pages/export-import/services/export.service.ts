import { Injectable, Optional } from '@nestjs/common';
import { SnapshotService } from '@/modules/pages/history/services/snapshot.service';
import { ArchiveManifest } from '../domain/archive.domain';
import {
  IExportProfileStrategy,
  resolveExportProfile,
} from '../domain/archive.policy';
import {
  IPageArchiveAggregatorPort,
  IZipEnginePort,
} from '../domain/archive.ports';
import { ZipAdapter } from '../adapters/zip.adapter';
import { ExportZipQueryDto } from '../dto/export.dto';
import type {
  ExportProjectZipOutput,
  ExportProjectZipStreamOutput,
} from '../types/archive.types';

const DEFAULT_MAIN_TEX_FALLBACK = Buffer.from(
  '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
  'utf8',
);

@Injectable()
export class ExportService {
  private readonly zipEngine: IZipEnginePort;

  constructor(
    private readonly aggregator: IPageArchiveAggregatorPort,
    @Optional() zipEngine?: IZipEnginePort,
    @Optional() private readonly snapshotService?: SnapshotService,
  ) {
    this.zipEngine = zipEngine ?? new ZipAdapter();
  }

  public async collectProjectEntries(
    projectId: string,
    includePdf = false,
    cleanArxiv = false,
    pageId?: string,
  ) {
    return this.aggregator.collectProjectEntries(
      projectId,
      includePdf,
      cleanArxiv,
      pageId,
    );
  }

  public async exportProjectZip(
    projectId: string,
    query?: ExportZipQueryDto,
  ): Promise<ExportProjectZipOutput> {
    const profile = resolveExportProfile(query);
    const includePdf = profile.shouldIncludeCompiledPdf(query?.includePdf);

    const collected = await this.aggregator.collectProjectEntries(
      projectId,
      includePdf,
      profile.cleanArxiv,
      query?.pageId,
    );

    const { files, hasPdf, resolvedName } = this.prepareExportPlan(
      collected,
      profile,
      (entryPath, data) => ({ path: entryPath, data }),
      query?.projectName,
    );

    const zipBuffer = this.zipEngine.buildZip(files);
    const manifest = ArchiveManifest.create({
      projectId,
      projectName: resolvedName,
      fileCount: files.length,
      totalSizeBytes: zipBuffer.length,
      hasCompiledPdf: hasPdf,
    });

    return { zipBuffer, manifest };
  }

  public async exportProjectZipStream(
    projectId: string,
    query?: ExportZipQueryDto,
  ): Promise<ExportProjectZipStreamOutput> {
    if (query?.version && this.snapshotService) {
      const versionResult =
        await this.snapshotService.exportVersionZipStream(
          projectId,
          Number(query.version),
          query.projectName,
          query.pageId,
        );
      return {
        zipStream: versionResult.zipStream,
        projectName: versionResult.filename.replace(/\.zip$/i, ''),
        fileCount: versionResult.fileCount,
        hasCompiledPdf: false,
      };
    }

    const profile = resolveExportProfile(query);
    const includePdf = profile.shouldIncludeCompiledPdf(query?.includePdf);

    const collected = await this.aggregator.collectLazyProjectEntries(
      projectId,
      includePdf,
      profile.cleanArxiv,
      query?.pageId,
    );

    const { files, hasPdf, resolvedName } = this.prepareExportPlan(
      collected,
      profile,
      (entryPath, data) => ({ path: entryPath, data }),
      query?.projectName,
    );

    return {
      zipStream: this.zipEngine.createZipStream(files),
      projectName: resolvedName,
      fileCount: files.length,
      hasCompiledPdf: hasPdf,
    };
  }

  private prepareExportPlan<T extends { path: string }>(
    files: T[],
    profile: IExportProfileStrategy,
    createFallbackEntry: (path: string, data: Buffer) => T,
    projectName?: string,
  ): {
    files: T[];
    hasPdf: boolean;
    resolvedName: string;
  } {
    if (files.length === 0) {
      files.push(createFallbackEntry('main.tex', DEFAULT_MAIN_TEX_FALLBACK));
    }

    const hasPdf = files.some((f) => f.path.toLowerCase().endsWith('.pdf'));
    const resolvedName = profile.formatArchiveName(projectName);

    return { files, hasPdf, resolvedName };
  }
}
