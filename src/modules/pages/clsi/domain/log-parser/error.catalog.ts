/**
 * modules/pages/clsi/domain/log-parser/error.catalog.ts
 * Pure domain LaTeX error knowledge base and package lookup tables.
 * Zero I/O, zero NestJS imports.
 */

import {
  ErrorExplanationVo,
  ErrorExplanationProps,
} from './diagnostic.model';

export const PKG_LOOKUP: Record<string, string> = {
  includegraphics: 'graphicx',
  graphicspath: 'graphicx',
  rotatebox: 'graphicx',
  scalebox: 'graphicx',
  resizebox: 'graphicx',
  textcolor: 'xcolor',
  colorbox: 'xcolor',
  definecolor: 'xcolor',
  rowcolor: 'xcolor',
  cellcolor: 'xcolor',
  href: 'hyperref',
  url: 'hyperref',
  hyperref: 'hyperref',
  toprule: 'booktabs',
  midrule: 'booktabs',
  bottomrule: 'booktabs',
  cmidrule: 'booktabs',
  multirow: 'multirow',
  SI: 'siunitx',
  si: 'siunitx',
  num: 'siunitx',
  ang: 'siunitx',
  qty: 'siunitx',
  unit: 'siunitx',
  mathbb: 'amssymb',
  mathcal: 'amssymb',
  mathfrak: 'amssymb',
  checkmark: 'amssymb',
  leqslant: 'amssymb',
  geqslant: 'amssymb',
  text: 'amsmath',
  dfrac: 'amsmath',
  tfrac: 'amsmath',
  binom: 'amsmath',
  DeclareMathOperator: 'amsmath',
  numberwithin: 'amsmath',
  boldsymbol: 'amsmath',
  bm: 'bm',
  cancel: 'cancel',
  bcancel: 'cancel',
  xcancel: 'cancel',
  sout: 'ulem',
  uwave: 'ulem',
  ul: 'soul',
  hl: 'soul',
  st: 'soul',
  todo: 'todonotes',
  lstinputlisting: 'listings',
  lstset: 'listings',
  mintinline: 'minted',
  inputminted: 'minted',
  subfloat: 'subfig',
  subfigure: 'subcaption',
  subtable: 'subcaption',
  FloatBarrier: 'placeins',
  lipsum: 'lipsum',
  blindtext: 'blindtext',
  fontawesome: 'fontawesome5',
  faIcon: 'fontawesome5',
  tikz: 'tikz',
  usetikzlibrary: 'tikz',
  pgfplotsset: 'pgfplots',
  citep: 'natbib',
  citet: 'natbib',
  citeauthor: 'natbib',
  citeyear: 'natbib',
  parencite: 'biblatex',
  textcite: 'biblatex',
  footcite: 'biblatex',
  addbibresource: 'biblatex',
  printbibliography: 'biblatex',
  enquote: 'csquotes',
  cleveref: 'cleveref',
  cref: 'cleveref',
  Cref: 'cleveref',
  SetAlgoLined: 'algorithm2e',
  KwResult: 'algorithm2e',
  KwData: 'algorithm2e',
  State: 'algpseudocode',
  Ensure: 'algpseudocode',
  Require: 'algpseudocode',
  newacronym: 'glossaries',
  newglossaryentry: 'glossaries',
  gls: 'glossaries',
};

export const ENV_PKG_LOOKUP: Record<string, string> = {
  align: 'amsmath',
  'align*': 'amsmath',
  gather: 'amsmath',
  'gather*': 'amsmath',
  multline: 'amsmath',
  'multline*': 'amsmath',
  flalign: 'amsmath',
  'flalign*': 'amsmath',
  alignat: 'amsmath',
  'alignat*': 'amsmath',
  split: 'amsmath',
  cases: 'amsmath',
  matrix: 'amsmath',
  pmatrix: 'amsmath',
  bmatrix: 'amsmath',
  Bmatrix: 'amsmath',
  vmatrix: 'amsmath',
  Vmatrix: 'amsmath',
  smallmatrix: 'amsmath',
  subequations: 'amsmath',
  proof: 'amsthm',
  lstlisting: 'listings',
  minted: 'minted',
  tikzpicture: 'tikz',
  axis: 'pgfplots',
  semilogyaxis: 'pgfplots',
  loglogaxis: 'pgfplots',
  subfigure: 'subcaption',
  subtable: 'subcaption',
  tabularx: 'tabularx',
  longtable: 'longtable',
  sidewaystable: 'rotating',
  sidewaysfigure: 'rotating',
  landscape: 'pdflscape',
  algorithm: 'algorithm',
  algorithmic: 'algpseudocode',
  algorithm2e: 'algorithm2e',
  frame: 'beamer',
  block: 'beamer',
  columns: 'beamer',
  multicols: 'multicol',
  wrapfigure: 'wrapfig',
  wraptable: 'wrapfig',
  comment: 'verbatim',
};

