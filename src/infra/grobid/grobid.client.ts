import { Injectable, Logger } from '@nestjs/common';

export interface GrobidCreator {
  fullName: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  email?: string;
  affiliation?: string;
  institution?: string;
  department?: string;
  country?: string;
  isCorresponding?: boolean;
}

export interface GrobidHeaderResult {
  title?: string;
  authors?: string[];
  creators?: GrobidCreator[];
  abstract?: string;
  abstractParagraphs?: string[];
  abstractSections?: Array<{ heading?: string; text: string }>;
  doi?: string;
  arxivId?: string;
  year?: number;
  publicationDate?: string;
  journal?: string;
  keywords?: string[];
  affiliations?: string[];
  rawTei?: string;
}

export interface GrobidReference {
  id?: string;
  title?: string;
  authors: string[];
  year?: number;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  arxivId?: string;
  rawCitation?: string;
}

export interface GrobidBoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GrobidSection {
  id: string;
  num: string;
  title: string;
  paragraphs: string[];
  page: number;
  coords?: GrobidBoundingBox;
  imradCategory:
    | 'introduction'
    | 'methods'
    | 'results'
    | 'discussion'
    | 'conclusion'
    | 'other';
}

export interface GrobidFigure {
  id: string;
  label: string;
  caption: string;
  page: number;
  coords?: GrobidBoundingBox;
}

export interface GrobidTable {
  id: string;
  label: string;
  caption: string;
  page: number;
  coords?: GrobidBoundingBox;
  headers?: string[];
  rows?: string[][];
  markdown?: string;
}

export interface GrobidFormula {
  id: string;
  label?: string;
  text: string;
  page: number;
  coords?: GrobidBoundingBox;
}

export interface GrobidFulltextResult {
  header: GrobidHeaderResult;
  sections: GrobidSection[];
  figures: GrobidFigure[];
  tables: GrobidTable[];
  formulas: GrobidFormula[];
  references: GrobidReference[];
  rawTei?: string;
}

/**
 * HTTP client for GROBID — ML-based structured academic PDF extraction.
 * GROBID runs as a Docker sidecar (lfoppiano/grobid:0.8.2-crf) on port 8070.
 *
 * License: Apache 2.0 (safe for commercial SaaS)
 * Docs: https://grobid.readthedocs.io/en/latest/Grobid-service/
 *
 * Gracefully disabled if GROBID_ENABLED=false or sidecar is unreachable.
 */
@Injectable()
export class GrobidClient {
  private readonly logger = new Logger(GrobidClient.name);

  private get baseUrl(): string {
    return (
      process.env.GROBID_URL?.replace(/\/$/, '') ?? 'http://localhost:8070'
    );
  }

  private get enabled(): boolean {
    const val = process.env.GROBID_ENABLED;
    // Default enabled if env not set (opt-out model)
    return val !== 'false' && val !== '0';
  }

  private get timeoutMs(): number {
    return parseInt(process.env.GROBID_TIMEOUT_MS || '120000', 10);
  }

