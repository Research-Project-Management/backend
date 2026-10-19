import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { PdfProvider } from '@/modules/library/extraction/providers/pdf.provider';
import { TrustedExtractionService } from '@/modules/library/extraction/services/trusted-extraction.service';
import { UrlMetadataScraperService } from '@/modules/library/ingestion/services/url-metadata-scraper.service';
import { WebFetchLadderService } from '@/modules/library/ingestion/services/web-fetch-ladder.service';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import {
  IExtractionFacade,
  inferItemTypeFromPdfSignals,
} from '@/modules/library/core';

interface BenchmarkSample {
  id: number;
  type: 'FILE' | 'LINK';
  name: string;
  category: string;
  input: string; // File path or URL
  groundTruth: {
    expectedTitleSnippet: string;
    expectedItemType: string;
    expectedAuthorSnippet?: string;
    expectedDoi?: string;
    expectedYear?: number;
  };
}

interface BenchmarkOutput {
  id: number;
  type: 'FILE' | 'LINK';
  name: string;
  category: string;
  input: string;
  durationMs: number;
  inferredItemType: string;
  title: string;
  titleMatch: boolean;
  authors: string[];
  authorsCount: number;
  hasAuthors: boolean;
  year?: number;
  yearMatch: boolean;
  doi?: string;
  hasDoi: boolean;
  venueOrPublisher?: string;
  hasVenue: boolean;
  abstractSnippet?: string;
  hasAbstract: boolean;
  completenessScore: number; // 0 to 100%
  pipelineNotes: string;
}