export const CASCADE_SUPPRESSION_MAP: Record<string, string[]> = {
  RUNAWAY_ARGUMENT: ['EMERGENCY_STOP'],
  UNBALANCED_BRACES: ['EMERGENCY_STOP'],
  FILE_NOT_FOUND: ['EMERGENCY_STOP'],
  MISSING_BEGIN_DOCUMENT: ['EMERGENCY_STOP'],
  UNDEFINED_CONTROL_SEQUENCE: ['EMERGENCY_STOP'],
  ENVIRONMENT_MISMATCH: ['EMERGENCY_STOP', 'UNBALANCED_BRACES'],
  ENVIRONMENT_UNDEFINED: ['EMERGENCY_STOP'],
  EXTRA_ALIGNMENT_TAB: ['EMERGENCY_STOP'],
  UNICODE_CHAR_NOT_SET_UP: ['EMERGENCY_STOP'],
  USEPACKAGE_BEFORE_DOCUMENTCLASS: ['EMERGENCY_STOP'],
};

export const FATAL_CASCADE_PATTERNS: RegExp[] = [
  /fatal error occurred, no output pdf/i,
  /^==> fatal error occurred/i,
  /^no pages of output\.?$/i,
  /latex error:\s*too many errors/i,
];

export interface RuleDefinition extends ErrorExplanationProps {
  patterns: RegExp[];
}

export interface ErrorExplainerLike {
  explain(message: string, context?: string): ErrorExplanationVo | null;
  getByCode(code: string): ErrorExplanationVo | null;
}

const LATEX_KB_BASE_URL =
  process.env.LATEX_KB_BASE_URL || 'https://latexref.xyz/dev/latex2e.html';

