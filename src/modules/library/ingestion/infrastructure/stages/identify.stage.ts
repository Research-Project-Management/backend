import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { SubmissionPayload } from '../../domain/types/submission.types';
import { MetadataCandidate } from '../../domain/types/metadata-candidate.types';
import { DoiParser } from '../parsers/doi.parser';
import { BibtexParser } from '../parsers/bibtex.parser';
import { RisParser } from '../parsers/ris.parser';
import { NormalizationPolicy } from '../../domain/policies/normalization.policy';
import { IStoragePort, STORAGE_PORT } from '@/modules/storage/storage.port';
import { QueryClassifier } from '../../application/classifiers/query.classifier';
import {
  normalizeAcademicTitleCase,
  normalizeArxivId,
  normalizePmid,
  normalizeIsbn,
} from '../../../shared-kernel/utils/bibliographic.utils';
import { UrlMetadataScraperService } from '../../application/services/url-metadata-scraper.service';
import {
  READER_FACADE,
  IReaderFacade,
  CONTENT_FACADE,
  IContentFacade,
} from '../../../reader/reader.facade';
import { randomUUID } from 'crypto';

@Injectable()
export class IdentifyStage {
  private readonly logger = new Logger(IdentifyStage.name);

  constructor(
    private readonly doiParser: DoiParser,
    private readonly bibtexParser: BibtexParser,
    private readonly risParser: RisParser,
    private readonly normalizer: NormalizationPolicy,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional()
    @Inject(CONTENT_FACADE)
    private readonly contentFacade?: IContentFacade,
    @Optional() private readonly urlScraper?: UrlMetadataScraperService,
  ) {}

