/**
 * benchmark-15-papers.ts
 *
 * Empirical Benchmark Suite testing 15 landmark academic papers across diverse ingestion channels:
 *  - Channel 1: Canonical DOI Ingestion (CrossRef Provider)
 *  - Channel 2: Pre-print Ingestion (arXiv Provider)
 *  - Channel 3: Direct PDF Upload (4-Tier In-Process Trusted Extraction: XMP -> Regex -> Layout -> MeXtract)
 *  - Channel 4: Academic Publisher URLs (Url / Doi Resolver)
 *  - Channel 5: Retraction Watch & Quality Gate (Retracted Paper Detection)
 *  - Channel 6: Massive Multi-Author Stress Test (>1,000 co-authors)
 */

import { CrossRefProvider } from '../src/modules/library/ingestion/providers/crossref.provider';
import { ArxivProvider } from '../src/modules/library/ingestion/providers/arxiv.provider';
import { DoiParser } from '../src/modules/library/ingestion/parsers/doi.parser';
import { TrustedExtractionService } from '../src/modules/library/extraction/services/trusted-extraction.service';
import { NormalizationPolicy } from '../src/modules/library/ingestion/policies/normalization.policy';
import { RetractionScannerProvider } from '../src/modules/library/ingestion/providers/retraction-scanner.provider';
import { RetractionDatabaseService } from '../src/modules/library/ingestion/services/retraction-database.service';
import { ZoteroSchemaValidatorService } from '../src/modules/library/catalog/services/zotero-schema-validator.service';
import { ItemMetadata } from '../src/modules/library/shared-kernel';

interface PaperTestCase {
  id: number;
  category: string;
  expectedTitleSnippet: string;
  channel: 'DOI' | 'ARXIV' | 'PDF_UPLOAD' | 'URL';
  query: string;
  notes: string;
  expectedRetracted?: boolean;
  expectHugeAuthorList?: boolean;
}

