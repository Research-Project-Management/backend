/**
 * modules/manuscripts/clsi/domain/ai-assistant.ts
 * Pure domain logic for server-side LaTeX AI Academic Assistant & Error Assist:
 * - LaTeX macro & math entity masking (`maskLatexEntities`)
 * - Academic writing strategies & system prompts (`AI_ACTION_STRATEGIES`)
 * - Offline heuristic transformations (`applyFallbackTransform`)
 * - Compiler error remediation heuristics (`fixLatexError`)
 */

import { hasVietnameseCharacters } from '@/modules/pages/core';

export type AiActionType =
  | 'academic-tone'
  | 'make-concise'
  | 'rewrite-academic'
  | 'concise'
  | 'expand'
  | 'fix-grammar'
  | 'translate-english'
  | 'explain-latex'
  | 'custom';

export interface AiActionParams {
  action: AiActionType;
  selectedText: string;
  customPrompt?: string;
  contextBefore?: string;
  contextAfter?: string;
  documentTitle?: string;
  spaceId?: string;
  pageId?: string;
}

export interface AiActionResult {
  success: boolean;
  originalText: string;
  suggestedText: string;
  explanation: string;
  action: AiActionType;
  diffSummary: {
    charsOriginal: number;
    charsSuggested: number;
    wordsOriginal: number;
    wordsSuggested: number;
  };
}

export interface AiErrorFixParams {
  errorMessage: string;
  errorLine?: number;
  errorFile?: string;
  detail?: string;
  surroundingCode?: string;
  fullCode?: string;
  pageId?: string;
  spaceId?: string;
}

export interface AiErrorFixResult {
  explanation: string;
  originalSnippet: string;
  fixedSnippet: string;
  startLine: number;
  endLine: number;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * LaTeX Token Masker to guarantee macros and math equations are preserved verbatim.
 */
export function maskLatexEntities(text: string): {
  maskedText: string;
  unmask: (str: string) => string;
} {
  const placeholders: Map<string, string> = new Map();
  let counter = 0;

  let masked = text.replace(
    /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|displaymath)\}[\s\S]*?\\end\{\2\})/g,
    (match) => {
      const id = `__LATEX_DISPLAY_MATH_${counter++}__`;
      placeholders.set(id, match);
      return id;
    },
  );

  masked = masked.replace(/(\$[^$\n]+\$|\\\(.*?\\\))/g, (match) => {
    const id = `__LATEX_INLINE_MATH_${counter++}__`;
    placeholders.set(id, match);
    return id;
  });

  masked = masked.replace(
    /(\\(?:auto|paren|text|foot|no|new|short)?cite(?:p|t|alt|alp|author|year|date|num)?\*?(?:\[[^\]]*\])*\{[^}]+\})/g,
    (match) => {
      const id = `__LATEX_CITE_${counter++}__`;
      placeholders.set(id, match);
      return id;
    },
  );

  masked = masked.replace(
    /(\\label\{[^}]+\}|\\(?:eq|c|C|auto|page|name)?ref\*?\{[^}]+\})/g,
    (match) => {
      const id = `__LATEX_REF_${counter++}__`;
      placeholders.set(id, match);
      return id;
    },
  );

  const unmask = (str: string): string => {
    let result = str;
    for (const [id, original] of placeholders.entries()) {
      result = result.replaceAll(id, original);
    }
    return result;
  };

  return { maskedText: masked, unmask };
}

export interface AiActionStrategy {
  readonly buildSystemPrompt: (customPrompt?: string) => string;
  readonly applyHeuristic: (text: string) => string;
}

export const AI_ACTION_STRATEGIES: Readonly<
  Record<AiActionType, AiActionStrategy>