  /**
   * Extracts structured header metadata from a PDF buffer.
   * Sends to GROBID /api/processHeaderDocument → TEI XML → parsed result.
   * Returns null if GROBID is disabled, down, or returns non-200.
   */
  async processHeaderDocument(
    buffer: Buffer,
  ): Promise<GrobidHeaderResult | null> {
    if (!this.enabled) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const formData = new FormData();
      formData.append(
        'input',
        new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
        'document.pdf',
      );
      formData.append('consolidateHeader', '0'); // No CrossRef consolidation (we have our own)

      const response = await fetch(
        `${this.baseUrl}/api/processHeaderDocument`,
        {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        this.logger.warn(
          `GROBID processHeaderDocument returned HTTP ${response.status} — skipping enrichment`,
        );
        return null;
      }

      const teiXml = await response.text();
      return this.parseTeiHeader(teiXml);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.logger.warn(
          'GROBID processHeaderDocument timed out — skipping enrichment',
        );
      } else {
        this.logger.warn(
          `GROBID unavailable: ${err?.message} — using unpdf fallback`,
        );
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extracts structured bibliographic references from a PDF buffer using GROBID.
   * Sends to GROBID /api/processReferences → TEI XML → parsed GrobidReference array.
   * Enables 100% offline in-house citation network construction.
   */
  async processReferences(buffer: Buffer): Promise<GrobidReference[]> {
    if (!this.enabled) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const formData = new FormData();
      formData.append(
        'input',
        new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
        'document.pdf',
      );
      formData.append('consolidateCitations', '0');

      const response = await fetch(`${this.baseUrl}/api/processReferences`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `GROBID processReferences returned HTTP ${response.status} — skipping references`,
        );
        return [];
      }

      const teiXml = await response.text();
      return this.parseTeiReferences(teiXml);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.logger.warn(
          'GROBID processReferences timed out — skipping references',
        );
      } else {
        this.logger.warn(`GROBID references unavailable: ${err?.message}`);
      }
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Authoritative In-House Full-Text Document Parsing via GROBID.
   * Calls /api/processFulltextDocument with teiCoordinates for head, figure, table, formula, biblStruct.
   * Extracts sections (IMRAD), tables (matrix/markdown), figures (captions/bboxes), formulas, and references
   * in a single high-efficiency pass.
   */
  async processFulltextDocument(
    buffer: Buffer,
  ): Promise<GrobidFulltextResult | null> {
    if (!this.enabled) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const formData = new FormData();
      formData.append(
        'input',
        new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
        'document.pdf',
      );
      formData.append('consolidateHeader', '0');
      formData.append('consolidateCitations', '0');
      formData.append('includeRawAffiliations', '1');
      formData.append('teiCoordinates', 'head');
      formData.append('teiCoordinates', 'figure');
      formData.append('teiCoordinates', 'table');
      formData.append('teiCoordinates', 'formula');
      formData.append('teiCoordinates', 'biblStruct');

      const response = await fetch(
        `${this.baseUrl}/api/processFulltextDocument`,
        {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        this.logger.warn(
          `GROBID processFulltextDocument returned HTTP ${response.status} — skipping fulltext`,
        );
        return null;
      }

      const teiXml = await response.text();
      return this.parseTeiFulltext(teiXml);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        this.logger.warn('GROBID processFulltextDocument timed out');
      } else {
        this.logger.warn(
          `GROBID processFulltextDocument error: ${err?.message}`,
        );
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Health check — returns true if GROBID is alive.
   */
  async isAlive(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const response = await fetch(`${this.baseUrl}/api/isalive`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── TEI XML parsing ────────────────────────────────────────────────────────

  /**
   * Parses GROBID TEI XML header output into a comprehensive GrobidHeaderResult.
   * Leverages GROBID's CRF/Deep Learning sequence labeling to extract structured
   * document metadata, multi-paragraph/structured abstracts, and author affiliations.
   */
  private parseTeiHeader(teiXml: string): GrobidHeaderResult {
    const result: GrobidHeaderResult = {
      rawTei: teiXml,
    };

    // Title
    const titleMatch =
      teiXml.match(/<title[^>]*level="a"[^>]*>([^<]+)<\/title>/i) ??
      teiXml.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch?.[1]) {
      result.title = this.cleanText(titleMatch[1]);
    }

    // Abstract (high-precision zoning, multi-paragraph, structured abstract parsing)
    const abstractData = this.extractTeiAbstract(teiXml);
    if (abstractData) {
      result.abstract = abstractData.fullText;
      result.abstractParagraphs = abstractData.paragraphs;
      result.abstractSections = abstractData.sections;
    }

    // DOI
    const doiMatch = teiXml.match(/<idno[^>]*type="DOI"[^>]*>([^<]+)<\/idno>/i);
    if (doiMatch?.[1]) {
      result.doi = doiMatch[1].trim();
    }

    // ArXiv ID
    const arxivMatch = teiXml.match(
      /<idno[^>]*type="arXiv"[^>]*>([^<]+)<\/idno>/i,
    );
    if (arxivMatch?.[1]) {
      result.arxivId = arxivMatch[1].replace(/^arxiv:/i, '').trim();
    }

    // Publication Date and Year (from normalized ISO-8601 when attribute)
    const dateMatch = teiXml.match(/<date[^>]*when="([^"]+)"/i);
    if (dateMatch?.[1]) {
      result.publicationDate = dateMatch[1];
      const parsedYear = parseInt(dateMatch[1].slice(0, 4), 10);
      if (!isNaN(parsedYear)) {
        result.year = parsedYear;
      }
    }

    // Journal
    const journalMatch = teiXml.match(
      /<title[^>]*level="j"[^>]*>([^<]+)<\/title>/i,
    );
    if (journalMatch?.[1]) {
      result.journal = this.cleanText(journalMatch[1]);
    }

    // Authors & Creators (Token-level Sequence Labeling with affiliations & emails)
    const creators: GrobidCreator[] = [];
    const authorRegex =
      /<author(?:\s+role="([^"]*)")?[^>]*>([\s\S]*?)<\/author>/gi;
    let aMatch: RegExpExecArray | null;

    while ((aMatch = authorRegex.exec(teiXml)) !== null) {
      const roleAttr = aMatch[1];
      const block = aMatch[2];

      const firstName = this.cleanText(
        block.match(
          /<forename[^>]*type="first"[^>]*>([^<]+)<\/forename>/i,
        )?.[1] || '',
      );
      const middleName = this.cleanText(
        block.match(
          /<forename[^>]*type="middle"[^>]*>([^<]+)<\/forename>/i,
        )?.[1] || '',
      );
      const lastName = this.cleanText(
        block.match(/<surname[^>]*>([^<]+)<\/surname>/i)?.[1] || '',
      );

      const fullNameParts = [firstName, middleName, lastName].filter(Boolean);
      const fullName =
        fullNameParts.length > 0
          ? fullNameParts.join(' ')
          : this.cleanText(
              block.match(/<persName[^>]*>([^<]+)<\/persName>/i)?.[1] || '',
            );

      if (!fullName || fullName.length < 2) continue;

      const email = this.cleanText(
        block.match(/<email[^>]*>([^<]+)<\/email>/i)?.[1] || '',
      );
      const institution = this.cleanText(
        block.match(
          /<orgName[^>]*type="institution"[^>]*>([^<]+)<\/orgName>/i,
        )?.[1] || '',
      );
      const department = this.cleanText(
        block.match(
          /<orgName[^>]*type="department"[^>]*>([^<]+)<\/orgName>/i,
        )?.[1] || '',
      );
      const country = this.cleanText(
        block.match(/<country[^>]*>([^<]+)<\/country>/i)?.[1] || '',
      );

      const affParts = [department, institution, country].filter(Boolean);
      const affiliation = affParts.length > 0 ? affParts.join(', ') : undefined;

      creators.push({
        fullName,
        firstName: firstName || undefined,
        middleName: middleName || undefined,
        lastName: lastName || undefined,
        email: email || undefined,
        affiliation,
        institution: institution || undefined,
        department: department || undefined,
        country: country || undefined,
        isCorresponding: roleAttr === 'corresp',
      });
    }

    if (creators.length > 0) {
      result.creators = creators;
      result.authors = creators.map((c) => c.fullName);
      const distinctAffs = Array.from(
        new Set(creators.map((c) => c.affiliation).filter(Boolean) as string[]),
      );
      if (distinctAffs.length > 0) {
        result.affiliations = distinctAffs;
      }
    }

    // Keywords
    const keywords: string[] = [];
    const kwRegex = /<term>([^<]+)<\/term>/gi;
    let kwMatch: RegExpExecArray | null;
    while ((kwMatch = kwRegex.exec(teiXml)) !== null) {
      const kw = this.cleanText(kwMatch[1]);
      if (kw) keywords.push(kw);
    }
    if (keywords.length > 0) result.keywords = keywords;

    return result;
  }

  /**
   * Extracts and normalizes the abstract from GROBID TEI XML.
   * Handles:
   * 1. Multi-paragraph abstracts (<p>...</p>) preserving semantic paragraph breaks.
   * 2. Structured abstracts (<head>Background</head><p>...</p>) formatted in bold Markdown.
   * 3. Strips trailing author contribution / footnote artifacts.
   * 4. De-hyphenates words broken across line breaks.
   */
  private extractTeiAbstract(teiXml: string):
    | {
        fullText: string;
        paragraphs: string[];
        sections: Array<{ heading?: string; text: string }>;
      }
    | undefined {
    const abstractMatch = teiXml.match(
      /<abstract[^>]*>([\s\S]*?)<\/abstract>/i,
    );
    if (!abstractMatch || !abstractMatch[1]) return undefined;

    const rawBlock = abstractMatch[1].trim();
    if (!rawBlock) return undefined;

    const paragraphs: string[] = [];
    const sections: Array<{ heading?: string; text: string }> = [];

    // Check for structured sections with <head> and <p>
    const headRegex = /<head[^>]*>([^<]+)<\/head>\s*<p[^>]*>([\s\S]*?)<\/p>/gi;
    let hMatch: RegExpExecArray | null;
    while ((hMatch = headRegex.exec(rawBlock)) !== null) {
      const heading = this.cleanText(hMatch[1]);
      const body = this.cleanText(hMatch[2].replace(/<[^>]+>/g, ' '));
      if (heading && body) {
        sections.push({ heading, text: body });
      }
    }

    // Check for paragraphs <p>
    const pMatches = rawBlock.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
    if (pMatches && pMatches.length > 0) {
      for (const pXml of pMatches) {
        const pClean = this.cleanText(pXml.replace(/<[^>]+>/g, ' '));
        if (pClean) {
          paragraphs.push(pClean);
        }
      }
    }

    let fullText = '';
    if (sections.length > 0) {
      fullText = sections
        .map((s) => `**${s.heading}**: ${s.text}`)
        .join('\n\n');
    } else if (paragraphs.length > 0) {
      fullText = paragraphs.join('\n\n');
    } else {
      fullText = this.cleanText(rawBlock.replace(/<[^>]+>/g, ' '));
    }

    if (!fullText || fullText.length < 15) return undefined;

    // Clean trailing author contribution / footnote noise and dehyphenate
    const cleaned = this.cleanAbstractArtifacts(fullText);
    const dehyphenated = this.dehyphenateText(cleaned);

    return {
      fullText: dehyphenated,
      paragraphs,
      sections,
    };
  }

  /**
   * Strips non-abstract noise that occasionally bleeds into the GROBID abstract zone
   * (e.g. "* Equal contribution", "* Corresponding author", listing orders, copyright).
   */
  private cleanAbstractArtifacts(text: string): string {
    const artifactPattern =
      /(?:(?:\n\s*|\.\s+|\s+)[*†‡§\d]*\s*(?:Equal contribution|Corresponding author|Correspondence to|Author ordering|Listing order|These authors contributed equally|Work performed while|Supported in part by|This work was supported by)[\s\S]*$)/i;
    let cleaned = text.replace(artifactPattern, '.');

    // Strip leading "Abstract" or "ABSTRACT" headings
    cleaned = cleaned.replace(
      /^(?:abstract|summary|résumé)\s*[:.—\-–]?\s+/i,
      '',
    );
    cleaned = cleaned.replace(/^(?:abstract|summary|résumé)\s*\r?\n+/i, '');

    // Strip repeated parenthesized / bracketed year-chain extraction artifacts
    // e.g. "(2012)(2013)(2014)(2015)(2016)(2017)."
    cleaned = cleaned.replace(/(?:\((?:19|20)\d{2}\)\s*){2,}\.?/g, '');
    cleaned = cleaned.replace(/(?:\[(?:19|20)\d{2}\]\s*){2,}\.?/g, '');
    cleaned = cleaned.replace(/\((?:(?:19|20)\d{2}[,\s;]*){3,}\)\.?/g, '');

    // Strip trailing reference format or keywords if duplicated inside abstract
    cleaned = cleaned.replace(
      /(?:\n\s*|\s+)(?:ACM Reference [Ff]ormat|Index Terms|Keywords|Key words|Additional Key Words and Phrases)[—:\-\s]+[\s\S]*$/i,
      '',
    );

    // Strip trailing IEEE/ACM copyright banners
    cleaned = cleaned.replace(
      /(?:\n\s*|\.\s+|\s+)(?:Copyright\s*(?:\(c\)|©)?\s*(?:19|20)\d{2}|©\s*(?:19|20)\d{2}\s*IEEE)[\s\S]*$/i,
      '',
    );
    cleaned = cleaned.replace(
      /(?:\n\s*|\s+)\b\d{4}-\d{3}[\dX]\s*(?:\(c\)|©)?\s*\d{4}\s*IEEE[\s\S]*$/i,
      '',
    );

    // Clean trailing punctuation artifacts
    cleaned = cleaned
      .replace(/\s+\./g, '.')
      .replace(/\.{2,}/g, '.')
      .trim();
    return cleaned;
  }

  /**
   * Fixes words broken with hyphens across line breaks (e.g., "stochas- tic" -> "stochastic").
   */
  private dehyphenateText(text: string): string {
    return text.replace(/([a-z]{2,})-\s+([a-z]{2,})/gi, '$1$2');
  }

  /**
   * Parses GROBID TEI XML references output (<listBibl><biblStruct>...) into structured references.
   */
  parseTeiReferences(teiXml: string): GrobidReference[] {
    const references: GrobidReference[] = [];
    if (!teiXml || !teiXml.includes('<biblStruct')) return references;

    const biblRegex = /<biblStruct(?:\s+[^>]*)?>([\s\S]*?)<\/biblStruct>/gi;
    let bMatch: RegExpExecArray | null;

    while ((bMatch = biblRegex.exec(teiXml)) !== null) {
      const block = bMatch[1];

      // 1. Title: Analytic (paper title) takes precedence, otherwise Monogr (book/proceedings title)
      const analyticTitleMatch =
        block.match(
          /<analytic[^>]*>[\s\S]*?<title[^>]*level="a"[^>]*>([^<]+)<\/title>/i,
        ) ??
        block.match(/<analytic[^>]*>[\s\S]*?<title[^>]*>([^<]+)<\/title>/i);
      const monogrTitleMatch = block.match(
        /<monogr[^>]*>[\s\S]*?<title[^>]*>([^<]+)<\/title>/i,
      );

      let title = analyticTitleMatch?.[1]
        ? this.cleanText(analyticTitleMatch[1])
        : undefined;
      let journal = monogrTitleMatch?.[1]
        ? this.cleanText(monogrTitleMatch[1])
        : undefined;

      if (!title && journal) {
        title = journal;
        journal = undefined;
      }

      if (!title || title.length < 3) continue;

      // 2. Authors
      const authors: string[] = [];
      const authorRegex = /<author[^>]*>([\s\S]*?)<\/author>/gi;
      let aMatch: RegExpExecArray | null;
      while ((aMatch = authorRegex.exec(block)) !== null) {
        const aBlock = aMatch[1];
        const firstName = this.cleanText(
          aBlock.match(
            /<forename[^>]*type="first"[^>]*>([^<]+)<\/forename>/i,
          )?.[1] ||
            aBlock.match(/<forename[^>]*>([^<]+)<\/forename>/i)?.[1] ||
            '',
        );
        const lastName = this.cleanText(
          aBlock.match(/<surname[^>]*>([^<]+)<\/surname>/i)?.[1] || '',
        );
        const nameParts = [firstName, lastName].filter(Boolean);
        const name =
          nameParts.length > 0
            ? nameParts.join(' ')
            : this.cleanText(
                aBlock.match(/<persName[^>]*>([^<]+)<\/persName>/i)?.[1] || '',
              );

        if (name && name.length >= 2) {
          authors.push(name);
        }
      }

      // 3. Year
      let year: number | undefined;
      const dateWhenMatch = block.match(/<date[^>]*when="([^"]+)"/i);
      if (dateWhenMatch?.[1]) {
        const y = parseInt(dateWhenMatch[1].slice(0, 4), 10);
        if (!isNaN(y) && y > 1800 && y < 2100) year = y;
      }
      if (!year) {
        const textDateMatch = block.match(/<date[^>]*>([^<]+)<\/date>/i);
        if (textDateMatch?.[1]) {
          const m = textDateMatch[1].match(/\b(19\d\d|20\d\d)\b/);
          if (m) year = parseInt(m[1], 10);
        }
      }

      // 4. DOI
      let doi: string | undefined;
      const doiMatch = block.match(
        /<idno[^>]*type="DOI"[^>]*>([^<]+)<\/idno>/i,
      );
      if (doiMatch?.[1]) {
        doi = doiMatch[1].trim();
      } else {
        const regexDoi = block.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
        if (regexDoi?.[0]) doi = regexDoi[0];
      }

      // 5. ArXiv ID
      let arxivId: string | undefined;
      const arxivMatch = block.match(
        /<idno[^>]*type="arXiv"[^>]*>([^<]+)<\/idno>/i,
      );
      if (arxivMatch?.[1]) {
        arxivId = arxivMatch[1].replace(/^arxiv:/i, '').trim();
      }

      // 6. Volume, Issue, Pages
      const volMatch = block.match(
        /<biblScope[^>]*unit="volume"[^>]*>([^<]+)<\/biblScope>/i,
      );
      const issueMatch = block.match(
        /<biblScope[^>]*unit="issue"[^>]*>([^<]+)<\/biblScope>/i,
      );
      const pageMatch = block.match(
        /<biblScope[^>]*unit="page"[^>]*>([^<]+)<\/biblScope>/i,
      );
      const pageFromMatch = block.match(
        /<biblScope[^>]*unit="page"[^>]*from="([^"]*)"(?:\s+to="([^"]*)")?/i,
      );

      let pages = pageMatch?.[1] ? this.cleanText(pageMatch[1]) : undefined;
      if (!pages && pageFromMatch?.[1]) {
        pages = pageFromMatch[2]
          ? `${pageFromMatch[1]}-${pageFromMatch[2]}`
          : pageFromMatch[1];
      }

      references.push({
        title,
        authors,
        year,
        journal,
        volume: volMatch?.[1] ? this.cleanText(volMatch[1]) : undefined,
        issue: issueMatch?.[1] ? this.cleanText(issueMatch[1]) : undefined,
        pages,
        doi,
        arxivId,
      });
    }

    return references;
  }

