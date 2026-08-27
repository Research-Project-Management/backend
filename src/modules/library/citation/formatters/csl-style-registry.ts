import {
  CitationStyleId,
  CitationItemInput,
  FormattedCitationResult,
  CitationCreator,
} from '../types/citation.types';

export interface CitationStyleDefinition {
  id: CitationStyleId;
  name: string;
  category: 'author-date' | 'numeric' | 'label' | 'raw';
  format(item: CitationItemInput, index?: number): FormattedCitationResult;
}

export class CslStyleRegistry {
  private readonly styles = new Map<CitationStyleId, CitationStyleDefinition>();

  constructor() {
    this.registerDefaults();
  }

  private parseAuthors(item: CitationItemInput): CitationCreator[] {
    if (item.creators && item.creators.length > 0) {
      return item.creators;
    }
    if (item.authors && item.authors.length > 0) {
      return item.authors.map((a) => {
        const parts = a.trim().split(/\s+/);
        if (parts.length === 1) return { lastName: parts[0] };
        const lastName = parts.pop();
        const firstName = parts.join(' ');
        return { firstName, lastName };
      });
    }
    return [{ lastName: 'Anonymous' }];
  }

  private registerDefaults() {
    // 1. APA 7th Edition
    this.styles.set('apa-7th', {
      id: 'apa-7th',
      name: 'American Psychological Association 7th edition',
      category: 'author-date',
      format: (item: CitationItemInput) => {
        const authors = this.parseAuthors(item);
        const year =
          item.year || (item.date ? new Date(item.date).getFullYear() : 'n.d.');

        // In-text citation
        let inText = '';
        if (authors.length === 1) {
          inText = `(${authors[0].lastName || 'Anonymous'}, ${year})`;
        } else if (authors.length === 2) {
          inText = `(${authors[0].lastName} & ${authors[1].lastName}, ${year})`;
        } else {
          inText = `(${authors[0].lastName} et al., ${year})`;
        }

        // Bibliography formatting
        let authorStr = '';
        if (authors.length === 1) {
          const init = authors[0].firstName
            ? ` ${authors[0].firstName[0]}.`
            : '';
          authorStr = `${authors[0].lastName},${init}`;
        } else if (authors.length === 2) {
          const a1 = `${authors[0].lastName}, ${authors[0].firstName?.[0] || ''}.`;
          const a2 = `${authors[1].lastName}, ${authors[1].firstName?.[0] || ''}.`;
          authorStr = `${a1}, & ${a2}`;
        } else if (authors.length <= 20) {
          const list = authors.map(
            (a) => `${a.lastName}, ${a.firstName?.[0] || ''}.`,
          );
          const last = list.pop();
          authorStr = `${list.join(', ')}, & ${last}`;
        } else {
          const list = authors
            .slice(0, 19)
            .map((a) => `${a.lastName}, ${a.firstName?.[0] || ''}.`);
          const last = authors[authors.length - 1];
          authorStr = `${list.join(', ')}, ... ${last.lastName}, ${last.firstName?.[0] || ''}.`;
        }

        const title = item.title.endsWith('.') ? item.title : `${item.title}.`;
        const pubTitle =
          item.publicationTitle || item.journal || item.publisher || '';
        const volumeStr = item.volume ? `, ${item.volume}` : '';
        const doiStr = item.doi ? ` https://doi.org/${item.doi}` : '';

        const pubSection = pubTitle ? ` ${pubTitle}${volumeStr}.` : '';
        const bibliography =
          `${authorStr} (${year}). ${title}${pubSection}${doiStr}`.trim();

        return { styleId: 'apa-7th', inText, bibliography };
      },
    });

    // 2. IEEE
    this.styles.set('ieee', {
      id: 'ieee',
      name: 'IEEE Standard',
      category: 'numeric',
      format: (item: CitationItemInput, index: number = 1) => {
        const authors = this.parseAuthors(item);
        const year =
          item.year || (item.date ? new Date(item.date).getFullYear() : 'n.d.');
        const inText = `[${index}]`;

        const authorList = authors.map((a) => {
          const init = a.firstName ? `${a.firstName[0]}. ` : '';
          return `${init}${a.lastName}`;
        });

        let authorStr = '';
        if (authorList.length === 1) authorStr = authorList[0];
        else if (authorList.length === 2)
          authorStr = `${authorList[0]} and ${authorList[1]}`;
        else if (authorList.length <= 6) {
          const last = authorList.pop();
          authorStr = `${authorList.join(', ')}, and ${last}`;
        } else {
          authorStr = `${authorList[0]} et al.`;
        }

        const pubTitle =
          item.publicationTitle || item.journal || item.publisher || '';
        const pages = item.pages ? `, pp. ${item.pages}` : '';
        const doi = item.doi ? `, doi: ${item.doi}` : '';

        const bibliography =
          `${authorStr}, "${item.title}," ${pubTitle}${pages}, ${year}${doi}.`.trim();

        return { styleId: 'ieee', inText, bibliography };
      },
    });

    // 3. Nature
    this.styles.set('nature', {
      id: 'nature',
      name: 'Nature',
      category: 'numeric',
      format: (item: CitationItemInput, index: number = 1) => {
        const authors = this.parseAuthors(item);
        const year =
          item.year || (item.date ? new Date(item.date).getFullYear() : 'n.d.');
        const inText = `${index}`;

        const authorList = authors.map((a) => {
          const init = a.firstName ? ` ${a.firstName[0]}.` : '';
          return `${a.lastName},${init}`;
        });

        let authorStr = '';
        if (authorList.length <= 5) {
          if (authorList.length === 1) authorStr = authorList[0];
          else {
            const last = authorList.pop();
            authorStr = `${authorList.join(', ')} & ${last}`;
          }
        } else {
          authorStr = `${authorList[0]} et al.`;
        }

        const pubTitle = item.publicationTitle || item.journal || '';
        const vol = item.volume ? ` ${item.volume}` : '';
        const pages = item.pages ? `, ${item.pages}` : '';

        const bibliography =
          `${authorStr} ${item.title}. ${pubTitle}${vol}${pages} (${year}).`.trim();

        return { styleId: 'nature', inText, bibliography };
      },
    });

    // 4. BibTeX
    this.styles.set('bibtex', {
      id: 'bibtex',
      name: 'BibTeX',
      category: 'raw',
      format: (item: CitationItemInput) => {
        const authors = this.parseAuthors(item);
        const key = item.citationKey || `ref_${item.id || Date.now()}`;
        const authorStr = authors
          .map((a) => `${a.lastName || ''}, ${a.firstName || ''}`.trim())
          .join(' and ');

        const typeMap: Record<string, string> = {
          journalArticle: 'article',
          conferencePaper: 'inproceedings',
          book: 'book',
          report: 'techreport',
        };
        const entryType = typeMap[item.itemType] || 'misc';

        const lines = [`@${entryType}{${key},`];
        lines.push(`  title = {${item.title}},`);
        if (authorStr) lines.push(`  author = {${authorStr}},`);
        if (item.publicationTitle || item.journal) {
          lines.push(`  journal = {${item.publicationTitle || item.journal}},`);
        }
        if (item.year) lines.push(`  year = {${item.year}},`);
        if (item.volume) lines.push(`  volume = {${item.volume}},`);
        if (item.pages) lines.push(`  pages = {${item.pages}},`);
        if (item.doi) lines.push(`  doi = {${item.doi}},`);
        if (item.url) lines.push(`  url = {${item.url}},`);
        lines.push('}');

        const bib = lines.join('\n');
        return {
          styleId: 'bibtex',
          inText: `\\cite{${key}}`,
          bibliography: bib,
        };
      },
    });

    // 5. RIS
    this.styles.set('ris', {
      id: 'ris',
      name: 'Research Information Systems (RIS)',
      category: 'raw',
      format: (item: CitationItemInput) => {
        const authors = this.parseAuthors(item);
        const typeMap: Record<string, string> = {
          journalArticle: 'JOUR',
          conferencePaper: 'CONF',
          book: 'BOOK',
          report: 'RPRT',
        };
        const risType = typeMap[item.itemType] || 'GEN';

        const lines = [`TY  - ${risType}`];
        lines.push(`TI  - ${item.title}`);
        authors.forEach((a) => {
          lines.push(`AU  - ${a.lastName || ''}, ${a.firstName || ''}`);
        });
        if (item.publicationTitle || item.journal) {
          lines.push(`T2  - ${item.publicationTitle || item.journal}`);
        }
        if (item.year) lines.push(`PY  - ${item.year}`);
        if (item.volume) lines.push(`VL  - ${item.volume}`);
        if (item.pages) lines.push(`SP  - ${item.pages}`);
        if (item.doi) lines.push(`DO  - ${item.doi}`);
        if (item.url) lines.push(`UR  - ${item.url}`);
        lines.push('ER  - \n');

        const ris = lines.join('\n');
        return { styleId: 'ris', inText: item.title, bibliography: ris };
      },
    });
  }

  getStyle(styleId: CitationStyleId): CitationStyleDefinition | undefined {
    return this.styles.get(styleId);
  }

  listStyles(): Array<{ id: CitationStyleId; name: string; category: string }> {
    return Array.from(this.styles.values()).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
    }));
  }
}