> = {
  'academic-tone': {
    buildSystemPrompt: () =>
      'You are an expert scientific editor for top-tier peer-reviewed journals (Nature, IEEE, ACM, Science). Rewrite the provided text to elevate its academic tone, scholarly vocabulary, clarity, and precision. Maintain third-person or formal academic voice. Preserve any __LATEX_*__ placeholder tokens verbatim. Do NOT add preamble or meta-commentary, return ONLY the rewritten text.',
    applyHeuristic: (text) =>
      text
        .replace(/\ba lot of\b/gi, 'a substantial volume of')
        .replace(/\bvery good\b/gi, 'superior')
        .replace(/\bshow that\b/gi, 'demonstrate that')
        .replace(/\bmake sure\b/gi, 'ensure')
        .replace(/\blook at\b/gi, 'investigate')
        .replace(/\bbig\b/gi, 'significant')
        .replace(/\bget\b/gi, 'obtain')
        .replace(/\bfind out\b/gi, 'determine')
        .replace(/\buse\b/gi, 'utilize')
        .replace(/\babout\b(?=\s+\d+)/gi, 'approximately'),
  },
  'rewrite-academic': {
    buildSystemPrompt: () =>
      'You are an expert scientific editor for top-tier peer-reviewed journals (Nature, IEEE, ACM, Science). Rewrite the provided text to elevate its academic tone, scholarly vocabulary, clarity, and precision. Maintain third-person or formal academic voice. Preserve any __LATEX_*__ placeholder tokens verbatim. Do NOT add preamble or meta-commentary, return ONLY the rewritten text.',
    applyHeuristic: (text) =>
      AI_ACTION_STRATEGIES['academic-tone'].applyHeuristic(text),
  },
  'make-concise': {
    buildSystemPrompt: () =>
      'You are an expert scientific editor. Rewrite the provided text to make it significantly more concise and direct. Eliminate redundant modifiers, passive fluff, and wordiness while strictly preserving all technical nuance, factual points, and __LATEX_*__ placeholder tokens. Return ONLY the rewritten text.',
    applyHeuristic: (text) =>
      text
        .replace(/\bin order to\b/gi, 'to')
        .replace(/\bdue to the fact that\b/gi, 'because')
        .replace(/\bat the present time\b/gi, 'currently')
        .replace(/\bfor the purpose of\b/gi, 'for')
        .replace(/\bin spite of the fact that\b/gi, 'although')
        .replace(/\ba large number of\b/gi, 'many')
        .replace(/\bis able to\b/gi, 'can')
        .replace(/\bit is important to note that\b/gi, 'notably,'),
  },
  concise: {
    buildSystemPrompt: () =>
      'You are an expert scientific editor. Rewrite the provided text to make it significantly more concise and direct. Eliminate redundant modifiers, passive fluff, and wordiness while strictly preserving all technical nuance, factual points, and __LATEX_*__ placeholder tokens. Return ONLY the rewritten text.',
    applyHeuristic: (text) =>
      AI_ACTION_STRATEGIES['make-concise'].applyHeuristic(text),
  },
  expand: {
    buildSystemPrompt: () =>
      'You are an expert academic co-author. Expand the provided text with clear scientific reasoning, transitional precision, and supporting elaboration while strictly preserving all factual claims and __LATEX_*__ placeholder tokens verbatim. Return ONLY the expanded text.',
    applyHeuristic: (text) => text,
  },
  'fix-grammar': {
    buildSystemPrompt: () =>
      'You are an expert academic proofreader. Fix all grammatical, typographical, punctuation, and structural flow errors in the following text. Improve transition phrases and preserve __LATEX_*__ placeholder tokens verbatim. Return ONLY the corrected text.',
    applyHeuristic: (text) => {
      const trimmed = text.trim();
      return trimmed.length > 0
        ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
        : trimmed;
    },
  },
  'translate-english': {
    buildSystemPrompt: () =>
      'You are an expert academic translator. Translate the provided text into formal, publication-ready academic English suitable for high-impact research papers. Preserve any __LATEX_*__ placeholder tokens verbatim. Return ONLY the translated English text.',
    applyHeuristic: (text) => text,
  },
  'explain-latex': {
    buildSystemPrompt: () =>
      'You are an expert LaTeX mentor. Briefly explain what the selected LaTeX commands, environments, or equations do and highlight any formatting considerations. Return a clear, concise explanation.',
    applyHeuristic: (text) => text,
  },
  custom: {
    buildSystemPrompt: (customPrompt) =>
      `You are an expert scientific writing assistant. Follow this instruction carefully: ${customPrompt || 'Improve the text'}. Preserve any __LATEX_*__ placeholder tokens verbatim. Return ONLY the resulting text without conversational commentary.`,
    applyHeuristic: (text) => text,
  },
};