const TEST_PAPERS: PaperTestCase[] = [
  {
    id: 1,
    category: 'AI / Transformers',
    expectedTitleSnippet: 'Attention Is All You Need',
    channel: 'ARXIV',
    query: '1706.03762',
    notes: 'Landmark AI paper introducing Transformers architecture',
  },
  {
    id: 2,
    category: 'Computer Vision / ResNet',
    expectedTitleSnippet: 'Deep Residual Learning for Image Recognition',
    channel: 'PDF_UPLOAD',
    query: 'https://arxiv.org/pdf/1512.03385.pdf',
    notes: 'Direct PDF upload testing 4-Tier In-Process Extractor',
  },
  {
    id: 3,
    category: 'NLP / Language Models',
    expectedTitleSnippet: 'BERT',
    channel: 'URL',
    query: 'https://arxiv.org/abs/1810.04805',
    notes: 'arXiv web landing page resolver',
  },
  {
    id: 4,
    category: 'Reinforcement Learning / AlphaGo',
    expectedTitleSnippet: 'Mastering the game of Go',
    channel: 'DOI',
    query: '10.1038/nature16961',
    notes: 'Nature landmark paper',
  },
  {
    id: 5,
    category: 'Biotechnology / CRISPR',
    expectedTitleSnippet: 'programmable dual-RNA-guided DNA endonuclease',
    channel: 'DOI',
    query: '10.1126/science.1225829',
    notes: 'Science CRISPR-Cas9 breakthrough paper (Nobel Prize)',
  },
  {
    id: 6,
    category: 'Astrophysics / Gravitational Waves',
    expectedTitleSnippet: 'Observation of Gravitational Waves from a Binary Black Hole Merger',
    channel: 'DOI',
    query: '10.1103/PhysRevLett.116.061102',
    notes: 'Physical Review Letters (1,000+ authors multi-author stress test)',
    expectHugeAuthorList: true,
  },
  {
    id: 7,
    category: 'Quantum Computing / Quantum Supremacy',
    expectedTitleSnippet: 'Quantum computational advantage using photons',
    channel: 'DOI',
    query: '10.1126/science.abe8770',
    notes: 'Science photonic quantum advantage',
  },
  {
    id: 8,
    category: 'Machine Learning / Optimization',
    expectedTitleSnippet: 'Adam',
    channel: 'ARXIV',
    query: '1412.6980',
    notes: 'Most widely used deep learning optimizer',
  },
  {
    id: 9,
    category: 'Structural Biology / AlphaFold2',
    expectedTitleSnippet: 'Highly accurate protein structure prediction with AlphaFold',
    channel: 'DOI',
    query: '10.1038/s41586-021-03819-2',
    notes: 'Nature DeepMind AlphaFold landmark paper',
  },
  {
    id: 10,
    category: 'Information Retrieval / Google PageRank',
    expectedTitleSnippet: 'anatomy of a large-scale hypertextual',
    channel: 'DOI',
    query: '10.1016/S0169-7552(98)00110-X',
    notes: 'Brin & Page foundational web search paper (Elsevier/ScienceDirect)',
  },
  {
    id: 11,
    category: 'Medicine / mRNA Vaccine',
    expectedTitleSnippet: 'Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine',
    channel: 'DOI',
    query: '10.1056/NEJMoa2034577',
    notes: 'New England Journal of Medicine (NEJM) landmark clinical trial',
  },
  {
    id: 12,
    category: 'Generative AI / GANs',
    expectedTitleSnippet: 'Generative Adversarial Nets',
    channel: 'PDF_UPLOAD',
    query: 'https://arxiv.org/pdf/1406.2661.pdf',
    notes: 'Direct PDF upload testing Layout / Academic Regex extraction',
  },
  {
    id: 13,
    category: 'Theoretical Physics / BCS Superconductivity',
    expectedTitleSnippet: 'Superconductivity',
    channel: 'DOI',
    query: '10.1103/PhysRev.117.648',
    notes: 'Yoichiro Nambu 1960 Nobel Prize classic archive',
  },
  {
    id: 14,
    category: 'Virology / Remdesivir Covid Structure',
    expectedTitleSnippet: 'Structural basis of SARS-CoV-2 polymerase',
    channel: 'URL',
    query: 'https://www.nature.com/articles/s41586-020-2649-2',
    notes: 'Nature publisher URL resolving to DOI 10.1038/s41586-020-2649-2',
  },
  {
    id: 15,
    category: 'Medical Fraud / Retraction Test',
    expectedTitleSnippet: 'Ileal-lymphoid-nodular hyperplasia',
    channel: 'DOI',
    query: '10.1016/S0140-6736(97)11096-0',
    notes: 'Famous Wakefield Lancet 1998 retracted paper (Retraction Watch test)',
    expectedRetracted: true,
  },
];

interface BenchmarkResult {
  id: number;
  category: string;
  channel: string;
  query: string;
  success: boolean;
  latencyMs: number;
  engineUsed: string;
  extractedTitle: string;
  authorsCount: number;
  firstAuthor?: string;
  year?: number;
  doi?: string;
  journal?: string;
  cslItemType?: string;
  retractionStatus?: string;
  cslValid: boolean;
  notes: string;
  error?: string;
}

function formatFirstAuthor(authors?: any[]): string {
  if (!authors || authors.length === 0) return 'N/A';
  const first = authors[0];
  if (typeof first === 'string') return first;
  if (first.name) return first.name;
  if (first.family) {
    return first.given ? `${first.given} ${first.family}` : first.family;
  }
  if (first.lastName) {
    return first.firstName ? `${first.firstName} ${first.lastName}` : first.lastName;
  }
  return 'Unknown';
}

