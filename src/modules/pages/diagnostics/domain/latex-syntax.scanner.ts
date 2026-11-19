/**
 * modules/pages/diagnostics/domain/latex-syntax.scanner.ts
 * Pure domain character/line scanning rules for LaTeX static syntax linting.
 * Zero I/O, zero NestJS imports.
 */

import { DiagnosticItem, DiagnosticSeverityVo } from './diagnostic-item.entity';
import type { ErrorExplainerLike } from './error-knowledge-base';

export const MATH_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'aligned',
  'alignedat',
  'gather',
  'gather*',
  'gathered',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'eqnarray',
  'eqnarray*',
  'math',
  'displaymath',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'subarray',
  'split',
  'cases',
  'tikzpicture',
]);

export const TABLE_ENVIRONMENTS = new Set([
  'tabular',
  'tabular*',
  'tabularx',
  'tabulary',
  'longtable',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'aligned',
  'alignedat',
  'flalign',
  'flalign*',
  'eqnarray',
  'eqnarray*',
  'split',
  'cases',
]);

export const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'filecontents',
  'filecontents*',
  'comment',
]);

const TECHNICAL_COMMAND_REGEX =
  /\\(?:label|ref|eqref|pageref|autoref|nameref|cref|Cref|cite[a-zA-Z]*|newcite|shortcite|parencite|footcite|textcite|smartcite|autocite|nocite|input|include|subfile|includegraphics|bibliography|bibliographystyle|addbibresource|usepackage|documentclass|url|href|path|texttt|newcommand|renewcommand|providecommand|DeclareMathOperator|definecolor|color|textcolor)\*?(?:\[[^\]]*\])*\{([^{}]*)\}/g;

export interface MathScanState {
  inInlineMath: boolean;
  inInlineMathParen: boolean;
  inlineMathStartLine: number;
  inDisplayMathBracket: boolean;
  inDisplayMathDollar: boolean;
  displayMathStartLine: number;
}

export function stripLatexComment(line: string): string {
  let result = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) {
        backslashes++;
      }
      if (backslashes % 2 === 0) {
        if (
          i > 0 &&
          /\d/.test(line[i - 1]) &&
          /^\s*[a-zA-Z,;.)\]}]/.test(line.slice(i + 1))
        ) {
          result += line[i];
          continue;
        }
        break;
      }
    }
    result += line[i];
  }
  return result;
}

export function computeTechnicalMask(codeOnly: string): Uint8Array {
  const mask = new Uint8Array(codeOnly.length);

  const verbRegex = /\\verb\*?([^a-zA-Z\s])([\s\S]*?)\1/g;
  let vMatch: RegExpExecArray | null;
  while ((vMatch = verbRegex.exec(codeOnly)) !== null) {
    for (
      let k = vMatch.index;
      k < vMatch.index + vMatch[0].length && k < mask.length;
      k++
    ) {
      mask[k] = 2;
    }
  }

  TECHNICAL_COMMAND_REGEX.lastIndex = 0;
  let cMatch: RegExpExecArray | null;
  while ((cMatch = TECHNICAL_COMMAND_REGEX.exec(codeOnly)) !== null) {
    const startBrace = codeOnly.indexOf('{', cMatch.index);
    const start = startBrace !== -1 ? startBrace + 1 : cMatch.index;
    const end = cMatch.index + cMatch[0].length - 1;
    for (let k = start; k < end && k < mask.length; k++) {
      if (mask[k] === 0) mask[k] = 1;
    }
  }

  return mask;
}

export function isLineInVerbatim(
  rawLine: string,
  envStack: Array<{ name: string; line: number }>,
): boolean {
  const currentEnv =
    envStack.length > 0 ? envStack[envStack.length - 1].name : null;
  const inVerbatim =
    currentEnv !== null && VERBATIM_ENVIRONMENTS.has(currentEnv);

  if (inVerbatim) {
    const endMatch = rawLine.match(/\\end\{([^}]+)\}/);
    if (endMatch && endMatch[1] && endMatch[1].trim() === currentEnv) {
      envStack.pop();
    }
    return true;
  }

  const singleMatch = rawLine.match(
    /\\begin\{([a-zA-Z0-9*]+)\}[\s\S]*?\\end\{\1\}/,
  );
  if (singleMatch?.[1] && VERBATIM_ENVIRONMENTS.has(singleMatch[1])) {
    return true;
  }
  return false;
}