  /**
   * Executes identification and initial format translation.
   */
  async execute(
    runId: string,
    payload: SubmissionPayload,
    scopeId?: string,
  ): Promise<MetadataCandidate[]> {
    const candidates: MetadataCandidate[] = [];

    switch (payload.kind) {
      case 'IDENTIFIER': {
        if (payload.identifierType === 'DOI') {
          const cleanDoi = this.doiParser.normalize(payload.value);
          const normalized = this.normalizer.normalize({ doi: cleanDoi });
          candidates.push({
            candidateId: randomUUID(),
            sourceKind: 'IDENTIFIER',
            sourceName: 'DirectIdentifier',
            sourceRecordId: cleanDoi,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {
              doi: {
                path: 'doi',
                value: payload.value,
                normalizedValue: cleanDoi,
                confidence: 1.0,
                sourceProvider: 'UserIdentifier',
                retrievedAt: new Date().toISOString(),
              },
            },
            normalizedMetadata: normalized,
            confidenceScore: 1.0,
          });
        } else if (payload.identifierType === 'ARXIV') {
          const cleanArxiv =
            normalizeArxivId(payload.value) ||
            payload.value.replace(/^arxiv:\s*/i, '').trim();
          const normalized = this.normalizer.normalize({ arxivId: cleanArxiv });
          candidates.push({
            candidateId: randomUUID(),
            sourceKind: 'IDENTIFIER',
            sourceName: 'DirectIdentifier',
            sourceRecordId: cleanArxiv,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {
              arxivId: {
                path: 'arxivId',
                value: payload.value,
                normalizedValue: cleanArxiv,
                confidence: 1.0,
                sourceProvider: 'UserIdentifier',
                retrievedAt: new Date().toISOString(),
              },
            },
            normalizedMetadata: normalized,
            confidenceScore: 1.0,
          });
        } else if (payload.identifierType === 'PMID') {
          const cleanPmid =
            normalizePmid(payload.value) ||
            payload.value.replace(/^pmid:\s*/i, '').trim();
          const normalized = this.normalizer.normalize({ pmid: cleanPmid });
          candidates.push({
            candidateId: randomUUID(),
            sourceKind: 'IDENTIFIER',
            sourceName: 'DirectIdentifier',
            sourceRecordId: cleanPmid,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {
              pmid: {
                path: 'pmid',
                value: payload.value,
                normalizedValue: cleanPmid,
                confidence: 1.0,
                sourceProvider: 'UserIdentifier',
                retrievedAt: new Date().toISOString(),
              },
            },
            normalizedMetadata: normalized,
            confidenceScore: 1.0,
          });
        } else if (payload.identifierType === 'ISBN') {
          const cleanIsbn =
            normalizeIsbn(payload.value) ||
            payload.value
              .replace(/[-\s]/g, '')
              .replace(/^isbn:?\s*/i, '')
              .trim();
          const normalized = this.normalizer.normalize({ isbn: cleanIsbn });
          candidates.push({
            candidateId: randomUUID(),
            sourceKind: 'IDENTIFIER',
            sourceName: 'DirectIdentifier',
            sourceRecordId: cleanIsbn,
            retrievedAt: new Date().toISOString(),
            schemaVersion: '1.0.0',
            fields: {
              isbn: {
                path: 'isbn',
                value: payload.value,
                normalizedValue: cleanIsbn,
                confidence: 1.0,
                sourceProvider: 'UserIdentifier',
                retrievedAt: new Date().toISOString(),
              },
            },
            normalizedMetadata: normalized,
            confidenceScore: 1.0,
          });
        }
        break;
      }

      case 'RECORD': {
        if (payload.format === 'BIBTEX') {
          const parsedList = this.bibtexParser.parse(payload.content);
          for (const item of parsedList) {
            const rawMetadata = {
              title: item.title,
              itemType: item.itemType,
              authors: item.authors,
              editors: item.editors,
              year: item.year,
              publicationTitle: item.journal,
              journal: item.journal,
              publisher: item.publisher,
              place: item.place,
              volume: item.volume,
              issue: item.issue,
              pages: item.pages,
              series: item.series,
              edition: item.edition,
              arxivId: item.arxivId,
              doi: item.doi,
              isbn: item.isbn,
              issn: item.issn,
              url: item.url,
              abstract: item.abstract,
              citationKey: item.citationKey,
              tags: item.keywords,
              keywords: item.keywords,
              notes: item.notes?.map((noteContent) => ({
                content: noteContent,
                source: 'bibtex',
              })),
              language: item.language,
              rights: item.rights,
              fileUrl: item.fileUrl,
              extra: item.extra,
            };
            const normalized = this.normalizer.normalize(rawMetadata);
            candidates.push({
              candidateId: randomUUID(),
              sourceKind: 'RECORD',
              sourceName: 'BibTeX',
              sourceRecordId: item.citationKey || item.doi,
              retrievedAt: new Date().toISOString(),
              schemaVersion: '1.0.0',
              fields: this.buildEvidenceFields(
                rawMetadata,
                normalized,
                'BibTeX',
              ),
              normalizedMetadata: normalized,
              confidenceScore: 0.95,
            });
          }
        } else if (payload.format === 'RIS') {
          const parsedList = this.risParser.parse(payload.content);
          for (const item of parsedList) {
            const normalized = this.normalizer.normalize(item);
            candidates.push({
              candidateId: randomUUID(),
              sourceKind: 'RECORD',
              sourceName: 'RIS',
              sourceRecordId: item.doi || item.citationKey,
              retrievedAt: new Date().toISOString(),
              schemaVersion: '1.0.0',
              fields: this.buildEvidenceFields(item, normalized, 'RIS'),
              normalizedMetadata: normalized,
              confidenceScore: 0.95,
            });
          }
        } else if (
          payload.format === 'CSL_JSON' ||
          (payload.format as string) === 'JSON' ||
          (payload.format as string) === 'csl_json'
        ) {
          let items: any[] = [];
          try {
            const parsed =
              typeof payload.content === 'string'
                ? JSON.parse(payload.content)
                : payload.content;
            items = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            items = [];
          }

          for (const csl of items) {
            if (!csl || typeof csl !== 'object') continue;

            const authors = (csl.author || [])
              .map((a: any) => {
                if (a.literal) return a.literal.trim();
                if (a.given && a.family) return `${a.given} ${a.family}`.trim();
                return (a.family || a.given || '').trim();
              })
              .filter(Boolean);

            const editors = (csl.editor || [])
              .map((e: any) => {
                if (e.literal) return e.literal.trim();
                if (e.given && e.family) return `${e.given} ${e.family}`.trim();
                return (e.family || e.given || '').trim();
              })
              .filter(Boolean);

            const creators = [
              ...(csl.author || []).map((a: any) => ({
                name:
                  a.literal ||
                  (a.given && a.family
                    ? `${a.given} ${a.family}`
                    : a.family || a.given || ''),
                firstName: a.given || undefined,
                lastName: a.family || undefined,
                creatorType: 'author',
              })),
              ...(csl.editor || []).map((e: any) => ({
                name:
                  e.literal ||
                  (e.given && e.family
                    ? `${e.given} ${e.family}`
                    : e.family || e.given || ''),
                firstName: e.given || undefined,
                lastName: e.family || undefined,
                creatorType: 'editor',
              })),
            ];

            const year =
              csl.issued?.['date-parts']?.[0]?.[0] != null
                ? Number(csl.issued['date-parts'][0][0])
                : undefined;

            let keywords: string[] | undefined;
            const rawKeywords = csl.keyword || csl.keywords || csl.subject;
            if (Array.isArray(rawKeywords)) {
              keywords = rawKeywords
                .map((k: any) => String(k).trim())
                .filter(Boolean);
            } else if (typeof rawKeywords === 'string' && rawKeywords.trim()) {
              keywords = rawKeywords
                .split(/[,;\n]/)
                .map((k: string) => k.trim())
                .filter(Boolean);
            }

            const numPages =
              csl['number-of-pages'] != null
                ? String(csl['number-of-pages'])
                : undefined;

            const mapCslType = (cslType: string): string => {
              const typeMap: Record<string, string> = {
                'article-journal': 'journalArticle',
                'paper-conference': 'conferencePaper',
                book: 'book',
                chapter: 'bookSection',
                thesis: 'thesis',
                report: 'report',
                webpage: 'webpage',
                patent: 'patent',
                dataset: 'dataset',
                software: 'computerProgram',
              };
              return typeMap[cslType] || cslType || 'journalArticle';
            };

            const rawMetadata = {
              title: csl.title || 'Untitled Document',
              itemType: mapCslType(csl.type),
              authors: authors.length > 0 ? authors : undefined,
              editors: editors.length > 0 ? editors : undefined,
              creators: creators.length > 0 ? creators : undefined,
              year,
              publicationTitle: csl['container-title'] || undefined,
              journal: csl['container-title'] || undefined,
              publisher: csl.publisher || undefined,
              place: csl['publisher-place'] || undefined,
              volume: csl.volume ? String(csl.volume) : undefined,
              issue: csl.issue ? String(csl.issue) : undefined,
              pages: csl.page || undefined,
              series: csl['collection-title'] || undefined,
              edition: csl.edition ? String(csl.edition).trim() : undefined,
              doi: csl.DOI || csl.doi || undefined,
              isbn: csl.ISBN || csl.isbn || undefined,
              issn: csl.ISSN || csl.issn || undefined,
              url: csl.URL || csl.url || undefined,
              abstract: csl.abstract || undefined,
              citationKey: csl.id || csl['citation-key'] || undefined,
              tags: keywords,
              keywords,
              language: csl.language ? String(csl.language).trim() : undefined,
              rights: csl.rights ? String(csl.rights).trim() : undefined,
              extraFields: numPages
                ? {
                    numberOfPages: Number(numPages) || numPages,
                    numPages: Number(numPages) || numPages,
                  }
                : undefined,
            };

            const normalized = this.normalizer.normalize(rawMetadata);
            candidates.push({
              candidateId: randomUUID(),
              sourceKind: 'RECORD',
              sourceName: 'CSL_JSON',
              sourceRecordId: rawMetadata.citationKey || rawMetadata.doi,
              retrievedAt: new Date().toISOString(),
              schemaVersion: '1.0.0',
              fields: this.buildEvidenceFields(
                rawMetadata,
                normalized,
                'CSL_JSON',
              ),
              normalizedMetadata: normalized,
              confidenceScore: 0.95,
            });
          }
        }
        break;
      }

      case 'URL': {
        const classified = QueryClassifier.classify(payload.url);
        let extractedRaw: Record<string, any> = { url: payload.url };

        if (classified.type === 'DOI') {
          extractedRaw.doi = classified.clean;
        } else if (classified.type === 'ARXIV') {
          extractedRaw.arxivId = classified.clean;
        } else if (classified.type === 'PMID') {
          extractedRaw.pmid = classified.clean;
        } else if (classified.type === 'ISBN') {
          extractedRaw.isbn = classified.clean;
        }

        // Active Academic Web & PDF Scraper
        if (this.urlScraper) {
          try {
            const scraped = await this.urlScraper.scrape(payload.url, {
              scopeId,
              preferredFilename: payload.filename,
            });

            extractedRaw = {
              ...extractedRaw,
              url: payload.url,
              title: scraped.title || extractedRaw.title,
              authors: scraped.authors || extractedRaw.authors,
              creators: scraped.creators || extractedRaw.creators,
              doi: scraped.doi || extractedRaw.doi,
              arxivId: scraped.arxivId || extractedRaw.arxivId,
              pmid: scraped.pmid || extractedRaw.pmid,
              isbn: scraped.isbn || extractedRaw.isbn,
              issn: scraped.issn || extractedRaw.issn,
              year: scraped.year || extractedRaw.year,
              publicationDate:
                scraped.publicationDate || extractedRaw.publicationDate,
              publicationTitle:
                scraped.publicationTitle || extractedRaw.publicationTitle,
              journal: scraped.journal || extractedRaw.journal,
              publisher: scraped.publisher || extractedRaw.publisher,
              abstract: scraped.abstract || extractedRaw.abstract,
              keywords: scraped.keywords || extractedRaw.keywords,
              fileId: scraped.fileId,
              filename: scraped.filename || payload.filename,
              fileUrl:
                scraped.pdfUrl || (scraped.isPdf ? payload.url : undefined),
            };
          } catch (scrapeErr: any) {
            this.logger.warn(
              `UrlMetadataScraper error for "${payload.url}": ${scrapeErr?.message}`,
            );
          }
        }

        const normalized = this.normalizer.normalize(extractedRaw);
        if (extractedRaw.fileId) normalized.fileId = extractedRaw.fileId;
        if (extractedRaw.filename) normalized.filename = extractedRaw.filename;
        if (extractedRaw.fileUrl) normalized.fileUrl = extractedRaw.fileUrl;

        const hasIdentifier = Boolean(
          normalized.doi || normalized.arxivId || normalized.pmid,
        );
        const hasTitle = Boolean(
          normalized.title && normalized.title !== 'Untitled Document',
        );

        candidates.push({
          candidateId: randomUUID(),
          sourceKind: 'URL',
          sourceName: 'UrlCapture',
          sourceRecordId: payload.url,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          fields: this.buildEvidenceFields(
            extractedRaw,
            normalized,
            'UrlCapture',
          ),
          normalizedMetadata: normalized,
          confidenceScore: hasIdentifier ? 0.95 : hasTitle ? 0.88 : 0.7,
        });
        break;
      }

      case 'FILE': {
        let extractedMetadata: any = {};
        let fileBuffer: Buffer | undefined;

        // 1. Zotero-style Fast-Path: Sniff DOI and arXiv ID directly from filename (0ms)
        const rawFilenameDoiMatch = payload.filename?.match(
          /10\.\d{4,9}[/_@][-._;()/:A-Za-z0-9]+/,
        )?.[0];
        const filenameDoi = rawFilenameDoiMatch
          ? rawFilenameDoiMatch
              .replace(/^(10\.\d{4,9})[_@]/, '$1/')
              .replace(/[.,;:)\]]+$/, '')
          : undefined;

        const filenameArxivId = payload.filename?.match(
          /(?:arxiv[:_.-]*)?([0-2]\d{3}\.\d{4,5}(?:v\d+)?)/i,
        )?.[1];

        const hasFastIdentifier = Boolean(filenameDoi || filenameArxivId);

        if (
          this.storagePort?.readOwnedFile &&
          this.contentFacade?.extractDocumentFromBuffer &&
          payload.fileId
        ) {
          try {
            const fileRecord = await this.storagePort.readOwnedFile({
              fileId: payload.fileId,
              projectId: scopeId && scopeId !== 'user' ? scopeId : undefined,
            });
            if (fileRecord?.buffer) {
              fileBuffer = fileRecord.buffer;

              // Fast-path: read first 2 pages with skipGrobid: true (takes ~30-50ms)
              const extractedDocument =
                await this.contentFacade.extractDocumentFromBuffer(
                  fileRecord.buffer,
                  {
                    headerOnly: true,
                    skipGrobid: true,
                    maxPages: 2,
                  },
                );
              extractedMetadata =
                extractedDocument?.metadata || extractedDocument || {};

              // Some PDF adapters can read the document header even when the
              // full document parser fails. Preserve that partial metadata.
              if (
                Object.keys(extractedMetadata).length === 0 &&
                this.contentFacade.extractMetadataFromBuffer
              ) {
                extractedMetadata =
                  this.contentFacade.extractMetadataFromBuffer(
                    fileRecord.buffer,
                  ) || {};
              }

              const detectedDoi = extractedMetadata.doi || filenameDoi;
              const detectedArxiv =
                extractedMetadata.arxivId || filenameArxivId;

              // Only if NEITHER filename nor page 1-2 text revealed a DOI or arXiv ID:
              // Fallback to GROBID layout CRF model to guess title/authors from raw layout
              if (!detectedDoi && !detectedArxiv && !hasFastIdentifier) {
                try {
                  const grobidDoc =
                    await this.contentFacade.extractDocumentFromBuffer(
                      fileRecord.buffer,
                      {
                        headerOnly: true,
                        skipGrobid: false,
                        maxPages: 3,
                      },
                    );
                  if (grobidDoc?.metadata) {
                    extractedMetadata = {
                      ...extractedMetadata,
                      ...grobidDoc.metadata,
                    };
                  }
                } catch {
                  // Fallback failure is non-fatal; unpdf text metadata remains
                }
              }
            }
          } catch (caughtError: unknown) {
            const errorMessage =
              caughtError instanceof Error
                ? caughtError.message
                : String(caughtError);
            this.logger.warn(
              `PDF metadata extraction failed for file ${payload.fileId}: ${errorMessage}`,
            );
            try {
              extractedMetadata =
                fileBuffer && this.contentFacade?.extractMetadataFromBuffer
                  ? this.contentFacade.extractMetadataFromBuffer(fileBuffer)
                  : {};
            } catch {
              extractedMetadata = {};
            }
          }
        }

        // Keep the complete extractor result at the ingestion boundary. This
        // is deliberately a projection rather than a hand-maintained list:
        // adding a field to the PDF extractor must not silently discard it
        // before normalization and reconciliation can use it.
        const {
          rawText: _rawText,
          creationDate: _creationDate,
          ...extractedItemMetadata
        } = extractedMetadata;

        // Clean and prepare title: avoid leaving raw filename or .pdf extension
        let resolvedTitle: string | undefined;
        if (
          extractedMetadata.title &&
          typeof extractedMetadata.title === 'string'
        ) {
          const t = extractedMetadata.title.trim();
          const isBannerOrGarbage =
            /noname\s+manuscript/i.test(t) ||
            /\(will\s+be\s+inserted\s+by\s+the\s+editor\)/i.test(t) ||
            /proceedings\s+of\s+the/i.test(t) ||
            /submitted\s+to/i.test(t) ||
            /\.(eps|pdf|png|jpe?g|svg)$/i.test(t) ||
            /^(untitled|document|microsoft word)/i.test(t) ||
            /^[A-Z]\s+[A-Z]\s+[A-Z]\s+[A-Z]/i.test(t);
          if (t.length > 3 && !isBannerOrGarbage) {
            resolvedTitle = normalizeAcademicTitleCase(t);
          }
        }

        if (!resolvedTitle && payload.filename) {
          // Clean filename fallback: strip .pdf, replace underscores/hyphens with spaces
          const cleanBase = payload.filename
            .replace(/\.[a-zA-Z0-9]+$/, '')
            .replace(/[-_]+/g, ' ')
            .trim();
          const isArxivPattern =
            /^\d{4}\s*\d{4,5}(v\d+)?$/i.test(cleanBase) ||
            /^arxiv/i.test(cleanBase);
          if (cleanBase.length > 2 && !isArxivPattern) {
            resolvedTitle = normalizeAcademicTitleCase(cleanBase);
          }
        }

        if (!resolvedTitle) {
          resolvedTitle = 'Uploaded Document';
        }

        const rawFileMetadata = {
          ...extractedItemMetadata,
          doi: extractedMetadata.doi || filenameDoi,
          isbn: extractedMetadata.isbn,
          arxivId: extractedMetadata.arxivId || filenameArxivId,
          title: resolvedTitle,
          authors: extractedMetadata.authors?.length
            ? extractedMetadata.authors
            : undefined,
          creators: extractedMetadata.creators?.length
            ? extractedMetadata.creators
            : undefined,
          year: extractedMetadata.year || undefined,
          publicationDate:
            extractedMetadata.publicationDate ||
            (extractedMetadata.year
              ? String(extractedMetadata.year)
              : undefined),
          abstract: extractedMetadata.abstract || undefined,
          publisher: extractedMetadata.publisher,
          publicationTitle:
            extractedMetadata.publicationTitle || extractedMetadata.journal,
          journal: extractedMetadata.journal,
          pages: extractedMetadata.pages || undefined,
          tags: extractedMetadata.tags || extractedMetadata.keywords,
          fileId: payload.fileId,
          filename: payload.filename,
          referenceCount: extractedMetadata.referenceCount,
          citationCount: extractedMetadata.citationCount,
          extraFields: {
            ...(extractedMetadata.extraFields || {}),
            ...(extractedMetadata.numberOfPages
              ? {
                  numberOfPages: extractedMetadata.numberOfPages,
                  numPages: extractedMetadata.numberOfPages,
                }
              : {}),
          },
        };
        const normalized = this.normalizer.normalize(rawFileMetadata);

        candidates.push({
          candidateId: randomUUID(),
          sourceKind: 'FILE',
          sourceName: 'StagedPdf',
          sourceRecordId: payload.fileId,
          retrievedAt: new Date().toISOString(),
          schemaVersion: '1.0.0',
          fields: this.buildEvidenceFields(
            rawFileMetadata,
            normalized,
            'StagedPdf',
          ),
          normalizedMetadata: normalized,
          confidenceScore: extractedMetadata.doi
            ? 0.95
            : extractedMetadata.arxivId
              ? 0.92
              : extractedMetadata.isbn
                ? 0.9
                : 0.75,
        });
        break;
      }
    }

    return Promise.resolve(candidates);
  }

  private buildEvidenceFields(
    rawMetadata: Record<string, any>,
    normalizedMetadata: Record<string, any>,
    sourceName: string,
  ): Record<string, any> {
    const fields: Record<string, any> = {};
    for (const fieldName of Object.keys(normalizedMetadata)) {
      if (
        normalizedMetadata[fieldName] !== undefined &&
        normalizedMetadata[fieldName] !== null
      ) {
        fields[fieldName] = {
          path: fieldName,
          value: rawMetadata[fieldName],
          normalizedValue: normalizedMetadata[fieldName],
          confidence: 0.95,
          sourceProvider: sourceName,
          retrievedAt: new Date().toISOString(),
        };
      }
    }
    return fields;
  }
}
