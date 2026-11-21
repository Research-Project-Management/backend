/**
 * modules/pages/clsi/services/clsi-ai.helper.ts
 * Server-side LaTeX AI error remediation and table generation helpers.
 */

import {
  ClsiAiFixErrorDto,
  ClsiAiGenerateEquationDto,
  ClsiAiGenerateTableDto,
} from '../dto/clsi.dto';
import { SyntaxLinter } from '@/modules/pages/diagnostics/domain';
import { AiErrorFixResult, fixLatexError } from '../domain/ai-assistant';
import type { IAiFacade } from '@/modules/ai';

export type ClsiAiEngine = Partial<
  Pick<IAiFacade, 'generate' | 'authorizeScope'>
>;

/**
 * Server-side LaTeX compiler error remediation:
 * Queries IAiFacade for structured JSON fix, falls back to FastSyntaxLinter.autoFix
 * and expert heuristic rules.
 */
export async function fixLatexErrorHelper(
  aiEngine: ClsiAiEngine | undefined,
  syntaxLinter: SyntaxLinter,
  dto: ClsiAiFixErrorDto,
  userId?: string,
): Promise<AiErrorFixResult> {
  const scope = aiEngine?.authorizeScope
    ? await aiEngine.authorizeScope({
        userId,
        spaceId: dto.spaceId,
        pageId: dto.pageId,
      })
    : { spaceId: dto.spaceId, pageId: dto.pageId };

  if (aiEngine && typeof aiEngine.generate === 'function') {
    const prompt = [
      'You are an expert LaTeX debugging assistant (Overleaf Error Assist).',
      'Analyze the following LaTeX compiler error and suggest an immediate, surgical fix.',
      `File: ${dto.errorFile || 'main.tex'}`,
      `Line: ${dto.errorLine || 'unknown'}`,
      `Error Message: ${dto.errorMessage}`,
      dto.detail ? `Detail: ${dto.detail}` : '',
      dto.surroundingCode
        ? `\nSurrounding Code:\n\`\`\`latex\n${dto.surroundingCode}\n\`\`\``
        : '',
      '',
      'Rules:',
      '- Never place \\usepackage before \\documentclass{...}; all \\usepackage declarations must appear after \\documentclass{...} and before \\begin{document}.',
      '- For Vietnamese Unicode errors in pdfLaTeX (e.g., áº¥, Æ¡, Æ°, Ä‘), use \\usepackage[T5]{fontenc} (NOT T1, which lacks Vietnamese glyphs, and omit legacy \\usepackage[utf8]{inputenc}). For non-Latin scripts (CJK, Cyrillic, Arabic), advise XeLaTeX or LuaLaTeX with \\usepackage{fontspec}.',
      '',
      'Reply ONLY with a valid JSON object in this exact schema (no markdown fences, pure JSON):',
      '{',
      '  "explanation": "Brief 1-2 sentence description of what caused the error and how to fix it",',
      '  "originalSnippet": "Exact code line(s) that should be replaced",',
      '  "fixedSnippet": "The corrected code line(s)",',
      `  "startLine": ${dto.errorLine || 1},`,
      `  "endLine": ${dto.errorLine || 1},`,
      '  "confidence": "high"',
      '}',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const aiRes = await aiEngine.generate({
        prompt,
        temperature: 0.2,
        userId,
        spaceId: scope.spaceId,
        pageId: scope.pageId,
      });
      const jsonText = (aiRes?.text || '')
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/, '')
        .replace(/\s*```$/, '')
        .trim();

      if (jsonText) {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.explanation === 'string' &&
          parsed.explanation.trim().length > 0 &&
          typeof parsed.fixedSnippet === 'string'
        ) {
          const explanation = parsed.explanation
            .trim()
            .replace(/^Error on line \d+:\s*/i, '')
            .replace(/^LaTeX Error:\s*/i, '')
            .trim();
          const originalSnippet =
            typeof parsed.originalSnippet === 'string'
              ? parsed.originalSnippet
              : '';

          return {
            explanation: explanation || parsed.explanation,
            originalSnippet,
            fixedSnippet: parsed.fixedSnippet,
            startLine: Number(parsed.startLine) || dto.errorLine || 1,
            endLine: Number(parsed.endLine) || dto.errorLine || 1,
            confidence:
              parsed.confidence === 'high' ||
              parsed.confidence === 'medium' ||
              parsed.confidence === 'low'
                ? parsed.confidence
                : 'high',
          };
        }
      }
    } catch {
      // Fall through to autoFix & heuristic
    }
  }

  if (dto.surroundingCode) {
    const autoFixRes = syntaxLinter.autoFix(dto.surroundingCode);
    if (autoFixRes.isFixed && autoFixRes.fixedSource !== dto.surroundingCode) {
      return {
        explanation:
          autoFixRes.appliedFixes.length > 0
            ? autoFixRes.appliedFixes.map((f) => f.description).join('; ')
            : 'Applied automated LaTeX syntax repair via Manuscript Diagnostics.',
        originalSnippet: dto.surroundingCode,
        fixedSnippet: autoFixRes.fixedSource,
        startLine: dto.errorLine || 1,
        endLine: dto.errorLine || 1,
        confidence: 'medium',
      };
    }
  }

  return fixLatexError(dto);
}

/**
 * Server-side LaTeX table generator from a natural language prompt.
 */
export async function generateLatexTableHelper(
  aiEngine: ClsiAiEngine | undefined,
  dto: ClsiAiGenerateTableDto,
  userId?: string,
): Promise<{ table: string }> {
  const scope = aiEngine?.authorizeScope
    ? await aiEngine.authorizeScope({
        userId,
        spaceId: dto.spaceId,
        pageId: dto.pageId,
      })
    : { spaceId: dto.spaceId, pageId: dto.pageId };

  const systemPrompt = `You are an expert academic LaTeX assistant. Generate a clean LaTeX tabular or TSV table according to the user request.
Output ONLY the clean LaTeX tabular code starting with \\begin{tabular} and ending with \\end{tabular} or TSV data with tabs and newlines. Do not wrap in markdown quotes or add conversational preamble.`;

  if (aiEngine && typeof aiEngine.generate === 'function') {
    try {
      const aiRes = await aiEngine.generate({
        prompt: dto.prompt,
        systemInstruction: systemPrompt,
        temperature: 0.3,
        userId,
        spaceId: scope.spaceId,
        pageId: scope.pageId,
      });
      const table = (aiRes?.text || '')
        .replace(/```latex\n?|```tsv\n?|```\n?/g, '')
        .trim();
      if (table) {
        return { table };
      }
    } catch {
      // Fallback below
    }
  }

  return {
    table: `\\begin{tabular}{lll}\n\\hline\nColumn 1 & Column 2 & Column 3 \\\\\n\\hline\nValue 1 & Value 2 & Value 3 \\\\\n\\hline\n\\end{tabular}`,
  };
}

