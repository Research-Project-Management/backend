import { Injectable, Logger } from '@nestjs/common';
import { ItemMetadata, CreatorInput } from '@/modules/library/ingestion/types/metadata.types';
import {
  cleanAbstractText, decodeHtmlEntities, extractYearFromDate,
  normalizeDoi, normalizePmid, normalizeIsbn, normalizeIssn, parseCreatorString,
} from '@/modules/library/core';
import { normalizeTags } from '@/modules/library/core/domain/tag.domain';
import { parseMedlineNbibRecords, parseCsvBibliographyRecords } from './csl.parser';

type LegacyRecordFormat = 'ENDNOTE_XML' | 'MODS' | 'ZOTERO_RDF' | 'MEDLINE' | 'CSV';

function decodeXmlEntities(raw: string): string {
  if (!raw) return '';
  const stripped = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '$1')
    .replace(/<\/?[a-zA-Z0-9:_-]+(?:\s+[^>]*)?>/g, '');
  return decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
}

function extractFirstXmlBlock(xml: string, tagPattern: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})>`,
    'i',
  );
  return xml.match(re)?.[1];
}

function extractBalancedXmlTag(
  xml: string,
  tagName: string,
  attrPredicate?: (openTagAttrs: string) => boolean,
): { fullMatch: string; innerXml: string } | undefined {
  const tokenRe = new RegExp(`<(\\/?)(?:[a-zA-Z0-9_-]+:)?${tagName}\\b([^>]*?)(\\/?)>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const attrs = match[2] || '';
    const isSelfClosing = match[3] === '/' || attrs.trim().endsWith('/');
    if (isClosing || isSelfClosing) continue;
    if (attrPredicate && !attrPredicate(attrs)) continue;

    const outerStart = match.index;
    const innerStart = outerStart + match[0].length;
    let depth = 1;
    let nextMatch: RegExpExecArray | null;
    while ((nextMatch = tokenRe.exec(xml)) !== null) {
      const nextIsClosing = nextMatch[1] === '/';
      const nextAttrs = nextMatch[2] || '';
      if (nextMatch[3] === '/' || nextAttrs.trim().endsWith('/')) continue;
      if (nextIsClosing) {
        depth--;
        if (depth === 0) {
          const innerEnd = nextMatch.index;
          return {
            fullMatch: xml.slice(outerStart, innerEnd + nextMatch[0].length),
            innerXml: xml.slice(innerStart, innerEnd),
          };
        }
      } else {
        depth++;
      }
    }
    break;
  }
  return undefined;
}

