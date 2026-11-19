/**
 * modules/pages/diagnostics/domain/latex-autofix.engine.ts
 * Pure domain pre-compile LaTeX auto-fix rule pipeline.
 * Zero I/O, zero NestJS imports.
 */

import {
  MATH_ENVIRONMENTS,
  VERBATIM_ENVIRONMENTS,
  computeTechnicalMask,
  stripLatexComment,
} from './latex-syntax.scanner';

export interface AppliedFix {
  line: number;
  rule: string;
  description: string;
}

export interface AutoFixResult {
  isFixed: boolean;
  fixedSource: string;
  appliedFixes: AppliedFix[];
}

/**
 * Strategy / Pipeline Pattern: Composable line-level LaTeX Auto-Fix rule.
 */
export interface ILatexLineAutoFixRule {
  readonly id: string;
  applyLine(line: string, lineNum: number, appliedFixes: AppliedFix[]): string;
}

export function createDefaultLineAutoFixRules(): ILatexLineAutoFixRule[] {
  return [
    {
      id: 'SMART_QUOTES',
      applyLine: (line, lineNum, fixes) => fixSmartQuotes(line, lineNum, fixes),
    },
    {
      id: 'UNESCAPED_PERCENT',
      applyLine: (line, lineNum, fixes) =>
        fixNakedPercentages(line, lineNum, fixes),
    },
    {
      id: 'NAKED_UNDERSCORE',
      applyLine: (line, lineNum, fixes) =>
        fixNakedUnderscores(line, lineNum, fixes),
    },
  ];
}

export function runLatexAutoFix(
  source: string,
  lineAutoFixRules: readonly ILatexLineAutoFixRule[],
): AutoFixResult {
  const lines = source.split('\n');
  const appliedFixes: AppliedFix[] = [];
  const fixedLines: string[] = [];
  const unclosedEnvs: string[] = [];

  let verbatimEnvName: string | null = null;
  let ifFalseDepth = 0;
  let inDisplayMathBracket = false;
  let inDisplayMathDollar = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] || '';
    const lineNum = i + 1;

    if (!verbatimEnvName) {
      const vStart = line.match(/\\begin\{([a-zA-Z0-9*]+)\}/);
      if (vStart?.[1] && VERBATIM_ENVIRONMENTS.has(vStart[1])) {
        verbatimEnvName = vStart[1];
      }
    }
    if (verbatimEnvName) {
      fixedLines.push(line);
      const vEnd = line.match(/\\end\{([a-zA-Z0-9*]+)\}/);
      if (vEnd?.[1] === verbatimEnvName) {
        verbatimEnvName = null;
      }
      continue;
    }

    const codeOnlyBeforeRules = stripLatexComment(line);
    if (/\\iffalse\b/.test(codeOnlyBeforeRules)) {
      ifFalseDepth++;
    }
    if (ifFalseDepth > 0) {
      fixedLines.push(line);
      if (/\\fi\b/.test(codeOnlyBeforeRules)) {
        ifFalseDepth = Math.max(0, ifFalseDepth - 1);
      }
      continue;
    }

    const wasInMathEnv = unclosedEnvs.some((e) => MATH_ENVIRONMENTS.has(e));
    trackEnvironmentsForAutoFix(line, unclosedEnvs);
    const isInMathEnv =
      wasInMathEnv || unclosedEnvs.some((e) => MATH_ENVIRONMENTS.has(e));

    if (/\\\[/.test(codeOnlyBeforeRules)) inDisplayMathBracket = true;
    const doubleDollarMatches = codeOnlyBeforeRules.match(/(?<!\\)\$\$/g);
    const hadDisplayDollarOnLine = Boolean(
      doubleDollarMatches && doubleDollarMatches.length > 0,
    );
    const wasInDisplayMath =
      inDisplayMathBracket || inDisplayMathDollar || hadDisplayDollarOnLine;

    const skipNakedUnderscore = isInMathEnv || wasInDisplayMath;

    for (const rule of lineAutoFixRules) {
      if (rule.id === 'NAKED_UNDERSCORE' && skipNakedUnderscore) {
        continue;
      }
      line = rule.applyLine(line, lineNum, appliedFixes);
    }

    if (/\\\]/.test(codeOnlyBeforeRules)) inDisplayMathBracket = false;
    if (doubleDollarMatches && doubleDollarMatches.length % 2 === 1) {
      inDisplayMathDollar = !inDisplayMathDollar;
    }

    fixedLines.push(line);
  }

  fixRemainingUnclosedEnvironments(unclosedEnvs, fixedLines, appliedFixes);

  return {
    isFixed: appliedFixes.length > 0,
    fixedSource: fixedLines.join('\n'),
    appliedFixes,
  };
}