export function lintSmartQuotes(
  codeOnly: string,
  rawLine: string,
  lineNum: number,
  filename: string,
  diagnostics: DiagnosticItem[],
  explainer?: ErrorExplainerLike,
): void {
  if (/[“”‘’]/.test(codeOnly)) {
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: lineNum,
        severity: DiagnosticSeverityVo.warning(),
        message:
          'Unicode smart quotes detected (“” or ‘’). pdfTeX may fail to render these characters.',
        context: rawLine.trim(),
        code: 'SMART_QUOTES',
        explanation:
          explainer?.getByCode('UNDEFINED_CONTROL_SEQUENCE') || undefined,
        quickFix: {
          description:
            "Convert Unicode quotes to standard LaTeX quotes (`` or '')",
          replacementText: rawLine
            .replace(/“/g, '``')
            .replace(/”/g, "''")
            .replace(/‘/g, '`')
            .replace(/’/g, "'"),
        },
      }),
    );
  }
}

export function lintCitationKeys(
  codeOnly: string,
  rawLine: string,
  lineNum: number,
  filename: string,
  knownBibKeys: Set<string> | undefined,
  diagnostics: DiagnosticItem[],
  explainer?: ErrorExplainerLike,
): void {
  if (!knownBibKeys || knownBibKeys.size === 0) return;

  const citeMatches = codeOnly.matchAll(
    /\\(?:cite[a-zA-Z]*|newcite|shortcite|parencite|footcite|textcite|smartcite|autocite|nocite)\*?(?:\[[^\]]*\])*\{([^}]+)\}/g,
  );
  for (const m of citeMatches) {
    if (m[1]) {
      const keys = m[1].split(',').map((k) => k.trim());
      for (const key of keys) {
        if (
          key &&
          key !== '*' &&
          !knownBibKeys.has(key) &&
          !knownBibKeys.has(key.toLowerCase())
        ) {
          const colIdx = rawLine.indexOf(key, m.index ?? 0);
          diagnostics.push(
            new DiagnosticItem({
              file: filename,
              line: lineNum,
              column: colIdx >= 0 ? colIdx + 1 : null,
              severity: DiagnosticSeverityVo.warning(),
              message: `Citation key "${key}" not found in project bibliography (.bib) files.`,
              context: rawLine.trim(),
              code: 'MISSING_CITATION_KEY',
              explanation:
                explainer?.getByCode('UNDEFINED_CITATION') || undefined,
              quickFix: {
                description: `Add bibliography entry @article{${key}, ...} to references.bib`,
                replacementText: key,
              },
            }),
          );
        }
      }
    }
  }
}

export function lintLabelsAndRefs(
  codeOnly: string,
  rawLine: string,
  lineNum: number,
  filename: string,
  seenLabelsInDoc: Set<string>,
  knownLabels: Set<string> | undefined,
  diagnostics: DiagnosticItem[],
): void {
  const labelMatches = codeOnly.matchAll(/\\label\{([^}]+)\}/g);
  for (const lm of labelMatches) {
    const labelKey = (lm[1] || '').trim();
    if (!labelKey) continue;
    if (seenLabelsInDoc.has(labelKey)) {
      const colIdx = rawLine.indexOf(labelKey, lm.index ?? 0);
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: lineNum,
          column: colIdx >= 0 ? colIdx + 1 : null,
          severity: DiagnosticSeverityVo.error(),
          message: `Duplicate label "${labelKey}". Label was already declared earlier in this file.`,
          context: rawLine.trim(),
          code: 'DUPLICATE_LABEL',
        }),
      );
    } else {
      seenLabelsInDoc.add(labelKey);
    }
  }

  if (!knownLabels || knownLabels.size === 0) return;

  const refMatches = codeOnly.matchAll(
    /\\(?:ref|eqref|autoref|cref|Cref|pageref|vref)\*?\{([^}]+)\}/g,
  );
  for (const rm of refMatches) {
    if (rm[1]) {
      const labels = rm[1].split(',').map((l) => l.trim());
      for (const label of labels) {
        if (label && !knownLabels.has(label) && !seenLabelsInDoc.has(label)) {
          const colIdx = rawLine.indexOf(label, rm.index ?? 0);
          diagnostics.push(
            new DiagnosticItem({
              file: filename,
              line: lineNum,
              column: colIdx >= 0 ? colIdx + 1 : null,
              severity: DiagnosticSeverityVo.warning(),
              message: `Reference label "${label}" is not defined in any project file.`,
              context: rawLine.trim(),
              code: 'UNDEFINED_REFERENCE',
            }),
          );
        }
      }
    }
  }
}