  /**
   * Parses GROBID bounding box coordinate strings (e.g. "page,x,y,w,h;...") into a structured GrobidBoundingBox.
   */
  public parseCoordinates(coordsStr?: string): GrobidBoundingBox | undefined {
    if (!coordsStr) return undefined;
    const first = coordsStr.split(';')[0]?.trim();
    if (!first) return undefined;
    const parts = first.split(',').map((p) => parseFloat(p.trim()));
    if (parts.length >= 5 && !parts.some(isNaN)) {
      return {
        page: Math.round(parts[0]),
        x: Math.round(parts[1] * 100) / 100,
        y: Math.round(parts[2] * 100) / 100,
        width: Math.round(parts[3] * 100) / 100,
        height: Math.round(parts[4] * 100) / 100,
      };
    }
    return undefined;
  }

  /**
   * Classifies a section heading into standard academic IMRAD categories.
   */
  public detectImradCategory(title: string): GrobidSection['imradCategory'] {
    const t = (title || '').toLowerCase();
    if (/intro|background|overview|motivation|preliminar/i.test(t))
      return 'introduction';
    if (
      /method|approach|model|architecture|formulat|framework|algorithm|implement/i.test(
        t,
      )
    )
      return 'methods';
    if (/result|experiment|evaluat|finding|empirical|benchmark/i.test(t))
      return 'results';
    if (/discuss|analysis|limitat|advantage|disadvantage|implicat/i.test(t))
      return 'discussion';
    if (/conclu|future work|summary/i.test(t)) return 'conclusion';
    return 'other';
  }