function trackEnvironmentsForAutoFix(
  line: string,
  unclosedEnvs: string[],
): void {
  const codeOnly = stripLatexComment(line);
  const beginMatches = codeOnly.matchAll(/\\begin\{([^}]+)\}/g);
  for (const m of beginMatches) {
    if (m[1]) unclosedEnvs.push(m[1].trim());
  }
  const endMatches = codeOnly.matchAll(/\\end\{([^}]+)\}/g);
  for (const m of endMatches) {
    if (m[1]) {
      const idx = unclosedEnvs.lastIndexOf(m[1].trim());
      if (idx !== -1) unclosedEnvs.splice(idx, 1);
    }
  }
}

function fixSmartQuotes(
  line: string,
  lineNum: number,
  appliedFixes: AppliedFix[],
): string {
  const codeOnly = stripLatexComment(line);
  const commentTail = line.slice(codeOnly.length);
  if (/[“”‘’]/.test(codeOnly)) {
    appliedFixes.push({
      line: lineNum,
      rule: 'SMART_QUOTES',
      description: 'Convert Unicode smart quotes to standard LaTeX quotes',
    });
    return (
      codeOnly
        .replace(/“/g, '``')
        .replace(/”/g, "''")
        .replace(/‘/g, '`')
        .replace(/’/g, "'") + commentTail
    );
  }
  return line;
}

function fixNakedPercentages(
  line: string,
  lineNum: number,
  appliedFixes: AppliedFix[],
): string {
  if (/^\s*%/.test(line)) return line;
  const codeOnly = stripLatexComment(line);
  const commentTail = line.slice(codeOnly.length);
  const percentFix = codeOnly.replace(
    /(?<!\\)(\d+(?:\.\d+)?)\s*%(?=\s*[a-zA-Z,;.)\]}])/g,
    '$1\\%',
  );
  if (percentFix !== codeOnly) {
    appliedFixes.push({
      line: lineNum,
      rule: 'UNESCAPED_PERCENT',
      description: 'Escape plain-text percent symbol as \\%',
    });
    return percentFix + commentTail;
  }
  return line;
}

function fixNakedUnderscores(
  line: string,
  lineNum: number,
  appliedFixes: AppliedFix[],
): string {
  const codeOnly = stripLatexComment(line);
  const commentTail = line.slice(codeOnly.length);
  const techMask = computeTechnicalMask(codeOnly);

  let fixedChars = '';
  let isMathChar = false;
  let underscoreFixed = false;

  for (let cIdx = 0; cIdx < codeOnly.length; cIdx++) {
    const c = codeOnly[cIdx];
    const prevC = cIdx > 0 ? codeOnly[cIdx - 1] : '';
    if (c === '$' && prevC !== '\\' && techMask[cIdx] !== 2) {
      isMathChar = !isMathChar;
    }
    if (c === '_' && !isMathChar && prevC !== '\\' && techMask[cIdx] === 0) {
      fixedChars += '\\_';
      underscoreFixed = true;
    } else {
      fixedChars += c;
    }
  }

  if (underscoreFixed) {
    appliedFixes.push({
      line: lineNum,
      rule: 'NAKED_UNDERSCORE',
      description: 'Escape plain-text underscore "_" as "\\_"',
    });
    return fixedChars + commentTail;
  }
  return line;
}

function fixRemainingUnclosedEnvironments(
  unclosedEnvs: string[],
  fixedLines: string[],
  appliedFixes: AppliedFix[],
): void {
  while (unclosedEnvs.length > 0) {
    const env = unclosedEnvs.pop()!;
    fixedLines.push(`\\end{${env}}`);
    appliedFixes.push({
      line: fixedLines.length,
      rule: 'UNCLOSED_ENVIRONMENT',
      description: `Automatically append missing \\end{${env}} at end of file`,
    });
  }
}