const SAMPLES: BenchmarkSample[] = [
  // --- 10 DIVERSE PDF FILES ---
  {
    id: 1,
    type: 'FILE',
    name: 'AlphaFold 2 (Nature Breakthrough)',
    category: 'Biomedical / Structural Biology Journal',
    input:
      'D:/project/flux/source/papers/paper_0019_highly_accurate_protein_structure_prediction_with_.pdf',
    groundTruth: {
      expectedTitleSnippet: 'AlphaFold',
      expectedItemType: 'journalArticle',
      expectedAuthorSnippet: 'Jumper',
      expectedDoi: '10.1038/s41586-021-03819-2',
      expectedYear: 2021,
    },
  },
  {
    id: 2,
    type: 'FILE',
    name: 'SciPy 1.0 (Nature Methods)',
    category: 'Scientific Computing / Open Source Software Paper',
    input:
      'D:/project/flux/source/papers/paper_0006_scipy_1_0__fundamental_algorithms_for_scienti.pdf',
    groundTruth: {
      expectedTitleSnippet: 'SciPy 1.0',
      expectedItemType: 'journalArticle',
      expectedAuthorSnippet: 'Virtanen',
      expectedDoi: '10.48550/arXiv.1907.10121v1',
      expectedYear: 2020,
    },
  },
  {
    id: 3,
    type: 'FILE',
    name: 'Scikit-Learn (JMLR)',
    category: 'Machine Learning Benchmark / Journal Article',
    input:
      'D:/project/flux/source/papers/paper_0002_scikit-learn__machine_learning_in_python.pdf',
    groundTruth: {
      expectedTitleSnippet: 'Scikit-learn',
      expectedItemType: 'journalArticle',
      expectedAuthorSnippet: 'Pedregosa',
      expectedDoi: '10.48550/arxiv.1201.0490',
      expectedYear: 2011,
    },
  },
  {
    id: 4,
    type: 'FILE',
    name: 'YOLO v1 (CVPR 2016)',
    category: 'Computer Vision / Conference Paper',
    input:
      'D:/project/flux/source/papers/paper_0004_you_only_look_once__unified__real-time_object.pdf',
    groundTruth: {
      expectedTitleSnippet: 'You Only Look Once',
      expectedItemType: 'conferencePaper',
      expectedAuthorSnippet: 'Redmon',
      expectedYear: 2016,
    },
  },
  {
    id: 5,
    type: 'FILE',
    name: 'XGBoost (ACM KDD 2016)',
    category: 'Applied Data Mining / Conference Paper',
    input: 'D:/project/flux/source/papers/paper_0003_xgboost.pdf',
    groundTruth: {
      expectedTitleSnippet: 'XGBoost',
      expectedItemType: 'conferencePaper',
      expectedAuthorSnippet: 'Chen',
      expectedDoi: '10.1145/2939672.2939785',
      expectedYear: 2016,
    },
  },
  {
    id: 6,
    type: 'FILE',
    name: 'Support-Vector Networks (Springer 1995)',
    category: 'Classical Machine Learning / Foundational Journal',
    input:
      'D:/project/flux/source/papers/paper_0017_support-vector_networks.pdf',
    groundTruth: {
      expectedTitleSnippet: 'Support-Vector Networks',
      expectedItemType: 'journalArticle',
      expectedAuthorSnippet: 'Cortes',
      expectedDoi: '10.1007/bf00994018',
      expectedYear: 1995,
    },
  },
  {
    id: 7,
    type: 'FILE',
    name: 'Graphene (Science 2004)',
    category: 'Physics / Nanomaterials Journal Article',
    input:
      'D:/project/flux/source/papers/paper_0001_electric_field_effect_in_atomically_thin_carb.pdf',
    groundTruth: {
      expectedTitleSnippet:
        'Electric Field Effect in Atomically Thin Carbon Films',
      expectedItemType: 'journalArticle',
      expectedAuthorSnippet: 'Novoselov',
      expectedDoi: '10.1126/science.1102896',
      expectedYear: 2004,
    },
  },
  {
    id: 8,
    type: 'FILE',
    name: 'STROBE Statement (PLOS Medicine)',
    category: 'Medical / Epidemiological Guideline Paper',
    input:
      'D:/project/flux/source/papers/paper_0561_the_strengthening_the_reporting_of_observatio.pdf',
    groundTruth: {
      expectedTitleSnippet: 'STROBE',
      expectedItemType: 'journalArticle',
      expectedAuthorSnippet: 'von Elm',
      expectedDoi: '10.1371/journal.pmed.0040296',
      expectedYear: 2007,
    },
  },
  {
    id: 9,
    type: 'FILE',
    name: 'DenseNet (CVPR 2017)',
    category: 'Deep Learning / Multi-column Conference Paper',
    input:
      'D:/project/flux/source/papers/paper_0005_densely_connected_convolutional_networks.pdf',
    groundTruth: {
      expectedTitleSnippet: 'Densely Connected Convolutional Networks',
      expectedItemType: 'conferencePaper',
      expectedAuthorSnippet: 'Huang',
      expectedYear: 2017,
    },
  },
  {
    id: 10,
    type: 'FILE',
    name: 'MobileNetV2 (CVPR 2018)',
    category: 'Mobile Deep Learning / Efficient Architecture',
    input:
      'D:/project/flux/source/papers/paper_0012_mobilenetv2__inverted_residuals_and_linear_bo.pdf',
    groundTruth: {
      expectedTitleSnippet: 'MobileNetV2',
      expectedItemType: 'conferencePaper',
      expectedAuthorSnippet: 'Sandler',
      expectedYear: 2018,
    },
  },

  // --- 10 DIVERSE LINKS / URLS ---
  {
    id: 11,
    type: 'LINK',
    name: 'Attention Is All You Need (arXiv)',
    category: 'Preprint Repository (arXiv)',
    input: 'https://arxiv.org/abs/1706.03762',
    groundTruth: {
      expectedTitleSnippet: 'Attention Is All You Need',
      expectedItemType: 'preprint',
      expectedAuthorSnippet: 'Vaswani',
      expectedDoi: '10.48550/arXiv.1706.03762',
      expectedYear: 2017,
    },
  },
  {
    id: 12,
    type: 'LINK',
    name: 'PLOS ONE Research Article',
    category: 'Open Access Journal (PLOS)',
    input:
      'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0248823',
    groundTruth: {
      expectedTitleSnippet: 'primary care',
      expectedItemType: 'journalArticle',
      expectedDoi: '10.1371/journal.pone.0248823',
      expectedYear: 2021,
    },
  },
  {
    id: 13,
    type: 'LINK',
    name: 'SARS-CoV-2 Spike Glycoprotein (bioRxiv)',
    category: 'Biological Preprint (bioRxiv)',
    input: 'https://www.biorxiv.org/content/10.1101/2020.03.22.002386v1',
    groundTruth: {
      expectedTitleSnippet: 'SARS-CoV-2',
      expectedItemType: 'preprint',
      expectedDoi: '10.1101/2020.03.22.002386',
      expectedYear: 2020,
    },
  },
  {
    id: 14,
    type: 'LINK',
    name: 'EuropePMC Open Access Record',
    category: 'Biomedical Index (EuropePMC)',
    input: 'https://europepmc.org/article/MED/33053782',
    groundTruth: {
      expectedTitleSnippet: 'COVID-19',
      expectedItemType: 'journalArticle',
    },
  },
  {
    id: 15,
    type: 'LINK',
    name: 'Springer Nature Article DOI Link',
    category: 'Major Commercial Publisher (Springer)',
    input: 'https://link.springer.com/article/10.1007/s11263-015-0816-y',
    groundTruth: {
      expectedTitleSnippet: 'ImageNet Large Scale Visual Recognition Challenge',
      expectedItemType: 'journalArticle',
      expectedDoi: '10.1007/s11263-015-0816-y',
      expectedYear: 2015,
    },
  },
  {
    id: 16,
    type: 'LINK',
    name: 'ACL Anthology NLP Paper',
    category: 'Computer Linguistics Library (ACL)',
    input: 'https://aclanthology.org/2020.acl-main.703/',
    groundTruth: {
      expectedTitleSnippet: 'BART',
      expectedItemType: 'conferencePaper',
    },
  },
  {
    id: 17,
    type: 'LINK',
    name: 'Modular Monolith (Martin Fowler)',
    category: 'Software Architecture / Technical Blog',
    input: 'https://martinfowler.com/articles/modular-monolith.html',
    groundTruth: {
      expectedTitleSnippet: 'Modular Monolith',
      expectedItemType: 'blogPost',
      expectedAuthorSnippet: 'Fowler',
    },
  },
  {
    id: 18,
    type: 'LINK',
    name: 'Transformer Deep Learning (Wikipedia)',
    category: 'Online Encyclopedia / Knowledge Base',
    input:
      'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)',
    groundTruth: {
      expectedTitleSnippet: 'Transformer',
      expectedItemType: 'webpage',
    },
  },
  {
    id: 19,
    type: 'LINK',
    name: 'Modern Math (Quanta Magazine)',
    category: 'Science Journalism / Magazine Article',
    input:
      'https://www.quantamagazine.org/how-mathematics-built-the-modern-world-20230524/',
    groundTruth: {
      expectedTitleSnippet: 'Mathematics',
      expectedItemType: 'magazineArticle',
    },
  },
  {
    id: 20,
    type: 'LINK',
    name: 'Node.js Core Documentation',
    category: 'Technical Specification / API Docs',
    input: 'https://nodejs.org/api/documentation.html',
    groundTruth: {
      expectedTitleSnippet: 'Documentation',
      expectedItemType: 'webpage',
    },
  },
];

