/**
 * modules/pages/clsi/adapters/texcount.adapter.ts
 * Runs the real TeX Live `texcount` binary (Overleaf parity) in an isolated temp directory
 * with safe `execFile` (no shell), UTF-8 support, `\input`/`\include` traversal, and strict timeout.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type {
  ISandboxRunner,
  WordCountFileStats,
  WordCountSection,
  WordCountStats,
} from '../domain/ports';
import { SafePath } from '../domain/path.policy';

const execFileAsync = promisify(execFile);

const BRIEF_LINE_RE =
  /^\s*(\d+)\+(\d+)\+(\d+)\s+\((\d+)\/(\d+)\/(\d+)\/(\d+)\)\s+(.*)$/;
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g;

export interface ParsedTexcountBrief {
  wordsInText: number;
  wordsInHeaders: number;
  wordsInCaptions: number;
  headers: number;
  floats: number;
  mathInlines: number;
  mathDisplayed: number;
  sections: WordCountSection[];
  perFileStats: WordCountFileStats[];
}

/**
 * Pure parser for `texcount -v0 -utf8 -brief -sub=section` stdout.
 * Format per line: `<text>+<headers>+<captions> (<h>/<f>/<inMath>/<dispMath>) <label>`
 */
export function parseTexcountBriefOutput(
  stdout: string,
  defaultFilename = 'main.tex',
): ParsedTexcountBrief | null {
  const lines = (stdout || '').split(/\r?\n/);

  let total: {
    wordsInText: number;
    wordsInHeaders: number;
    wordsInCaptions: number;
    headers: number;
    floats: number;
    mathInlines: number;
    mathDisplayed: number;
  } | null = null;

  const sections: WordCountSection[] = [];
  const perFileStats: WordCountFileStats[] = [];

  for (const rawLine of lines) {
    const match = BRIEF_LINE_RE.exec(rawLine);
    if (!match) continue;

    const wordsInText = Number(match[1]);
    const wordsInHeaders = Number(match[2]);
    const wordsInCaptions = Number(match[3]);
    const headers = Number(match[4]);
    const floats = Number(match[5]);
    const mathInlines = Number(match[6]);
    const mathDisplayed = Number(match[7]);
    const label = match[8].trim();

    if (/^Total\b/i.test(label) || /^Sum count:/i.test(label)) {
      total = {
        wordsInText,
        wordsInHeaders,
        wordsInCaptions,
        headers,
        floats,
        mathInlines,
        mathDisplayed,
      };
      continue;
    }

    const fileMatch = /^(?:Included file|File):\s*(.+)$/i.exec(label);
    if (fileMatch) {
      const filePath = fileMatch[1].trim().replace(/^\.\//, '');
      const entry: WordCountFileStats = {
        id: filePath,
        title: path.posix.basename(filePath.replace(/\\/g, '/')),
        path: filePath,
        words: wordsInText + wordsInHeaders + wordsInCaptions,
        wordsInText,
        wordsInHeaders,
        wordsInCaptions,
        wordsInBibliography: 0,
        headers,
        floats,
        math: mathInlines + mathDisplayed,
        mathInlines,
        mathDisplayed,
      };
      perFileStats.push(entry);
      // Single-file `texcount` outputs `File: ...` without a separate `Total` line.
      if (!total) {
        total = {
          wordsInText,
          wordsInHeaders,
          wordsInCaptions,
          headers,
          floats,
          mathInlines,
          mathDisplayed,
        };
      }
      continue;
    }

    const secMatch =
      /^(Section|Subsection|Subsubsection|Chapter|Part):\s*(.*)$/i.exec(label);
    if (secMatch) {
      sections.push({
        level: secMatch[1].toLowerCase(),
        title: secMatch[2].trim() || '(untitled)',
        line: 0,
        words: wordsInText + wordsInHeaders + wordsInCaptions,
      });
    }
  }

  if (!total) return null;

  if (perFileStats.length === 0) {
    perFileStats.push({
      id: defaultFilename,
      title: path.posix.basename(defaultFilename.replace(/\\/g, '/')),
      path: defaultFilename,
      words: total.wordsInText + total.wordsInHeaders + total.wordsInCaptions,
      wordsInText: total.wordsInText,
      wordsInHeaders: total.wordsInHeaders,
      wordsInCaptions: total.wordsInCaptions,
      wordsInBibliography: 0,
      headers: total.headers,
      floats: total.floats,
      math: total.mathInlines + total.mathDisplayed,
      mathInlines: total.mathInlines,
      mathDisplayed: total.mathDisplayed,
    });
  }

  return {
    ...total,
    sections,
    perFileStats,
  };
}

export class TexcountCliAdapter {
  private readonly bin: string;
  private readonly sandboxRunner?: ISandboxRunner;

  constructor(
    binOrRunner: string | ISandboxRunner = process.env.TEXCOUNT_BIN ||
      'texcount',
    sandboxRunner?: ISandboxRunner,
  ) {
    if (typeof binOrRunner === 'string') {
      this.bin = binOrRunner;
      this.sandboxRunner = sandboxRunner;
    } else {
      this.bin = process.env.TEXCOUNT_BIN || 'texcount';
      this.sandboxRunner = binOrRunner;
    }
  }

  public async countFiles(params: {
    files: Record<string, string>;
    rootFile: string;
    includeBib?: boolean;
    timeoutMs?: number;
  }): Promise<WordCountStats | null> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-texcount-'));
    try {
      const normalizedRoot =
        SafePath.normalizeRelPath(params.rootFile || 'main.tex') || 'main.tex';
      if (!SafePath.isSafeCompileEntryPath(normalizedRoot)) {
        return null;
      }
      let combinedText = '';

      for (const [rawPath, content] of Object.entries(params.files)) {
        const rel = SafePath.normalizeRelPath(rawPath);
        if (!rel || rel.includes('..')) continue;
        const abs = await SafePath.assertSafeWorkspacePath(tmpDir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
        combinedText += content + '\n';
      }

      const args = [
        '-v0',
        '-utf8',
        '-brief',
        '-sub=section',
        ...(params.includeBib ? ['-incbib'] : []),
        '--',
        normalizedRoot,
      ];

      const timeoutMs = params.timeoutMs ?? 10_000;
      const env = {
        PATH: process.env.PATH || '',
        HOME: tmpDir,
        TMPDIR: tmpDir,
        LANG: 'C.UTF-8',
      };

      let stdout = '';
      if (this.sandboxRunner) {
        const execResult = await this.sandboxRunner.run(this.bin, args, {
          cwd: tmpDir,
          timeoutMs,
          maxOutputBytes: 2 * 1024 * 1024,
          env,
        });
        if (
          execResult.timedOut ||
          (execResult.exitCode !== 0 && !execResult.stdout)
        ) {
          return null;
        }
        stdout = execResult.stdout;
      } else {
        const execResult = await execFileAsync(this.bin, args, {
          cwd: tmpDir,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          env,
        });
        stdout = execResult.stdout;
      }

      const parsed = parseTexcountBriefOutput(stdout, normalizedRoot);
      if (!parsed) return null;

      const totalWords =
        parsed.wordsInText + parsed.wordsInHeaders + parsed.wordsInCaptions;
      const charactersWithSpaces = combinedText.trim().length;
      const charactersNoSpaces = combinedText.replace(/\s+/g, '').length;
      const cjkCharacters = (combinedText.match(CJK_RE) || []).length;

      return {
        wordsInText: parsed.wordsInText,
        wordsInHeaders: parsed.wordsInHeaders,
        wordsInCaptions: parsed.wordsInCaptions,
        wordsInBibliography: 0,
        headers: parsed.headers,
        floats: parsed.floats,
        mathInlines: parsed.mathInlines,
        mathDisplayed: parsed.mathDisplayed,
        totalWords,
        charactersWithSpaces,
        charactersNoSpaces,
        cjkCharacters,
        readingTimeMinutes:
          totalWords > 0 ? Math.max(1, Math.ceil(totalWords / 200)) : 0,
        sections: parsed.sections,
        perFileStats: parsed.perFileStats,
        rawOutput: stdout.trim(),
      };
    } catch {
      return null;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
