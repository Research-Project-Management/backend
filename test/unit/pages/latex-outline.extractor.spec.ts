import { LatexOutlineExtractor } from '@/modules/pages/structure/domain/latex-outline.extractor';

describe('LatexOutlineExtractor', () => {
  it('extracts multi-line section titles and ignores inline comments', () => {
    const tex = [
      '\\section{A Very Long Title % inline comment',
      '  Continued on \\textbf{Next \\emph{Line}}}',
      '\\label{sec:long}',
    ].join('\n');

    const entries = LatexOutlineExtractor.extractFromContent(tex, 'main.tex');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'section',
      title: 'A Very Long Title Continued on Next Line',
      line: 1,
      label: 'sec:long',
    });
  });

  it('unescapes special LaTeX characters and distinguishes \\\\\\% from \\%', () => {
    const tex = [
      '\\section{R\\&D 100\\% \\_test\\#1 \\$50}',
      'Some text\\\\% \\section{Commented Out Heading}',
    ].join('\n');

    const entries = LatexOutlineExtractor.extractFromContent(tex, 'main.tex');
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('R&D 100% _test#1 $50');
  });

  it('handles Beamer frames and frametitle with nested braces and overlays', () => {
    const tex = [
      '\\begin{frame}<1-2>[fragile]{Overview of \\textbf{Flux \\emph{Editor}}}',
      'Body',
      '\\end{frame}',
      '\\begin{frame}',
      '\\frametitle[short]{Architecture \\& \\texttt{CLSI}}',
      '\\end{frame}',
    ].join('\n');

    const entries = LatexOutlineExtractor.extractFromContent(tex, 'slides.tex');
    expect(entries.map((e) => ({ level: e.level, title: e.title }))).toEqual([
      { level: 'slide', title: 'Overview of Flux Editor' },
      { level: 'slide', title: 'Architecture & CLSI' },
    ]);
  });

  it('builds proper part > chapter > section hierarchy and skips verbatim/comment blocks', () => {
    const tex = [
      '\\part{Foundations}',
      '\\chapter{Background}',
      '\\section{Intro} \\subsection{Details}',
      '\\begin{verbatim}',
      '\\section{Fake Verbatim Section}',
      '\\end{verbatim}',
      '\\begin{comment}',
      '\\section{Fake Comment Section}',
      '\\end{comment}',
    ].join('\n');

    const entries = LatexOutlineExtractor.extractFromContent(tex, 'book.tex');
    expect(entries.map((e) => `${e.level}:${e.title}`)).toEqual([
      'part:Foundations',
      'chapter:Background',
      'section:Intro',
      'subsection:Details',
    ]);

    const tree = LatexOutlineExtractor.buildOutlineTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0].level).toBe('part');
    expect(tree[0].children?.[0].level).toBe('chapter');
    expect(tree[0].children?.[0].children?.[0].level).toBe('section');
    expect(tree[0].children?.[0].children?.[0].children?.[0].level).toBe(
      'subsection',
    );
  });
});
