import { Injectable, Optional } from '@nestjs/common';
import { CslItemData } from '@/modules/library/citation/types/csl-json.types';
import type { EngineCitationResult } from './csl-engine.service';
import {
  TcvnCitationFormatterService,
  escapeCitationHtml,
} from './tcvn-citation-formatter.service';
import {
  CslFallbackFormatter,
  BIBTEX_ITEM_TYPE_MAP,
  BIBTEX_CSL_TYPE_MAP,
  RIS_ITEM_TYPE_MAP,
  RIS_CSL_TYPE_MAP,
} from '../domain/csl-style-formatter.domain';

interface CiteInstance {
  format(type: string, options?: Record<string, unknown>): string;
}

interface CiteConstructor {
  new (data: unknown): CiteInstance;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Cite } = require('@citation-js/core') as { Cite: CiteConstructor };
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-bibtex');
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@citation-js/plugin-ris');

export {
  TcvnCitationFormatterService,
  escapeCitationHtml,
  BIBTEX_ITEM_TYPE_MAP,
  BIBTEX_CSL_TYPE_MAP,
  RIS_ITEM_TYPE_MAP,
  RIS_CSL_TYPE_MAP,
};

@Injectable()
export class CslStyleFormatterService extends CslFallbackFormatter {
  constructor(
    @Optional()
    private readonly tcvnFormatter: TcvnCitationFormatterService = new TcvnCitationFormatterService(),
  ) {
    super();
  }

  public escapeHtml(text: string): string {
    return escapeCitationHtml(text);
  }

  private replaceBibtexFieldBalanced(
    raw: string,
    fieldName: string,
    newBody: string,
  ): string | null {
    const fieldRegex = new RegExp(`\\b${fieldName}\\s*=\\s*\\{`, 'i');
    const match = fieldRegex.exec(raw);
    if (!match) return null;

    const openBraceIdx = match.index + match[0].length - 1;
    let depth = 0;
    let closeBraceIdx = -1;
    for (let i = openBraceIdx; i < raw.length; i++) {
      const ch = raw[i];
      const prev = i > 0 ? raw[i - 1] : '';
      if (ch === '{' && prev !== '\\') {
        depth++;
      } else if (ch === '}' && prev !== '\\') {
        depth--;
        if (depth === 0) {
          closeBraceIdx = i;
          break;
        }
      }
    }
    if (closeBraceIdx === -1) return null;

    return (
      raw.slice(0, match.index) +
      `${fieldName} = {${newBody}}` +
      raw.slice(closeBraceIdx + 1)
    );
  }

