/**
 * modules/manuscripts/export-import/domain/document-transpiler.ts
 * Pure in-process transpiler domain utilities converting Word (.docx) and Markdown (.md) documents
 * into compilable LaTeX projects without external CLI dependencies.
 * 100% Pure Domain logic, zero framework dependencies.
 */

export function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export {
  DocumentTranspilerAdapter,
  DocumentTranspilerAdapter as DocumentTranspiler,
} from '../services/document-transpiler.adapter';
