import { Injectable } from '@nestjs/common';
import {
  CslItemData,
  CslName,
} from '@/modules/library/citation/types/csl-json.types';
import {
  VIETNAMESE_SURNAMES_PREFIX_REGEX,
  hasVietnameseDiacritics,
} from '@/modules/library/core';
import type { EngineCitationResult } from './csl-engine.service';

export function escapeCitationHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

@Injectable()
export class TcvnCitationFormatterService {
  private static readonly VN_SURNAMES_REGEX = VIETNAMESE_SURNAMES_PREFIX_REGEX;
  private static readonly ACADEMIC_DEGREES_REGEX =
    /^(?:(?:p?gs|ts(?:kh)?|ths|cn|ks|bs|dr|prof|ph\.?d)\.?\s*)+/gi;

  public static stripAcademicDegrees(text: string): string {
    return (text || '').trim().replace(this.ACADEMIC_DEGREES_REGEX, '').trim();
  }

  public static isVietnameseAuthor(author?: CslName | null): boolean {
    if (!author) return false;
    if (author.literal) return hasVietnameseDiacritics(author.literal);
    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');
    if (hasVietnameseDiacritics(`${cleanFamily} ${cleanGiven}`.trim())) {
      return true;
    }
    return TcvnCitationFormatterService.VN_SURNAMES_REGEX.test(cleanFamily);
  }

  public static getVietnameseSortKey(author?: CslName | null): {
    primary: string;
    secondary: string;
  } {
    if (!author) return { primary: '', secondary: '' };
    if (author.literal) {
      return {
        primary: this.stripAcademicDegrees(author.literal),
        secondary: '',
      };
    }
    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');
    if (cleanGiven) {
      const givenParts = cleanGiven.split(/\s+/);
      const primary = givenParts[givenParts.length - 1];
      const middle = givenParts.slice(0, -1).join(' ');
      return { primary, secondary: `${cleanFamily} ${middle}`.trim() };
    }
    const familyParts = cleanFamily.split(/\s+/).filter(Boolean);
    if (familyParts.length > 1) {
      return {
        primary: familyParts[familyParts.length - 1],
        secondary: familyParts.slice(0, -1).join(' '),
      };
    }
    return { primary: cleanFamily, secondary: '' };
  }

  public static isVietnameseItem(item: CslItemData): boolean {
    const firstAuthor = item.author?.[0];
    if (
      firstAuthor &&
      TcvnCitationFormatterService.isVietnameseAuthor(firstAuthor)
    ) {
      return true;
    }
    return Boolean(item.title && hasVietnameseDiacritics(item.title));
  }

  public static compareTcvnEntries(
    itemA: CslItemData,
    itemB: CslItemData,
  ): number {
    const isVnA = TcvnCitationFormatterService.isVietnameseItem(itemA);
    const isVnB = TcvnCitationFormatterService.isVietnameseItem(itemB);
    if (isVnA && !isVnB) return -1;
    if (!isVnA && isVnB) return 1;

    if (isVnA && isVnB) {
      const keyA = TcvnCitationFormatterService.getVietnameseSortKey(
        itemA.author?.[0],
      );
      const keyB = TcvnCitationFormatterService.getVietnameseSortKey(
        itemB.author?.[0],
      );
      const cmp = keyA.primary.localeCompare(keyB.primary, 'vi', {
        sensitivity: 'base',
      });
      return cmp !== 0
        ? cmp
        : keyA.secondary.localeCompare(keyB.secondary, 'vi', {
            sensitivity: 'base',
          });
    }

    const famA =
      itemA.author?.[0]?.family ||
      itemA.author?.[0]?.literal ||
      itemA.title ||
      '';
    const famB =
      itemB.author?.[0]?.family ||
      itemB.author?.[0]?.literal ||
      itemB.title ||
      '';
    return famA.localeCompare(famB, 'en', { sensitivity: 'base' });
  }

  public static formatTcvnAuthorName(author?: CslName | null): string {
    if (!author) return 'Khuyết danh';
    if (author.literal) return this.stripAcademicDegrees(author.literal);

    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');

    if (TcvnCitationFormatterService.isVietnameseAuthor(author)) {
      return `${cleanFamily} ${cleanGiven}`.trim() || 'Khuyết danh';
    }
    if (cleanGiven) {
      const initials = cleanGiven
        .split(/\s+/)
        .filter(Boolean)
        .map((p: string) => p[0] + '.')
        .join(' ');
      return `${cleanFamily}, ${initials}`.trim();
    }
    return cleanFamily || 'Anonymous';
  }

