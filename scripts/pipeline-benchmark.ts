/**
 * Pipeline Accuracy Benchmark — d:\project\flux\zotero\pdfs\
 *
 * Tests the actual library pipeline components:
 *   1. DOI extraction from PDF text (mirrors PdfDoiExtractor.extractFromText)
 *   2. CrossRef metadata resolution (mirrors DoiResolver.resolve)
 *
 * Filenames follow Zotero Better BibTeX format: AuthorYEARKeyword_title_slug.pdf
 * This allows us to parse ground truth (author, year) from the filename itself.
 *
 * Run: cd backend && npx ts-node --project tsconfig.json scripts/pipeline-benchmark.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// ── Config ────────────────────────────────────────────────────────────────────
const PDF_DIR = 'd:\\project\\flux\\zotero\\pdfs';
const SAMPLE_SIZE = 20; // Run on 20 PDFs for speed; set to 100 for full run
const RATE_LIMIT_MS = 1000; // CrossRef free tier: 50 req/s — 1s safe margin

// ── DOI patterns (identical to PdfDoiExtractor) ────────────────────────────────
const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"'<>[\]{}|\\^`\u0000-\u001F\u007F-\u009F]{2,})/g;
const ARXIV_PATTERN = /(?:arxiv[:\s\/]+)(\d{4}\.\d{4,5}(?:v\d+)?)/gi;

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function fetchJson(url: string): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'flux-pipeline-benchmark/1.0 (mailto:dev@flux.app)' },
    }, (res) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

async function resolveViaCrossRef(doi: string): Promise<any | null> {
  const res = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  return res?.status === 'ok' ? res.message : null;
}

// ── PDF text extraction — first 50KB only (same limit as pipeline) ─────────────
function extractPdfText(pdfPath: string): string {
  const SCAN_LIMIT = 51200;
  const buf = Buffer.allocUnsafe(SCAN_LIMIT);
  const fd = fs.openSync(pdfPath, 'r');
  const n = fs.readSync(fd, buf, 0, SCAN_LIMIT, 0);
  fs.closeSync(fd);
  // Convert to readable ASCII — same approach as pdf-parse fallback
  return buf.slice(0, n).toString('latin1').replace(/[^\x20-\x7E\r\n]/g, ' ').replace(/\s+/g, ' ');
}

// ── Parse ground truth from Zotero Better BibTeX filename ─────────────────────
// Format: AuthorYEARKeyword_title_slug_words.pdf
// Example: Vaswani2017Attention_attention_is_all_you_need.pdf
function parseFilenameGT(filename: string): { author: string; year: number | null; keyword: string } {
  const base = filename.replace(/\.pdf$/i, '');
  const match = base.match(/^([A-Za-z]+)(\d{4})([A-Za-z]+)_/);
  if (match) {
    return {
      author: match[1],
      year: parseInt(match[2], 10),
      keyword: match[3],
    };
  }
  return { author: '', year: null, keyword: '' };
}

// ── Result type ───────────────────────────────────────────────────────────────
interface BenchmarkResult {
  filename: string;
  gtAuthor: string;
  gtYear: number | null;
  gtKeyword: string;

  // Step 1: DOI scan
  doiScanResult: 'found' | 'arxiv_only' | 'none';
  rawDois: string[];
  selectedDoi: string | null;
  selectedArxiv: string | null;

  // Step 2: Metadata
  provider: string;
  title: string | null;
  authors: string[];
  year: number | null;
  journal: string | null;
  abstract: string | null;
  confidenceScore: number;

  // Step 3: Accuracy
  yearAccurate: boolean | null;
  authorAccurate: boolean | null;
  fieldCoverage: number; // 0–5: doi, title, authors, year, abstract
  missingFields: string[];
  issues: string[];

  durationMs: number;
}

async function benchmarkOne(pdfPath: string): Promise<BenchmarkResult> {
  const t0 = Date.now();
  const filename = path.basename(pdfPath);
  const gt = parseFilenameGT(filename);

  const r: BenchmarkResult = {
    filename,
    gtAuthor: gt.author,
    gtYear: gt.year,
    gtKeyword: gt.keyword,
    doiScanResult: 'none',
    rawDois: [],
    selectedDoi: null,
    selectedArxiv: null,
    provider: 'none',
    title: null,
    authors: [],
    year: null,
    journal: null,
    abstract: null,
    confidenceScore: 0,
    yearAccurate: null,
    authorAccurate: null,
    fieldCoverage: 0,
    missingFields: [],
    issues: [],
    durationMs: 0,
  };

  try {
    // ── Step 1: DOI extraction from PDF binary ──────────────────────────────
    const text = extractPdfText(pdfPath);
    const doiHits = [...text.matchAll(DOI_PATTERN)].map(m => m[1]);
    const arxivHits = [...text.matchAll(ARXIV_PATTERN)].map(m => m[1]);

    r.rawDois = [...new Set(doiHits)];

    // Filter: same heuristics as PdfDoiExtractor
    const validDoi = r.rawDois.find(doi =>
      doi.length > 8 &&
      doi.length < 150 &&
      !doi.endsWith('.') &&
      !doi.includes('..') &&
      doi.split('/').length >= 2 &&
      !doi.includes('example.') &&
      !doi.toLowerCase().includes('placeholder')
    )?.replace(/[.,;:)\]>]+$/, '');

    if (validDoi) {
      r.selectedDoi = validDoi;
      r.doiScanResult = 'found';
    } else if (arxivHits.length > 0) {
      r.selectedArxiv = arxivHits[0];
      r.selectedDoi = `10.48550/arXiv.${arxivHits[0].replace(/v\d+$/, '')}`;
      r.doiScanResult = 'arxiv_only';
    } else {
      r.doiScanResult = 'none';
      r.issues.push('DOI not found in first 50KB of PDF');
    }

    // ── Step 2: CrossRef resolution ─────────────────────────────────────────
    if (r.selectedDoi) {
      const cr = await resolveViaCrossRef(r.selectedDoi);
      if (cr) {
        r.title = Array.isArray(cr.title) ? cr.title[0] : cr.title ?? null;
        r.authors = (cr.author || []).map((a: any) =>
          [a.family, a.given].filter(Boolean).join(', ')
        );
        r.year = cr.published?.['date-parts']?.[0]?.[0] ?? null;
        r.journal = cr['container-title']?.[0] ?? cr.publisher ?? null;
        r.abstract = cr.abstract ? cr.abstract.replace(/<[^>]*>/g, '').trim().slice(0, 300) : null;
        r.provider = 'CrossRef';
        r.confidenceScore = 0.98;
      } else {
        r.issues.push(`CrossRef: no record for DOI "${r.selectedDoi}"`);
        r.provider = 'crossref_miss';
        r.confidenceScore = 0;
      }
    }

    // Filename fallback (what pipeline currently does)
    if (!r.title) {
      r.title = filename.replace(/\.pdf$/i, '').replace(/_/g, ' ');
      r.provider = 'filename_fallback';
      r.confidenceScore = 0;
      r.issues.push('FALLBACK: all resolvers failed — title from filename only');
    }

    // ── Step 3: Field coverage ──────────────────────────────────────────────
    const fields = [r.selectedDoi, r.title, r.authors.length > 0, r.year, r.abstract];
    const fieldNames = ['doi', 'title', 'authors', 'year', 'abstract'];
    r.missingFields = fieldNames.filter((_, i) => !fields[i]);
    r.fieldCoverage = fields.filter(Boolean).length;

    // ── Step 4: Accuracy vs filename ground truth ───────────────────────────
    if (gt.year) {
      // Allow ±1 year (preprint vs published)
      r.yearAccurate = r.year !== null && Math.abs(r.year - gt.year) <= 1;
      if (r.year && !r.yearAccurate) r.issues.push(`Year: got ${r.year}, expected ~${gt.year}`);
    }
    if (gt.author) {
      const resolved1stAuthor = (r.authors[0] || '').split(',')[0].trim().toLowerCase();
      r.authorAccurate = resolved1stAuthor.length > 0 &&
        (resolved1stAuthor.includes(gt.author.toLowerCase()) ||
         gt.author.toLowerCase().includes(resolved1stAuthor.slice(0, 4)));
      if (!r.authorAccurate && r.authors.length > 0) {
        r.issues.push(`Author: got "${r.authors[0]}", expected first author starting with "${gt.author}"`);
      }
    }

  } catch (err: any) {
    r.issues.push(`ERROR: ${err.message}`);
  }

  r.durationMs = Date.now() - t0;
  return r;
}

// ── Report ────────────────────────────────────────────────────────────────────
function printReport(results: BenchmarkResult[]): void {
  const W = 80;
  console.log('\n' + '═'.repeat(W));
  console.log('  FLUX LIBRARY PIPELINE — ACCURACY BENCHMARK REPORT');
  console.log(`  d:\\project\\flux\\zotero\\pdfs  |  n=${results.length}  |  ${new Date().toISOString()}`);
  console.log('═'.repeat(W));

  // Per-paper details
  for (const r of results) {
    const icon = r.provider === 'filename_fallback' ? '🔴'
      : r.provider === 'crossref_miss' ? '🟠'
      : r.issues.length > 0 ? '⚠️ '
      : '✅';
    console.log(`\n${icon} ${r.filename.slice(0, 72)}`);
    console.log(`   GT        : author=${r.gtAuthor}, year=${r.gtYear}, kw=${r.gtKeyword}`);
    console.log(`   DOI scan  : ${r.doiScanResult} | ${r.selectedDoi ?? r.selectedArxiv ?? '—'}`);
    console.log(`   Provider  : ${r.provider} (score=${r.confidenceScore})`);
    console.log(`   Title     : ${(r.title || '').slice(0, 70)}`);
    console.log(`   Authors   : ${r.authors.slice(0, 3).join(' | ') || '—'}`);
    console.log(`   Year/Venue: ${r.year ?? '—'} / ${r.journal ?? '—'}`);
    console.log(`   Abstract  : ${r.abstract ? '✅ ' + r.abstract.length + ' chars' : '❌ missing'}`);
    console.log(`   Coverage  : ${r.fieldCoverage}/5 fields${r.missingFields.length ? ' | missing=[' + r.missingFields.join(',') + ']' : ''}`);
    console.log(`   Year ok?  : ${r.yearAccurate === null ? 'N/A' : r.yearAccurate ? '✅' : '❌'}`);
    console.log(`   Author ok?: ${r.authorAccurate === null ? 'N/A' : r.authorAccurate ? '✅' : '❌'}`);
    r.issues.forEach(i => console.log(`   ⚠  ${i}`));
    console.log(`   Time      : ${r.durationMs}ms`);
  }

  // Aggregate stats
  const n = results.length;
  const doiFound = results.filter(r => r.doiScanResult !== 'none').length;
  const crResolved = results.filter(r => r.provider === 'CrossRef').length;
  const fallback = results.filter(r => r.provider === 'filename_fallback').length;
  const crMiss = results.filter(r => r.provider === 'crossref_miss').length;
  const withYear = results.filter(r => r.yearAccurate !== null);
  const yearOk = withYear.filter(r => r.yearAccurate).length;
  const withAuthor = results.filter(r => r.authorAccurate !== null);
  const authorOk = withAuthor.filter(r => r.authorAccurate).length;
  const avgCoverage = (results.reduce((s, r) => s + r.fieldCoverage, 0) / n).toFixed(2);
  const fullCoverage = results.filter(r => r.fieldCoverage === 5).length;

  const pct = (a: number, b: number) => b > 0 ? `${((a/b)*100).toFixed(0)}%` : 'N/A';

  console.log('\n' + '─'.repeat(W));
  console.log(`  AGGREGATE METRICS  (n=${n})`);
  console.log('─'.repeat(W));
  console.log(`  DOI Extraction Rate      : ${pct(doiFound, n)}  (${doiFound}/${n})`);
  console.log(`  CrossRef Resolution Rate : ${pct(crResolved, n)}  (${crResolved}/${n})`);
  console.log(`  CrossRef Miss (DOI found but no record) : ${crMiss}`);
  console.log(`  Filename Fallback Rate   : ${pct(fallback, n)}  (${fallback}/${n})  ← papers with 0 metadata`);
  console.log(`  Year Accuracy            : ${pct(yearOk, withYear.length)}  (${yearOk}/${withYear.length})`);
  console.log(`  First Author Accuracy    : ${pct(authorOk, withAuthor.length)}  (${authorOk}/${withAuthor.length})`);
  console.log(`  Avg Field Coverage       : ${avgCoverage}/5`);
  console.log(`  Full 5/5 Coverage        : ${pct(fullCoverage, n)}  (${fullCoverage}/${n})`);

  // Best practice
  const best = results.filter(r => r.provider === 'CrossRef' && r.fieldCoverage >= 4 && r.yearAccurate && r.authorAccurate);
  console.log(`\n  ✅ BEST PRACTICE — fully resolved (${best.length} papers):`);
  best.slice(0, 5).forEach(r => console.log(`     DOI scan → CrossRef → ${r.fieldCoverage}/5 fields ← ${r.filename.slice(0, 55)}`));

  // Bad practice
  console.log(`\n  ❌ BAD PRACTICE — pipeline failures:`);
  const bad = results.filter(r => r.provider !== 'CrossRef' || r.fieldCoverage < 3);
  bad.slice(0, 10).forEach(r => {
    console.log(`     [${r.provider}] ${r.filename.slice(0, 55)}`);
    r.issues.slice(0, 2).forEach(i => console.log(`       → ${i}`));
  });

  // Gaps & recommendations
  console.log('\n  📋 GAPS IDENTIFIED:');
  const noAbstract = results.filter(r => !r.abstract && r.provider === 'CrossRef').length;
  const noJournal = results.filter(r => !r.journal && r.provider === 'CrossRef').length;
  if (noAbstract > 0) console.log(`     • ${noAbstract} papers resolved via CrossRef but have NO abstract (CrossRef doesn't store abstracts for all works)`);
  if (noJournal > 0) console.log(`     • ${noJournal} papers resolved via CrossRef but have NO venue/journal`);
  if (crMiss > 0) console.log(`     • ${crMiss} DOIs found in PDF but not registered in CrossRef → need Semantic Scholar / OpenAlex fallback`);
  if (fallback > 0) console.log(`     • ${fallback} papers with no DOI → need title-based search fallback (S2 searchByTitle)`);

  console.log('\n' + '═'.repeat(W) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(PDF_DIR)) {
    console.error('PDF directory not found:', PDF_DIR);
    process.exit(1);
  }

  const allPdfs = fs.readdirSync(PDF_DIR)
    .filter(f => f.endsWith('.pdf'))
    .map(f => path.join(PDF_DIR, f))
    .slice(0, SAMPLE_SIZE);

  console.log(`\nRunning pipeline benchmark on ${allPdfs.length} PDFs from ${PDF_DIR}\n`);

  const results: BenchmarkResult[] = [];
  for (const pdf of allPdfs) {
    const name = path.basename(pdf).slice(0, 58).padEnd(60);
    process.stdout.write(`  → ${name}`);
    const r = await benchmarkOne(pdf);
    results.push(r);
    const icon = r.provider === 'CrossRef' && r.fieldCoverage >= 4 ? '✅'
      : r.provider === 'filename_fallback' ? '🔴'
      : '⚠️';
    console.log(` ${icon} cov=${r.fieldCoverage}/5 doi=${r.doiScanResult} ${r.durationMs}ms`);
    await new Promise(res => setTimeout(res, RATE_LIMIT_MS));
  }

  printReport(results);
}

main().catch(err => { console.error(err); process.exit(1); });