export function getAiSystemPrompt(
  action: AiActionType,
  customPrompt?: string,
): string {
  const strategy = AI_ACTION_STRATEGIES[action] ?? AI_ACTION_STRATEGIES.custom;
  return strategy.buildSystemPrompt(customPrompt);
}

export function applyFallbackTransform(
  text: string,
  action: AiActionType,
): string {
  const strategy = AI_ACTION_STRATEGIES[action] ?? AI_ACTION_STRATEGIES.custom;
  let result = strategy.applyHeuristic(text);
  if (
    result.length > 0 &&
    text.length > 0 &&
    text[0] === text[0].toUpperCase()
  ) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }
  return result;
}

/**
 * Common LaTeX error heuristic fix patterns when AI call fails or is unavailable.
 */
export function fixLatexError(params: AiErrorFixParams): AiErrorFixResult {
  const {
    errorMessage,
    errorLine = 1,
    detail = '',
    surroundingCode = '',
  } = params;
  const lineNum = errorLine || 1;
  const lines = surroundingCode ? surroundingCode.split('\n') : [];
  const currentLineText =
    lines.length > 0 ? lines[Math.min(lines.length - 1, 2)] : '';

  const combinedErr = `${errorMessage}\n${detail}`;

  const unicodeMatch = combinedErr.match(
    /unicode character\s+(\S+)\s+\(U\+([0-9A-F]{4,6})\)[\s\S]*not set up for use with latex/i,
  );
  if (unicodeMatch?.[1] && unicodeMatch[2]) {
    const charStr = unicodeMatch[1];
    const cp = parseInt(unicodeMatch[2], 16);
    const cpChar = Number.isFinite(cp) ? String.fromCodePoint(cp) : charStr;
    if (hasVietnameseCharacters(charStr) || hasVietnameseCharacters(cpChar)) {
      return {
        explanation:
          'pdfLaTeX encountered a Vietnamese Unicode character without T5 font encoding. Add \\usepackage[T5]{fontenc} to your preamble (T1 does not cover Vietnamese glyphs).',
        originalSnippet: currentLineText || charStr,
        fixedSnippet: '\\usepackage[T5]{fontenc}',
        startLine: lineNum,
        endLine: lineNum,
        confidence: 'high',
      };
    }
    if (Number.isFinite(cp) && cp >= 0x00a0 && cp <= 0x017f) {
      return {
        explanation:
          'pdfLaTeX encountered an extended Latin character without T1 font encoding. Add \\usepackage[T1]{fontenc} to your preamble.',
        originalSnippet: currentLineText || charStr,
        fixedSnippet: '\\usepackage[T1]{fontenc}',
        startLine: lineNum,
        endLine: lineNum,
        confidence: 'high',
      };
    }
    return {
      explanation:
        'pdfLaTeX cannot typeset this Unicode character with 8-bit font encodings. Switch the compiler to XeLaTeX or LuaLaTeX in Project Settings and load \\usepackage{fontspec}.',
      originalSnippet: currentLineText || charStr,
      fixedSnippet: '',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'medium',
    };
  }

  if (/\\usepackage\s+before\s+\\documentclass/i.test(combinedErr)) {
    const baseStartLine = Math.max(1, lineNum - 3);
    const docClassTokenRe = /\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/;
    const pkgTokenRe =
      /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/g;
    const docLineIdx = lines.findIndex((ln) => docClassTokenRe.test(ln));

    if (docLineIdx !== -1) {
      const docLine = lines[docLineIdx];
      const docMatch = docLine.match(docClassTokenRe);
      const docIdxInLine = docMatch?.index ?? -1;
      if (docMatch && docIdxInLine >= 0) {
        let firstMisplacedIdx = -1;
        for (let i = 0; i <= docLineIdx; i++) {
          const segment =
            i === docLineIdx ? docLine.slice(0, docIdxInLine) : lines[i];
          if (
            /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/.test(
              segment,
            )
          ) {
            firstMisplacedIdx = i;
            break;
          }
        }

        if (firstMisplacedIdx !== -1) {
          const slice = lines.slice(firstMisplacedIdx, docLineIdx + 1);
          const beforeDocText =
            slice.length > 1
              ? `${slice.slice(0, -1).join('\n')}\n${docLine.slice(0, docIdxInLine)}`
              : docLine.slice(0, docIdxInLine);
          const pkgMatches = Array.from(
            beforeDocText.matchAll(pkgTokenRe),
            (m) => m[0].trim(),
          );
          if (pkgMatches.length > 0) {
            const trailing = docLine.slice(docIdxInLine + docMatch[0].length);
            return {
              explanation:
                'Moved \\usepackage declarations after \\documentclass so the document class is declared first.',
              originalSnippet: slice.join('\n'),
              fixedSnippet: [`${docMatch[0]}${trailing}`, ...pkgMatches].join(
                '\n',
              ),
              startLine: baseStartLine + firstMisplacedIdx,
              endLine: baseStartLine + docLineIdx,
              confidence: 'high',
            };
          }
        }
      }
    }

    return {
      explanation:
        'A \\usepackage declaration appeared before \\documentclass{...}. Move all \\usepackage commands below \\documentclass{...} and above \\begin{document}.',
      originalSnippet: currentLineText || '',
      fixedSnippet: '',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'high',
    };
  }

  if (
    /undefined control sequence/i.test(errorMessage) ||
    /undefined control sequence/i.test(detail)
  ) {
    const packageMap: Record<string, string> = {
      toprule: 'booktabs',
      midrule: 'booktabs',
      bottomrule: 'booktabs',
      cmidrule: 'booktabs',
      specialrule: 'booktabs',
      addlinespace: 'booktabs',
      multirow: 'multirow',
      includegraphics: 'graphicx',
      mathbb: 'amssymb, amsmath',
      mathcal: 'amssymb, amsmath',
      mathfrak: 'amssymb, amsmath',
      leqslant: 'amssymb, amsmath',
      geqslant: 'amssymb, amsmath',
      triangleq: 'amssymb, amsmath',
      intercal: 'amssymb, amsmath',
      eqref: 'amsmath',
      align: 'amsmath',
      DeclareMathOperator: 'amsmath',
      binom: 'amsmath',
      tfrac: 'amsmath',
      dfrac: 'amsmath',
      bm: 'bm',
      citet: 'natbib',
      citep: 'natbib',
      citealp: 'natbib',
      citealt: 'natbib',
      citeauthor: 'natbib',
      citeyear: 'natbib',
      newcite: 'natbib',
      shortcite: 'natbib',
      parencite: 'biblatex',
      textcite: 'biblatex',
      autocite: 'biblatex',
      cref: 'cleveref',
      Cref: 'cleveref',
      crefrange: 'cleveref',
      autoref: 'hyperref',
      nameref: 'hyperref',
      url: 'hyperref',
      href: 'hyperref',
      textcolor: 'xcolor',
      color: 'xcolor',
      SI: 'siunitx',
      qty: 'siunitx',
      unit: 'siunitx',
      tikz: 'tikz',
      tikzpicture: 'tikz',
      subfloat: 'subfig',
      subfigure: 'subcaption',
      lstinline: 'listings',
      lstlisting: 'listings',
      lipsum: 'lipsum',
    };

    const allCmds = [
      ...Array.from(detail.matchAll(/\\([a-zA-Z]+)/g), (m) => m[1]),
      ...Array.from(errorMessage.matchAll(/\\([a-zA-Z]+)/g), (m) => m[1]),
    ];
    const mappedCmd = allCmds.find((c) => Boolean(packageMap[c]));
    const cmd = mappedCmd || allCmds[allCmds.length - 1] || '';

    if (cmd && packageMap[cmd]) {
      const pkg = packageMap[cmd];
      const primaryPkg = pkg.split(',')[0].trim();
      return {
        explanation: `The command '\\${cmd}' requires the '${pkg}' package. Add \\usepackage{${primaryPkg}} to your preamble.`,
        originalSnippet: currentLineText || `\\${cmd}`,
        fixedSnippet: `\\usepackage{${primaryPkg}}`,
        startLine: lineNum,
        endLine: lineNum,
        confidence: 'high',
      };
    }

    return {
      explanation: `LaTeX encountered an unknown command ${cmd ? `'\\${cmd}'` : ''}. Check for spelling errors or missing package imports.`,
      originalSnippet: currentLineText || (cmd ? `\\${cmd}` : ''),
      fixedSnippet:
        currentLineText.replace(new RegExp(`\\\\${cmd}\\b`), '') ||
        '% Fixed command',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'medium',
    };
  }

  if (/missing \$ inserted/i.test(errorMessage)) {
    return {
      explanation:
        'Mathematical symbol, subscript, or superscript used outside of math mode. Wrap the formula in $...$.',
      originalSnippet: currentLineText,
      fixedSnippet: currentLineText ? `$${currentLineText.trim()}$` : '$x$',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'medium',
    };
  }

  if (/perhaps a missing \\item/i.test(errorMessage)) {
    return {
      explanation:
        "List environment (itemize/enumerate) contains text without an '\\item' command.",
      originalSnippet: currentLineText,
      fixedSnippet: currentLineText
        ? `  \\item ${currentLineText.trim()}`
        : '  \\item Content',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'high',
    };
  }

  const envMismatch = errorMessage.match(
    /\\begin\{([^}]+)\} ended by \\end\{([^}]+)\}/i,
  );
  if (envMismatch) {
    const beginEnv = envMismatch[1];
    const endEnv = envMismatch[2];
    return {
      explanation: `Mismatched environment: started with '\\begin{${beginEnv}}' but closed with '\\end{${endEnv}}'.`,
      originalSnippet: `\\end{${endEnv}}`,
      fixedSnippet: `\\end{${beginEnv}}`,
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'high',
    };
  }

  if (
    /missing \\begin\{document\}/i.test(errorMessage) ||
    /missing \\begin\{document\}/i.test(detail)
  ) {
    return {
      explanation:
        "The document environment has not been opened. Add '\\begin{document}' after your preamble before document content, or verify the main root document.",
      originalSnippet: currentLineText || '',
      fixedSnippet: '\\begin{document}',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'high',
    };
  }

  const fileNotFoundMatch = errorMessage.match(
    /File ['`"]?([^'`"]+)['`"]? not found/i,
  );
  if (fileNotFoundMatch) {
    const missingFile = fileNotFoundMatch[1];
    return {
      explanation: `Referenced file or package '${missingFile}' cannot be found. Verify that the file exists in the project hierarchy or update the \\input path.`,
      originalSnippet: currentLineText || `\\input{${missingFile}}`,
      fixedSnippet: currentLineText
        ? `% Verify file exists: ${missingFile}\n${currentLineText}`
        : '',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'high',
    };
  }

  if (
    /missing \} inserted/i.test(errorMessage) ||
    /extra \}, or forgotten \\endgroup/i.test(errorMessage) ||
    /too many \}'s/i.test(errorMessage)
  ) {
    return {
      explanation:
        "Unbalanced curly braces. Check for an unclosed '{' or an extra closing '}' in this block.",
      originalSnippet: currentLineText || '',
      fixedSnippet: currentLineText ? currentLineText.replace(/\}+$/, '') : '',
      startLine: lineNum,
      endLine: lineNum,
      confidence: 'medium',
    };
  }

  const cleanMsg = errorMessage
    .replace(/^!/g, '')
    .replace(/^LaTeX Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  const cleanDetail =
    detail && !/^[@^~.?!\s]+$/.test(detail) && detail.length > 1
      ? ` (${detail})`
      : '';

  return {
    explanation: cleanMsg
      ? `${cleanMsg}${cleanDetail}. Review the syntax at line ${lineNum}.`
      : `LaTeX syntax issue detected at line ${lineNum}. Check surrounding commands.`,
    originalSnippet: currentLineText || '',
    fixedSnippet: '',
    startLine: lineNum,
    endLine: lineNum,
    confidence: 'medium',
  };
}

/** @deprecated Use AiActionType, AiActionParams, AiActionResult, AiActionStrategy, AI_ACTION_STRATEGIES, getAiSystemPrompt, applyFallbackTransform, fixLatexError */
export {
  type AiActionType as AcademicAiActionType,
  type AiActionParams as AcademicAiActionParams,
  type AiActionResult as AcademicAiActionResult,
  type AiActionStrategy as AcademicAiActionStrategy,
  AI_ACTION_STRATEGIES as ACADEMIC_AI_STRATEGIES,
  getAiSystemPrompt as getAcademicSystemPrompt,
  applyFallbackTransform as applyHeuristicTransformation,
  fixLatexError as heuristicLatexErrorFix,
};
