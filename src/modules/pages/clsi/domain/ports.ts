/**
 * modules/pages/clsi/domain/ports.ts
 * Domain contracts and port interfaces for CLSI artifacts, engines, sandbox runners, and workspaces.
 */

import { WorkspaceFile } from '@/modules/pages/core';
import { SandboxProfile } from './sandbox.policy';

export type CompileOutcome =
  | 'success'
  | 'stopped-on-first-error'
  | 'failure'
  | 'timedout'
  | 'terminated'
  | 'validation-problems'
  | 'clsi-unavailable';

export interface CompileLogMeta {
  sizeBytes: number;
  truncated: boolean;
  logArtifactUrl?: string;
  bibLogFiles?: string[];
}

export interface DiagnosticsSummary {
  totalErrors: number;
  totalWarnings: number;
  totalBadboxes: number;
  suppressedCascadeCount: number;
  truncated: boolean;
}

export type CompileValidationIssue =
  | {
      code: 'mainFile';
      mainFile: string;
      availableTexFiles: string[];
      message: string;
    }
  | {
      code: 'conflictedPaths';
      paths: string[];
      message: string;
    }
  | {
      code: 'sizeCheck';
      totalBytes: number;
      limitBytes: number;
      fileLimitBytes: number;
      offendingFiles: Array<{ path: string; sizeBytes: number }>;
      message: string;
    };

export interface BibLogInput {
  filename: string;
  content: string;
}

export interface LogParseOptions {
  bibLogs?: BibLogInput[];
  stopOnFirstError?: boolean;
  maxDiagnostics?: number;
}

export interface CompilerDiagnostic {
  file?: string;
  line: number | null;
  column?: number;
  message: string;
  context?: string;
  severity: 'error' | 'warning' | 'badbox' | 'info';
  category?: 'error' | 'warning' | 'badbox' | 'info';
  warningSubtype?: 'font' | 'package' | 'citation' | 'reference' | 'badbox';
  source?: 'tex' | 'bibtex' | 'biber' | 'system';
  highlightCommand?: string;
  code?: string;
  suggestion?: string;
  quickFix?: {
    description: string;
    replacementText: string;
  };
  explanation?: {
    title: string;
    whyItHappened: string;
    howToFix: string;
  };
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

export interface WordCountSection {
  title: string;
  level: string;
  line: number;
  words: number;
}

export interface WordCountFileStats {
  id: string;
  title: string;
  path?: string;
  words: number;
  wordsInText: number;
  wordsInHeaders: number;
  wordsInCaptions: number;
  wordsInBibliography?: number;
  headers: number;
  floats: number;
  math: number;
  mathInlines: number;
  mathDisplayed: number;
}

export interface WordCountStats {
  wordsInText: number;
  wordsInHeaders: number;
  wordsInCaptions: number;
  wordsInBibliography?: number;
  headers: number;
  floats: number;
  mathInlines: number;
  mathDisplayed: number;
  totalWords: number;
  charactersWithSpaces: number;
  charactersNoSpaces: number;
  cjkCharacters?: number;
  readingTimeMinutes?: number;
  sections?: WordCountSection[];
  perFileStats?: WordCountFileStats[];
  rawOutput: string;
}

export interface DiscoveredOutputFile {
  path: string;
  size: number;
  mtime: Date;
  isMainPdf: boolean;
  isLog: boolean;
  isSynctex: boolean;
}

export interface EngineRunOptions {
  cwd: string;
  mainFile: string;
  timeoutMs?: number;
  stopOnFirstError?: boolean;
  draft?: boolean;
  syntaxOnly?: boolean;
  force?: boolean;
  shellEscape?: boolean;
  compilerOverride?: 'pdflatex' | 'xelatex' | 'lualatex';
  texLiveVersion?: string;
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
  openinAny?: 'p' | 'r';
  texLiveVersion?: string;
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

export interface BuildStateRecord {
  success: boolean;
  mainFile: string;
  engine: string;
  draft: boolean;
  timestamp: number;
}

export interface CachedCompileArtifacts {
  pdf?: string;
  synctex?: string;
  logs?: string;
}

export interface IWorkspaceManager {
  getScratchDir(spaceId: string): string;
  ensureScratch(spaceId: string): Promise<string>;
  syncFiles(
    spaceId: string,
    files: WorkspaceFile[],
  ): Promise<WorkspaceSyncStats>;
  cleanScratch(spaceId: string): Promise<void>;
  cleanAuxBuildCache(spaceId: string): Promise<void>;
  purgeExtraneousFiles(spaceId: string, inputFiles: string[]): Promise<void>;
  listAuxFiles(spaceId: string): Promise<AuxFileInfo[]>;
  readAuxFile(spaceId: string, filename: string): Promise<Buffer | null>;
  readArtifact(spaceId: string, filename: string): Promise<Buffer | null>;
  readBuildState(spaceId: string): Promise<BuildStateRecord | null>;
  writeBuildState(spaceId: string, state: BuildStateRecord): Promise<void>;
  writeCachedArtifacts(
    spaceId: string,
    artifacts: CachedCompileArtifacts,
  ): Promise<void>;
}
