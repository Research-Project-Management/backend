import { Injectable, Logger } from '@nestjs/common';
import {
  ItemMetadata,
  CreatorInput,
} from '@/modules/library/ingestion/types/metadata.types';
import {
  cleanAbstractText,
  normalizeDoi,
  normalizeArxivId,
  normalizePmid,
  normalizePmcid,
  normalizeIsbn,
  normalizeIssn,
  parseCreatorString,
} from '@/modules/library/core';
import { normalizeAcademicTags } from '@/modules/library/core/domain/tag.domain';

export type LegacyRecordFormat =
  | 'ENDNOTE_XML'
  | 'MODS'
  | 'ZOTERO_RDF'
  | 'MEDLINE'
  | 'CSV';

function decodeXmlEntities(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '$1')
    .replace(/<\/?[a-zA-Z0-9:_-]+(?:\s+[^>]*)?>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstTagText(xml: string, tagPattern: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})>`,
    'i',
  );
  const match = xml.match(re);
  if (!match || !match[1]) return undefined;
  const cleaned = decodeXmlEntities(match[1]);
  return cleaned || undefined;
}

function extractAllTagTexts(xml: string, tagPattern: string): string[] {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})>`,
    'gi',
  );
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const cleaned = decodeXmlEntities(match[1] || '');
    if (cleaned) results.push(cleaned);
  }
  return results;
}

function extractYearFromDate(raw?: string): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/\b(1[7-9]\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : undefined;
}

function mapEndnoteRefType(rawName?: string, rawNum?: string): string {
  const name = (rawName || '').toLowerCase().trim();
  const num = Number(rawNum || 0);
  if (name.includes('book section') || num === 5) return 'bookSection';
  if (name.includes('edited book') || name === 'book' || num === 6 || num === 28)
    return 'book';
  if (name.includes('conference') || name.includes('proceeding') || num === 10 || num === 47)
    return 'conferencePaper';
  if (name.includes('thesis') || name.includes('dissertation') || num === 32)
    return 'thesis';
  if (name.includes('report') || num === 27) return 'report';
  if (name.includes('web') || name.includes('blog') || num === 12) return 'webpage';
  if (name.includes('patent') || num === 25) return 'patent';
  if (name.includes('newspaper') || num === 23) return 'newspaperArticle';
  if (name.includes('magazine') || num === 19) return 'magazineArticle';
  if (name.includes('computer') || name.includes('software') || num === 9)
    return 'computerProgram';
  if (name.includes('dataset') || num === 59) return 'dataset';
  if (name.includes('preprint') || name.includes('unpublished') || num === 34)
    return 'preprint';
  return 'journalArticle';
}

@Injectable()
export class XmlLegacyFormatsParser {
  private readonly logger = new Logger(XmlLegacyFormatsParser.name);

  detectFormat(content: string, hintFormat?: string): LegacyRecordFormat | null {
    const trimmed = (content || '').trim();
    const upperHint = (hintFormat || '').toUpperCase().trim();

    if (upperHint === 'ENDNOTE_XML') {
      if (/<mods[\s>:]/i.test(trimmed)) return 'MODS';
      if (/<rdf:RDF[\s>]/i.test(trimmed)) return 'ZOTERO_RDF';
      return 'ENDNOTE_XML';
    }
    if (upperHint === 'MODS') return 'MODS';
    if (upperHint === 'ZOTERO_RDF' || upperHint === 'RDF') return 'ZOTERO_RDF';
    if (upperHint === 'MEDLINE' || upperHint === 'NBIB') return 'MEDLINE';
    if (upperHint === 'CSV') return 'CSV';

    if (/<records[\s>]/i.test(trimmed) || /<ref-type[\s>]/i.test(trimmed)) {
      return 'ENDNOTE_XML';
    }
    if (/<(?:mods:)?mods(?:Collection)?[\s>]/i.test(trimmed)) {
      return 'MODS';
    }
    if (/<rdf:RDF[\s>]/i.test(trimmed) || /xmlns:bib=/i.test(trimmed)) {
      return 'ZOTERO_RDF';
    }
    if (/^(?:PMID|TI|AU|FAU|DP|JT|LID|SO)\s*-\s+/m.test(trimmed)) {
      return 'MEDLINE';
    }
    if (
      /^"?(?:Item Type|Title|Author|Authors|Publication Title|DOI|Year|Publication Year)"?\s*,/i.test(
        trimmed,
      )
    ) {
      return 'CSV';
    }
    return null;
  }

