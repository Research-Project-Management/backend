import { TexEngineDetector } from '@/modules/pages/clsi/domain/tex-engine.detector';

describe('TexEngineDetector', () => {
  it('auto-selects xelatex via unicode-hint when source has Vietnamese without T5/vietnam package even if pdflatex or auto is requested', () => {
    const source = [
      '\\documentclass{article}',
      '\\usepackage{graphicx}',
      '\\title{flux}',
      '\\author{Tấn Thành}',
      '\\begin{document}',
      '\\maketitle',
      '\\end{document}',
    ].join('\n');

    expect(TexEngineDetector.detect(source, 'pdflatex')).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'unicode-hint',
    });
    expect(TexEngineDetector.detect(source, 'auto')).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'unicode-hint',
    });
    expect(TexEngineDetector.detect(source)).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'unicode-hint',
    });
  });

  it('keeps pdflatex when Vietnamese text uses T5 fontenc, vietnam package, or babel vietnamese', () => {
    const withT5 = [
      '\\documentclass{article}',
      '\\usepackage[T5]{fontenc}',
      '\\author{Tấn Thành}',
      '\\begin{document}\\maketitle\\end{document}',
    ].join('\n');
    expect(TexEngineDetector.detect(withT5, 'pdflatex')).toMatchObject({
      engine: 'pdflatex',
      detectedFrom: 'explicit',
    });
    expect(TexEngineDetector.detect(withT5, 'auto')).toMatchObject({
      engine: 'pdflatex',
      detectedFrom: 'default',
    });

    const withVietnamPkg = [
      '\\documentclass{article}',
      '\\usepackage[utf8]{vietnam}',
      '\\author{Tấn Thành}',
    ].join('\n');
    expect(TexEngineDetector.detect(withVietnamPkg, 'pdflatex').engine).toBe('pdflatex');

    const withBabel = [
      '\\documentclass{article}',
      '\\usepackage[vietnamese]{babel}',
      '\\author{Tấn Thành}',
    ].join('\n');
    expect(TexEngineDetector.detect(withBabel, 'pdflatex').engine).toBe('pdflatex');
  });

  it('does not trigger xelatex when Vietnamese characters only appear inside LaTeX comments', () => {
    const source = [
      '\\documentclass{article}',
      '\\usepackage{graphicx} % Chú thích tiếng Việt có dấu ấ ộ',
      '\\title{English Paper}',
      '\\author{Jane Doe}',
      '\\begin{document}\\maketitle\\end{document}',
    ].join('\n');

    expect(TexEngineDetector.detect(source, 'pdflatex')).toMatchObject({
      engine: 'pdflatex',
      detectedFrom: 'explicit',
    });
    expect(TexEngineDetector.detect(source, 'auto')).toMatchObject({
      engine: 'pdflatex',
      detectedFrom: 'default',
    });
  });

  it('auto-selects xelatex for non-Latin Unicode scripts', () => {
    const source = '\\documentclass{article}\n\\begin{document}\n日本語テスト\n\\end{document}';
    expect(TexEngineDetector.detect(source, 'pdflatex')).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'unicode-hint',
    });
  });

  it('respects explicit lualatex or xelatex override', () => {
    const source = '\\documentclass{article}\n\\author{Tấn Thành}\n\\begin{document}\\end{document}';
    expect(TexEngineDetector.detect(source, 'lualatex')).toMatchObject({
      engine: 'lualatex',
      detectedFrom: 'explicit',
    });
    expect(TexEngineDetector.detect(source, 'xelatex')).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'explicit',
    });
  });
});