  public formatBibtex(cslInput: CslItemData | CslItemData[]): string {
    if (Array.isArray(cslInput)) {
      return cslInput.map((item) => this.formatBibtex(item)).join('\n\n');
    }
    const cslItem = cslInput;
    const targetType = this.resolveBibtexEntryType(cslItem);
    const safeKey = cslItem.id ? this.sanitizeBibtexKey(cslItem.id) : undefined;
    try {
      const {
        annote: _annote,
        keyword: _keyword,
        _keywords: __keywords,
        ...cslForCite
      } = cslItem;
      const cite = new Cite(cslForCite);
      let raw = cite.format('bibtex');
      if (raw && raw.trim().startsWith('@')) {
        raw = raw.replace(/^@[a-zA-Z]+\{/i, () => `@${targetType}{`);
        if (safeKey) {
          raw = raw.replace(
            /^(@[a-zA-Z]+\{)[^,]+,/,
            (_, prefix: string) => `${prefix}${safeKey},`,
          );
        }

        for (const role of ['author', 'editor'] as const) {
          const list = cslItem[role];
          if (
            Array.isArray(list) &&
            list.some((c) => Boolean(c.literal && !c.family && !c.given))
          ) {
            const formatted = this.formatBibtexCreatorList(list);
            if (formatted) {
              const escaped = this.escapeBibtexValue(formatted);
              const replaced = this.replaceBibtexFieldBalanced(
                raw,
                role,
                escaped,
              );
              raw =
                replaced !== null
                  ? replaced
                  : raw.replace(
                      /^(@[a-zA-Z]+\{[^,]+,)/,
                      (m: string) => `${m}\n  ${role} = {${escaped}},`,
                    );
            }
          }
        }

        raw = raw.replace(
          /(\bpages\s*=\s*\{)([A-Za-z0-9]+)\s*[-–—]+\s*([A-Za-z0-9]+)(\})/i,
          '$1$2--$3$4',
        );

        const extraBibFields: string[] = [];
        for (const [fieldKey, val] of this.collectBibtexSupplementPairs(
          cslItem,
          targetType,
        )) {
          if (
            fieldKey === 'howpublished' &&
            (/\burl\s*=/i.test(raw) || Boolean(cslItem.URL))
          ) {
            continue;
          }
          if (!new RegExp(`\\b${fieldKey}\\s*=`, 'i').test(raw)) {
            extraBibFields.push(
              `  ${fieldKey} = {${this.escapeBibtexValue(val, fieldKey)}},`,
            );
          }
        }

        if (/\burl\s*=/i.test(raw) || extraBibFields.some((f) => /^\s*url\s*=/i.test(f))) {
          raw = raw.replace(/^\s*howpublished\s*=\s*\{\\url\{[^}]*\}\},?\r?\n?/gim, '');
        }

        if (extraBibFields.length > 0) {
          raw = raw
            .trim()
            .replace(/\}\s*$/, () => `${extraBibFields.join('\n')}\n}`);
        }
        return raw.trim();
      }
    } catch {
      // Fallback manual serializer
    }

    return this.fallbackBibtex(cslItem);
  }

  public formatRis(cslInput: CslItemData | CslItemData[]): string {
    if (Array.isArray(cslInput)) {
      return cslInput.map((item) => this.formatRis(item)).join('\n\n');
    }
    const cslItem = cslInput;
    const targetRisType = this.resolveRisType(cslItem);
    try {
      const sanitizedCslForRis: CslItemData = {
        ...cslItem,
        ...(typeof cslItem.title === 'string'
          ? { title: cslItem.title.replace(/\r?\n+/g, ' ').trim() }
          : {}),
        ...(typeof cslItem.abstract === 'string'
          ? { abstract: cslItem.abstract.replace(/\r?\n+/g, ' ').trim() }
          : {}),
        ...(typeof cslItem.note === 'string'
          ? { note: cslItem.note.replace(/\r?\n+/g, ' ').trim() }
          : {}),
        ...(typeof cslItem.annote === 'string'
          ? { annote: cslItem.annote.replace(/\r?\n+/g, ' ').trim() }
          : {}),
      };
      const cite = new Cite(sanitizedCslForRis);
      let raw = cite.format('ris');
      if (raw && raw.trim().startsWith('TY  -')) {
        raw = raw
          .replace(/^TY\s+-\s+\S+/m, () => `TY  - ${targetRisType}`)
          .replace(/^KW\s+-\s+/gm, 'KW  - ')
          .replace(/^(N1\s+-\s+arXiv:)\s+/gm, '$1')
          .replace(
            /^SP\s+-\s+(\S+?)\s*[-–—]\s*(\S+)\s*$/m,
            'SP  - $1\nEP  - $2',
          );

        if (Array.isArray(cslItem._keywords) && cslItem._keywords.length > 0) {
          raw = raw.replace(/^KW\s+-\s+.*\r?\n?/gm, '');
        }

        const extraRisLines: string[] = [];
        for (const { tag, checkRegex, value } of this.collectRisSupplementTags(
          cslItem,
        )) {
          if (!checkRegex.test(raw)) {
            extraRisLines.push(
              `${tag}  - ${String(value).replace(/\r?\n+/g, ' ').trim()}`,
            );
          }
        }

        if (extraRisLines.length > 0) {
          raw = raw
            .trim()
            .replace(/ER\s*-\s*$/, () => `${extraRisLines.join('\n')}\nER  - `);
        }
        return raw.trim();
      }
    } catch {
      // Fallback
    }

    return this.fallbackRis(cslItem);
  }

  // TCVN & VIETNAMESE DELEGATIONS

  public formatTcvn(
    cslItem: CslItemData,
    isNumeric: boolean = false,
    index: number = 1,
  ): EngineCitationResult {
    return this.tcvnFormatter.formatTcvn(cslItem, isNumeric, index);
  }

  public formatTcvnBatch(cslItems: CslItemData[], isNumeric: boolean = false) {
    return this.tcvnFormatter.formatTcvnBatch(cslItems, isNumeric);
  }
}
