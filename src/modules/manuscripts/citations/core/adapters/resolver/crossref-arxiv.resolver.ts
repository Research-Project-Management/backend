/**
 * citations/core/adapters/resolver/crossref-arxiv.resolver.ts
 * Adapter resolving DOI and arXiv identifiers via public academic APIs
 * (CrossRef Content Negotiation & arXiv Atom Export API).
 */

import { IIdentifierResolverPort } from '../../ports/identifier-resolver.port';
import { AcademicIdentifierVo } from '../../domain/value-objects/academic-identifier.vo';
import { BibEntry } from '../../domain/entities/bib-entry.entity';
import { RegexAstBibtexParser } from '../parser/regex-ast-bibtex.parser';

export class CrossrefArxivResolverAdapter implements IIdentifierResolverPort {
  private readonly parser = new RegexAstBibtexParser();

  public async resolve(identifier: AcademicIdentifierVo): Promise<BibEntry | null> {
    if (identifier.isDoi()) {
      return this.resolveDoi(identifier.clean);
    }

    if (identifier.isArxiv()) {
      return this.resolveArxiv(identifier.clean);
    }

    return null;
  }

  /**
   * Resolves DOI via CrossRef Content Negotiation or REST API.
   */
  private async resolveDoi(cleanDoi: string): Promise<BibEntry | null> {
    try {
      // 1. Try CrossRef Content Negotiation (returns formatted BibTeX directly)
      const res = await fetch(`https://doi.org/${encodeURIComponent(cleanDoi)}`, {
        headers: {
          Accept: 'application/x-bibtex; charset=utf-8',
          'User-Agent': 'FluxManuscripts/1.0 (mailto:support@flux.local)',
        },
      });

      if (res.ok) {
        const bibText = await res.text();
        const entries = this.parser.parse(bibText);
        if (entries.length > 0 && entries[0]) {
          return entries[0];
        }
      }
    } catch {
      // Network failure or offline
    }

    // 2. Fallback: Query CrossRef REST API for JSON metadata
    try {
      const jsonRes = await fetch(
        `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`,
        {
          headers: { 'User-Agent': 'FluxManuscripts/1.0' },
        }
      );

      if (jsonRes.ok) {
        const data = await jsonRes.json();
        const item = data.message;
        if (item) {
          const title = item.title?.[0] || 'Untitled Document';
          const year =
            item['published-print']?.['date-parts']?.[0]?.[0] ||
            item['published-online']?.['date-parts']?.[0]?.[0] ||
            item.published?.['date-parts']?.[0]?.[0] ||
            item.created?.['date-parts']?.[0]?.[0] ||
            new Date().getFullYear().toString();

          const authors = (item.author || [])
            .map((a: any) => `${a.given || ''} ${a.family || ''}`.trim())
            .filter(Boolean)
            .join(' and ');

          const firstAuthorLast = item.author?.[0]?.family?.toLowerCase() || 'author';
          const key = `${firstAuthorLast}${year}${title.slice(0, 8).replace(/\s+/g, '').toLowerCase()}`;

          return new BibEntry({
            key,
            entryType: 'article',
            fields: {
              title,
              author: authors || 'Unknown Author',
              year: year.toString(),
              doi: cleanDoi,
              journal: item['container-title']?.[0] || item.publisher || '',
            },
          });
        }
      }
    } catch {
      // Fallback
    }

    return null;
  }

  /**
   * Resolves arXiv ID via arXiv export API.
   */
  private async resolveArxiv(cleanArxivId: string): Promise<BibEntry | null> {
    try {
      const res = await fetch(
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanArxivId)}`
      );

      if (res.ok) {
        const xmlText = await res.text();
        const entryMatch = xmlText.match(/<entry>([\s\S]*?)<\/entry>/i);
        if (entryMatch && entryMatch[1]) {
          const entryXml = entryMatch[1];

          const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/i);
          const title = titleMatch ? titleMatch[1]!.replace(/\s+/g, ' ').trim() : 'arXiv Preprint';

          const publishedMatch = entryXml.match(/<published>(\d{4})/i);
          const year = publishedMatch ? publishedMatch[1]! : new Date().getFullYear().toString();

          const authors: string[] = [];
          const authorRegex = /<author>\s*<name>([^<]+)<\/name>/gi;
          let aMatch: RegExpExecArray | null;
          while ((aMatch = authorRegex.exec(entryXml)) !== null) {
            if (aMatch[1]) authors.push(aMatch[1].trim());
          }

          const firstLastName = authors[0]?.split(' ').pop()?.toLowerCase() || 'arxiv';
          const key = `${firstLastName}${year}${cleanArxivId.replace(/[^0-9]/g, '').slice(0, 6)}`;

          return new BibEntry({
            key,
            entryType: 'article',
            fields: {
              title,
              author: authors.join(' and ') || 'Unknown Author',
              year,
              eprint: cleanArxivId,
              archiveprefix: 'arXiv',
              primaryclass: 'cs.AI',
              journal: `arXiv preprint arXiv:${cleanArxivId}`,
            },
          });
        }
      }
    } catch {
      // Network failure
    }

    return null;
  }
}
