/**
 * modules/manuscripts/clsi/core/ports/engine.port.ts
 * Contract for LaTeX compilation engines (latexmk, tectonic, etc.)
 */

export interface EngineRunOptions {
  cwd: string;
  mainFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  stopOnFirstError?: boolean;
  draft?: boolean;
  shellEscape?: boolean;
  syntaxOnly?: boolean;
}

export interface EngineRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  pdfGenerated: boolean;
  synctexGenerated: boolean;
}

export interface ILatexEngine {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  compile(
    options: EngineRunOptions,
    compilerOverride?: 'pdflatex' | 'xelatex' | 'lualatex'
  ): Promise<EngineRunResult>;
}
