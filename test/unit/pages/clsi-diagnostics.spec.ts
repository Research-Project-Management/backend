import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  CompilerDiagnostic,
  ILatexEngine,
} from '@/modules/pages/clsi/domain/clsi.ports';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_PROJECT_BYTES,
  validatePlannedFileSet,
  type PlannedFileSet,
} from '@/modules/pages/clsi/domain/fileset.planner';
import {
  CompilePipeline,
  MAX_PARSE_LOG_BYTES,
  readBoundedLogFile,
} from '@/modules/pages/clsi/services/compile-pipeline.service';
import { WorkspaceRepository } from '@/modules/pages/clsi/repositories/workspace.repository';
import { enrichUnreachableRemoteFailure } from '@/modules/pages/clsi/services/clsi-artifacts.helper';
import {
  BibLogParser,
  CompileLogAnalyzer,
  LogLineVo,
  postProcessDiagnostics,
} from '@/modules/pages/diagnostics/domain';
import { resolveUnicodePreamblePackages } from '@/modules/pages/core/domain/latex-preamble';
import { fixLatexError } from '@/modules/pages/clsi/domain/ai-assistant';

describe('CLSI Log Harvesting, Validation & Diagnostics Pipeline', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Bounded Log Reader, Pre-Compile Validator & Compile Outcomes', () => {
    it('reads head + tail slices with truncation marker when log exceeds 1MB limit', async () => {
      const tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'clsi-bounded-log-'),
      );
      try {
        const logPath = path.join(tmpDir, 'output.log');
        const headText = 'HEAD_MARKER: pdfTeX 3.141592653\n';
        const middlePadding = 'A'.repeat(1200 * 1024);
        const tailText =
          '\nTAIL_MARKER: ! Undefined control sequence.\nl.42 \\badcmd\n';
        await fs.writeFile(
          logPath,
          `${headText}${middlePadding}${tailText}`,
          'utf8',
        );

        const result = await readBoundedLogFile(logPath, MAX_PARSE_LOG_BYTES);
        expect(result).not.toBeNull();
        expect(result!.truncated).toBe(true);
        expect(result!.sizeBytes).toBeGreaterThan(MAX_PARSE_LOG_BYTES);
        expect(result!.content).toContain('HEAD_MARKER:');
        expect(result!.content).toContain('TAIL_MARKER:');
        expect(result!.content).toContain('[truncated ');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects missingMainFile, conflictedPaths, and sizeCheck in validatePlannedFileSet', () => {
      const basePlan: PlannedFileSet = {
        mainFile: 'main.tex',
        files: new Map([
          [
            'chapters/intro.tex',
            { kind: 'inline', content: '\\section{Intro}', token: 'i:1' },
          ],
        ]),
        fingerprint: 'fp-1',
        hasMainContent: false,
        conflictedPaths: ['sections/intro.tex'],
      };

      const issues1 = validatePlannedFileSet(basePlan);
      expect(issues1.map((i) => i.code)).toEqual([
        'mainFile',
        'conflictedPaths',
      ]);
      const mainIssue = issues1.find((i) => i.code === 'mainFile');
      expect(
        mainIssue?.code === 'mainFile' && mainIssue.availableTexFiles,
      ).toContain('chapters/intro.tex');

      const oversizedSingle: PlannedFileSet = {
        mainFile: 'main.tex',
        files: new Map([
          ['main.tex', { kind: 'inline', content: 'ok', token: 'i:2' }],
        ]),
        fingerprint: 'fp-2',
        hasMainContent: true,
        binaryFiles: [
          {
            id: 'bin-1',
            name: 'huge-figure.png',
            sizeBytes: DEFAULT_MAX_FILE_BYTES + 1024,
            hash: 'h1',
          },
        ],
      };
      const issues2 = validatePlannedFileSet(oversizedSingle);
      expect(issues2).toHaveLength(1);
      expect(issues2[0].code).toBe('sizeCheck');
      expect(
        issues2[0].code === 'sizeCheck' && issues2[0].offendingFiles[0].path,
      ).toBe('huge-figure.png');

      const oversizedTotal: PlannedFileSet = {
        mainFile: 'main.tex',
        files: new Map([
          ['main.tex', { kind: 'inline', content: 'ok', token: 'i:3' }],
        ]),
        fingerprint: 'fp-3',
        hasMainContent: true,
        binaryFiles: Array.from({ length: 5 }, (_, idx) => ({
          id: `b-${idx}`,
          name: `fig-${idx}.pdf`,
          sizeBytes: Math.floor(DEFAULT_MAX_PROJECT_BYTES / 4),
          hash: `h-${idx}`,
        })),
      };
      const issues3 = validatePlannedFileSet(oversizedTotal);
      expect(issues3.some((i) => i.code === 'sizeCheck')).toBe(true);
    });

    it('maps timedout, terminated, stopped-on-first-error outcomes, harvests .blg, and gates cache on 0 errors', async () => {
      const tmpRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'clsi-outcomes-'),
      );
      try {
        const workspace = new WorkspaceRepository(tmpRoot);
        let scenario: 'stopped' | 'timedout' | 'terminated' = 'stopped';

        const mockEngine: jest.Mocked<ILatexEngine> = {
          name: 'latexmk',
          isAvailable: jest.fn().mockResolvedValue(true),
          compile: jest.fn().mockImplementation(async (opts) => {
            if (scenario === 'stopped') {
              await fs.writeFile(
                path.join(opts.cwd, 'output.log'),
                '(./main.tex\n! Undefined control sequence.\nl.3 \\unknowncmd\n!  ==> Fatal error occurred, no output PDF file produced!\n',
              );
              await fs.writeFile(
                path.join(opts.cwd, 'output.blg'),
                'Warning--I didn\'t find a database entry for "missingKey"\n(There was 1 warning)\n',
              );
              return {
                exitCode: 1,
                stdout: '',
                stderr: '',
                durationMs: 30,
                pdfGenerated: false,
                synctexGenerated: false,
                stopOnFirstError: true,
              };
            }
            if (scenario === 'timedout') {
              await fs.writeFile(
                path.join(opts.cwd, 'output.log'),
                'Timed out',
              );
              return {
                exitCode: 124,
                stdout: '',
                stderr: 'timed out',
                durationMs: 60000,
                pdfGenerated: false,
                synctexGenerated: false,
                timedOut: true,
              };
            }
            await fs.writeFile(path.join(opts.cwd, 'output.log'), 'Aborted');
            return {
              exitCode: 143,
              stdout: '',
              stderr: 'terminated',
              durationMs: 120,
              pdfGenerated: false,
              synctexGenerated: false,
              aborted: true,
            };
          }),
        };

        const pipeline = new CompilePipeline(
          workspace,
          mockEngine,
          new CompileLogAnalyzer(),
        );

        // 1. stopped-on-first-error + .blg harvesting + build-state must not cache errors
        const resStopped = await pipeline.execute({
          projectId: 'proj-c1-stopped',
          mainFile: 'main.tex',
          source:
            '\\documentclass{article}\n\\begin{document}\n\\unknowncmd\n\\end{document}',
          stopOnFirstError: true,
        });
        expect(resStopped.outcome).toBe('stopped-on-first-error');
        expect(resStopped.logMeta?.bibLogFiles).toContain('output.blg');
        expect(resStopped.diagnostics.some((d) => d.source === 'bibtex')).toBe(
          true,
        );

        // Verify a second call does not serve a false cached hit on the failed fingerprint
        const resSecondTry = await pipeline.execute({
          projectId: 'proj-c1-stopped',
          mainFile: 'main.tex',
          source:
            '\\documentclass{article}\n\\begin{document}\n\\unknowncmd\n\\end{document}',
          stopOnFirstError: true,
        });
        expect(resSecondTry.cached).not.toBe(true);
        expect(mockEngine.compile).toHaveBeenCalledTimes(2);

        // 2. timedout
        scenario = 'timedout';
        const resTimedout = await pipeline.execute({
          projectId: 'proj-c1-timeout',
          mainFile: 'main.tex',
          source: '\\documentclass{article}\\begin{document}x\\end{document}',
        });
        expect(resTimedout.outcome).toBe('timedout');

        // 3. terminated
        scenario = 'terminated';
        const resTerminated = await pipeline.execute({
          projectId: 'proj-c1-abort',
          mainFile: 'main.tex',
          source: '\\documentclass{article}\\begin{document}x\\end{document}',
        });
        expect(resTerminated.outcome).toBe('terminated');
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('marks outcome as failure when nonstopmode generates partial PDF with parsed errors', async () => {
      const tmpRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'clsi-partial-pdf-err-'),
      );
      try {
        const workspace = new WorkspaceRepository(tmpRoot);
        const mockEngine: jest.Mocked<ILatexEngine> = {
          name: 'latexmk',
          isAvailable: jest.fn().mockResolvedValue(true),
          compile: jest.fn().mockImplementation(async (opts) => {
            const cwd = (opts as { cwd: string }).cwd;
            await fs.writeFile(
              path.join(cwd, 'output.pdf'),
              '%PDF-1.5 partial',
            );
            await fs.writeFile(
              path.join(cwd, 'output.log'),
              '(./main.tex\n! Undefined control sequence.\nl.3 \\badnonstop\n',
            );
            return {
              exitCode: 1,
              stdout: '',
              stderr: '',
              durationMs: 20,
              pdfGenerated: true,
              synctexGenerated: false,
            };
          }),
        };

        const pipeline = new CompilePipeline(
          workspace,
          mockEngine,
          new CompileLogAnalyzer(),
        );
        const res = await pipeline.execute({
          projectId: 'proj-partial-err',
          mainFile: 'main.tex',
          source:
            '\\documentclass{article}\\begin{document}\\badnonstop\\end{document}',
          stopOnFirstError: false,
        });

        expect(res.outcome).toBe('failure');
        expect(res.status).toBe('failure');
        expect(res.pdf).toBeDefined();
        expect(res.diagnosticsSummary?.totalErrors).toBe(1);
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('emits clsi-unavailable with zero fabricated diagnostics when remote CLSI is unreachable', () => {
      const unreachable = enrichUnreachableRemoteFailure({
        pipelineResult: {
          success: false,
          status: 'failure',
          outcome: 'clsi-unavailable',
          error:
            'No supported TeX engine found locally (connect ECONNREFUSED 127.0.0.1:3013)',
          logs: '',
          durationMs: 5,
        },
        mainFile: 'main.tex',
        remoteUrl: 'http://127.0.0.1:3013',
      });
      expect(unreachable.outcome).toBe('clsi-unavailable');
      expect(unreachable.diagnostics).toEqual([]);
      expect(unreachable.success).toBe(false);
    });
  });

  describe('Log Unwrap, BibLogParser, Analyzer & Post-Processor', () => {
    it('unwraps strictly 79-char wrapped TeX lines without merging short lines, ellipsis, or fresh records', () => {
      const exact79 = 'L'.repeat(79);
      const exact79WithDots = `${'D'.repeat(76)}...`;
      const unwrapped = LogLineVo.unwrap(
        [
          exact79,
          'continued-part',
          exact79,
          '! Undefined control sequence.',
          exact79WithDots,
          'next-line-after-dots',
          'Short line',
          'Another short line',
        ].join('\n'),
      );

      expect(unwrapped[0]).toBe(`${exact79}continued-part`);
      expect(unwrapped[1]).toBe(exact79);
      expect(unwrapped[2]).toBe('! Undefined control sequence.');
      expect(unwrapped[3]).toBe(exact79WithDots);
      expect(unwrapped[4]).toBe('next-line-after-dots');
      expect(unwrapped[5]).toBe('Short line');
      expect(unwrapped[6]).toBe('Another short line');
    });

    it('parses BibTeX and Biber .blg logs with dedicated codes and source metadata', () => {
      const parser = new BibLogParser();

      const bibtexItems = parser.parse(`
Database file #1: refs.bib
I was expecting an '='---line 14 of file refs/library.bib
 : author
Repeated entry---line 28 of file refs/library.bib
 : @article{knuth1984
Warning--I didn't find a database entry for "missing2025"
Warning--empty title in knuth1984
`);
      expect(bibtexItems).toHaveLength(4);
      expect(bibtexItems[0].source).toBe('bibtex');
      expect(bibtexItems[0].file).toBe('refs/library.bib');
      expect(bibtexItems[0].line).toBe(14);
      expect(bibtexItems[0].code).toBe('BIB_SYNTAX_ERROR');
      expect(bibtexItems[1].code).toBe('BIB_DUPLICATE_KEY');
      expect(bibtexItems[2].file).toBe('refs.bib');
      expect(bibtexItems[2].code).toBe('UNDEFINED_CITATION');
      expect(bibtexItems[3].file).toBe('refs.bib');
      expect(bibtexItems[3].code).toBeUndefined();

      const biberItems = parser.parse(`
[88] Biber.pm:400> INFO - Found BibTeX data source 'refs.bib'
[102] Biber.pm:131> ERROR - BibTeX subsystem: /tmp/biber_tmp_x/hash.utf8, line 9: syntax error: found "title", expected ","
[120] Biber.pm:140> WARN - The following entry could not be found in the database: missing_biber_key
`);
      expect(biberItems).toHaveLength(2);
      expect(biberItems[0].source).toBe('biber');
      expect(biberItems[0].file).toBe('refs.bib');
      expect(biberItems[0].line).toBe(9);
      expect(biberItems[0].code).toBe('BIB_SYNTAX_ERROR');
      expect(biberItems[1].source).toBe('biber');
      expect(biberItems[1].severity.value).toBe('warning');
      expect(biberItems[1].code).toBe('UNDEFINED_CITATION');
    });

    it('detects Runaway argument, 20-line lookahead, highlightCommand, nested defaultFile, and cascade suppression', () => {
      const analyzer = new CompileLogAnalyzer();
      const longContextLines = Array.from(
        { length: 14 },
        (_, idx) => `<recently read> line ${idx}`,
      );
      const logText = [
        '(./paper/main.tex',
        '(./sections/intro.tex',
        'Runaway argument?',
        '{Some unclosed argument text',
        '! Paragraph ended before \\textbf was complete.',
        '<to be read again>',
        'l.18 \\textbf{unclosed',
        '! Undefined control sequence.',
        ...longContextLines,
        'l.25 \\badmacrofoo',
        '!  ==> Fatal error occurred, no output PDF file produced!',
        'LaTeX Warning: Reference `sec:intro` on page 1 undefined on input line 12',
        ')',
        ')',
      ].join('\n');

      const res = analyzer.parseWithSummary(logText, 'paper/main.tex', {
        stopOnFirstError: true,
      });

      const runaway = res.diagnostics.find(
        (d) => d.code === 'RUNAWAY_ARGUMENT',
      );
      expect(runaway).toBeDefined();
      expect(runaway?.file).toBe('paper/sections/intro.tex');
      expect(runaway?.line).toBe(18);

      const undef = res.diagnostics.find(
        (d) => d.code === 'UNDEFINED_CONTROL_SEQUENCE',
      );
      expect(undef).toBeDefined();
      expect(undef?.line).toBe(25);
      expect(undef?.highlightCommand).toBe('\\badmacrofoo');

      // Fatal cascade follow-up & transient warning suppressed
      expect(
        res.diagnostics.some((d) => d.message.includes('Fatal error occurred')),
      ).toBe(false);
      expect(res.summary.suppressedCascadeCount).toBeGreaterThanOrEqual(1);
      expect(
        res.diagnostics.some((d) =>
          d.message.includes('undefined on input line 12'),
        ),
      ).toBe(false);
    });

    it('postProcessDiagnostics deduplicates, suppresses cascades, and caps deterministically at maxDiagnostics', () => {
      const many: CompilerDiagnostic[] = Array.from({ length: 240 }, (_, i) => {
        const kind = i < 5 ? 'error' : i < 120 ? 'warning' : 'badbox';
        return {
          line: i <= 1 ? 1 : i + 1,
          severity: kind,
          category: kind,
          message:
            i === 0
              ? 'Undefined control sequence'
              : i === 1
                ? 'Undefined control sequence.'
                : `Diag ${i}`,
          code: i < 2 ? 'UNDEFINED_CONTROL_SEQUENCE' : undefined,
          file: 'main.tex',
        };
      });

      const { diagnostics, summary } = postProcessDiagnostics(many, {
        maxDiagnostics: 200,
      });
      expect(diagnostics).toHaveLength(200);
      expect(summary.truncated).toBe(true);
      // Item 0 and 1 deduplicated on normalized message & same file/line -> total errors = 4 (i=0,2,3,4)
      expect(summary.totalErrors).toBe(4);
    });

    it('joins multi-line GenericError Unicode messages and attaches T5 quickFix + explanation', () => {
      const analyzer = new CompileLogAnalyzer();
      const logText = [
        '(./main.tex',
        './main.tex:10: LaTeX Error: Unicode character ấ (U+1EA5)',
        '               not set up for use with LaTeX.',
        '',
        'See the LaTeX manual or LaTeX Companion for explanation.',
        'Type  H <return>  for immediate help.',
        ' ...',
        '',
        'l.10 \\maketitle',
        '',
        '!  ==> Fatal error occurred, no output PDF file produced!',
        ')',
      ].join('\n');

      const res = analyzer.parseWithSummary(logText, 'main.tex');
      expect(res.summary.totalErrors).toBe(1);
      expect(res.diagnostics).toHaveLength(1);
      const err = res.diagnostics[0];
      expect(err.file).toBe('main.tex');
      expect(err.line).toBe(10);
      expect(err.message).toContain(
        'Unicode character ấ (U+1EA5) not set up for use with LaTeX.',
      );
      expect(err.code).toBe('UNICODE_CHAR_NOT_SET_UP');
      expect(err.explanation?.title).toBe('Unsupported Unicode Character');
      expect(err.quickFix?.replacementText).toBe('\\usepackage[T5]{fontenc}');
    });

    it('resolveUnicodePreamblePackages selects minimal script-appropriate preamble packages', () => {
      expect(resolveUnicodePreamblePackages(['Flux', 'John Doe'])).toEqual({
        magicComments: [],
        packages: [],
      });
      expect(resolveUnicodePreamblePackages(['flux', 'Tấn Thành'])).toEqual({
        magicComments: [],
        packages: ['\\usepackage[T5]{fontenc}'],
      });
      expect(resolveUnicodePreamblePackages(['Paper', 'José Müller'])).toEqual({
        magicComments: [],
        packages: ['\\usepackage[T1]{fontenc}'],
      });
      expect(resolveUnicodePreamblePackages(['Paper', '山田太郎'])).toEqual({
        magicComments: ['% !TEX program = xelatex'],
        packages: ['\\usepackage{fontspec}'],
      });
    });

    it('parses \\usepackage before \\documentclass with USEPACKAGE_BEFORE_DOCUMENTCLASS rule and explanation', () => {
      const analyzer = new CompileLogAnalyzer();
      const logText = [
        '(./main.tex',
        './main.tex:1: LaTeX Error: \\usepackage before \\documentclass.',
        '',
        'See the LaTeX manual or LaTeX Companion for explanation.',
        'Type  H <return>  for immediate help.',
        ' ...',
        '',
        'l.1 \\usepackage',
        '               [utf8]{inputenc}',
        ')',
      ].join('\n');

      const res = analyzer.parseWithSummary(logText, 'main.tex');
      expect(res.summary.totalErrors).toBe(1);
      expect(res.diagnostics).toHaveLength(1);
      const err = res.diagnostics[0];
      expect(err.code).toBe('USEPACKAGE_BEFORE_DOCUMENTCLASS');
      expect(err.explanation?.title).toBe(
        '\\usepackage Before \\documentclass',
      );
    });

    it('fixLatexError returns T5 package for Vietnamese Unicode and reorders misplaced \\usepackage before \\documentclass', () => {
      const unicodeFix = fixLatexError({
        errorMessage:
          'LaTeX Error: Unicode character ấ (U+1EA5) not set up for use with LaTeX.',
        errorLine: 5,
        surroundingCode: '\\title{flux}\n\\author{Tấn Thành}',
      });
      expect(unicodeFix.fixedSnippet).toBe('\\usepackage[T5]{fontenc}');
      expect(unicodeFix.confidence).toBe('high');

      const orderFix = fixLatexError({
        errorMessage: 'LaTeX Error: \\usepackage before \\documentclass.',
        errorLine: 1,
        surroundingCode: [
          '\\usepackage[utf8]{inputenc}',
          '\\usepackage[T1]{fontenc}\\documentclass{article}',
          '\\usepackage{graphicx}',
        ].join('\n'),
      });
      expect(orderFix.startLine).toBe(1);
      expect(orderFix.endLine).toBe(2);
      expect(orderFix.fixedSnippet).toBe(
        [
          '\\documentclass{article}',
          '\\usepackage[utf8]{inputenc}',
          '\\usepackage[T1]{fontenc}',
        ].join('\n'),
      );
      expect(orderFix.confidence).toBe('high');
    });
  });
});