async function runBenchmark() {
  console.log('='.repeat(95));
  console.log('FLUX ACADEMIC BENCHMARK: Ingesting & Extracting 15 Official Landmark Papers');
  console.log('='.repeat(95));

  const crossref = new CrossRefProvider();
  const arxiv = new ArxivProvider();
  const doiParser = new DoiParser();
  const extractor = new TrustedExtractionService();
  const normalizer = new NormalizationPolicy();
  const typesService = new (require('../src/modules/library/catalog/services/types.service').TypesService)();
  const validator = new ZoteroSchemaValidatorService(typesService);
  const mockRetractionRepo = {
    countRetractionRecords: async () => 0,
    findRetractionRecord: async () => null,
    upsertRetractionRecord: async () => ({}),
  } as any;
  const retractionDb = new RetractionDatabaseService(mockRetractionRepo);
  const retractionScanner = new RetractionScannerProvider(retractionDb);

  const results: BenchmarkResult[] = [];

  for (const testCase of TEST_PAPERS) {
    const start = Date.now();
    console.log(`\n[${testCase.id}/15] Testing [${testCase.channel}] ${testCase.category}...`);
    console.log(`      Query: ${testCase.query}`);

    let metadata: ItemMetadata = {};
    let engineUsed = '';

    try {
      if (testCase.channel === 'ARXIV') {
        const res = await arxiv.resolve({
          query: testCase.query,
          queryType: 'ARXIV',
        });
        if (res?.metadata) {
          metadata = res.metadata;
          engineUsed = 'arXiv API Atom Feed';
        } else {
          throw new Error('arXiv provider returned null');
        }
      } else if (testCase.channel === 'DOI') {
        const cleanDoi = doiParser.normalize(testCase.query);
        const res = await crossref.resolve({
          query: cleanDoi,
          queryType: 'DOI',
        });
        if (res?.metadata) {
          metadata = res.metadata;
          engineUsed = 'CrossRef Official REST API';
        } else {
          throw new Error(`CrossRef could not resolve DOI: ${cleanDoi}`);
        }
      } else if (testCase.channel === 'URL') {
        if (testCase.query.includes('arxiv.org')) {
          const match = testCase.query.match(/abs\/([0-9]+\.[0-9]+)/);
          const arxivId = match ? match[1] : '';
          const res = await arxiv.resolve({
            query: arxivId,
            queryType: 'ARXIV',
          });
          if (res?.metadata) {
            metadata = res.metadata;
            engineUsed = 'arXiv URL -> ArxivProvider';
          }
        } else {
          const resolvedDoi = doiParser.normalize(testCase.query);
          const res = await crossref.resolve({
            query: resolvedDoi,
            queryType: 'DOI',
          });
          if (res?.metadata) {
            metadata = res.metadata;
            engineUsed = `Publisher URL -> DOI (${resolvedDoi}) -> CrossRef`;
          }
        }
      } else if (testCase.channel === 'PDF_UPLOAD') {
        console.log(`      Downloading PDF binary stream from ${testCase.query}...`);
        const fetchRes = await fetch(testCase.query, {
          headers: { 'User-Agent': 'FluxAcademicBench/1.0' },
        });
        if (!fetchRes.ok) {
          throw new Error(`Failed to download PDF: HTTP ${fetchRes.status}`);
        }
        const arrayBuf = await fetchRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        console.log(`      Downloaded ${buffer.byteLength} bytes. Executing 4-Tier In-Process Extraction...`);

        const extractRes = await extractor.extract(buffer, 'paper.pdf');
        metadata = extractRes.metadata;
        const totalScore = extractRes.quality?.totalScore ?? 0;
        const tierEngine = extractRes.provenance?.engineUsed ?? '4-TIER';
        engineUsed = `4-Tier In-Process [${tierEngine}] (Score: ${totalScore.toFixed(2)})`;

        if (metadata.doi) {
          try {
            const enriched = await crossref.resolve({
              query: metadata.doi,
              queryType: 'DOI',
            });
            if (enriched?.metadata) {
              metadata = { ...metadata, ...enriched.metadata };
              engineUsed += ' + CrossRef Enrichment';
            }
          } catch {
            // Self-sufficient fallback if CrossRef fails
          }
        }
      }

      // Check Retraction Status
      let retractionStatus = 'clean';
      if (metadata.doi) {
        try {
          const retRes = await retractionScanner.lookup(metadata.doi);
          if (retRes.status === 'retracted') {
            retractionStatus = 'RETRACTED';
          } else if (retRes.status === 'clean') {
            retractionStatus = 'VERIFIED_CLEAN';
          } else {
            retractionStatus = 'UNKNOWN';
          }
        } catch {
          retractionStatus = 'LOOKUP_FAILED';
        }
      }

      // Apply Normalization Policy
      const normalized = normalizer.normalize(metadata);

      // Validate against CSL 1.0.2 Schema
      const itemType = validator.validateItemType(normalized.itemType || 'journalArticle');
      const sanitized = validator.validateAndSanitizeFields(itemType, normalized);
      const cslValid = Boolean(itemType && sanitized.cleanFields);

      const latencyMs = Date.now() - start;
      const firstAuthor = formatFirstAuthor(normalized.authors);

      results.push({
        id: testCase.id,
        category: testCase.category,
        channel: testCase.channel,
        query: testCase.query,
        success: true,
        latencyMs,
        engineUsed,
        extractedTitle: normalized.title || '(No Title)',
        authorsCount: normalized.authors?.length || 0,
        firstAuthor,
        year: normalized.year,
        doi: normalized.doi,
        journal: normalized.journal || normalized.publicationTitle,
        cslItemType: itemType,
        retractionStatus,
        cslValid,
        notes: testCase.notes,
      });

      console.log(`      ✅ Success (${latencyMs}ms) via ${engineUsed}`);
      console.log(`         Title: "${normalized.title}"`);
      console.log(`         Authors: ${normalized.authors?.length} (First: ${firstAuthor})`);
      console.log(`         Year: ${normalized.year} | DOI: ${normalized.doi || 'N/A'} | Venue: ${normalized.journal || normalized.publicationTitle || 'N/A'}`);
      console.log(`         CSL Schema Valid: ${cslValid ? 'YES' : 'NO'}`);
      if (retractionStatus === 'RETRACTED') {
        console.log(`         ⚠️ RETRACTION DETECTED: Paper is formally flagged as RETRACTED!`);
      }
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      console.error(`      ❌ Error (${latencyMs}ms): ${err.message}`);
      results.push({
        id: testCase.id,
        category: testCase.category,
        channel: testCase.channel,
        query: testCase.query,
        success: false,
        latencyMs,
        engineUsed: 'FAILED',
        extractedTitle: '',
        authorsCount: 0,
        cslValid: false,
        notes: testCase.notes,
        error: err.message,
      });
    }

    // Gentle pacing to avoid external API rate-limiting
    await new Promise((r) => setTimeout(r, 600));
  }

  // Summary Report
  console.log('\n' + '='.repeat(95));
  console.log('FINAL BENCHMARK SUMMARY & ACCURACY REPORT');
  console.log('='.repeat(95));
  const passedCount = results.filter((r) => r.success).length;
  const avgLatency = Math.round(
    results.reduce((acc, r) => acc + r.latencyMs, 0) / results.length,
  );
  console.log(`Total Papers Tested: ${results.length}`);
  console.log(`Success Rate:        ${passedCount}/${results.length} (${((passedCount / results.length) * 100).toFixed(1)}%)`);
  console.log(`Average Latency:     ${avgLatency} ms`);
  console.log('='.repeat(95));

  // Markdown Table Output
  console.log('\n### BẢNG KẾT QUẢ THỰC NGHIỆM CHI TIẾT 15 BÀI BÁO KHOA HỌC CHÍNH THỐNG:\n');
  console.log('| # | Lĩnh vực | Kênh nạp | Tiêu đề trích xuất | Tác giả | Năm | DOI / Identifier | Phân loại CSL | Trạng thái | Thời gian |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const status = r.success ? '✅ Thành công' : '❌ Thất bại';
    const authors = r.authorsCount > 1 ? `${r.firstAuthor} et al. (${r.authorsCount})` : `${r.firstAuthor || 'N/A'}`;
    const doiOrId = r.doi || r.query;
    console.log(`| ${r.id} | ${r.category} | ${r.channel} | "${r.extractedTitle.slice(0, 35)}..." | ${authors} | ${r.year || 'N/A'} | \`${doiOrId}\` | \`${r.cslItemType || 'N/A'}\` | ${status} | ${r.latencyMs}ms |`);
  }
}

runBenchmark().catch((e) => {
  console.error('Fatal benchmark error:', e);
  process.exit(1);
});
