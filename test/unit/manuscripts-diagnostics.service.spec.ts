/**
 * test/unit/manuscripts-diagnostics.service.spec.ts
 * Comprehensive Unit Test Suite for Manuscripts Diagnostics Subsystem
 * Testing TeX Paren-Tree File Tracker, Tectonic Parser, Fast Syntax Linter, Explainer & Controller.
 */

import {
  DiagnosticItem,
  DiagnosticReport,
  DiagnosticSeverityVo,
  LogLineVo,
  ErrorExplanationVo,
  InvalidLogFormatException,
  ExplanationNotFoundException,
  KnowledgeBaseExplainerAdapter,
  TexParenTreeLogParser,
  TectonicLogParser,
  FastSyntaxLinterAdapter,
  ParseCompileLogUseCase,
  LintDocumentSyntaxUseCase,
  GetErrorExplanationUseCase,
  DiagnosticsService,
  DiagnosticsController,
} from '@/modules/manuscripts/diagnostics';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('Manuscripts Diagnostics Subsystem (Log Parser, Linter & Explainer)', () => {
  let explainer: KnowledgeBaseExplainerAdapter;
  let texParser: TexParenTreeLogParser;
  let tectonicParser: TectonicLogParser;
  let linter: FastSyntaxLinterAdapter;

  let parseUseCase: ParseCompileLogUseCase;
  let lintUseCase: LintDocumentSyntaxUseCase;
  let explainUseCase: GetErrorExplanationUseCase;

  let service: DiagnosticsService;
  let controller: DiagnosticsController;

  beforeEach(() => {
    explainer = new KnowledgeBaseExplainerAdapter();
    texParser = new TexParenTreeLogParser(explainer);
    tectonicParser = new TectonicLogParser(explainer);
    linter = new FastSyntaxLinterAdapter(explainer);

    parseUseCase = new ParseCompileLogUseCase(texParser, tectonicParser);
    lintUseCase = new LintDocumentSyntaxUseCase(linter);
    explainUseCase = new GetErrorExplanationUseCase(explainer);

    service = new DiagnosticsService(parseUseCase, lintUseCase, explainUseCase);
    controller = new DiagnosticsController(service);
  });

  // =========================================================================
  // 1. DOMAIN LAYER: VALUE OBJECTS & ENTITIES
  // =========================================================================
  describe('Domain Value Objects & Entities', () => {
    describe('DiagnosticSeverityVo', () => {
      it('should create severities and check flags correctly', () => {
        const err = DiagnosticSeverityVo.error();
        expect(err.isError()).toBe(true);
        expect(err.isWarning()).toBe(false);
        expect(err.isBadbox()).toBe(false);
        expect(err.value).toBe('error');

        const warn = DiagnosticSeverityVo.warning();
        expect(warn.isWarning()).toBe(true);

        const bb = DiagnosticSeverityVo.badbox();
        expect(bb.isBadbox()).toBe(true);

        const info = DiagnosticSeverityVo.info();
        expect(info.value).toBe('info');
      });

      it('should instantiate from string values flexibly', () => {
        expect(DiagnosticSeverityVo.fromString('ERROR').isError()).toBe(true);
        expect(DiagnosticSeverityVo.fromString('warn').isWarning()).toBe(true);
        expect(DiagnosticSeverityVo.fromString('overfull').isBadbox()).toBe(true);
        expect(DiagnosticSeverityVo.fromString('underfull').isBadbox()).toBe(true);
        expect(DiagnosticSeverityVo.fromString('other').value).toBe('info');
      });
    });

    describe('LogLineVo', () => {
      it('should unwrap lines that were hard-wrapped at 79 characters by TeX', () => {
        const longPathLine =
          '(/usr/local/texlive/2024/texmf-dist/tex/latex/amsmath/amsmath.sty'.padEnd(79, ' ');
        const wrappedContinuation = 'package loaded successfully)';

        const rawLog = `${longPathLine}\n${wrappedContinuation}\nNext line here`;
        const unwrapped = LogLineVo.unwrap(rawLog);

        expect(unwrapped.length).toBe(2);
        expect(unwrapped[0]).toContain('package loaded successfully)');
        expect(unwrapped[1]).toBe('Next line here');
      });

      it('should not combine lines if next line begins with ! or l.', () => {
        const line79 = 'Some long text that just happens to be seventy-nine characters long..............'.slice(0, 79);
        const errorLine = '! Undefined control sequence.';
        const log = `${line79}\n${errorLine}`;

        const unwrapped = LogLineVo.unwrap(log);
        expect(unwrapped.length).toBe(2);
        expect(unwrapped[1]).toBe(errorLine);
      });
    });

    describe('DiagnosticItem & DiagnosticReport', () => {
      it('should track items, compute summary counts and isSuccess flag', () => {
        const item1 = new DiagnosticItem({
          file: 'main.tex',
          line: 12,
          severity: DiagnosticSeverityVo.error(),
          message: 'Undefined control sequence \\foobar',
        });
        const item2 = new DiagnosticItem({
          file: 'chapters/intro.tex',
          line: 45,
          severity: DiagnosticSeverityVo.warning(),
          message: 'LaTeX Warning: Reference sec:test undefined',
        });
        const item3 = new DiagnosticItem({
          file: 'main.tex',
          line: 80,
          severity: DiagnosticSeverityVo.badbox(),
          message: 'Overfull \\hbox (12pt too wide)',
        });

        const report = new DiagnosticReport({ items: [item1, item2, item3] });

        expect(report.isSuccess).toBe(false);
        expect(report.errorsCount).toBe(1);
        expect(report.warningsCount).toBe(1);
        expect(report.badboxesCount).toBe(1);
        expect(report.infoCount).toBe(0);

        expect(report.getErrors().length).toBe(1);
        expect(report.getWarnings().length).toBe(1);
        expect(report.getBadboxes().length).toBe(1);

        const mainItems = report.getItemsByFile('main.tex');
        expect(mainItems.length).toBe(2);

        const ch1Items = report.getItemsByFile('chapters/intro.tex');
        expect(ch1Items.length).toBe(1);
      });

      it('should mark report as isSuccess = true if there are only warnings and badboxes', () => {
        const item = new DiagnosticItem({
          file: 'main.tex',
          line: 10,
          severity: DiagnosticSeverityVo.warning(),
          message: 'LaTeX Warning: Unused label',
        });
        const report = new DiagnosticReport({ items: [item] });
        expect(report.isSuccess).toBe(true);
        expect(report.errorsCount).toBe(0);
      });
    });
  });

  // =========================================================================
  // 2. KNOWLEDGE-BASE EXPLAINER ADAPTER
  // =========================================================================
  describe('KnowledgeBaseExplainerAdapter', () => {
    it('should match undefined control sequence error and provide fix snippet', () => {
      const exp = explainer.explain('! Undefined control sequence.', 'l.12 \\mycustommacro');
      expect(exp).not.toBeNull();
      expect(exp!.code).toBe('UNDEFINED_CONTROL_SEQUENCE');
      expect(exp!.suggestedFix).toContain('usepackage');
      expect(exp!.documentationUrl).toContain('Undefined_control_sequence');
    });

    it('should match missing $ error for unescaped math operators', () => {
      const exp = explainer.explain('! Missing $ inserted.', 'l.5 The variable name is user_id');
      expect(exp).not.toBeNull();
      expect(exp!.code).toBe('MISSING_MATH_DELIMITER');
      expect(exp!.suggestedFix).toContain('escape');
    });

    it('should match file not found errors', () => {
      const exp = explainer.explain("! LaTeX Error: File `custom.sty' not found.");
      expect(exp).not.toBeNull();
      expect(exp!.code).toBe('FILE_NOT_FOUND');
    });

    it('should match environment ended mismatch', () => {
      const exp = explainer.explain(
        '! LaTeX Error: \\begin{equation} on input line 15 ended by \\end{align}.'
      );
      expect(exp).not.toBeNull();
      expect(exp!.code).toBe('ENVIRONMENT_MISMATCH');
    });

    it('should match extra alignment tab & in tables', () => {
      const exp = explainer.explain('! Extra alignment tab has been changed to \\cr.');
      expect(exp).not.toBeNull();
      expect(exp!.code).toBe('EXTRA_ALIGNMENT_TAB');
    });

    it('should match emergency stop and corrupted aux file errors', () => {
      const exp1 = explainer.explain('! Emergency stop.');
      expect(exp1?.code).toBe('EMERGENCY_STOP');

      const exp2 = explainer.explain('! File ended while scanning use of \\@writefile.');
      expect(exp2?.code).toBe('CORRUPTED_AUX_FILE');
    });

    it('should retrieve rule directly by canonical code', () => {
      const rule = explainer.getByCode('UNDEFINED_CONTROL_SEQUENCE');
      expect(rule).toBeDefined();
      expect(rule!.title).toContain('Undefined Control Sequence');

      const unknown = explainer.getByCode('NON_EXISTENT_CODE');
      expect(unknown).toBeNull();
    });

    it('should list all rules in the knowledge base catalog', () => {
      const allRules = explainer.getAllRules();
      expect(allRules.length).toBeGreaterThanOrEqual(15);
    });
  });

  // =========================================================================
  // 3. TEX PAREN-TREE LOG PARSER (FILE TRACKER STATE MACHINE)
  // =========================================================================
  describe('TexParenTreeLogParser (Overleaf Parity)', () => {
    it('should parse single file error with accurate line number from l.<num>', () => {
      const log = `
This is pdfTeX, Version 3.141592653-2.6-1.40.24 (TeX Live 2022)
(./main.tex
LaTeX2e <2022-11-01>
! Undefined control sequence.
l.15 \\unknownCommand
                     {test}
Here is how much of TeX's memory you used:
)
`;
      const items = texParser.parse(log, 'main.tex');
      expect(items.length).toBe(1);

      const err = items[0]!;
      expect(err.file).toBe('main.tex');
      expect(err.line).toBe(15);
      expect(err.severity.isError()).toBe(true);
      expect(err.code).toBe('UNDEFINED_CONTROL_SEQUENCE');
      expect(err.explanation).toBeDefined();
    });

    it('should correctly attribute errors inside sub-files using TeX parentheses stack', () => {
      const log = `
(./main.tex
Document Class: article 2021/10/04 v1.4n Standard LaTeX document class
(./sections/introduction.tex
! Missing $ inserted.
<inserted text> 
                $
l.42 The formula calculates value_x
                                   here
)
(./sections/conclusion.tex
)
)
`;
      const items = texParser.parse(log, 'main.tex');
      expect(items.length).toBe(1);

      const err = items[0]!;
      expect(err.file).toBe('sections/introduction.tex'); // Correctly attributed to sub-file!
      expect(err.line).toBe(42);
      expect(err.code).toBe('MISSING_MATH_DELIMITER');
    });

    it('should handle deeply nested included files and pop stack upon closing paren', () => {
      const log = `
(./main.tex
 (./chapters/ch1.tex
  (./figures/diagram.tex
  )
! LaTeX Error: Environment myenv undefined.
l.108 \\begin{myenv}
 )
)
`;
      const items = texParser.parse(log, 'main.tex');
      expect(items.length).toBe(1);
      // Because diagram.tex closed before the error, the error belongs to ch1.tex
      expect(items[0]!.file).toBe('chapters/ch1.tex');
      expect(items[0]!.line).toBe(108);
      expect(items[0]!.code).toBe('ENVIRONMENT_UNDEFINED');
    });

    it('should parse LaTeX Warnings with input line numbers and multiline messages', () => {
      const log = `
(./main.tex
LaTeX Warning: Reference \`sec:results' on page 3 undefined on input line 58.
Package hyperref Warning: Token not allowed in a PDF string (PDFDocEncoding):
(hyperref)                removing \`math shift' on input line 85.
)
`;
      const items = texParser.parse(log, 'main.tex');
      expect(items.length).toBe(2);

      const warn1 = items.find((i) => i.message.includes('Reference `sec:results'));
      expect(warn1).toBeDefined();
      expect(warn1!.line).toBe(58);
      expect(warn1!.severity.isWarning()).toBe(true);
      expect(warn1!.code).toBe('UNDEFINED_REFERENCE');

      const warn2 = items.find((i) => i.message.includes('Token not allowed'));
      expect(warn2).toBeDefined();
      expect(warn2!.line).toBe(85);
    });

    it('should parse Overfull and Underfull badboxes with lines range', () => {
      const log = `
(./main.tex
Overfull \\hbox (21.345pt too wide) in paragraph at lines 102--115
 []\\OT1/cmr/m/n/10 VeryLongWordWithoutAnyHyphenationPointAppearsHere
Underfull \\hbox (badness 10000) in paragraph at lines 200--205
)
`;
      const items = texParser.parse(log, 'main.tex');
      expect(items.length).toBe(2);

      expect(items[0]!.severity.isBadbox()).toBe(true);
      expect(items[0]!.line).toBe(102);
      expect(items[0]!.code).toBe('OVERFULL_HBOX');

      expect(items[1]!.severity.isBadbox()).toBe(true);
      expect(items[1]!.line).toBe(200);
      expect(items[1]!.code).toBe('UNDERFULL_HBOX');
    });
  });

  // =========================================================================
  // 4. TECTONIC LOG PARSER
  // =========================================================================
  describe('TectonicLogParser', () => {
    it('should parse modern Tectonic rust cli error output', () => {
      const log = `
note: running tectonic
error: chapters/intro.tex:34: undefined control sequence \\badmacro
note: target halted
`;
      const items = tectonicParser.parse(log, 'main.tex');
      expect(items.length).toBe(1);

      const err = items[0]!;
      expect(err.file).toBe('chapters/intro.tex');
      expect(err.line).toBe(34);
      expect(err.severity.isError()).toBe(true);
      expect(err.code).toBe('UNDEFINED_CONTROL_SEQUENCE');
    });

    it('should parse modern Tectonic warnings and notes', () => {
      const log = `
warning: main.tex:12: label 'sec:method' multiply defined
error: main.tex:50: missing $ inserted
`;
      const items = tectonicParser.parse(log, 'main.tex');
      expect(items.length).toBe(2);

      expect(items[0]!.severity.isWarning()).toBe(true);
      expect(items[0]!.line).toBe(12);

      expect(items[1]!.severity.isError()).toBe(true);
      expect(items[1]!.line).toBe(50);
      expect(items[1]!.code).toBe('MISSING_MATH_DELIMITER');
    });
  });

  // =========================================================================
  // 5. FAST SYNTAX LINTER ADAPTER (PRE-COMPILATION)
  // =========================================================================
  describe('FastSyntaxLinterAdapter', () => {
    it('should detect unbalanced opening brace', () => {
      const source = `\\documentclass{article}\n\\begin{document}\n\\textbf{hello\n\\end{document}`;
      const items = linter.lint(source, 'main.tex');

      expect(items.length).toBe(1);
      expect(items[0]!.code).toBe('UNBALANCED_BRACES');
      expect(items[0]!.line).toBe(3); // Line of \textbf{hello
    });

    it('should detect extra closing brace', () => {
      const source = `\\documentclass{article}\n\\begin{document}\nHello world}\n\\end{document}`;
      const items = linter.lint(source, 'main.tex');

      expect(items.length).toBe(1);
      expect(items[0]!.code).toBe('UNBALANCED_BRACES');
      expect(items[0]!.line).toBe(3);
    });

    it('should detect unclosed environments at end of document', () => {
      const source = `
\\documentclass{article}
\\begin{document}
\\begin{itemize}
\\item First item
\\end{document}
`;
      const items = linter.lint(source, 'main.tex');

      const unclosed = items.find((i) => i.code === 'UNCLOSED_ENVIRONMENT');
      expect(unclosed).toBeDefined();
      expect(unclosed!.message).toContain('begin{itemize}');
    });

    it('should detect environment mismatch (begin A ended by B)', () => {
      const source = `
\\documentclass{article}
\\begin{document}
\\begin{table}
\\end{figure}
\\end{document}
`;
      const items = linter.lint(source, 'main.tex');

      const mismatch = items.find((i) => i.code === 'ENVIRONMENT_MISMATCH');
      expect(mismatch).toBeDefined();
      expect(mismatch!.message).toContain('table');
      expect(mismatch!.message).toContain('figure');
    });

    it('should detect naked math operators _ outside math mode', () => {
      const source = `
\\documentclass{article}
\\begin{document}
The result_of experiment was positive.
\\end{document}
`;
      const items = linter.lint(source, 'main.tex');

      const mathErr = items.find((i) => i.code === 'MISSING_MATH_DELIMITER');
      expect(mathErr).toBeDefined();
      expect(mathErr!.message).toContain('_');
    });

    it('should allow _ when inside math mode $...$ or escaped \\_', () => {
      const source = `
\\documentclass{article}
\\begin{document}
Result $x_1$ and filename my\\_file.tex are valid.
\\begin{equation}
y_2 = 10
\\end{equation}
\\end{document}
`;
      const items = linter.lint(source, 'main.tex');
      const mathErrors = items.filter((i) => i.code === 'MISSING_MATH_DELIMITER');
      expect(mathErrors.length).toBe(0);
    });

    it('should detect naked & outside table environments', () => {
      const source = `
\\documentclass{article}
\\begin{document}
Company A & Company B
\\end{document}
`;
      const items = linter.lint(source, 'main.tex');

      const tabErr = items.find((i) => i.code === 'EXTRA_ALIGNMENT_TAB');
      expect(tabErr).toBeDefined();
    });

    it('should warn about Unicode smart quotes', () => {
      const source = `
\\documentclass{article}
\\begin{document}
He said “Hello world”.
\\end{document}
`;
      const items = linter.lint(source, 'main.tex');

      const quoteWarn = items.find((i) => i.code === 'SMART_QUOTES');
      expect(quoteWarn).toBeDefined();
      expect(quoteWarn!.severity.isWarning()).toBe(true);
    });

    it('should ignore syntax inside LaTeX comments %', () => {
      const source = `
\\documentclass{article}
\\begin{document}
% Here is a comment with { and _ and & without closing
Normal text.
\\end{document}
`;
      const items = linter.lint(source, 'main.tex');
      expect(items.length).toBe(0);
    });
  });

  // =========================================================================
  // 6. INBOUND USE CASES
  // =========================================================================
  describe('Inbound Use Cases', () => {
    describe('ParseCompileLogUseCase', () => {
      it('should parse log and return DiagnosticReport', () => {
        const log = `(./main.tex\n! Undefined control sequence.\nl.10 \\foo\n)`;
        const report = parseUseCase.execute({ logText: log, defaultFile: 'main.tex' });

        expect(report.isSuccess).toBe(false);
        expect(report.errorsCount).toBe(1);
        expect(report.items[0]!.file).toBe('main.tex');
      });

      it('should throw InvalidLogFormatException if logText is empty', () => {
        expect(() => parseUseCase.execute({ logText: '' })).toThrow(InvalidLogFormatException);
        expect(() => parseUseCase.execute({ logText: '   ' })).toThrow(InvalidLogFormatException);
      });

      it('should route to tectonicParser when engine is tectonic', () => {
        const log = `error: main.tex:5: undefined control sequence \\bar`;
        const report = parseUseCase.execute({
          logText: log,
          defaultFile: 'main.tex',
          engine: 'tectonic',
        });

        expect(report.errorsCount).toBe(1);
        expect(report.items[0]!.line).toBe(5);
      });
    });

    describe('LintDocumentSyntaxUseCase', () => {
      it('should lint document and return DiagnosticReport', () => {
        const source = `\\begin{itemize}\n\\item Item`;
        const report = lintUseCase.execute({ source, filename: 'main.tex' });

        expect(report.isSuccess).toBe(false);
        expect(report.errorsCount).toBeGreaterThanOrEqual(1);
      });
    });

    describe('GetErrorExplanationUseCase', () => {
      it('should return error explanation for valid code', () => {
        const exp = explainUseCase.execute('UNDEFINED_CONTROL_SEQUENCE');
        expect(exp.code).toBe('UNDEFINED_CONTROL_SEQUENCE');
        expect(exp.title).toContain('Undefined Control Sequence');
      });

      it('should throw ExplanationNotFoundException for unknown code', () => {
        expect(() => explainUseCase.execute('TOTALLY_BOGUS_CODE')).toThrow(
          ExplanationNotFoundException
        );
      });

      it('should list all available rules', () => {
        const rules = explainUseCase.listRules();
        expect(rules.length).toBeGreaterThan(10);
      });
    });
  });

  // =========================================================================
  // 7. SERVICE & REST CONTROLLER INTEGRATION
  // =========================================================================
  describe('Service & REST Controller Integration', () => {
    it('should parse log via controller endpoint', () => {
      const log = `(./main.tex\n! Missing $ inserted.\nl.22 x_1\n)`;
      const res = controller.parseLog({ logText: log, defaultFile: 'main.tex' });

      expect(res.isSuccess).toBe(false);
      expect(res.errorsCount).toBe(1);
      expect(res.items[0]!.code).toBe('MISSING_MATH_DELIMITER');
    });

    it('should lint document via controller endpoint', () => {
      const source = `\\textbf{hello`;
      const res = controller.lintDocument({ source, filename: 'doc.tex' });

      expect(res.isSuccess).toBe(false);
      expect(res.errorsCount).toBe(1);
    });

    it('should retrieve explanation by code via controller endpoint', () => {
      const exp = controller.getExplanation('FILE_NOT_FOUND');
      expect(exp.code).toBe('FILE_NOT_FOUND');
    });

    it('should list all rules via controller endpoint', () => {
      const rules = controller.listAllRules();
      expect(rules.length).toBeGreaterThanOrEqual(15);
    });

    describe('Controller Exception Translation', () => {
      it('should translate InvalidLogFormatException to 400 BadRequestException', () => {
        expect(() => controller.parseLog({ logText: '' })).toThrow(BadRequestException);
      });

      it('should translate ExplanationNotFoundException to 404 NotFoundException', () => {
        expect(() => controller.getExplanation('NOT_REAL_CODE')).toThrow(NotFoundException);
      });
    });
  });
});