  /**
   * Authoritative full-text TEI XML parser extracting document outline/sections,
   * tables (matrix/markdown), figures (captions/bboxes), formulas, and references.
   */
  public parseTeiFulltext(teiXml: string): GrobidFulltextResult {
    const header = this.parseTeiHeader(teiXml);
    const references = this.parseTeiReferences(teiXml);

    const bodyMatch = teiXml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : teiXml;

    // 1. Sections (Headings + Paragraphs)
    const sections: GrobidSection[] = [];
    const divRegex = /<div(?:\s+[^>]*)?>([\s\S]*?)<\/div>/gi;
    let divMatch: RegExpExecArray | null;
    let sectionIndex = 0;

    while ((divMatch = divRegex.exec(bodyContent)) !== null) {
      const div = divMatch[1];
      const headMatch = div.match(/<head(?:\s+[^>]*)?>([\s\S]*?)<\/head>/i);
      if (!headMatch) continue;

      const headTag = headMatch[0];
      const numMatch = headTag.match(/n="([^"]*)"/i);
      const coordsMatch = headTag.match(/coords="([^"]*)"/i);
      const title = this.cleanText(headMatch[1].replace(/<[^>]+>/g, ''));
      if (!title || title.length < 2) continue;

      const num = numMatch ? numMatch[1].trim() : '';
      const coords = this.parseCoordinates(
        coordsMatch ? coordsMatch[1] : undefined,
      );
      const page = coords?.page || 1;