export class LatexErrorCatalog implements ErrorExplainerLike {
  private readonly rules: RuleDefinition[] = [
    {
      code: 'UNDEFINED_CONTROL_SEQUENCE',
      title: 'Undefined Control Sequence',
      explanation:
        'LaTeX encountered a macro command (starting with a backslash \\) that it does not recognize.',
      commonCauses: [
        'A typo in the command name (e.g. \\beign instead of \\begin).',
        'Missing package that defines this command in the preamble (e.g. \\includegraphics without \\usepackage{graphicx}).',
        'Using a math command outside of math mode ($...$ or \\[...\\]).',
      ],
      suggestedFix:
        'Check the spelling of the command, or add \\usepackage{<package_name>} to your document preamble.',
      exampleSnippet: '\\usepackage{amsmath}\n\\usepackage{graphicx}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Undefined_control_sequence`,
      patterns: [/undefined control sequence/i],
    },
    {
      code: 'UNICODE_CHAR_NOT_SET_UP',
      title: 'Unsupported Unicode Character',
      explanation:
        'pdfLaTeX encountered a non-ASCII Unicode character without a font encoding package that maps it.',
      commonCauses: [
        'Using Vietnamese or accented Unicode text with pdfLaTeX without loading \\usepackage[T5]{fontenc} (Vietnamese) or \\usepackage[T1]{fontenc} (European Latin).',
        'Using non-Latin scripts (CJK, Cyrillic, Greek, Arabic) or Unicode symbols under pdfLaTeX instead of XeLaTeX or LuaLaTeX.',
      ],
      suggestedFix:
        'For Vietnamese text in pdfLaTeX, add \\usepackage[T5]{fontenc} to your preamble. For broader Unicode scripts, switch the compiler to XeLaTeX or LuaLaTeX in Project Settings.',
      exampleSnippet: '\\usepackage[T5]{fontenc}',
      documentationUrl: `${LATEX_KB_BASE_URL}`,
      patterns: [
        /unicode character .+ not set up for use with latex/i,
        /package inputenc error:\s*unicode character/i,
      ],
    },
    {
      code: 'MISSING_MATH_DELIMITER',
      title: 'Missing $ inserted',
      explanation:
        'LaTeX detected a math character or command (such as an underscore _, caret ^, or Greek symbol \\alpha) in regular text mode.',
      commonCauses: [
        'Using an unescaped underscore "_" (such as in a variable or file name file_name) instead of "\\_".',
        'Writing mathematical notation without wrapping it in "$" or "\\[...\\]" math delimiters.',
      ],
      suggestedFix:
        'Wrap math expressions in $...$, or escape plain-text underscores with a backslash "\\_".',
      exampleSnippet: 'Value $x_1$ or file path my\\_file.tex',
      documentationUrl: `${LATEX_KB_BASE_URL}#Missing_$_inserted`,
      patterns: [/missing \$ inserted/i],
    },
    {
      code: 'FILE_NOT_FOUND',
      title: 'File Not Found',
      explanation:
        'The compiler cannot find the file referenced via \\input, \\include, \\includegraphics, or \\usepackage.',
      commonCauses: [
        'Incorrect file path or file extension (e.g. .png, .jpg, .tex).',
        'File name contains unsupported spaces or special characters.',
        'The package or asset has not been uploaded to the project folder.',
      ],
      suggestedFix:
        'Verify that the file exists in your project file tree and that the path in your code matches the file name exactly.',
      exampleSnippet: '\\includegraphics[width=\\linewidth]{figures/plot.png}',
      documentationUrl: `${LATEX_KB_BASE_URL}#LaTeX_Error:_File_not_found`,
      patterns: [
        /file [`'](.+?)['] not found/i,
        /i can't find file [`'](.+?)[']/i,
      ],
    },
    {
      code: 'ENVIRONMENT_MISMATCH',
      title: 'Environment Ended Mismatch',
      explanation:
        'An environment \\begin{A} was closed with \\end{B}, or an inner environment was not closed before closing the outer one.',
      commonCauses: [
        'Typo in the closing environment name inside \\end{...}.',
        'Missing a closing \\end{...} in a nested environment.',
      ],
      suggestedFix:
        'Verify that each \\begin{...} has a matching \\end{...} with the exact same name and in proper nesting order.',
      exampleSnippet: '\\begin{equation}\n  E = mc^2\n\\end{equation}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Environment_mismatch`,
      patterns: [
        /\\begin\{([^}]+)\} (?:on input line \d+ )?ended by \\end\{([^}]+)\}/i,
      ],
    },
    {
      code: 'ENVIRONMENT_UNDEFINED',
      title: 'Environment Undefined',
      explanation:
        'You are using an environment \\begin{env} whose definition LaTeX cannot find.',
      commonCauses: [
        'Typo in the environment name.',
        'Missing package that provides this environment (e.g. align requires amsmath).',
      ],
      suggestedFix:
        'Add the package providing this environment in your preamble using \\usepackage{...}.',
      exampleSnippet: '\\usepackage{amsmath} % For \\begin{align}',
      documentationUrl: `${LATEX_KB_BASE_URL}#LaTeX_Error:_Environment_undefined`,
      patterns: [/environment (.+?) undefined/i],
    },
    {
      code: 'EXTRA_ALIGNMENT_TAB',
      title: 'Extra Alignment Tab &',
      explanation:
        'The number of ampersands (&) in a table row or matrix exceeds the number of defined columns.',
      commonCauses: [
        'In a 3-column table {c|c|c}, typing 3 or more "&" characters on the same row (creating 4+ columns).',
        'Unescaped ampersand "&" in plain text instead of "\\&".',
      ],
      suggestedFix:
        'Reduce the number of "&" characters to match the table specification, or use "\\&" for plain-text ampersands.',
      exampleSnippet:
        'AT\\&T Company or \\begin{tabular}{cc} A & B \\\\ \\end{tabular}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Extra_alignment_tab`,
      patterns: [
        /extra alignment tab has been changed to/i,
        /extra alignment tab/i,
      ],
    },
    {
      code: 'NO_LINE_HERE_TO_END',
      title: "There's No Line Here to End",
      explanation:
        'The newline command "\\\\" was placed where no line exists to break, such as at the very start of a paragraph or immediately after a section heading.',
      commonCauses: [
        'Using "\\\\" to force vertical spacing between paragraphs instead of leaving an empty line or using \\vspace.',
        'Placing "\\\\" immediately after \\section{} or \\begin{center}.',
      ],
      suggestedFix:
        'Remove "\\\\" at the paragraph start. Use a blank line to separate paragraphs or \\vspace{1em} for vertical spacing.',
      exampleSnippet: '% Correct:\nFirst paragraph.\n\nSecond paragraph.',
      documentationUrl: `${LATEX_KB_BASE_URL}#There's_no_line_here_to_end`,
      patterns: [/there's no line here to end/i],
    },
    {
      code: 'CANNOT_BE_USED_IN_PREAMBLE',
      title: 'Can Be Used Only in Preamble',
      explanation:
        'A document configuration command (such as \\usepackage or \\documentclass) was placed after \\begin{document}.',
      commonCauses: [
        'Declaring \\usepackage after document content has already started.',
        'Accidentally pasting another full LaTeX document into the current file.',
      ],
      suggestedFix:
        'Move all \\usepackage commands above the \\begin{document} line.',
      exampleSnippet:
        '\\documentclass{article}\n\\usepackage{amsmath} % Before \\begin{document}\n\\begin{document}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Can_be_used_only_in_preamble`,
      patterns: [/can be used only in preamble/i],
    },
    {
      code: 'COMMAND_ALREADY_DEFINED',
      title: 'Command Already Defined',
      explanation:
        'You are defining \\newcommand{\\foo}{...}, but \\foo has already been defined by LaTeX or another loaded package.',
      commonCauses: [
        'Command name collides with a previously loaded package.',
        'Defining the same custom command twice in the document.',
      ],
      suggestedFix:
        'Choose a different command name, or use \\renewcommand{\\foo}{...} if you intentionally want to overwrite the existing definition.',
      exampleSnippet: '\\renewcommand{\\mycmd}{new definition}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Command_already_defined`,
      patterns: [/command (.+?) already defined/i],
    },
    {
      code: 'UNBALANCED_BRACES',
      title: 'Unbalanced Braces',
      explanation:
        'There is a mismatch between opening "{" and closing "}" curly braces in your code.',
      commonCauses: [
        'Forgot to close a brace for a command argument (e.g. \\textbf{bold text).',
        'Stray extra "}" typed by accident.',
      ],
      suggestedFix:
        'Inspect the braces around the line reported and ensure every opening brace has a matching closing brace.',
      exampleSnippet: '\\textbf{bold text}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Unbalanced_braces`,
      patterns: [
        /extra \}, or forgotten \$/i,
        /too many \}'s/i,
        /missing \} inserted/i,
      ],
    },
    {
      code: 'RUNAWAY_ARGUMENT',
      title: 'Runaway Argument',
      explanation:
        'A macro argument or group reached the end of a paragraph or file without a matching closing brace "}".',
      commonCauses: [
        'Missing closing curly brace "}" on a command (e.g. \\textbf{hello or \\caption{...).',
        'A blank line accidentally placed inside a non-long macro argument.',
      ],
      suggestedFix:
        'Check the line and preceding paragraph for an unclosed "{" and add the matching "}".',
      exampleSnippet: '\\textbf{bold text}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Runaway_argument`,
      patterns: [/runaway argument/i],
    },
    {
      code: 'CORRUPTED_AUX_FILE',
      title: 'Corrupted Auxiliary File',
      explanation:
        'The auxiliary (.aux) file was interrupted during a previous compile pass, preventing cross-references or citations from loading.',
      commonCauses: [
        'The previous compilation was aborted abruptly or ran out of memory.',
        'An invalid character in a section heading corrupted the .aux file.',
      ],
      suggestedFix:
        'Click "Clear cached files" and recompile the project from scratch.',
      exampleSnippet:
        'Clear cached .aux, .bbl, and .out files, then recompile.',
      documentationUrl: `${LATEX_KB_BASE_URL}#File_ended_while_scanning_use_of`,
      patterns: [
        /\.aux[\s\S]*file ended while scanning use of/i,
        /file ended while scanning use of/i,
      ],
    },
    {
      code: 'MISSING_BEGIN_DOCUMENT',
      title: 'Missing \\begin{document}',
      explanation:
        'Text or printable content was encountered before \\begin{document}, or the main file does not contain a \\begin{document} declaration.',
      commonCauses: [
        'Plain text accidentally typed in the preamble before \\begin{document}.',
        'Wrong file set as the Main document (compiling a chapter subfile instead of main.tex).',
      ],
      suggestedFix:
        'Ensure printable text appears after \\begin{document}, or select your root .tex file as Main document.',
      exampleSnippet:
        '\\documentclass{article}\n\\begin{document}\nContent here\n\\end{document}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Missing_\\begin{document}`,
      patterns: [/missing \\begin\{document\}/i],
    },
    {
      code: 'USEPACKAGE_BEFORE_DOCUMENTCLASS',
      title: '\\usepackage Before \\documentclass',
      explanation:
        'A \\usepackage command was placed before \\documentclass{...}. In LaTeX, the document class must be declared first before loading packages.',
      commonCauses: [
        'Inserting \\usepackage{...} at the very top of the file above \\documentclass{...}.',
        'Pasting package declarations at line 1 without a newline before \\documentclass{...}.',
      ],
      suggestedFix:
        'Move all \\usepackage{...} commands below \\documentclass{...} and above \\begin{document}.',
      exampleSnippet:
        '\\documentclass{article}\n\\usepackage[T5]{fontenc}\n\\begin{document}',
      documentationUrl: `${LATEX_KB_BASE_URL}`,
      patterns: [/\\usepackage\s+before\s+\\documentclass/i],
    },
    {
      code: 'BIB_SYNTAX_ERROR',
      title: 'Bibliography Entry Syntax Error',
      explanation:
        'BibTeX or Biber encountered malformed syntax in a .bib entry (missing comma, unclosed brace/quote, or broken crossref).',
      commonCauses: [
        'Missing trailing comma at the end of a field line inside @article{...}.',
        'Unbalanced "{" / "}" or unescaped quote in a BibTeX field.',
      ],
      suggestedFix:
        'Inspect the reported .bib line for missing commas between fields and balanced braces.',
      exampleSnippet:
        '@article{key2025,\n  author = {Doe, Jane},\n  title  = {Sample Paper},\n  year   = {2025}\n}',
      documentationUrl: `${LATEX_KB_BASE_URL}`,
      patterns: [
        /i was expecting a [`',]/i,
        /illegal, another entry/i,
        /you're missing a field name/i,
        /a bad cross reference/i,
      ],
    },
    {
      code: 'BIB_DUPLICATE_KEY',
      title: 'Duplicate Bibliography Key',
      explanation:
        'Two entries in your .bib file(s) share the exact same citation key.',
      commonCauses: [
        'Importing or pasting the same BibTeX entry twice.',
        'Two references across different .bib files sharing one cite key.',
      ],
      suggestedFix:
        'Remove the duplicate entry or rename one of the keys so every citation key is unique.',
      exampleSnippet: '@article{doe2025a, ...}',
      documentationUrl: `${LATEX_KB_BASE_URL}`,
      patterns: [
        /repeated(?:\s+bib(?:tex)?)?\s+entry/i,
        /duplicate entry key/i,
      ],
    },
    {
      code: 'EMERGENCY_STOP',
      title: 'Emergency Stop',
      explanation:
        'The LaTeX engine encountered a fatal error from which it cannot recover and halted the compilation.',
      commonCauses: [
        'Missing required file in nonstopmode.',
        'Infinite recursion in a custom macro definition.',
        'Severe TeX syntax error.',
      ],
      suggestedFix:
        'Check the error messages immediately preceding the Emergency Stop line in the log to find the root cause.',
      exampleSnippet:
        'Check the error lines preceding the Emergency Stop message in the raw log.',
      documentationUrl: `${LATEX_KB_BASE_URL}#Emergency_stop`,
      patterns: [/! emergency stop/i, /emergency stop/i],
    },
    {
      code: 'OVERFULL_HBOX',
      title: 'Overfull \\hbox',
      explanation:
        'A line of text, table, or equation is too wide and extends past the right margin of the page.',
      commonCauses: [
        'A long unbroken word or URL that cannot be automatically hyphenated.',
        'An image or table wider than \\textwidth.',
      ],
      suggestedFix:
        'Add \\usepackage{microtype} to improve word justification, or use \\resizebox{\\textwidth}{!}{...} for wide tables and graphics.',
      exampleSnippet: '\\includegraphics[width=\\linewidth]{image.png}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Overfull_hbox`,
      patterns: [/overfull \\hbox/i],
    },
    {
      code: 'UNDERFULL_HBOX',
      title: 'Underfull \\hbox',
      explanation:
        'LaTeX was unable to stretch or justify the line evenly, resulting in excessive gaps between words.',
      commonCauses: [
        'Forced line breaks using "\\\\" in regular paragraphs.',
        'A paragraph that is too short with words that cannot be hyphenated.',
      ],
      suggestedFix:
        'Avoid forcing line breaks with "\\\\"; allow LaTeX to justify paragraphs naturally.',
      exampleSnippet: 'Write continuous text paragraphs without forced breaks.',
      documentationUrl: `${LATEX_KB_BASE_URL}#Underfull_hbox`,
      patterns: [/underfull \\hbox/i],
    },
    {
      code: 'UNDEFINED_REFERENCE',
      title: 'Undefined Reference',
      explanation:
        'A \\ref{label} command references a label that does not exist in any \\label{label} statement.',
      commonCauses: [
        'The document requires a second compilation pass to resolve cross-references.',
        'Mismatched label key between \\ref and \\label.',
      ],
      suggestedFix:
        'Ensure the label keys match exactly and recompile to synchronize the .aux file.',
      exampleSnippet:
        '\\label{sec:intro}\n... As discussed in Section~\\ref{sec:intro}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Undefined_reference`,
      patterns: [
        /reference [`'](.+?)['] on page \d+ undefined/i,
        /there were undefined references/i,
      ],
    },
    {
      code: 'UNDEFINED_CITATION',
      title: 'Undefined Citation',
      explanation:
        'A \\cite{key} command references an entry that does not exist in your bibliography (.bib) file.',
      commonCauses: [
        'BibTeX or Biber has not processed the bibliography yet.',
        'Mismatched citation key in the .bib file.',
        'Missing \\bibliography{...} or \\addbibresource{...} command.',
      ],
      suggestedFix:
        'Verify that the citation key exists in your .bib file and that the bibliography file is properly linked.',
      exampleSnippet: '\\cite{vaswani2017attention}',
      documentationUrl: `${LATEX_KB_BASE_URL}#Undefined_citation`,
      patterns: [
        /citation [`'](.+?)['] on page \d+ undefined/i,
        /there were undefined citations/i,
      ],
    },
  ];

  private static readonly CODE_ALIASES: Record<string, string> = {
    UNMATCHED_CLOSING_BRACE: 'UNBALANCED_BRACES',
    UNCLOSED_OPENING_BRACE: 'UNBALANCED_BRACES',
    EXTRA_END_ENV: 'ENVIRONMENT_MISMATCH',
    MISMATCHED_ENV: 'ENVIRONMENT_MISMATCH',
    UNCLOSED_ENV: 'ENVIRONMENT_MISMATCH',
    UNESCAPED_PERCENT: 'MISSING_MATH_DELIMITER',
    UNESCAPED_AMPERSAND: 'EXTRA_ALIGNMENT_TAB',
    UNESCAPED_UNDERSCORE: 'MISSING_MATH_DELIMITER',
    UNCLOSED_INLINE_MATH: 'MISSING_MATH_DELIMITER',
    COMMAND_TYPO: 'UNDEFINED_CONTROL_SEQUENCE',
    DEPRECATED_COMMAND: 'UNDEFINED_CONTROL_SEQUENCE',
    EMPTY_REFERENCE: 'UNDEFINED_REFERENCE',
    RETRACTED_CITATION: 'UNDEFINED_CITATION',
    UNDEFINED_MACRO: 'UNDEFINED_CONTROL_SEQUENCE',
  };

  public explain(message: string, context?: string): ErrorExplanationVo | null {
    const textToMatch = `${message} ${context || ''}`;

    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        if (pattern.test(textToMatch)) {
          return new ErrorExplanationVo(rule);
        }
      }
    }

    return null;
  }

  public getByCode(code: string): ErrorExplanationVo | null {
    const normalized = code.trim().toUpperCase();
    const targetCode =
      LatexErrorCatalog.CODE_ALIASES[normalized] || normalized;
    let rule = this.rules.find((r) => r.code.toUpperCase() === targetCode);
    if (!rule) {
      rule = this.rules.find((r) => r.patterns.some((p) => p.test(code)));
    }
    return rule ? new ErrorExplanationVo(rule) : null;
  }
}