function extractFirstTagText(xml: string, tagPattern: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?(?:${tagPattern})>`,
    'i',
  );
  const match = xml.match(re);
  if (!match || !match[1]) return undefined;
  return decodeXmlEntities(match[1]) || undefined;
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

function mapEndnoteRefType(rawName?: string, rawNum?: string): string {
  const name = (rawName || '').toLowerCase().trim();
  const num = Number(rawNum || 0);
  if (name.includes('book section') || num === 5) return 'bookSection';
  if (name.includes('edited book') || name === 'book' || num === 6 || num === 28) return 'book';
  if (name.includes('conference') || name.includes('proceeding') || num === 10 || num === 47) return 'conferencePaper';
  if (name.includes('thesis') || name.includes('dissertation') || num === 32) return 'thesis';
  if (name.includes('report') || num === 27) return 'report';
  if (name.includes('web') || name.includes('blog') || num === 12) return 'webpage';
  if (name.includes('patent') || num === 25) return 'patent';
  if (name.includes('newspaper') || num === 23) return 'newspaperArticle';
  if (name.includes('magazine') || num === 19) return 'magazineArticle';
  if (name.includes('computer') || name.includes('software') || num === 9) return 'computerProgram';
  if (name.includes('dataset') || num === 59) return 'dataset';
  if (name.includes('preprint') || name.includes('unpublished') || num === 34) return 'preprint';
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

    if (/<records[\s>]/i.test(trimmed) || /<ref-type[\s>]/i.test(trimmed)) return 'ENDNOTE_XML';
    if (/<(?:mods:)?mods(?:Collection)?[\s>]/i.test(trimmed)) return 'MODS';
    if (/<rdf:RDF[\s>]/i.test(trimmed) || /xmlns:bib=/i.test(trimmed)) return 'ZOTERO_RDF';
    if (/^(?:PMID|TI|AU|FAU|DP|JT|LID|SO)\s*-\s+/m.test(trimmed)) return 'MEDLINE';
    if (/^"?(?:Item Type|Title|Author|Authors|Publication Title|DOI|Year|Publication Year)"?\s*,/i.test(trimmed)) {
      return 'CSV';
    }
    return null;
  }

  parse(content: string, formatHint?: string): ItemMetadata[] {
    if (!content || typeof content !== 'string' || !content.trim()) return [];
    const detected = this.detectFormat(content, formatHint) || ((formatHint || '').toUpperCase() as LegacyRecordFormat);
    switch (detected) {
      case 'ENDNOTE_XML': return this.parseEndnoteXml(content);
      case 'MODS': return this.parseModsXml(content);
      case 'ZOTERO_RDF': return this.parseZoteroRdf(content);
      case 'MEDLINE': return this.parseMedlineNbib(content);
      case 'CSV': return this.parseCsvBibliography(content);
      default: return [];
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

      const titlesBlock = extractFirstXmlBlock(rec, 'titles') ?? rec;
      const title =
        extractFirstTagText(titlesBlock, 'title') || 'Untitled Record';
      const secondaryTitle = extractFirstTagText(
        titlesBlock,
        'secondary-title',
      );
      const shortTitle = extractFirstTagText(titlesBlock, 'short-title');

      const periodicalBlock = extractFirstXmlBlock(rec, 'periodical');
      const periodicalTitle = periodicalBlock
        ? extractFirstTagText(periodicalBlock, 'full-title')
        : undefined;
      const journalAbbr = periodicalBlock
        ? extractFirstTagText(periodicalBlock, 'abbr-1')
        : undefined;

      const authorsBlock =
        extractFirstXmlBlock(rec, 'authors') ??
        extractFirstXmlBlock(rec, 'contributors') ??
        rec;
      const rawAuthors = extractAllTagTexts(authorsBlock, 'author');

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
      const keywords = normalizeTags(
        kwMatch?.[1] ? extractAllTagTexts(kwMatch[1], 'keyword') : [],
      );

      const urls = extractAllTagTexts(rec, 'url').filter((u) =>
        /^https?:\/\//i.test(u),
      );
      const pdfUrl = urls.find((u) => /\.pdf(?:$|\?)/i.test(u));
      const url = urls.find((u) => u !== pdfUrl) || urls[0];

      const pubTitle = periodicalTitle || secondaryTitle;

      items.push({
        title,
        itemType,
        authors: rawAuthors,
        editors: rawEditors.length > 0 ? rawEditors : undefined,
        creators,
        year,
        publicationDate: dateStr,
        publicationTitle: pubTitle,
        journal: itemType === 'journalArticle' ? pubTitle : undefined,
        bookTitle: itemType === 'bookSection' ? pubTitle : undefined,
        proceedingsTitle: itemType === 'conferencePaper' ? pubTitle : undefined,
        university: itemType === 'thesis' ? publisher : undefined,
        institution: itemType === 'report' ? publisher : undefined,
        journalAbbr,
        shortTitle,
        volume,
        issue,
        pages,
        publisher,
        place,
        doi,
        isbn,
        issn: !isbn ? rawIssn : undefined,
        url,
        openAccessPdfUrl: pdfUrl,
        abstract: abstract || undefined,
        keywords,
        tags: keywords,
        callNumber,
        language,
        notes: notesText
          ? [{ content: notesText, source: 'endnote_xml' }]
          : undefined,
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
      const hostBlock = extractBalancedXmlTag(block, 'relatedItem', (attrs) =>
        /\btype\s*=\s*["']host["']/i.test(attrs),
      );
      const hostXml = hostBlock?.innerXml || '';
      const mainXml = hostBlock
        ? block.replace(hostBlock.fullMatch, '')
        : block;
      const titleInfoMatch = mainXml.match(
        /<(?:[a-zA-Z0-9_-]+:)?titleInfo(?:\s+[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?titleInfo>/i,
      );
      const titleXml = titleInfoMatch?.[1] || mainXml;
      const baseTitle =
        extractFirstTagText(titleXml, 'title') || 'Untitled Record';
      const subTitle = extractFirstTagText(titleXml, 'subTitle');
      const title = subTitle ? `${baseTitle}: ${subTitle}` : baseTitle;
      const nestedHostSeries = hostXml
        ? extractBalancedXmlTag(hostXml, 'relatedItem')
        : undefined;
      const directHostXml =
        hostXml && nestedHostSeries
          ? hostXml.replace(nestedHostSeries.fullMatch, '')
          : hostXml;
      const hostTitle = directHostXml
        ? extractFirstTagText(directHostXml, 'title')
        : undefined;

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
        const roleTerm =
          extractFirstTagText(nXml, 'roleTerm')?.toLowerCase() || '';
        const role =
          roleTerm.includes('edt') || roleTerm.includes('editor')
            ? 'editor'
            : 'author';

        if (family || given) {
          const cleanFam = decodeXmlEntities(family || '');
          const cleanGiv = decodeXmlEntities(given || '');
          const full = [cleanGiv, cleanFam].filter(Boolean).join(' ');
          creators.push({
            firstName: cleanGiv,
            lastName: cleanFam,
            fullName: full,
            name: full,
            creatorType: role,
          });
          if (role === 'author' && full) authors.push(full);
        } else {
          const literal = extractFirstTagText(nXml, 'namePart');
          if (literal) {
            creators.push(parseCreatorString(literal, creators.length, role));
            if (role === 'author') authors.push(literal);
          }
        }
      }

      const dateStr =
        extractFirstTagText(block, 'dateIssued') ||
        extractFirstTagText(block, 'dateCreated');
      const year = extractYearFromDate(dateStr);
      const publisher = extractFirstTagText(block, 'publisher');
      const place = extractFirstTagText(block, 'placeTerm');
      const abstract = cleanAbstractText(
        extractFirstTagText(block, 'abstract'),
      );
      const url = extractFirstTagText(block, 'url');
      const genres = extractAllTagTexts(block, 'genre').map((g) =>
        g.toLowerCase(),
      );

      let itemType = 'journalArticle';
      if (
        genres.some((g) => g.includes('thesis') || g.includes('dissertation'))
      ) {
        itemType = 'thesis';
      } else if (genres.some((g) => g.includes('conference'))) {
        itemType = 'conferencePaper';
      } else if (genres.some((g) => g.includes('book')) && !hostTitle) {
        itemType = 'book';
      } else if (genres.some((g) => g.includes('report'))) {
        itemType = 'report';
      }

      const volume = block
        .match(
          /<(?:[a-zA-Z0-9_-]+:)?detail[^>]*type=["']volume["'][^>]*>[\s\S]*?<(?:[a-zA-Z0-9_-]+:)?number>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?number>/i,
        )?.[1]
        ?.trim();
      const issue = block
        .match(
          /<(?:[a-zA-Z0-9_-]+:)?detail[^>]*type=["']issue["'][^>]*>[\s\S]*?<(?:[a-zA-Z0-9_-]+:)?number>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?number>/i,
        )?.[1]
        ?.trim();
      const startPage = extractFirstTagText(block, 'start');
      const endPage = extractFirstTagText(block, 'end');
      const pages =
        startPage && endPage
          ? `${startPage}-${endPage}`
          : startPage || extractFirstTagText(block, 'list');

      let doi: string | undefined;
      let isbn: string | undefined;
      let issn: string | undefined;
      let pmid: string | undefined;
      const idRe =
        /<(?:[a-zA-Z0-9_-]+:)?identifier(?:\s+type=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?identifier>/gi;
      let idMatch: RegExpExecArray | null;
      while ((idMatch = idRe.exec(block)) !== null) {
        const idType = (idMatch[1] || '').toLowerCase();
        const idVal = decodeXmlEntities(idMatch[2] || '');
        if (!idVal) continue;
        if (idType === 'doi' || /^10\.\d{4,9}\//.test(idVal)) {
          doi = normalizeDoi(idVal) || idVal;
        } else if (idType === 'isbn') {
          isbn = normalizeIsbn(idVal) || idVal;
        } else if (idType === 'issn') {
          issn = normalizeIssn(idVal) || idVal;
        } else if (idType === 'pmid') {
          pmid = normalizePmid(idVal) || idVal;
        }
      }

      const topics = normalizeTags(extractAllTagTexts(block, 'topic'));
      const notes = extractAllTagTexts(block, 'note');
      if (itemType === 'journalArticle' && isbn && !issn && !doi) {
        itemType = hostTitle ? 'bookSection' : 'book';
      }

      items.push({
        title,
        itemType,
        authors,
        creators,
        year,
        publicationDate: dateStr,
        publicationTitle: hostTitle,
        journal: itemType === 'journalArticle' ? hostTitle : undefined,
        publisher,
        place,
        volume: volume ? decodeXmlEntities(volume) : undefined,
        issue: issue ? decodeXmlEntities(issue) : undefined,
        pages,
        doi,
        isbn,
        issn,
        pmid,
        url,
        abstract: abstract || undefined,
        keywords: topics,
        tags: topics,
        notes:
          notes.length > 0
            ? notes.map((n) => ({ content: n, source: 'mods' }))
            : undefined,
      });
    }

    return items;
  }

  /**
   * 3. Zotero RDF / Bibliontology RDF (.rdf)
   */
  parseZoteroRdf(content: string): ItemMetadata[] {
    const items: ItemMetadata[] = [];

    const normalizeResourceKey = (rawKey?: string): string =>
      (rawKey || '').trim().replace(/^#/, '');

    // Pass 1: Index standalone container/organization/note nodes by rdf:about / rdf:ID
    // so <dcterms:isPartOf rdf:resource="#..."/> and <dc:publisher rdf:resource="#..."/> resolve cleanly.
    const resourceNodeMap = new Map<
      string,
      { tagName: string; body: string }
    >();
    const resourceNodeRe =
      /<(bib:(?:Journal|Book|Series|ConferenceProceedings)|foaf:Organization|z:Attachment|bib:Memo|rdf:Description)\s+([^>]*?)>([\s\S]*?)<\/\1>/gi;
    let resMatch: RegExpExecArray | null;
    while ((resMatch = resourceNodeRe.exec(content)) !== null) {
      const tagName = resMatch[1] || '';
      const attrs = resMatch[2] || '';
      const body = resMatch[3] || '';
      const idAttr =
        attrs.match(/\brdf:(?:about|ID)\s*=\s*["']([^"']+)["']/i)?.[1] || '';
      const normKey = normalizeResourceKey(idAttr);
      if (normKey) {
        resourceNodeMap.set(normKey, { tagName, body });
      }
    }

    const extractPersonsByRole = (
      xmlBlock: string,
      roleTag: string,
      creatorType: 'author' | 'editor' | 'contributor',
      outCreators: CreatorInput[],
      outNames: string[],
    ): void => {
      const roleBlockMatch = xmlBlock.match(
        new RegExp(
          `<${roleTag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${roleTag}>`,
          'i',
        ),
      );
      if (!roleBlockMatch?.[1]) return;
      const personRe =
        /<foaf:Person(?:\s+[^>]*)?>([\s\S]*?)<\/foaf:Person>/gi;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = personRe.exec(roleBlockMatch[1])) !== null) {
        const pXml = pMatch[1] || '';
        const surname = extractFirstTagText(pXml, 'surname') || '';
        const givenname =
          extractFirstTagText(pXml, 'givenname') ||
          extractFirstTagText(pXml, 'givenName') ||
          '';
        const full = [givenname, surname].filter(Boolean).join(' ').trim();
        if (full) {
          outCreators.push({
            firstName: givenname,
            lastName: surname,
            fullName: full,
            name: full,
            creatorType,
          });
          outNames.push(full);
        }
      }
    };

    const nodeRe =
      /<(bib:(?:Article|Book|BookSection|Thesis|Report|ConferenceProceedings|Document|Manuscript|Patent)|rdf:Description)(?:\s+([^>]*))?>([\s\S]*?)<\/\1>/gi;
    let match: RegExpExecArray | null;

    while ((match = nodeRe.exec(content)) !== null) {
      const tagName = match[1] || '';
      const body = match[3] || '';
      const zItemType = extractFirstTagText(body, 'itemType');
      if (
        tagName.toLowerCase() === 'rdf:description' &&
        !zItemType &&
        !/<dc:title>/i.test(body)
      ) {
        continue;
      }
      if (
        zItemType === 'attachment' ||
        zItemType === 'note' ||
        zItemType === 'journal'
      ) {
        continue;
      }
      // Skip standalone Book/ConferenceProceedings containers that are purely targets of dcterms:isPartOf
      // unless they carry an explicit <z:itemType> or author/editor list
      if (
        (tagName.toLowerCase() === 'bib:book' ||
          tagName.toLowerCase() === 'bib:conferenceproceedings') &&
        !zItemType &&
        !/<bib:(?:authors|editors|contributors)\b/i.test(body)
      ) {
        continue;
      }

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
      const editors: string[] = [];

      if (/<bib:(?:authors|editors|contributors)\b/i.test(body)) {
        extractPersonsByRole(body, 'bib:authors', 'author', creators, authors);
        extractPersonsByRole(body, 'bib:editors', 'editor', creators, editors);
        extractPersonsByRole(
          body,
          'bib:contributors',
          'contributor',
          creators,
          [],
        );
      } else {
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
      }

      const dateStr = extractFirstTagText(body, 'date');
      const year = extractYearFromDate(dateStr);
      const abstract = cleanAbstractText(extractFirstTagText(body, 'abstract'));

      // Resolve inline or referenced <dcterms:isPartOf> container node
      const isPartOfInlineMatch = body.match(
        /<dcterms:isPartOf(?:\s+[^>]*)?>([\s\S]*?)<\/dcterms:isPartOf>/i,
      );
      const isPartOfRefMatch = body.match(
        /<dcterms:isPartOf[^>]*\brdf:resource\s*=\s*["']([^"']+)["'][^>]*\/?>/i,
      );
      const linkedContainerXml = isPartOfRefMatch?.[1]
        ? resourceNodeMap.get(normalizeResourceKey(isPartOfRefMatch[1]))?.body
        : undefined;
      const containerXml = isPartOfInlineMatch?.[1] || linkedContainerXml || '';

      const bodyWithoutInlineContainer = isPartOfInlineMatch?.[0]
        ? body.replace(isPartOfInlineMatch[0], '')
        : body;

      const publicationTitle = containerXml
        ? extractFirstTagText(containerXml, 'title')
        : undefined;
      const journalAbbr =
        extractFirstTagText(containerXml, 'alternative') ||
        extractFirstTagText(bodyWithoutInlineContainer, 'shortTitle');

      const volume =
        extractFirstTagText(bodyWithoutInlineContainer, 'volume') ||
        extractFirstTagText(containerXml, 'volume');
      const issue =
        extractFirstTagText(bodyWithoutInlineContainer, 'number') ||
        extractFirstTagText(containerXml, 'number');
      const pages = extractFirstTagText(bodyWithoutInlineContainer, 'pages');

      // Resolve inline or referenced <dc:publisher> organization
      const publisherInlineMatch = body.match(
        /<dc:publisher(?:\s+[^>]*)?>([\s\S]*?)<\/dc:publisher>/i,
      );
      const publisherRefMatch = body.match(
        /<dc:publisher[^>]*\brdf:resource\s*=\s*["']([^"']+)["'][^>]*\/?>/i,
      );
      const publisherXml =
        publisherInlineMatch?.[1] ||
        (publisherRefMatch?.[1]
          ? resourceNodeMap.get(normalizeResourceKey(publisherRefMatch[1]))
              ?.body
          : '') ||
        containerXml;
      const publisher =
        extractFirstTagText(publisherXml, 'name') ||
        extractFirstTagText(bodyWithoutInlineContainer, 'publisher');
      const place =
        extractFirstTagText(publisherXml, 'locality') ||
        extractFirstTagText(publisherXml, 'address');

      const identifiers = [
        ...extractAllTagTexts(bodyWithoutInlineContainer, 'identifier'),
        ...extractAllTagTexts(containerXml, 'identifier'),
        ...extractAllTagTexts(bodyWithoutInlineContainer, 'URI'),
      ];
      let doi: string | undefined;
      let isbn: string | undefined;
      let issn: string | undefined;
      let url: string | undefined;
      for (const idStr of identifiers) {
        if (/^doi\s*:?\s*10\./i.test(idStr) || /^10\.\d{4,9}\//.test(idStr)) {
          doi = doi || normalizeDoi(idStr) || undefined;
        } else if (/^isbn/i.test(idStr)) {
          isbn = isbn || normalizeIsbn(idStr) || undefined;
        } else if (/^issn/i.test(idStr)) {
          issn = issn || normalizeIssn(idStr) || undefined;
        } else if (/^https?:\/\//i.test(idStr)) {
          if (/doi\.org\/10\.\d{4,9}\//i.test(idStr) && !doi) {
            doi = normalizeDoi(idStr) || undefined;
          }
          url = url || idStr;
        }
      }

      const tags = normalizeTags(
        extractAllTagTexts(bodyWithoutInlineContainer, 'subject'),
      );

      items.push({
        title,
        itemType,
        authors,
        editors: editors.length > 0 ? editors : undefined,
        creators,
        year,
        publicationDate: dateStr,
        publicationTitle,
        journal: itemType === 'journalArticle' ? publicationTitle : undefined,
        journalAbbr,
        publisher,
        place,
        volume,
        issue,
        pages,
        doi,
        isbn,
        issn,
        url,
        abstract: abstract || undefined,
        keywords: tags,
        tags,
      });
    }

    return items;
  }

  /**
   * 4. PubMed / MEDLINE Tagged Format (.nbib / .txt)
   */
  parseMedlineNbib(content: string): ItemMetadata[] {
    return parseMedlineNbibRecords(content);
  }

  /**
   * 5. Standardized Bibliographic CSV (Zotero CSV / Generic CSV)
   */
  parseCsvBibliography(content: string): ItemMetadata[] {
    return parseCsvBibliographyRecords(content);
  }
}
