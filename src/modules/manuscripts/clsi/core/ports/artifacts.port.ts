/**
 * modules/manuscripts/clsi/core/ports/artifacts.port.ts
 * Contracts for artifact extraction, log parsing, SyncTeX mapping, and word counting
 */

export interface CompilerDiagnostic {
  file: string;
  line: number | null;
  column?: number | null;
  message: string;
  severity: 'error' | 'warning' | 'info';
  context?: string;
  code?: string;
  suggestion?: string;
}

export interface SyncPoint {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  precision?: string;
}

export interface ReverseSyncPoint {
  file: string;
  line: number;
  column: number;
  precision?: string;
}

export interface WordCountStats {
  wordsInText: number;
  wordsInHeaders: number;
  wordsInCaptions: number;
  headers: number;
  floats: number;
  mathInlines: number;
  mathDisplayed: number;
}

export interface ILogParser {
  parse(logText: string, defaultFile?: string): CompilerDiagnostic[];
}

export interface ISyncTexProcessor {
  decompress(buffer: Buffer): Promise<string>;
  forwardLookup(
    synctexText: string,
    file: string,
    line: number,
    col?: number
  ): SyncPoint | null;
  reverseLookup(
    synctexText: string,
    page: number,
    x: number,
    y: number
  ): ReverseSyncPoint | null;
}

export interface IWordCounter {
  count(source: string): WordCountStats;
}

export interface DiscoveredOutputFile {
  path: string;
  size: number;
  mtime: Date;
  isMainPdf: boolean;
  isLog: boolean;
  isSynctex: boolean;
}

export interface IOutputFileFinder {
  find(
    scratchDir: string,
    inputFiles: string[]
  ): Promise<DiscoveredOutputFile[]>;
}