  public static formatTcvnInTextAuthor(author?: CslName | null): string {
    if (!author) return 'Khuyết danh';
    if (author.literal) return this.stripAcademicDegrees(author.literal);

    const cleanFamily = this.stripAcademicDegrees(author.family || '');
    const cleanGiven = this.stripAcademicDegrees(author.given || '');

    if (TcvnCitationFormatterService.isVietnameseAuthor(author)) {
      return `${cleanFamily} ${cleanGiven}`.trim() || 'Khuyết danh';
    }
    return cleanFamily || 'Anonymous';
  }

  public formatTcvn(
    cslItem: CslItemData,
    isNumeric: boolean = false,
    index: number = 1,
  ): EngineCitationResult {
    const authors = cslItem.author || [];
    const formattedAuthors = authors.map((a: CslName) =>
      TcvnCitationFormatterService.formatTcvnAuthorName(a),
    );

    const authorStr =
      formattedAuthors.length === 0
        ? 'Khuyết danh'
        : formattedAuthors.length === 1
          ? formattedAuthors[0]
          : formattedAuthors.length === 2
            ? `${formattedAuthors[0]} và ${formattedAuthors[1]}`
            : formattedAuthors.length === 3
              ? `${formattedAuthors[0]}, ${formattedAuthors[1]} và ${formattedAuthors[2]}`
              : `${formattedAuthors.slice(0, 3).join(', ')} và c.s.`;

    const year = cslItem.issued?.['date-parts']?.[0]?.[0] || 'không ngày';
    const title = cslItem.title || 'Không có tiêu đề';
    const journal = cslItem['container-title'] || '';
    const volume = cslItem.volume ? `tập ${cslItem.volume}` : '';
    const issue = cslItem.issue ? `(${cslItem.issue})` : '';
    const page = cslItem.page ? `tr. ${cslItem.page}` : '';
    const publisher = cslItem.publisher || '';
    const place = cslItem['publisher-place'] || '';
    const url = cslItem.URL || '';
    const doi = cslItem.DOI ? `DOI: ${cslItem.DOI}` : '';

    let accessedDateStr = '';
    const accessedParts = cslItem.accessed?.['date-parts']?.[0];
    if (accessedParts && accessedParts.length >= 1) {
      const accYear = accessedParts[0];
      const accMonth = accessedParts[1]
        ? String(accessedParts[1]).padStart(2, '0')
        : '01';
      const accDay = accessedParts[2]
        ? String(accessedParts[2]).padStart(2, '0')
        : '01';
      accessedDateStr =
        accessedParts.length >= 3
          ? `${accDay}/${accMonth}/${accYear}`
          : accessedParts.length === 2
            ? `${accMonth}/${accYear}`
            : `${accYear}`;
    }

    let inText = '';
    if (isNumeric) {
      inText = `[${index}]`;
    } else {
      const inTextAuthors = authors.map((a: CslName) =>
        TcvnCitationFormatterService.formatTcvnInTextAuthor(a),
      );
      inText =
        inTextAuthors.length === 0
          ? `(Khuyết danh, ${year})`
          : inTextAuthors.length === 1
            ? `(${inTextAuthors[0]}, ${year})`
            : inTextAuthors.length === 2
              ? `(${inTextAuthors[0]} và ${inTextAuthors[1]}, ${year})`
              : `(${inTextAuthors[0]} và c.s., ${year})`;
    }

    let details = '';
    let detailsHtml = '';
    const type = cslItem.type || 'article-journal';

    if (
      type === 'article-journal' ||
      type === 'article-magazine' ||
      type === 'article'
    ) {
      const volIssueParts = [volume ? `${volume}${issue}` : issue, page, doi]
        .filter(Boolean)
        .join(', ');
      const journalPart = [journal, volIssueParts].filter(Boolean).join(', ');
      details = `"${title}"${journalPart ? `, ${journalPart}` : ''}.`;
      detailsHtml = `"${escapeCitationHtml(title)}"${journal ? `, <i>${escapeCitationHtml(journal)}</i>` : ''}${volIssueParts ? `, ${escapeCitationHtml(volIssueParts)}` : ''}.`;
    } else if (type === 'chapter' || type === 'bookSection') {
      const tailParts = [publisher, place, page, doi]
        .filter(Boolean)
        .join(', ');
      const inContainer = journal
        ? `Trong: ${journal}`
        : 'Trong: Sách chuyên khảo';
      const inContainerHtml = journal
        ? `Trong: <i>${escapeCitationHtml(journal)}</i>`
        : 'Trong: <i>Sách chuyên khảo</i>';
      details = `"${title}", ${inContainer}${tailParts ? `, ${tailParts}` : ''}.`;
      detailsHtml = `"${escapeCitationHtml(title)}", ${inContainerHtml}${tailParts ? `, ${escapeCitationHtml(tailParts)}` : ''}.`;
    } else if (type === 'book') {
      const pubParts = [publisher, place, page, doi].filter(Boolean).join(', ');
      details = `${title}${pubParts ? `, ${pubParts}` : ''}.`;
      detailsHtml = `<i>${escapeCitationHtml(title)}</i>${pubParts ? `, ${escapeCitationHtml(pubParts)}` : ''}.`;
    } else if (type === 'paper-conference') {
      const confTail = [place, publisher, page, doi].filter(Boolean).join(', ');
      details = `"${title}", Kỷ yếu ${journal || 'Hội nghị Khoa học'}${confTail ? `, ${confTail}` : ''}.`;
      detailsHtml = `"${escapeCitationHtml(title)}", <i>Kỷ yếu ${escapeCitationHtml(journal || 'Hội nghị Khoa học')}</i>${confTail ? `, ${escapeCitationHtml(confTail)}` : ''}.`;
    } else if (type === 'thesis') {
      const genre = cslItem.genre || 'Luận án tiến sĩ';
      const thesisTail = [publisher, place].filter(Boolean).join(', ');
      details = `${title}, ${genre}${thesisTail ? `, ${thesisTail}` : ''}.`;
      detailsHtml = `<i>${escapeCitationHtml(title)}</i>, ${escapeCitationHtml(genre)}${thesisTail ? `, ${escapeCitationHtml(thesisTail)}` : ''}.`;
    } else {
      const accessClause = accessedDateStr
        ? `, truy cập ngày ${accessedDateStr}`
        : '';
      const urlClause = url
        ? accessedDateStr
          ? `, tại <${url}>`
          : `, <${url}>`
        : '';
      const urlClauseHtml = url
        ? accessedDateStr
          ? `, tại &lt;${escapeCitationHtml(url)}&gt;`
          : `, &lt;${escapeCitationHtml(url)}&gt;`
        : '';
      details = `"${title}"${journal ? `, ${journal}` : ''}${publisher ? `, ${publisher}` : ''}${accessClause}${urlClause}.`;
      detailsHtml = `"${escapeCitationHtml(title)}"${journal ? `, <i>${escapeCitationHtml(journal)}</i>` : ''}${publisher ? `, ${escapeCitationHtml(publisher)}` : ''}${escapeCitationHtml(accessClause)}${urlClauseHtml}.`;
    }

    const prefix = isNumeric ? `[${index}] ` : '';
    return {
      styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
      inText,
      bibliography: `${prefix}${authorStr} (${year}), ${details}`.trim(),
      bibliographyHtml:
        `${prefix}${escapeCitationHtml(authorStr)} (${year}), ${detailsHtml}`.trim(),
      source: 'csl-engine',
    };
  }

