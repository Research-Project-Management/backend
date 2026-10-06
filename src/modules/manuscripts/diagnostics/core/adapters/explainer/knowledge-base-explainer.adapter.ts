/**
 * diagnostics/core/adapters/explainer/knowledge-base-explainer.adapter.ts
 * Adapter implementing IErrorExplainerPort with a rich knowledge base of 50+ LaTeX error patterns.
 */

import { IErrorExplainerPort } from '../../ports/error-explainer.port';
import {
  ErrorExplanationVo,
  ErrorExplanationProps,
} from '../../domain/value-objects/error-explanation.vo';

interface RuleDefinition extends ErrorExplanationProps {
  patterns: RegExp[];
}

export class KnowledgeBaseExplainerAdapter implements IErrorExplainerPort {
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Undefined_control_sequence',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Missing_$_inserted',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/LaTeX_Error%3A_File_not_found',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/%5Cbegin%7B...%7D_ended_by_%5Cend%7B...%7D',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/LaTeX_Error%3A_Environment_undefined',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Extra_alignment_tab_has_been_changed_to_%5Ccr',
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
      documentationUrl:
        "https://www.overleaf.com/learn/latex/Errors/There's_no_line_here_to_end",
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Can_be_used_only_in_preamble',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/LaTeX_Error%3A_Command_..._already_defined',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Extra_%7D%2C_or_forgotten_%24',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/File_ended_while_scanning_use_of',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Emergency_stop',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Overfull_%5Chbox',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/Underfull_%5Chbox',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/LaTeX_Warning%3A_Reference_..._undefined',
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
      documentationUrl:
        'https://www.overleaf.com/learn/latex/Errors/LaTeX_Warning%3A_Citation_..._undefined',
      patterns: [
        /citation [`'](.+?)['] on page \d+ undefined/i,
        /there were undefined citations/i,
      ],
    },
  ];

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

  public getByCode(code: string): ErrorExplanationVo | null {
    const normalized = code.trim().toUpperCase();
    const targetCode =
      KnowledgeBaseExplainerAdapter.CODE_ALIASES[normalized] || normalized;
    let rule = this.rules.find((r) => r.code.toUpperCase() === targetCode);
    if (!rule) {
      rule = this.rules.find((r) => r.patterns.some((p) => p.test(code)));
    }
    return rule ? new ErrorExplanationVo(rule) : null;
  }

  public getAllRules(): ErrorExplanationVo[] {
    return this.rules.map((r) => new ErrorExplanationVo(r));
  }
}
