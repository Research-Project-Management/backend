/**
 * modules/manuscripts/clsi/domain/clsi.ports.ts
 * Domain contracts and port interfaces for CLSI artifacts, engines, sandbox runners, and workspaces.
 */

import { WorkspaceFile } from '@/modules/manuscripts/core';
import { SandboxProfile } from './sandbox-profile';

export interface CompilerDiagnostic {
  file?: string;
  line: number | null;
  message: string;
  context?: string;
  severity: 'error' | 'warning' | 'info';
  code?: string;
  suggestion?: string;
}

export interface ILogParser {
  parse(logText: string, defaultFile?: string): CompilerDiagnostic[];
}

export interface SyncPoint {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  precision: 'exact' | 'approximate';
}

export interface ReverseSyncPoint {
  file: string;
  line: number;
  column: number;
  precision: 'coordinate_match';
}

export interface ISyncTexProcessor {
  decompress(buffer: Buffer): Promise<string>;
  forwardLookup(
    synctexText: string,
    file: string,
    line: number,
    col?: number,
  ): SyncPoint | null;
  reverseLookup(
    synctexText: string,
    page: number,
    x: number,
    y: number,
  ): ReverseSyncPoint | null;
}

export interface WordCountStats {
  wordsInText: number;
  wordsInHeaders: number;
  wordsInCaptions: number;
  headers: number;
  floats: number;
  mathInlines: number;
  mathDisplayed: number;
  totalWords: number;
  charactersWithSpaces: number;
  charactersNoSpaces: number;
  rawOutput: string;
}

export interface IWordCounter {
  count(source: string, filename?: string): WordCountStats;
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
    inputFiles: string[],
  ): Promise<DiscoveredOutputFile[]>;
}

export interface EngineRunOptions {
  cwd: string;
  mainFile: string;
  timeoutMs?: number;
  stopOnFirstError?: boolean;
  draft?: boolean;
  syntaxOnly?: boolean;
  shellEscape?: boolean;
  compilerOverride?: 'pdflatex' | 'xelatex' | 'lualatex';
  signal?: AbortSignal;
  onLogChunk?: (chunk: string) => void;
  env?: Record<string, string>;
}

export interface EngineRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  pdfGenerated: boolean;
  synctexGenerated: boolean;
  timedOut?: boolean;
  shellEscapeAdvisories?: string[];
}

export interface ILatexEngine {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  compile(
    options: EngineRunOptions,
    compilerOverride?: 'pdflatex' | 'xelatex' | 'lualatex',
  ): Promise<EngineRunResult>;
}

export interface ProcessExecutionOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onLogChunk?: (chunk: string) => void;
  maxOutputBytes?: number;
  profile?: SandboxProfile;
  runId?: string;
}

export interface ProcessExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  signal?: string | null;
  killed?: boolean;
}

export interface ISandboxRunner {
  readonly name: string;
  run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult>;
}

export type { WorkspaceFile };

export interface WorkspaceSyncStats {
  written: number;
  unchanged: number;
  deleted: number;
}

export interface AuxFileInfo {
  name: string;
  size: number;
  ext: string;
}

export interface SyncWorkspaceResult {
  scratchDir: string;
  syncedFiles: string[];
  unchangedFiles: string[];
  removedFiles: string[];
}

export interface IWorkspaceManager {
  getScratchDir(projectId: string): string;
  ensureScratch(projectId: string): Promise<string>;
  syncFiles(
    projectId: string,
    files: WorkspaceFile[],
  ): Promise<WorkspaceSyncStats>;
  cleanScratch(projectId: string): Promise<void>;
  purgeExtraneousFiles(projectId: string, inputFiles: string[]): Promise<void>;
  listAuxFiles(projectId: string): Promise<AuxFileInfo[]>;
  readAuxFile(projectId: string, filename: string): Promise<Buffer | null>;
  readArtifact(projectId: string, filename: string): Promise<Buffer | null>;
}