export function scanLineCharacters(
  codeOnly: string,
  rawLine: string,
  lineNum: number,
  filename: string,
  envStack: Array<{ name: string; line: number }>,
  braceStack: Array<{ line: number; col: number }>,
  mathState: MathScanState,
  diagnostics: DiagnosticItem[],
  explainer?: ErrorExplainerLike,
): void {
  const techMask = computeTechnicalMask(codeOnly);
  let i = 0;
  while (i < codeOnly.length) {
    if (techMask[i] === 2) {
      i++;
      continue;
    }

    const char = codeOnly[i];
    const nextChar = i + 1 < codeOnly.length ? codeOnly[i + 1] : '';

    if (char === '\\') {
      if (nextChar === '[') {
        mathState.inDisplayMathBracket = true;
        mathState.displayMathStartLine = lineNum;
        i += 2;
        continue;
      }
      if (nextChar === ']') {
        mathState.inDisplayMathBracket = false;
        i += 2;
        continue;
      }
      if (nextChar === '(') {
        mathState.inInlineMathParen = true;
        mathState.inlineMathStartLine = lineNum;
        i += 2;
        continue;
      }
      if (nextChar === ')') {
        mathState.inInlineMathParen = false;
        i += 2;
        continue;
      }

      const beginMatch = codeOnly.slice(i).match(/^\\begin\{([^}]+)\}/);
      if (beginMatch && beginMatch[1]) {
        const envName = beginMatch[1].trim();
        envStack.push({ name: envName, line: lineNum });
        i += beginMatch[0].length;
        continue;
      }

      const endMatch = codeOnly.slice(i).match(/^\\end\{([^}]+)\}/);
      if (endMatch && endMatch[1]) {
        handleEndEnvironment(
          endMatch[1].trim(),
          rawLine,
          lineNum,
          filename,
          envStack,
          diagnostics,
          explainer,
        );
        i += endMatch[0].length;
        continue;
      }

      i += 2;
      continue;
    }

    if (char === '$' && nextChar === '$') {
      mathState.inDisplayMathDollar = !mathState.inDisplayMathDollar;
      if (mathState.inDisplayMathDollar)
        mathState.displayMathStartLine = lineNum;
      i += 2;
      continue;
    }

    if (char === '$') {
      mathState.inInlineMath = !mathState.inInlineMath;
      if (mathState.inInlineMath) mathState.inlineMathStartLine = lineNum;
      i++;
      continue;
    }

    if (char === '{') {
      braceStack.push({ line: lineNum, col: i + 1 });
    } else if (char === '}') {
      if (braceStack.length === 0) {
        diagnostics.push(
          new DiagnosticItem({
            file: filename,
            line: lineNum,
            column: i + 1,
            severity: DiagnosticSeverityVo.error(),
            message: 'Stray closing brace "}" without matching opening brace.',
            context: rawLine.trim(),
            code: 'UNBALANCED_BRACES',
            explanation: explainer?.getByCode('UNBALANCED_BRACES') || undefined,
          }),
        );
      } else {
        braceStack.pop();
      }
    }

    if (techMask[i] === 1) {
      i++;
      continue;
    }

    const isCurrentInMath =
      mathState.inInlineMath ||
      mathState.inInlineMathParen ||
      mathState.inDisplayMathBracket ||
      mathState.inDisplayMathDollar ||
      envStack.some((e) => MATH_ENVIRONMENTS.has(e.name));

    if (!isCurrentInMath) {
      if (char === '_' || char === '^') {
        diagnostics.push(
          new DiagnosticItem({
            file: filename,
            line: lineNum,
            column: i + 1,
            severity: DiagnosticSeverityVo.error(),
            message: `Math operator "${char}" found outside math mode. Wrap in $...$ or escape as "\\${char}".`,
            context: rawLine.trim(),
            code: 'MISSING_MATH_DELIMITER',
            explanation:
              explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
            quickFix: {
              description: `Escape "${char}" as "\\${char}"`,
              replacementText: `\\${char}`,
            },
          }),
        );
      }

      if (char === '&') {
        const isCurrentInTable = envStack.some((e) =>
          TABLE_ENVIRONMENTS.has(e.name),
        );
        if (!isCurrentInTable) {
          diagnostics.push(
            new DiagnosticItem({
              file: filename,
              line: lineNum,
              column: i + 1,
              severity: DiagnosticSeverityVo.error(),
              message:
                'Column delimiter "&" used outside table environment. Use "\\&" for plain-text ampersands.',
              context: rawLine.trim(),
              code: 'EXTRA_ALIGNMENT_TAB',
              explanation:
                explainer?.getByCode('EXTRA_ALIGNMENT_TAB') || undefined,
              quickFix: {
                description: 'Escape & as \\&',
                replacementText: '\\&',
              },
            }),
          );
        }
      }
    }

    i++;
  }
}

