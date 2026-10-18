/**
 * test/unit/manuscripts/clsi/compile-tex-flags.spec.ts
 * Verifies that TeX engines strictly enforce -no-shell-escape and reject any attempt to enable it.
 */

import {
  LatexmkEngine,
  TectonicEngine,
} from '../../../../src/modules/manuscripts/clsi/services/compile-pipeline.service';
import { BibBackendDetector } from '../../../../src/modules/manuscripts/clsi/domain/bib-backend.detector';
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

  describe('TectonicEngine', () => {
    it('should compile without any shell-escape flags', async () => {
      const engine = new TectonicEngine(mockRunner);
      await engine.compile({
        cwd: '/tmp/workspace',
        mainFile: 'main.tex',
      });

      expect(mockRunner.lastArgs).toBeDefined();
      expect(mockRunner.lastArgs).not.toContain('-Z shell-escape');
      expect(mockRunner.lastArgs).not.toContain('--shell-escape');
    });

    it('should throw SandboxPolicyViolationException if caller tries to pass shellEscape: true', async () => {
      const engine = new TectonicEngine(mockRunner);
      await expect(
        engine.compile({
          cwd: '/tmp/workspace',
          mainFile: 'main.tex',
          shellEscape: true,
        }),
      ).rejects.toThrow(SandboxPolicyViolationException);
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
  });
});
