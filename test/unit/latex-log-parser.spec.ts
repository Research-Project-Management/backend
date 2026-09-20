import {
  parseLatexLog,
  extractPrimaryError,
  getLatexSuggestion,
} from '@/modules/document/compiler/utils/latex-log-parser.util';

describe('LatexLogParser (Overleaf-grade Log & Error Diagnostics)', () => {
  describe('Error Parsing (!)', () => {
    it('should parse "! Undefined control sequence" with line number and context snippet', () => {
      const sampleLog = `
This is pdfTeX, Version 3.141592653-2.6-1.40.24 (TeX Live 2022)
entering extended mode
(./main.tex
LaTeX2e <2022-11-01> patch level 1
! Undefined control sequence.
l.25 \\unknownCommand
                    [test argument]
The control sequence at the end of the top line
of your error message was never \\def'ed.
)
No pages of output.
Transcript written on main.log.
      `;

      const diagnostics = parseLatexLog(sampleLog, 'main.tex');
      expect(diagnostics.length).toBeGreaterThan(0);

      const err = diagnostics.find((d) => d.severity === 'error');
      expect(err).toBeDefined();
      expect(err?.message).toBe('Undefined control sequence.');
      expect(err?.line).toBe(25);
      expect(err?.context).toContain('\\unknownCommand');
      expect(err?.file).toBe('main.tex');
      expect(err?.suggestion).toContain('\\usepackage');
    });

    it('should parse "! Missing $ inserted" and offer math mode suggestion', () => {
      const sampleLog = `
! Missing $ inserted.
<inserted text> 
                $
l.54 x_
       i = 10
I've inserted a begin-math/end-math symbol since I think
you left one out.
      `;

      const diagnostics = parseLatexLog(sampleLog, 'main.tex');
      const err = diagnostics.find((d) => d.message.includes('Missing $ inserted'));
      expect(err).toBeDefined();
      expect(err?.line).toBe(54);
      expect(err?.suggestion).toContain('math');
    });

    it('should parse missing package / file error', () => {
      const sampleLog = `
! LaTeX Error: File 'customtheme.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)
Enter file name: 
l.8 \\usepackage
               {customtheme}
      `;

      const diagnostics = parseLatexLog(sampleLog, 'main.tex');
      const err = diagnostics.find((d) => d.severity === 'error');
      expect(err).toBeDefined();
      expect(err?.message).toContain("File 'customtheme.sty' not found");
      expect(err?.line).toBe(8);
      expect(err?.suggestion).toContain('uploaded');
    });
  });

  describe('Multi-file Tree Context Tracking', () => {
    it('should correctly attribute errors to child files via file stack tracking', () => {
      const sampleLog = `
(./main.tex
\\section{Intro}
(./chapters/methodology.tex
! Undefined control sequence.
l.14 \\invalidSubMacro
                      {param}
)
)
      `;

      const diagnostics = parseLatexLog(sampleLog, 'main.tex');
      const err = diagnostics.find((d) => d.severity === 'error');
      expect(err).toBeDefined();
      expect(err?.file).toBe('methodology.tex');
      expect(err?.line).toBe(14);
    });
  });

  describe('Warnings & Badboxes Parsing', () => {
    it('should extract undefined citations with line number', () => {
      const sampleLog = `
LaTeX Warning: Citation 'turing1936' on page 2 undefined on input line 78.
      `;

      const diagnostics = parseLatexLog(sampleLog, 'main.tex');
      const warn = diagnostics.find((d) => d.severity === 'warning');
      expect(warn).toBeDefined();
      expect(warn?.message).toContain("Citation 'turing1936'");
      expect(warn?.line).toBe(78);
      expect(warn?.suggestion).toContain('references.bib');
    });

    it('should extract undefined references with line number', () => {
      const sampleLog = `
LaTeX Warning: Reference 'fig:neural_net' on page 4 undefined on input line 120.
      `;

      const diagnostics = parseLatexLog(sampleLog, 'main.tex');
      const warn = diagnostics.find((d) => d.severity === 'warning');
      expect(warn).toBeDefined();
      expect(warn?.message).toContain("Reference 'fig:neural_net'");
      expect(warn?.line).toBe(120);
      expect(warn?.suggestion).toContain('\\label');
    });

    it('should extract Overfull \\hbox warnings with line range', () => {
      const sampleLog = `
Overfull \\hbox (14.2854pt too wide) in paragraph at lines 35--42
      `;

      const diagnostics = parseLatexLog(sampleLog, 'main.tex');
      const info = diagnostics.find((d) => d.message.includes('Overfull \\hbox'));
      expect(info).toBeDefined();
      expect(info?.line).toBe(35);
      expect(info?.context).toContain('14.2854pt too wide');
    });
  });

  describe('extractPrimaryError', () => {
    it('should format a concise primary error string from diagnostics', () => {
      const diagnostics = parseLatexLog(
        `
! Undefined control sequence.
l.42 \\fooBar
        `,
        'report.tex',
      );

      const primary = extractPrimaryError(diagnostics);
      expect(primary).toBe('! Undefined control sequence. on line 42 in report.tex');
    });

    it('should return null when there are no errors', () => {
      const diagnostics = parseLatexLog(
        `LaTeX Warning: Reference 'sec:1' on page 1 undefined on input line 10.`,
      );
      expect(extractPrimaryError(diagnostics)).toBeNull();
    });
  });

  describe('Resilience & Edge Cases', () => {
    it('should handle empty or malformed log inputs gracefully without throwing', () => {
      expect(parseLatexLog('')).toEqual([]);
      expect(parseLatexLog(null as any)).toEqual([]);
      expect(parseLatexLog(undefined as any)).toEqual([]);
    });
  });
});