  parse(content: string, formatHint?: string): ItemMetadata[] {
    if (!content || typeof content !== 'string' || !content.trim()) {
      return [];
    }
    const detected =
      this.detectFormat(content, formatHint) ||
      ((formatHint || '').toUpperCase() as LegacyRecordFormat);

    switch (detected) {
      case 'ENDNOTE_XML':
        return this.parseEndnoteXml(content);
      case 'MODS':
        return this.parseModsXml(content);
      case 'ZOTERO_RDF':
        return this.parseZoteroRdf(content);
      case 'MEDLINE':
        return this.parseMedlineNbib(content);
      case 'CSV':
        return this.parseCsvBibliography(content);
      default:
        return [];
    }
  }

  /**
   * 1. EndNote XML (<xml><records><record>...</record></records></xml>)
   */
  parseEndnoteXml(content: string): ItemMetadata[] {
    const items: ItemMetadata[] = [];
    const recordRe = /<record(?:\s+[^>]*)?>([\s\S]*?)<\/record>/gi;
    let match: RegExpExecArray | null;

    while ((match = recordRe.exec(content)) !== null) {
      const rec = match[1] || '';
      const refTypeMatch = rec.match(
        /<ref-type(?:\s+name="([^"]*)")?[^>]*>(\d+)?<\/ref-type>/i,
      );
      const itemType = mapEndnoteRefType(refTypeMatch?.[1], refTypeMatch?.[2]);

      const titlesBlock = extractFirstTagText(rec, 'titles') ? rec : rec;
      const titlesMatch = rec.match(/<titles>([\s\S]*?)<\/titles>/i);
      const titlesXml = titlesMatch?.[1] || rec;
      const title =
        extractFirstTagText(titlesXml, 'title') || 'Untitled Record';
      const secondaryTitle = extractFirstTagText(titlesXml, 'secondary-title');
      const shortTitle = extractFirstTagText(titlesXml, 'short-title');

      const periodicalMatch = rec.match(/<periodical>([\s\S]*?)<\/periodical>/i);
      const periodicalTitle = periodicalMatch?.[1]
        ? extractFirstTagText(periodicalMatch[1], 'full-title')
        : undefined;
      const journalAbbr = periodicalMatch?.[1]
        ? extractFirstTagText(periodicalMatch[1], 'abbr-1')
        : undefined;

      const authorsMatch = rec.match(/<authors>([\s\S]*?)<\/authors>/i);
      const rawAuthors = authorsMatch?.[1]
        ? extractAllTagTexts(authorsMatch[1], 'author')
        : extractAllTagTexts(titlesBlock, 'author');

      const secAuthorsMatch = rec.match(
        /<secondary-authors>([\s\S]*?)<\/secondary-authors>/i,
      );
      const rawEditors = secAuthorsMatch?.[1]
        ? extractAllTagTexts(secAuthorsMatch[1], 'author')
        : [];

      const creators: CreatorInput[] = [
        ...rawAuthors.map((a, idx) => parseCreatorString(a, idx, 'author')),
        ...rawEditors.map((e, idx) =>
          parseCreatorString(e, rawAuthors.length + idx, 'editor'),
        ),
      ];

      const yearStr = extractFirstTagText(rec, 'year');
      const dateStr = extractFirstTagText(rec, 'date') || yearStr;
      const year = extractYearFromDate(yearStr || dateStr);

      const volume = extractFirstTagText(rec, 'volume');
      const issue =
        extractFirstTagText(rec, 'number') || extractFirstTagText(rec, 'issue');
      const pages = extractFirstTagText(rec, 'pages');
      const publisher = extractFirstTagText(rec, 'publisher');
      const place = extractFirstTagText(rec, 'pub-location');
      const rawDoi = extractFirstTagText(rec, 'electronic-resource-num');
      const doi = rawDoi ? normalizeDoi(rawDoi) || rawDoi : undefined;
      const rawIsbn = extractFirstTagText(rec, 'isbn');
      const isbn = rawIsbn ? normalizeIsbn(rawIsbn) || undefined : undefined;
      const rawIssn = rawIsbn ? normalizeIssn(rawIsbn) || undefined : undefined;
      const abstract = cleanAbstractText(extractFirstTagText(rec, 'abstract'));
      const callNumber = extractFirstTagText(rec, 'call-num');
      const language = extractFirstTagText(rec, 'language');
      const notesText = extractFirstTagText(rec, 'notes');

      const kwMatch = rec.match(/<keywords>([\s\S]*?)<\/keywords>/i);
      const keywords = normalizeAcademicTags(
        kwMatch?.[1] ? extractAllTagTexts(kwMatch[1], 'keyword') : [],
      );

      const urls = extractAllTagTexts(rec, 'url').filter((u) =>
        /^https?:\/\//i.test(u),
      );
      const pdfUrl = urls.find((u) => /\.pdf(?:$|\?)/i.test(u));
      const url = urls.find((u) => u !== pdfUrl) || urls[0];

      const pubTitle = periodicalTitle || secondaryTitle;

      items.push({
        title, itemType, authors: rawAuthors,
        editors: rawEditors.length > 0 ? rawEditors : undefined,
        creators, year, publicationDate: dateStr,
        publicationTitle: pubTitle,
        journal: itemType === 'journalArticle' ? pubTitle : undefined,
        journalAbbr, shortTitle, volume, issue, pages, publisher, place,
        doi, isbn, issn: !isbn ? rawIssn : undefined, url,
        openAccessPdfUrl: pdfUrl, abstract: abstract || undefined,
        keywords, tags: keywords, callNumber, language,
        notes: notesText ? [{ content: notesText, source: 'endnote_xml' }] : undefined,
      });
    }