/**
 * Normalizes raw model output into a display-math LaTeX equation:
 * strips markdown fences and `$$` / `\[ \]` / `$` delimiters, then wraps the body
 * in an `equation` environment unless it already contains a math environment.
 */
export function sanitizeLatexEquation(raw: string): string {
  const stripped = (raw || '')
    .replace(/```(?:latex|tex)?\n?/g, '')
    .trim()
    .replace(/^\$\$([\s\S]*?)\$\$$/, '$1')
    .replace(/^\\\[([\s\S]*?)\\\]$/, '$1')
    .replace(/^\$([\s\S]*?)\$$/, '$1')
    .trim();
  if (!stripped) {
    return '';
  }
  if (
    /\\begin\{(equation|align|gather|multline|eqnarray)\*?\}/.test(stripped)
  ) {
    return stripped;
  }
  return `\\begin{equation}\n  ${stripped}\n\\end{equation}`;
}

/**
 * Server-side LaTeX equation generator from a natural language prompt.
 * Returns an empty equation when no AI engine is available or generation fails.
 */
export async function generateLatexEquationHelper(
  aiEngine: ClsiAiEngine | undefined,
  dto: ClsiAiGenerateEquationDto,
  userId?: string,
): Promise<{ equation: string }> {
  const scope = aiEngine?.authorizeScope
    ? await aiEngine.authorizeScope({
        userId,
        spaceId: dto.spaceId,
        pageId: dto.pageId,
      })
    : { spaceId: dto.spaceId, pageId: dto.pageId };

  const systemPrompt = `You are an expert academic LaTeX assistant. Convert the user's description into a single correct LaTeX equation.
Output ONLY the LaTeX math (no markdown fences, no explanation, no surrounding text).`;

  if (aiEngine && typeof aiEngine.generate === 'function') {
    try {
      const aiRes = await aiEngine.generate({
        prompt: dto.prompt,
        systemInstruction: systemPrompt,
        temperature: 0.2,
        userId,
        spaceId: scope.spaceId,
        pageId: scope.pageId,
      });
      return { equation: sanitizeLatexEquation(aiRes?.text || '') };
    } catch {
      // Fall through to empty result
    }
  }

  return { equation: '' };
}
