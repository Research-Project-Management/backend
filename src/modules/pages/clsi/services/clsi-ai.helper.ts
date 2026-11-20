/**
 * modules/pages/clsi/services/clsi-ai.helper.ts
 * Server-side LaTeX AI academic text transformation, error remediation, and table generation helpers.
 */

import {
  ClsiAiFixErrorDto,
  ClsiAiGenerateTableDto,
  ClsiAiTransformDto,
} from '../dto/clsi.dto';
import { SyntaxLinter } from '@/modules/pages/diagnostics/domain';
import {
  AiActionResult,
  AiErrorFixResult,
  applyFallbackTransform,
  fixLatexError,
  getAiSystemPrompt,
  maskLatexEntities,
} from '../domain/ai-assistant';
import type { IAiFacade } from '@/modules/ai';

export type ClsiAiEngine = Partial<
  Pick<IAiFacade, 'generate' | 'authorizeScope'>
>;

/**
 * Server-side LaTeX AI academic writing transformation:
 * Masks LaTeX math, citations, and references, applies academic strategy via IAiFacade
 * (with heuristic fallback), and unmasks all LaTeX entities verbatim.
 */
export async function transformAcademicTextHelper(
  aiEngine: ClsiAiEngine | undefined,
  dto: ClsiAiTransformDto,
  userId?: string,
): Promise<AiActionResult> {
  const {
    action,
    selectedText,
    customPrompt,
    contextBefore,
    contextAfter,
    documentTitle,
  } = dto;

  const scope = aiEngine?.authorizeScope
    ? await aiEngine.authorizeScope({
        userId,
        spaceId: dto.spaceId,
        pageId: dto.pageId,
      })
    : { spaceId: dto.spaceId, pageId: dto.pageId };

  const rawText = selectedText || '';
  const trimmed = rawText.trim();
  const leadingWs = rawText.match(/^\s*/)?.[0] ?? '';
  const trailingWs = rawText.match(/\s*$/)?.[0] ?? '';

  if (!trimmed) {
    return {
      success: false,
      originalText: selectedText,
      suggestedText: selectedText,
      explanation: 'No text selected.',
      action,
      diffSummary: {
        charsOriginal: 0,
        charsSuggested: 0,
        wordsOriginal: 0,
        wordsSuggested: 0,
      },
    };
  }

  const { maskedText, unmask } = maskLatexEntities(trimmed);
  let suggestedCore = '';
  let explanation = '';

  if (aiEngine && typeof aiEngine.generate === 'function') {
    try {
      const systemPrompt = getAiSystemPrompt(action, customPrompt);
      const promptParts: string[] = [];
      if (documentTitle) {
        promptParts.push(`Document Title: ${documentTitle}`);
      }
      if (contextBefore) {
        promptParts.push(
          `Context before selection:\n"""\n${contextBefore.slice(-1500)}\n"""`,
        );
      }
      promptParts.push(`Text to edit:\n"""\n${maskedText}\n"""`);
      if (contextAfter) {
        promptParts.push(
          `Context after selection:\n"""\n${contextAfter.slice(0, 1500)}\n"""`,
        );
      }
      const promptText = promptParts.join('\n\n');
      const aiRes = await aiEngine.generate({
        prompt: promptText,
        systemInstruction: systemPrompt,
        temperature: 0.3,
        userId,
        spaceId: scope.spaceId,
        pageId: scope.pageId,
      });
      const rawAiText = (aiRes?.text || '')
        .replace(/^"""\s*|\s*"""$/g, '')
        .trim();
      if (rawAiText.length > 0) {
        suggestedCore = unmask(rawAiText).trim();
        explanation = `Applied ${action.replace(/-/g, ' ')} via AI Assistant.`;
      }
    } catch {
      // Fallback to server-side heuristic transformation
    }
  }

  if (!suggestedCore) {
    const fallbackMasked = applyFallbackTransform(maskedText, action);
    suggestedCore = unmask(fallbackMasked).trim();
    explanation = `Enhanced ${action.replace(/-/g, ' ')} using Academic Heuristic Rules.`;
  }

  const suggestedResult = `${leadingWs}${suggestedCore}${trailingWs}`;
  const wordsOriginal = trimmed.split(/\s+/).filter(Boolean).length;
  const wordsSuggested = suggestedCore.split(/\s+/).filter(Boolean).length;

  return {
    success: true,
    originalText: selectedText,
    suggestedText: suggestedResult,
    explanation,
    action,
    diffSummary: {
      charsOriginal: selectedText.length,
      charsSuggested: suggestedResult.length,
      wordsOriginal,
      wordsSuggested,
    },
  };
}

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
      '- For Vietnamese Unicode errors in pdfLaTeX (e.g., ấ, ơ, ư, đ), use \\usepackage[T5]{fontenc} (NOT T1, which lacks Vietnamese glyphs, and omit legacy \\usepackage[utf8]{inputenc}). For non-Latin scripts (CJK, Cyrillic, Arabic), advise XeLaTeX or LuaLaTeX with \\usepackage{fontspec}.',
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