    return items;
  }

  /**
   * 2. MODS XML (Metadata Object Description Schema v3)
   */
  parseModsXml(content: string): ItemMetadata[] {
    const items: ItemMetadata[] = [];
    const modsRe =
      /<(?:[a-zA-Z0-9_-]+:)?mods(?:\s+[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?mods>/gi;
    let match: RegExpExecArray | null;

    while ((match = modsRe.exec(content)) !== null) {
      const block = match[1] || '';
      const hostMatch = block.match(
        /<(?:[a-zA-Z0-9_-]+:)?relatedItem[^>]*type=["']host["'][^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?relatedItem>/i,
      );
      const hostXml = hostMatch?.[1] || '';
      const mainXml = hostMatch ? block.replace(hostMatch[0], '') : block;
      const titleInfoMatch = mainXml.match(
        /<(?:[a-zA-Z0-9_-]+:)?titleInfo(?:\s+[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?titleInfo>/i,
      );
      const titleXml = titleInfoMatch?.[1] || mainXml;
      const baseTitle = extractFirstTagText(titleXml, 'title') || 'Untitled Record';
      const subTitle = extractFirstTagText(titleXml, 'subTitle');
      const title = subTitle ? `${baseTitle}: ${subTitle}` : baseTitle;
      const hostTitle = hostXml ? extractFirstTagText(hostXml, 'title') : undefined;

      const creators: CreatorInput[] = [];
      const authors: string[] = [];
      const nameRe =
        /<(?:[a-zA-Z0-9_-]+:)?name(?:\s+[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?name>/gi;
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = nameRe.exec(mainXml)) !== null) {
        const nXml = nameMatch[1] || '';
        const family = nXml.match(
          /<(?:[a-zA-Z0-9_-]+:)?namePart[^>]*type=["']family["'][^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?namePart>/i,
        )?.[1];
        const given = nXml.match(
          /<(?:[a-zA-Z0-9_-]+:)?namePart[^>]*type=["']given["'][^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?namePart>/i,
        )?.[1];
        const roleTerm = extractFirstTagText(nXml, 'roleTerm')?.toLowerCase() || '';
        const role =
          roleTerm.includes('edt') || roleTerm.includes('editor') ? 'editor' : 'author';

        if (family || given) {
          const cleanFam = decodeXmlEntities(family || '');
          const cleanGiv = decodeXmlEntities(given || '');
          const full = [cleanGiv, cleanFam].filter(Boolean).join(' ');
          creators.push({ firstName: cleanGiv, lastName: cleanFam, fullName: full, name: full, creatorType: role });
          if (role === 'author' && full) authors.push(full);
        } else {
          const literal = extractFirstTagText(nXml, 'namePart');
          if (literal) {
            creators.push(parseCreatorString(literal, creators.length, role));
            if (role === 'author') authors.push(literal);
          }
        }
      }

      const dateStr = extractFirstTagText(block, 'dateIssued') || extractFirstTagText(block, 'dateCreated');
      const year = extractYearFromDate(dateStr);
      const publisher = extractFirstTagText(block, 'publisher');
      const place = extractFirstTagText(block, 'placeTerm');
      const abstract = cleanAbstractText(extractFirstTagText(block, 'abstract'));
      const url = extractFirstTagText(block, 'url');
      const genres = extractAllTagTexts(block, 'genre').map((g) => g.toLowerCase());

      let itemType = 'journalArticle';
      if (genres.some((g) => g.includes('thesis') || g.includes('dissertation'))) itemType = 'thesis';
      else if (genres.some((g) => g.includes('conference'))) itemType = 'conferencePaper';
      else if (genres.some((g) => g.includes('book')) && !hostTitle) itemType = 'book';
      else if (genres.some((g) => g.includes('report'))) itemType = 'report';

      const volume = block.match(/<(?:[a-zA-Z0-9_-]+:)?detail[^>]*type=["']volume["'][^>]*>[\s\S]*?<(?:[a-zA-Z0-9_-]+:)?number>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?number>/i)?.[1]?.trim();
      const issue = block.match(/<(?:[a-zA-Z0-9_-]+:)?detail[^>]*type=["']issue["'][^>]*>[\s\S]*?<(?:[a-zA-Z0-9_-]+:)?number>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?number>/i)?.[1]?.trim();
      const startPage = extractFirstTagText(block, 'start');
      const endPage = extractFirstTagText(block, 'end');
      const pages = startPage && endPage ? `${startPage}-${endPage}` : startPage || extractFirstTagText(block, 'list');

      let doi: string | undefined;
      let isbn: string | undefined;
      let issn: string | undefined;
      let pmid: string | undefined;
      const idRe = /<(?:[a-zA-Z0-9_-]+:)?identifier(?:\s+type=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?identifier>/gi;
      let idMatch: RegExpExecArray | null;
      while ((idMatch = idRe.exec(block)) !== null) {
        const idType = (idMatch[1] || '').toLowerCase();
        const idVal = decodeXmlEntities(idMatch[2] || '');
        if (!idVal) continue;
        if (idType === 'doi' || /^10\.\d{4,9}\//.test(idVal)) doi = normalizeDoi(idVal) || idVal;
        else if (idType === 'isbn') isbn = normalizeIsbn(idVal) || idVal;
        else if (idType === 'issn') issn = normalizeIssn(idVal) || idVal;
        else if (idType === 'pmid') pmid = normalizePmid(idVal) || idVal;
      }

      const topics = normalizeAcademicTags(extractAllTagTexts(block, 'topic'));
      const notes = extractAllTagTexts(block, 'note');

      items.push({
        title, itemType, authors, creators, year,
        publicationDate: dateStr, publicationTitle: hostTitle,
        journal: itemType === 'journalArticle' ? hostTitle : undefined,
        publisher, place,
        volume: volume ? decodeXmlEntities(volume) : undefined,
        issue: issue ? decodeXmlEntities(issue) : undefined,
        pages, doi, isbn, issn, pmid, url,
        abstract: abstract || undefined, keywords: topics, tags: topics,
        notes: notes.length > 0 ? notes.map((n) => ({ content: n, source: 'mods' })) : undefined,
      });
    }

    return items;
  }

  /**
   * 3. Zotero RDF / Bibliontology RDF (.rdf)
   */
  parseZoteroRdf(content: string): ItemMetadata[] {
    const items: ItemMetadata[] = [];
    const nodeRe =
      /<(bib:(?:Article|Book|BookSection|Thesis|Report|ConferenceProceedings|Document|Manuscript|Patent)|rdf:Description)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi;
    let match: RegExpExecArray | null;

    while ((match = nodeRe.exec(content)) !== null) {
      const tagName = match[1] || '';
      const body = match[2] || '';
      const zItemType = extractFirstTagText(body, 'itemType');
      if (
        tagName.toLowerCase() === 'rdf:description' &&
        !zItemType &&
        !/<dc:title>/i.test(body)
      ) {
        continue;
      }
      if (zItemType === 'attachment' || zItemType === 'note') continue;

      const title = extractFirstTagText(body, 'title');
      if (!title) continue;

      const itemType =
        zItemType ||
        (tagName.includes('BookSection')
          ? 'bookSection'
          : tagName.includes('Book')
            ? 'book'
            : tagName.includes('Thesis')
              ? 'thesis'
              : tagName.includes('Report')
                ? 'report'
                : tagName.includes('Conference')
                  ? 'conferencePaper'
                  : 'journalArticle');

      const creators: CreatorInput[] = [];
      const authors: string[] = [];
      const personRe =
        /<foaf:Person(?:\s+[^>]*)?>([\s\S]*?)<\/foaf:Person>/gi;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = personRe.exec(body)) !== null) {
        const pXml = pMatch[1] || '';
        const surname = extractFirstTagText(pXml, 'surname') || '';
        const givenname =
          extractFirstTagText(pXml, 'givenname') ||
          extractFirstTagText(pXml, 'givenName') ||
          '';
        const full = [givenname, surname].filter(Boolean).join(' ').trim();
        if (full) {
          creators.push({
            firstName: givenname,
            lastName: surname,
            fullName: full,
            name: full,
            creatorType: 'author',
          });
          authors.push(full);
        }
      }

      const dateStr = extractFirstTagText(body, 'date');
      const year = extractYearFromDate(dateStr);
      const abstract = cleanAbstractText(extractFirstTagText(body, 'abstract'));
      const volume = extractFirstTagText(body, 'volume');
      const issue = extractFirstTagText(body, 'number');
      const pages = extractFirstTagText(body, 'pages');

      const identifiers = extractAllTagTexts(body, 'identifier');
      let doi: string | undefined;
      let isbn: string | undefined;
      let issn: string | undefined;
      let url: string | undefined;
      for (const idStr of identifiers) {
        if (/^doi\s*:?\s*10\./i.test(idStr) || /^10\.\d{4,9}\//.test(idStr)) {
          doi = normalizeDoi(idStr) || undefined;
        } else if (/^isbn/i.test(idStr)) {
          isbn = normalizeIsbn(idStr) || undefined;
        } else if (/^issn/i.test(idStr)) {
          issn = normalizeIssn(idStr) || undefined;
        } else if (/^https?:\/\//i.test(idStr)) {
          url = idStr;
        }
      }

      const isPartOfMatch = body.match(
        /<dcterms:isPartOf(?:\s+[^>]*)?>([\s\S]*?)<\/dcterms:isPartOf>/i,
      );
      const publicationTitle = isPartOfMatch?.[1]
        ? extractFirstTagText(isPartOfMatch[1], 'title')
        : undefined;

      const tags = normalizeAcademicTags(extractAllTagTexts(body, 'subject'));

      items.push({
        title, itemType, authors, creators, year,
        publicationDate: dateStr, publicationTitle,
        journal: itemType === 'journalArticle' ? publicationTitle : undefined,
        volume, issue, pages, doi, isbn, issn, url,
        abstract: abstract || undefined, keywords: tags, tags,
      });
    }

    return items;
  }

  /**
   * 4. PubMed / MEDLINE Tagged Format (.nbib / .txt)
   */
  parseMedlineNbib(content: string): ItemMetadata[] {
    const records = content
      .split(/\r?\n\s*\r?\n+/)
      .filter((chunk) => /^(?:PMID|TI|AU|FAU)\s*-/m.test(chunk));
    const chunks = records.length > 0 ? records : [content];
    const items: ItemMetadata[] = [];

    for (const chunk of chunks) {
      const fields = new Map<string, string[]>();
      let currentKey = '';
      for (const rawLine of chunk.split(/\r?\n/)) {
        const tagMatch = rawLine.match(/^([A-Z]{2,4})\s*-\s*(.*)$/);
        if (tagMatch) {
          currentKey = tagMatch[1].trim();
          const list = fields.get(currentKey) || [];
          list.push(tagMatch[2].trim());
          fields.set(currentKey, list);
        } else if (currentKey && /^\s{2,}\S/.test(rawLine)) {
          const list = fields.get(currentKey);
          if (list && list.length > 0) {
            list[list.length - 1] = `${list[list.length - 1]} ${rawLine.trim()}`;
          }
        }
      }

      const title = fields.get('TI')?.[0] || fields.get('BTI')?.[0];
      if (!title) continue;

      const rawAuthors = fields.get('FAU') || fields.get('AU') || [];
      const creators = rawAuthors.map((a, idx) =>
        parseCreatorString(a, idx, 'author'),
      );
      const pmid = normalizePmid(fields.get('PMID')?.[0] || '') || undefined;
      const pmcid = normalizePmcid(fields.get('PMC')?.[0] || '') || undefined;
      const dp = fields.get('DP')?.[0];
      const year = extractYearFromDate(dp);
      const journal = fields.get('JT')?.[0] || fields.get('TA')?.[0];
      const journalAbbr = fields.get('TA')?.[0];
      const volume = fields.get('VI')?.[0];
      const issue = fields.get('IP')?.[0];
      const pages = fields.get('PG')?.[0];
      const abstract = cleanAbstractText(fields.get('AB')?.join(' '));
      const issn = normalizeIssn(fields.get('IS')?.[0] || '') || undefined;

      let doi: string | undefined;
      const ids = [...(fields.get('LID') || []), ...(fields.get('AID') || [])];
      for (const idLine of ids) {
        if (/\[doi\]/i.test(idLine) || /^10\.\d{4,9}\//.test(idLine)) {
          const cleaned = idLine.replace(/\s*\[doi\]/i, '').trim();
          doi = normalizeDoi(cleaned) || cleaned;
          break;
        }
      }

      const keywords = normalizeAcademicTags([
        ...(fields.get('OT') || []),
        ...(fields.get('MH') || []).map((m) => m.replace(/\*/g, '')),
      ]);

      items.push({
        title, itemType: 'journalArticle', authors: rawAuthors, creators,
        year, publicationDate: dp, publicationTitle: journal, journal,
        journalAbbr, volume, issue, pages, doi, pmid, pmcid, issn,
        abstract: abstract || undefined, keywords, tags: keywords,
      });
    }

    return items;
  }

  /**
   * 5. Standardized Bibliographic CSV (Zotero CSV / Generic CSV)
   */
  parseCsvBibliography(content: string): ItemMetadata[] {
    const rows = this.parseCsvRows(content);
    if (rows.length < 2) return [];

    const headers = rows[0].map((h) =>
      h.replace(/^\uFEFF/, '').trim().toLowerCase(),
    );
    const items: ItemMetadata[] = [];

    const getCol = (row: string[], names: string[]): string | undefined => {
      for (const name of names) {
        const idx = headers.indexOf(name);
        if (idx !== -1 && row[idx]?.trim()) {
          return row[idx].trim();
        }
      }
      return undefined;
    };

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((cell) => !cell.trim())) continue;

      const title = getCol(row, ['title', 'item title', 'article title']);
      const doiRaw = getCol(row, ['doi']);
      if (!title && !doiRaw) continue;

      const itemType =
        getCol(row, ['item type', 'itemtype', 'type']) || 'journalArticle';
      const authorRaw = getCol(row, ['author', 'authors', 'creators']) || '';
      const authorList = authorRaw
        .split(/\s*;\s*|\s+and\s+/i)
        .map((s) => s.trim())
        .filter(Boolean);
      const creators = authorList.map((a, idx) =>
        parseCreatorString(a, idx, 'author'),
      );

      const yearStr = getCol(row, ['publication year', 'year']);
      const dateStr = getCol(row, ['date', 'publication date']) || yearStr;
      const year = extractYearFromDate(yearStr || dateStr);
      const pubTitle = getCol(row, [
        'publication title',
        'journal',
        'book title',
        'proceedings title',
      ]);
      const publisher = getCol(row, ['publisher']);
      const volume = getCol(row, ['volume']);
      const issue = getCol(row, ['issue', 'number']);
      const pages = getCol(row, ['pages']);
      const url = getCol(row, ['url', 'link']);
      const abstract = cleanAbstractText(
        getCol(row, ['abstract note', 'abstract']),
      );
      const citationKey = getCol(row, ['citation key', 'citationkey', 'key']);
      const isbn = normalizeIsbn(getCol(row, ['isbn']) || '') || undefined;
      const issn = normalizeIssn(getCol(row, ['issn']) || '') || undefined;
      const doi = doiRaw ? normalizeDoi(doiRaw) || doiRaw : undefined;
      const pmid = normalizePmid(getCol(row, ['pmid']) || '') || undefined;
      const arxivId =
        normalizeArxivId(getCol(row, ['arxiv', 'arxivid']) || '') || undefined;

      const rawTags = [
        getCol(row, ['manual tags', 'tags', 'keywords']),
        getCol(row, ['automatic tags']),
      ]
        .filter(Boolean)
        .join(';')
        .split(/[;,]/)
        .map((t) => t.trim())
        .filter(Boolean);
      const tags = normalizeAcademicTags(rawTags);

      items.push({
        title: title || doi || 'Untitled Record', itemType,
        authors: authorList, creators, year, publicationDate: dateStr,
        publicationTitle: pubTitle,
        journal: itemType === 'journalArticle' ? pubTitle : undefined,
        publisher, volume, issue, pages, doi, isbn, issn, pmid, arxivId,
        url, citationKey, abstract: abstract || undefined,
        keywords: tags, tags,
      });
    }

    return items;
  }

  private parseCsvRows(text: string): string[][] {
      const rows: string[][] = [];
      let currentRow: string[] = [];
      let currentField = '';
      let inQuotes = false;

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (inQuotes) {
          if (ch === '"' && next === '"') {
            currentField += '"';
            i++;
          } else if (ch === '"') {
            inQuotes = false;
          } else {
            currentField += ch;
          }
        } else if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          currentRow.push(currentField);
          currentField = '';
        } else if (ch === '\r' && next === '\n') {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
          i++;
        } else if (ch === '\n' || ch === '\r') {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
        } else {
          currentField += ch;
        }
      }
      if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
      }
      return rows;
    }
}
