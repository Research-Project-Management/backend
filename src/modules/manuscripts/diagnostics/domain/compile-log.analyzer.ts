/**
 * modules/manuscripts/diagnostics/domain/compile-log.analyzer.ts
 * Pure domain LaTeX compilation log analyzer (TeX Paren-Tree State Machine + Error Knowledge Base).
 * Zero I/O, zero NestJS imports.
 */

import {
  DiagnosticItem,
  DiagnosticSeverityVo,
  ErrorExplanationVo,
  ErrorExplanationProps,
} from './diagnostic-item.entity';
import { DiagnosticReport } from './diagnostic-report.entity';
import { LogLineVo } from './log-line';
import {
  InvalidLogFormatException,
  ExplanationNotFoundException,
} from './diagnostics.errors';
import {
  CompilerDiagnostic,
  ILogParser,
} from '@/modules/manuscripts/clsi/domain/clsi.ports';

export interface RuleDefinition extends ErrorExplanationProps {
  patterns: RegExp[];
}

export interface ErrorExplainerLike {
  explain(message: string, context?: string): ErrorExplanationVo | null;
  getByCode(code: string): ErrorExplanationVo | null;
  getAllRules(): ErrorExplanationVo[];
}

const LATEX_KB_BASE_URL =
  process.env.LATEX_KB_BASE_URL || 'https://latexref.xyz/dev/latex2e.html';

export class ErrorKnowledgeBase implements ErrorExplainerLike {
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
      patterns: [/file ended while scanning use of/i, /runaway argument/i],
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
      ErrorKnowledgeBase.CODE_ALIASES[normalized] || normalized;
    let rule = this.rules.find((r) => r.code.toUpperCase() === targetCode);
    if (!rule) {
      rule = this.rules.find((r) => r.patterns.some((p) => p.test(code)));
    }
    return rule ? new ErrorExplanationVo(rule) : null;
  }

  public requireByCode(code: string): ErrorExplanationVo {
    if (!code || typeof code !== 'string') {
      throw new ExplanationNotFoundException(String(code));
    }
    const found = this.getByCode(code);
    if (!found) {
      throw new ExplanationNotFoundException(code);
    }
    return found;
  }

  public getAllRules(): ErrorExplanationVo[] {
    return this.rules.map((r) => new ErrorExplanationVo(r));
  }
}

export class CompileLogAnalyzer implements ILogParser {
  private static readonly LATEX_WARNING_REGEX =
    /(?:LaTeX(?:\s+Font)?|Package [\w-]+|Class [\w-]+)\s+Warning:\s*(.+)/i;

