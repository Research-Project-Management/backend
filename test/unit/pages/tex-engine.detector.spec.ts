import { TexEngineDetector } from '@/modules/pages/clsi/domain/tex-engine.detector';

describe('TexEngineDetector (Overleaf-faithful compiler selection)', () => {
  it('respects explicit requestedEngine regardless of Unicode/Vietnamese characters in source', () => {
    const vietnameseSource = [
      '% !TEX program = xelatex',
      '\\documentclass{article}',
      '\\usepackage{fontspec}',
      '\\title{flux}',
      '\\author{Tấn Thành}',
      '\\begin{document}\\maketitle\\end{document}',
    ].join('\n');

    expect(TexEngineDetector.detect(vietnameseSource, 'pdflatex')).toMatchObject({
      engine: 'pdflatex',
      detectedFrom: 'explicit',
    });
    expect(TexEngineDetector.detect(vietnameseSource, 'xelatex')).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'explicit',
    });
    expect(TexEngineDetector.detect(vietnameseSource, 'lualatex')).toMatchObject({
      engine: 'lualatex',
      detectedFrom: 'explicit',
    });
  });

  it('defaults to pdflatex when engine is auto/omitted even with Vietnamese text unless magic comments or fontspec/luacode hints exist', () => {
    const plainVietnameseSource = [
      '\\documentclass{article}',
      '\\title{flux}',
      '\\author{Tấn Thành}',
      '\\begin{document}\\maketitle\\end{document}',
    ].join('\n');

    expect(TexEngineDetector.detect(plainVietnameseSource, 'auto')).toMatchObject({
      engine: 'pdflatex',
      detectedFrom: 'default',
    });
    expect(TexEngineDetector.detect(plainVietnameseSource)).toMatchObject({
      engine: 'pdflatex',
      detectedFrom: 'default',
    });
  });

  it('honors % !TEX program magic comments and fontspec/luacode package hints when auto/omitted', () => {
    const withMagicComment = [
      '% !TEX program = xelatex',
      '\\documentclass{article}',
      '\\begin{document}Hello\\end{document}',
    ].join('\n');
    expect(TexEngineDetector.detect(withMagicComment, 'auto')).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'magic-comment',
    });

    const withFontspec = [
      '\\documentclass{article}',
      '\\usepackage{fontspec}',
      '\\begin{document}Hello\\end{document}',
    ].join('\n');
    expect(TexEngineDetector.detect(withFontspec, 'auto')).toMatchObject({
      engine: 'xelatex',
      detectedFrom: 'package-hint',
    });

    const withLuacode = [
      '\\documentclass{article}',
      '\\usepackage{luacode}',
      '\\begin{document}Hello\\end{document}',
    ].join('\n');
    expect(TexEngineDetector.detect(withLuacode, 'auto')).toMatchObject({
      engine: 'lualatex',
      detectedFrom: 'package-hint',
    });
  });
});