      const pRegex = /<p(?:\s+[^>]*)?>([\s\S]*?)<\/p>/gi;
      const paragraphs: string[] = [];
      let pMatch: RegExpExecArray | null;
      while ((pMatch = pRegex.exec(div)) !== null) {
        const pText = this.cleanText(pMatch[1].replace(/<[^>]+>/g, ''));
        if (pText.length > 5) {
          paragraphs.push(pText);
        }
      }

      sectionIndex++;
      sections.push({
        id: `sec_${sectionIndex}`,
        num,
        title,
        paragraphs,
        page,
        coords,
        imradCategory: this.detectImradCategory(title),
      });
    }

    // 2. Figures & Tables
    const figures: GrobidFigure[] = [];
    const tables: GrobidTable[] = [];
    const figureRegex = /<figure(?:\s+[^>]*)?>([\s\S]*?)<\/figure>/gi;
    let figMatch: RegExpExecArray | null;
    let figIndex = 0;
    let tabIndex = 0;

    while ((figMatch = figureRegex.exec(bodyContent)) !== null) {
      const fullTag = figMatch[0];
      const content = figMatch[1];

      const isTable =
        fullTag.includes('type="table"') || content.includes('<table');
      const coordsMatch = fullTag.match(/coords="([^"]*)"/i);
      const coords = this.parseCoordinates(
        coordsMatch ? coordsMatch[1] : undefined,
      );
      const page = coords?.page || 1;

      const labelMatch = content.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
      const headMatch = content.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
      const descMatch = content.match(/<figDesc[^>]*>([\s\S]*?)<\/figDesc>/i);

      const label = labelMatch
        ? this.cleanText(labelMatch[1].replace(/<[^>]+>/g, ''))
        : '';
      const caption = this.cleanText(
        (descMatch ? descMatch[1] : headMatch ? headMatch[1] : '').replace(
          /<[^>]+>/g,
          '',
        ),
      );

      if (isTable) {
        tabIndex++;
        const tableTagMatch = content.match(
          /<table(?:\s+[^>]*)?>([\s\S]*?)<\/table>/i,
        );
        const headers: string[] = [];
        const rows: string[][] = [];

        if (tableTagMatch) {
          const tableContent = tableTagMatch[1];
          const rowRegex = /<row(?:\s+[^>]*)?>([\s\S]*?)<\/row>/gi;
          let rowMatch: RegExpExecArray | null;
          let isFirstRow = true;

          while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
            const rowContent = rowMatch[1];
            const cellRegex = /<cell(?:\s+[^>]*)?>([\s\S]*?)<\/cell>/gi;
            const cells: string[] = [];
            let cellMatch: RegExpExecArray | null;
            while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
              cells.push(this.cleanText(cellMatch[1].replace(/<[^>]+>/g, '')));
            }

            if (cells.length > 0) {
              if (isFirstRow) {
                headers.push(...cells);
                isFirstRow = false;
              } else {
                rows.push(cells);
              }
            }
          }
        }

        let markdown = '';
        if (headers.length > 0) {
          const headerRow = `| ${headers.join(' | ')} |`;
          const sepRow = `| ${headers.map(() => '---').join(' | ')} |`;
          const bodyRows = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
          markdown = `${headerRow}\n${sepRow}${bodyRows ? '\n' + bodyRows : ''}`;
        }

        tables.push({
          id: `tab_${tabIndex}`,
          label: label || `Table ${tabIndex}`,
          caption,
          page,
          coords,
          headers: headers.length > 0 ? headers : undefined,
          rows: rows.length > 0 ? rows : undefined,
          markdown: markdown || undefined,
        });
      } else {
        figIndex++;
        figures.push({
          id: `fig_${figIndex}`,
          label: label || `Figure ${figIndex}`,
          caption,
          page,
          coords,
        });
      }
    }

    // 3. Mathematical Formulas
    const formulas: GrobidFormula[] = [];
    const formulaRegex = /<formula(?:\s+[^>]*)?>([\s\S]*?)<\/formula>/gi;
    let fMatch: RegExpExecArray | null;
    let fIndex = 0;

    while ((fMatch = formulaRegex.exec(bodyContent)) !== null) {
      const fullTag = fMatch[0];
      const content = fMatch[1];
      const coordsMatch = fullTag.match(/coords="([^"]*)"/i);
      const coords = this.parseCoordinates(
        coordsMatch ? coordsMatch[1] : undefined,
      );
      const page = coords?.page || 1;

      const labelMatch = content.match(/<label[^>]*>([\s\S]*?)<\/label>/i);
      const label = labelMatch
        ? this.cleanText(labelMatch[1].replace(/<[^>]+>/g, ''))
        : undefined;

      const formulaText = this.cleanText(
        content
          .replace(/<label[^>]*>[\s\S]*?<\/label>/gi, '')
          .replace(/<[^>]+>/g, ''),
      );
      if (!formulaText || formulaText.length < 2) continue;

      fIndex++;
      formulas.push({
        id: `formula_${fIndex}`,
        label,
        text: formulaText,
        page,
        coords,
      });
    }

    return {
      header,
      sections,
      figures,
      tables,
      formulas,
      references,
      rawTei: teiXml,
    };
  }

  private cleanText(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
  }
}