function handleEndEnvironment(
  endEnvName: string,
  rawLine: string,
  lineNum: number,
  filename: string,
  envStack: Array<{ name: string; line: number }>,
  diagnostics: DiagnosticItem[],
  explainer?: ErrorExplainerLike,
): void {
  const matchIdx = envStack.map((e) => e.name).lastIndexOf(endEnvName);

  if (matchIdx !== -1) {
    while (envStack.length - 1 > matchIdx) {
      const unclosed = envStack.pop()!;
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: unclosed.line,
          severity: DiagnosticSeverityVo.error(),
          message: `Environment \\begin{${unclosed.name}} on line ${unclosed.line} is not closed before end of file.`,
          code: 'UNCLOSED_ENVIRONMENT',
          explanation:
            explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
          quickFix: {
            description: `Add \\end{${unclosed.name}} to close environment`,
            replacementText: `\\end{${unclosed.name}}`,
          },
        }),
      );
    }
    envStack.pop();
  } else if (envStack.length > 0) {
    const top = envStack.pop()!;
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: lineNum,
        severity: DiagnosticSeverityVo.error(),
        message: `Environment \\begin{${top.name}} (on line ${top.line}) was closed with mismatched \\end{${endEnvName}}.`,
        context: rawLine.trim(),
        code: 'ENVIRONMENT_MISMATCH',
        explanation: explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
        quickFix: {
          description: `Change to \\end{${top.name}}`,
          replacementText: `\\end{${top.name}}`,
        },
      }),
    );
  } else {
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: lineNum,
        severity: DiagnosticSeverityVo.error(),
        message: `Stray \\end{${endEnvName}} without matching \\begin.`,
        context: rawLine.trim(),
        code: 'UNMATCHED_END_ENVIRONMENT',
        explanation: explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
      }),
    );
  }
}

export function lintUnclosedBraces(
  braceStack: Array<{ line: number; col: number }>,
  filename: string,
  diagnostics: DiagnosticItem[],
  explainer?: ErrorExplainerLike,
): void {
  while (braceStack.length > 0) {
    const unclosed = braceStack.pop()!;
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: unclosed.line,
        column: unclosed.col,
        severity: DiagnosticSeverityVo.error(),
        message: `Opening brace "{" on line ${unclosed.line} was never closed with "}".`,
        code: 'UNBALANCED_BRACES',
        explanation: explainer?.getByCode('UNBALANCED_BRACES') || undefined,
        quickFix: {
          description: 'Add closing brace "}"',
          replacementText: '}',
        },
      }),
    );
  }
}

export function lintUnclosedEnvironments(
  envStack: Array<{ name: string; line: number }>,
  filename: string,
  diagnostics: DiagnosticItem[],
  explainer?: ErrorExplainerLike,
): void {
  while (envStack.length > 0) {
    const unclosed = envStack.pop()!;
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: unclosed.line,
        severity: DiagnosticSeverityVo.error(),
        message: `Environment \\begin{${unclosed.name}} on line ${unclosed.line} is not closed before end of file.`,
        code: 'UNCLOSED_ENVIRONMENT',
        explanation: explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
        quickFix: {
          description: `Add \\end{${unclosed.name}} at end of file`,
          replacementText: `\\end{${unclosed.name}}`,
        },
      }),
    );
  }
}

export function lintUnclosedMath(
  mathState: MathScanState,
  filename: string,
  diagnostics: DiagnosticItem[],
  explainer?: ErrorExplainerLike,
): void {
  if (mathState.inDisplayMathBracket) {
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: mathState.displayMathStartLine,
        severity: DiagnosticSeverityVo.error(),
        message: `Display math \\[ opened on line ${mathState.displayMathStartLine} was never closed with \\].`,
        code: 'MISSING_MATH_DELIMITER',
        explanation:
          explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
      }),
    );
  }

  if (mathState.inDisplayMathDollar) {
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: mathState.displayMathStartLine,
        severity: DiagnosticSeverityVo.error(),
        message: `Display math $$ opened on line ${mathState.displayMathStartLine} was never closed with $$.`,
        code: 'MISSING_MATH_DELIMITER',
        explanation:
          explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
      }),
    );
  }

  if (mathState.inInlineMath) {
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: mathState.inlineMathStartLine,
        severity: DiagnosticSeverityVo.error(),
        message: `Inline math $ opened on line ${mathState.inlineMathStartLine} was never closed with $.`,
        code: 'MISSING_MATH_DELIMITER',
        explanation:
          explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
      }),
    );
  }

  if (mathState.inInlineMathParen) {
    diagnostics.push(
      new DiagnosticItem({
        file: filename,
        line: mathState.inlineMathStartLine,
        severity: DiagnosticSeverityVo.error(),
        message: `Inline math \\( opened on line ${mathState.inlineMathStartLine} was never closed with \\).`,
        code: 'MISSING_MATH_DELIMITER',
        explanation:
          explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
      }),
    );
  }
}
