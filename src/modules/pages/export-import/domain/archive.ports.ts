import { Readable } from 'node:stream';
import type { ArchiveEntryVo, ImportSummaryVo } from './archive.domain';
import type {
  ExportableFileEntry,
  RawZipEntryInput,
  TranspiledProjectResult,
} from '../types/archive.types';

export abstract class IZipEnginePort {
  abstract buildZip(entries: RawZipEntryInput[]): Buffer;
  abstract createZipStream(entries: RawZipEntryInput[]): Readable;
  abstract extractZip(zipBuffer: Buffer): ArchiveEntryVo[];
}

export abstract class IPageArchiveAggregatorPort {
  abstract collectProjectEntries(
    projectId: string,
    includePdf?: boolean,
    cleanArxiv?: boolean,
    pageId?: string,
  ): Promise<ExportableFileEntry[]>;

  abstract collectLazyProjectEntries(
    projectId: string,
    includePdf?: boolean,
    cleanArxiv?: boolean,
    pageId?: string,
  ): Promise<ExportableFileEntry[]>;
}

export abstract class IPageArchiveHydratorPort {
  abstract hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
    pageId?: string,
  ): Promise<ImportSummaryVo>;
}

export abstract class IDocumentTranspilerPort {
  abstract transpileByFormat(
    format: 'docx' | 'md',
    buffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult>;

  abstract transpileMarkdown(
    content: string,
    fileName?: string,
  ): Promise<TranspiledProjectResult>;

  abstract transpileDocx(
    docxBuffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult>;
}