  private static readonly BADBOX_REGEX =
    /(?:Overfull|Underfull)\s+\\(?:hbox|vbox)\s*\([^)]*\)\s*(?:in paragraph\s*)?at lines?\s+(\d+)(?:--\d+)?/i;

  private static readonly FILE_LINE_ERROR_REGEX =
    /^(\.{0,2}\/?[^\s:!()]+\.(?:tex|bib|sty|cls|dtx|ins)):(\d+):\s*(.+)/i;

  private static readonly FILE_EXTENSION_REGEX =
    /\.(tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins)\b/i;

  private readonly explainer: ErrorExplainerLike;

  constructor(explainer?: ErrorExplainerLike) {
    this.explainer = explainer ?? new ErrorKnowledgeBase();
  }

  /**
   * Implements `ILogParser.parse()` for CLSI compile pipeline diagnostics.
   * Delegates to the unified TeX paren-tree state machine (`parseTexParenTreeLog`)
   * so there is a single source of truth for LaTeX log parsing.
   */
  public parse(
    logText: string,
    defaultFile = 'main.tex',
  ): CompilerDiagnostic[] {
    if (!logText || typeof logText !== 'string') return [];

    const items = this.parseTexParenTreeLog(logText, defaultFile);
    return items.map((item) => {
      const context = item.context || item.message;
      let message = item.message;
      if (item.severity.isWarning()) {
        message = message
          .replace(/\s*on input line\s+\d+\.?$/i, '')
          .replace(/\.$/, '')
          .trim();
      }
      const { code, suggestion } = this.generateSuggestion(message, context);
      const severity: 'error' | 'warning' | 'info' = item.severity.isError()
        ? 'error'
        : item.severity.isWarning()
          ? 'warning'
          : 'info';
      const resolvedCode = code || item.code;
      const resolvedSuggestion = suggestion || item.explanation?.suggestedFix;

      return {
        file: item.file,
        line: item.line,
        message,
        context,
        severity,
        ...(resolvedCode ? { code: resolvedCode } : {}),
        ...(resolvedSuggestion ? { suggestion: resolvedSuggestion } : {}),
      };
    });
  }

  private generateSuggestion(
    message: string,
    context: string,
  ): { code?: string; suggestion?: string } {
    const lowerMsg = message.toLowerCase();

    if (lowerMsg.includes('undefined control sequence')) {
      const match = context.match(/\\([a-zA-Z]+)/);
      const command = match ? `\\${match[1]}` : 'this command';
      return {
        code: 'UNDEFINED_MACRO',
        suggestion: `Command "${command}" is undefined. Check spelling or add the required \\usepackage{...}.`,
      };
    }

    if (lowerMsg.includes('missing $ inserted')) {
      return {
        code: 'MISSING_MATH_DELIMITER',
        suggestion:
          'Math characters or variables must be placed in a math environment ($...$ or \\[...\\]).',
      };
    }

    if (lowerMsg.includes('file') && lowerMsg.includes('not found')) {
      return {
        code: 'FILE_NOT_FOUND',
        suggestion:
          'File, graphic, bibliography, or package not found. Verify the file path and extension.',
      };
    }

    const explained = this.explainer?.explain(message, context);
    if (explained) {
      return {
        code: explained.code,
        suggestion: explained.suggestedFix,
      };
    }

    return {};
  }

  public analyzeLog(
    logText: string,
    defaultFile = 'main.tex',
    _engine = 'pdflatex',
  ): DiagnosticReport {
    if (typeof logText !== 'string' || logText.trim().length === 0) {
      throw new InvalidLogFormatException();
    }

    const resolvedDefaultFile = defaultFile || 'main.tex';
    const items = this.parseTexParenTreeLog(logText, resolvedDefaultFile);

    return new DiagnosticReport({
      items,
      rawLog: logText,
    });
  }

  public parseTexParenTreeLog(
    logText: string,
    defaultFile = 'main.tex',
  ): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const lines = LogLineVo.unwrap(logText);

    const parenStack: Array<{ isFile: boolean; file?: string }> = [
      { isFile: true, file: defaultFile },
    ];
    const getActiveFile = (): string => {
      for (let s = parenStack.length - 1; s >= 0; s--) {
        if (parenStack[s]?.isFile && parenStack[s]?.file) {
          return parenStack[s].file!;
        }
      }
      return defaultFile;
    };
    const scanParensLeftToRight = (text: string) => {
      let idx = 0;
      while (idx < text.length) {
        const ch = text[idx];
        if (ch === '(') {
          const rest = text.slice(idx + 1);
          const m = rest.match(
            /^(?:\.{0,2}\/|\/|[a-zA-Z]:|[a-zA-Z0-9_-]+\/)?([^()\s"]+\.(?:tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins))\b/i,
          );
          if (m) {
            const candidatePath = m[0].trim();
            const cleanPath = this.normalizeFilePath(
              candidatePath,
              defaultFile,
            );
            const isSystem =
              cleanPath.includes('texmf') ||
              cleanPath.includes('texlive') ||
              /\.(?:sty|cls|def|ldf|fd|cfg)$/i.test(cleanPath);
            parenStack.push({
              isFile: !isSystem,
              file: !isSystem ? cleanPath : undefined,
            });
            idx += 1 + m[0].length;
            continue;
          } else {
            parenStack.push({ isFile: false });
          }
        } else if (ch === ')') {
          if (parenStack.length > 1) {
            parenStack.pop();
          }
        }
        idx++;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || '';
      const cleanedLine = CompileLogAnalyzer.cleanNonFileParens(line);

      const isDiagnosticLine =
        CompileLogAnalyzer.FILE_LINE_ERROR_REGEX.test(line) ||
        line.startsWith('!') ||
        CompileLogAnalyzer.LATEX_WARNING_REGEX.test(line) ||
        CompileLogAnalyzer.BADBOX_REGEX.test(line);

      if (!isDiagnosticLine) {
        scanParensLeftToRight(cleanedLine);
      }

      const currentFile = getActiveFile();

      const fleMatch = line.match(CompileLogAnalyzer.FILE_LINE_ERROR_REGEX);
      if (fleMatch && fleMatch[1] && fleMatch[2] && fleMatch[3]) {
        const errorFile = this.normalizeFilePath(
          fleMatch[1].trim(),
          defaultFile,
        );
        const errorLine = parseInt(fleMatch[2], 10);
        const rawMessage = fleMatch[3].trim();
        const context = lines
          .slice(i, Math.min(i + 3, lines.length))
          .join('\n');
        const explanation =
          this.explainer?.explain(rawMessage, context) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: errorFile,
            line: errorLine,
            severity: DiagnosticSeverityVo.error(),
            message: rawMessage,
            context,
            code: explanation?.code,
            explanation,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      if (line.startsWith('!')) {
        const rawMessage = line.slice(1).trim();
        let errorLine: number | null = null;
        const contextLines: string[] = [line];

        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const nextLine = lines[j] || '';
          contextLines.push(nextLine);

          const lineMatch = nextLine.match(/^l\.(\d+)(.*)/);
          if (lineMatch && lineMatch[1]) {
            errorLine = parseInt(lineMatch[1], 10);
            i = j;
            break;
          }

          if (nextLine.startsWith('!')) {
            break;
          }
        }

        const context = contextLines.join('\n');
        const explanation =
          this.explainer?.explain(rawMessage, context) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: errorLine,
            severity: DiagnosticSeverityVo.error(),
            message: rawMessage,
            context,
            code: explanation?.code,
            explanation,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      const warningMatch = line.match(CompileLogAnalyzer.LATEX_WARNING_REGEX);
      if (warningMatch && warningMatch[1]) {
        let warnMsg = warningMatch[1].trim();
        let warnLine: number | null = null;
        const initialLineMatch = line.match(/on input line\s+(\d+)\./i);
        if (initialLineMatch && initialLineMatch[1]) {
          warnLine = parseInt(initialLineMatch[1], 10);
        }
        let context = line;

        let j = i + 1;
        while (
          j < lines.length &&
          lines[j] &&
          (/^\s{2,}/.test(lines[j]) || /^\([a-zA-Z0-9_-]+\)\s/.test(lines[j])) &&
          !lines[j].startsWith('!') &&
          !lines[j].match(CompileLogAnalyzer.LATEX_WARNING_REGEX) &&
          !lines[j].match(CompileLogAnalyzer.BADBOX_REGEX) &&
          !(lines[j].startsWith('(') && lines[j].includes('/'))
        ) {
          const nextL = lines[j].trim();
          const extraLineMatch = nextL.match(/on input line\s+(\d+)\./i);
          if (extraLineMatch && extraLineMatch[1]) {
            warnLine = parseInt(extraLineMatch[1], 10);
          }
          warnMsg += ' ' + nextL;
          context += '\n' + lines[j];
          scanParensLeftToRight(
            CompileLogAnalyzer.cleanNonFileParens(lines[j]),
          );
          j++;
          i = j - 1;
        }

        const explanation =
          this.explainer?.explain(warnMsg, context) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: warnLine,
            severity: DiagnosticSeverityVo.warning(),
            message: `LaTeX Warning: ${warnMsg}`,
            context,
            code: explanation?.code,
            explanation,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      // BibTeX / Biber warnings and errors
      const bibErrorMatch = line.match(
        /^(?:ERROR - BibTeX subsystem:\s*(.+)|I found no \\(?:citation|bibdata|bibstyle) commands---while reading file\s+(.+)|.*---line\s+(\d+)\s+of file\s+([^\s]+))/i,
      );
      if (bibErrorMatch) {
        const bibLine = bibErrorMatch[3]
          ? parseInt(bibErrorMatch[3], 10)
          : null;
        const bibFile = bibErrorMatch[4]
          ? this.normalizeFilePath(bibErrorMatch[4], defaultFile)
          : currentFile;
        diagnostics.push(
          new DiagnosticItem({
            file: bibFile,
            line: bibLine,
            severity: DiagnosticSeverityVo.error(),
            message: line.trim(),
            context: line,
          }),
        );
        if (isDiagnosticLine) scanParensLeftToRight(cleanedLine);
        continue;
      }

      const biberWarnMatch = line.match(/^WARN - (.+)$/);
      if (biberWarnMatch && biberWarnMatch[1]) {
        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: null,
            severity: DiagnosticSeverityVo.warning(),
            message: `Biber Warning: ${biberWarnMatch[1].trim()}`,
            context: line,
          }),
        );
        continue;
      }

      const badboxMatch = line.match(CompileLogAnalyzer.BADBOX_REGEX);
      if (badboxMatch && badboxMatch[1]) {
        const lineNum = parseInt(badboxMatch[1], 10);
        const explanation = this.explainer?.explain(line, line) || undefined;

        diagnostics.push(
          new DiagnosticItem({
            file: currentFile,
            line: lineNum,
            severity: DiagnosticSeverityVo.badbox(),
            message: line.trim(),
            context: line,
            code: explanation?.code,
            explanation,
          }),
        );
      }

      if (isDiagnosticLine) {
        scanParensLeftToRight(cleanedLine);
      }
    }

    return diagnostics;
  }

  private static cleanNonFileParens(line: string): string {
    if (line.length > 8192) {
      return line.slice(0, 8192);
    }
    let result = line;
    let prev = '';
    let iterations = 0;
    while (result !== prev && iterations < 8) {
      prev = result;
      iterations++;
      result = result.replace(/\(([^()]*)\)/g, (fullMatch, content) => {
        if (CompileLogAnalyzer.FILE_EXTENSION_REGEX.test(content)) {
          return fullMatch;
        }
        return ' ';
      });
    }
    return result;
  }

  private normalizeFilePath(raw: string, defaultFile: string): string {
    let clean = raw.replace(/\\/g, '/');
    clean = clean.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (clean.includes('texmf') || clean.includes('texlive')) {
      const parts = clean.split('/');
      return parts[parts.length - 1] || defaultFile;
    }
    return clean;
  }
}

const defaultLogParser = new CompileLogAnalyzer();

export function parseLatexLog(
  logText: string,
  defaultFile = 'main.tex',
): CompilerDiagnostic[] {
  return defaultLogParser.parse(logText, defaultFile);
}