function calculateCompleteness(meta: any): number {
  let score = 0;
  // Core fields (60%)
  if (meta.title && meta.title.length > 5) score += 25;
  if (meta.creators && meta.creators.length > 0) score += 20;
  if (meta.date || meta.year) score += 15;

  // Secondary metadata (40%)
  if (
    meta.publicationTitle ||
    meta.journal ||
    meta.bookTitle ||
    meta.conferenceName ||
    meta.publisher
  )
    score += 15;
  if (meta.doi || meta.arxivId || meta.pmid || meta.isbn) score += 15;
  if (meta.abstract && meta.abstract.length > 30) score += 10;

  return score;
}

async function runBenchmark() {
  console.log(
    '================================================================',
  );
  console.log('   FLUX LIBRARY INGESTION EMPIRICAL BENCHMARK (20 SAMPLES)');
  console.log('   Testing 10 Diverse PDF Files & 10 Diverse Links/URLs');
  console.log(
    '================================================================\n',
  );

  const trusted = new TrustedExtractionService();
  const pdfProvider = new PdfProvider(undefined, trusted);
  const webFetchLadder = new WebFetchLadderService();
  const extractionGateway = {
    extractDocumentFromBuffer: (buf: Buffer, opts?: unknown) =>
      pdfProvider.extractDocumentFromBuffer(
        buf,
        opts as Record<string, unknown>,
      ),
    extractMetadataFromBuffer: async (buf: Buffer) =>
      pdfProvider.extractMetadataFromBuffer(buf),
  } as unknown as IExtractionFacade;
  const urlScraper = new UrlMetadataScraperService(
    undefined,
    extractionGateway,
    undefined,
    webFetchLadder,
  );
  const normalizer = new NormalizationPolicy();

  const results: BenchmarkOutput[] = [];

  for (const sample of SAMPLES) {
    console.log(
      `[Item ${sample.id}/20] Processing ${sample.type}: ${sample.name}...`,
    );
    const start = performance.now();

    try {
      if (sample.type === 'FILE') {
        if (!fs.existsSync(sample.input)) {
          console.warn(`  File not found on disk: ${sample.input}`);
          continue;
        }

        const buffer = fs.readFileSync(sample.input);
        const doc = await pdfProvider.extractDocumentFromBuffer(buffer, {
          headerOnly: true,
          maxPages: 3,
        });

        // Infer item type from text signals + headers
        const inferred = inferItemTypeFromPdfSignals({
          title: doc.metadata.title,
          journal: doc.metadata.journal,
          publisher: doc.metadata.publisher,
          filename: path.basename(sample.input),
        });
        const inferredType: string =
          (inferred as any)?.itemType || 'journalArticle';

        // Normalize raw metadata
        const normalized = normalizer.normalize({
          itemType: inferredType,
          title: doc.metadata.title,
          creators:
            doc.metadata.creators ||
            (doc.metadata.authors || []).map((a, idx) => ({
              creatorType: 'author',
              fullName: a,
              orderIndex: idx,
            })),
          doi: doc.metadata.doi,
          arxivId: doc.metadata.arxivId,
          pmid: doc.metadata.pmid,
          journal: doc.metadata.journal,
          publicationTitle: doc.metadata.journal || doc.metadata.publisher,
          year: doc.metadata.year,
          abstract: doc.metadata.abstract,
        });

        const elapsed = Math.round(performance.now() - start);

        const title = normalized.title || doc.metadata.title || '';
        const titleMatch = sample.groundTruth.expectedTitleSnippet
          ? title
              .toLowerCase()
              .includes(sample.groundTruth.expectedTitleSnippet.toLowerCase())
          : false;

        const authors = (normalized.creators || []).map(
          (c: any) =>
            c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        );
        const year = normalized.year || doc.metadata.year;
        const yearMatch = sample.groundTruth.expectedYear
          ? year === sample.groundTruth.expectedYear
          : true;

        const doi = normalized.doi || doc.metadata.doi;
        const venue =
          normalized.publicationTitle ||
          normalized.journal ||
          doc.metadata.publisher ||
          '';
        const completeness = calculateCompleteness(normalized);

        results.push({
          id: sample.id,
          type: sample.type,
          name: sample.name,
          category: sample.category,
          input: path.basename(sample.input),
          durationMs: elapsed,
          inferredItemType: String(
            normalized.itemType || inferredType || 'journalArticle',
          ),
          title,
          titleMatch,
          authors,
          authorsCount: authors.length,
          hasAuthors: authors.length > 0,
          year,
          yearMatch,
          doi,
          hasDoi: Boolean(doi),
          venueOrPublisher: venue,
          hasVenue: Boolean(venue),
          abstractSnippet: normalized.abstract
            ? normalized.abstract.substring(0, 100) + '...'
            : undefined,
          hasAbstract: Boolean(normalized.abstract),
          completenessScore: completeness,
          pipelineNotes: `Engine: ${doc.metadata.engineUsed || 'LOCAL_CASCADE'}, Quality: ${doc.metadata.qualityScore || 0}, SelfSufficient: ${doc.metadata.isSelfSufficient ? 'YES' : 'NO'}`,
        });

        console.log(
          `  Done in ${elapsed}ms | Type: ${normalized.itemType || inferredType} | Title: "${title.substring(0, 45)}..." | Completeness: ${completeness}%`,
        );
      } else {
        // LINK / URL
        const scraped = await urlScraper.scrape(sample.input);
        const normalized = normalizer.normalize({
          itemType: scraped.itemType || 'webpage',
          title: scraped.title,
          creators:
            scraped.creators ||
            (scraped.authors || []).map((a, idx) => ({
              creatorType: 'author',
              fullName: a,
              orderIndex: idx,
            })),
          doi: scraped.doi,
          arxivId: scraped.arxivId,
          pmid: scraped.pmid,
          isbn: scraped.isbn,
          journal: scraped.journal,
          publicationTitle:
            scraped.publicationTitle || scraped.journal || scraped.publisher,
          year: scraped.year,
          abstract: scraped.abstract,
        });

        const elapsed = Math.round(performance.now() - start);

        const title = normalized.title || scraped.title || '';
        const titleMatch = sample.groundTruth.expectedTitleSnippet
          ? title
              .toLowerCase()
              .includes(sample.groundTruth.expectedTitleSnippet.toLowerCase())
          : false;

        const authors = (normalized.creators || []).map(
          (c: any) =>
            c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
        );
        const year = normalized.year || scraped.year;
        const yearMatch = sample.groundTruth.expectedYear
          ? year === sample.groundTruth.expectedYear
          : true;

        const doi = normalized.doi || scraped.doi;
        const venue =
          normalized.publicationTitle ||
          normalized.journal ||
          scraped.publisher ||
          '';
        const completeness = calculateCompleteness(normalized);

        results.push({
          id: sample.id,
          type: sample.type,
          name: sample.name,
          category: sample.category,
          input: sample.input,
          durationMs: elapsed,
          inferredItemType:
            normalized.itemType || scraped.itemType || 'webpage',
          title,
          titleMatch,
          authors,
          authorsCount: authors.length,
          hasAuthors: authors.length > 0,
          year,
          yearMatch,
          doi,
          hasDoi: Boolean(doi),
          venueOrPublisher: venue,
          hasVenue: Boolean(venue),
          abstractSnippet: normalized.abstract
            ? normalized.abstract.substring(0, 100) + '...'
            : undefined,
          hasAbstract: Boolean(normalized.abstract),
          completenessScore: completeness,
          pipelineNotes: `Ladder Step: ${scraped.ladderStepReached ?? 1}, Confidence: ${scraped.confidence}, Blocked: ${scraped.isBlocked ? 'YES' : 'NO'}`,
        });

        console.log(
          `  Done in ${elapsed}ms | Type: ${normalized.itemType || scraped.itemType || 'webpage'} | Title: "${title.substring(0, 45)}..." | Completeness: ${completeness}%`,
        );
      }
    } catch (err: any) {
      const elapsed = Math.round(performance.now() - start);
      console.error(
        `  Error processing sample ${sample.id}:`,
        err?.message || err,
      );
      results.push({
        id: sample.id,
        type: sample.type,
        name: sample.name,
        category: sample.category,
        input: sample.input,
        durationMs: elapsed,
        inferredItemType: 'unknown',
        title: '',
        titleMatch: false,
        authors: [],
        authorsCount: 0,
        hasAuthors: false,
        yearMatch: false,
        hasDoi: false,
        hasVenue: false,
        hasAbstract: false,
        completenessScore: 0,
        pipelineNotes: `Error: ${err?.message || err}`,
      });
    }
  }

  // Save detailed results to JSON
  const outputPath =
    'C:/Users/Admin/.gemini/antigravity/brain/4fa6911d-e2fe-44bd-a10a-14c162f38e53/batch_20_benchmark_results.json';
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nBenchmark completed. Results written to ${outputPath}`);

  // Summary statistics
  const fileResults = results.filter((r) => r.type === 'FILE');
  const linkResults = results.filter((r) => r.type === 'LINK');

  const avgFileDuration = Math.round(
    fileResults.reduce((a, b) => a + b.durationMs, 0) /
      Math.max(1, fileResults.length),
  );
  const avgLinkDuration = Math.round(
    linkResults.reduce((a, b) => a + b.durationMs, 0) /
      Math.max(1, linkResults.length),
  );

  const avgFileCompleteness = Math.round(
    fileResults.reduce((a, b) => a + b.completenessScore, 0) /
      Math.max(1, fileResults.length),
  );
  const avgLinkCompleteness = Math.round(
    linkResults.reduce((a, b) => a + b.completenessScore, 0) /
      Math.max(1, linkResults.length),
  );

  const fileTitleAccuracy = Math.round(
    (fileResults.filter((r) => r.titleMatch).length /
      Math.max(1, fileResults.length)) *
      100,
  );
  const linkTitleAccuracy = Math.round(
    (linkResults.filter((r) => r.titleMatch).length /
      Math.max(1, linkResults.length)) *
      100,
  );

  console.log(
    '\n================================================================',
  );
  console.log('                     BENCHMARK SUMMARY MATRIX');
  console.log(
    '================================================================',
  );
  console.log(
    `[Track 1 - PDF Files (10)]: Title Accuracy: ${fileTitleAccuracy}%, Avg Completeness: ${avgFileCompleteness}%, Avg Latency: ${avgFileDuration}ms`,
  );
  console.log(
    `[Track 2 - Links / URLs (10)]: Title Accuracy: ${linkTitleAccuracy}%, Avg Completeness: ${avgLinkCompleteness}%, Avg Latency: ${avgLinkDuration}ms`,
  );
  console.log(
    `[Overall (20 Samples)]: Avg Completeness: ${Math.round((avgFileCompleteness + avgLinkCompleteness) / 2)}%`,
  );
  console.log(
    '================================================================',
  );
}

runBenchmark().catch(console.error);