  public formatTcvnBatch(cslItems: CslItemData[], isNumeric: boolean = false) {
    if (cslItems.length === 0) {
      return {
        styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
        combinedInText: '',
        citations: [],
        bibliographyText: '',
        bibliographyHtml: '',
      };
    }

    const sorted = [...cslItems].sort((a, b) =>
      TcvnCitationFormatterService.compareTcvnEntries(a, b),
    );
    const citations = sorted.map((item, idx) => {
      const single = this.formatTcvn(item, isNumeric, idx + 1);
      return {
        id: item.id,
        inText: single.inText,
        bibliography: single.bibliography,
        bibliographyHtml: single.bibliographyHtml,
      };
    });

    const combinedInText = isNumeric
      ? `[${citations.map((_, i) => i + 1).join(', ')}]`
      : `(${citations
          .map((c) => c.inText.replace(/^\(|\)$/g, ''))
          .filter(Boolean)
          .join('; ')})`;

    return {
      styleId: isNumeric ? 'tcvn-numeric' : 'tcvn',
      combinedInText,
      citations,
      bibliographyText: citations.map((c) => c.bibliography).join('\n\n'),
      bibliographyHtml: citations
        .map((c) => `<div class="csl-entry">${c.bibliographyHtml}</div>`)
        .join('\n'),
    };
  }
}
