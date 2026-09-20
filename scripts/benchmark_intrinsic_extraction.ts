import * as fs from 'fs';
import * as path from 'path';
import { PdfProvider, ExtractedPdfDocument } from '../src/modules/library/content/infrastructure/providers/pdf.provider';

interface GroundTruthPaper {
  id: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  doi: string;
  landingUrl: string;
  pdfUrl: string;
  filename: string;
}

interface ExtractionScorecard {
  paperId: string;
  filename: string;
  durationMs: number;
  bufferSizeBytes: number;
  
  // Intrinsic Extracted fields
  intrinsic: {
    title?: string;
    authors?: string[];
    year?: number;
    doi?: string;
    arxivId?: string;
    abstractLength: number;
    abstractSnippet?: string;
    numberOfPages?: number;
    keywordsCount: number;
  };

  // Ground Truth fields
  groundTruth: {
    title: string;
    authors: string[];
    year: number;
    doi: string;
    venue: string;
  };

  // Accuracy metrics
  accuracy: {
    titleSimilarityPct: number;
    titleExactMatch: boolean;
    authorRecallPct: number;
    authorCountExtracted: number;
    authorCountExpected: number;
    yearMatch: boolean;
    yearDiff: number;
    identifierFound: boolean;
    identifierType: 'DOI' | 'ARXIV' | 'BOTH' | 'NONE';
    abstractExtracted: boolean;
  };

  // Enrichment data (supplementary)
  enrichment?: {
    source: 'CrossRef' | 'arXiv' | 'None';
    durationMs: number;
    canonicalTitle?: string;
    canonicalVenue?: string;
    citationCount?: number;
    publisher?: string;
    hasAuthorAffiliations: boolean;
    addedFields: string[];
  };
}

// ── Text Similarity Utilities ──────────────────────────────────────────────────
function normalizeString(str: string): string {
  return (str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeTokenJaccard(s1: string, s2: string): number {
  const t1 = new Set(normalizeString(s1).split(' ').filter(Boolean));
  const t2 = new Set(normalizeString(s2).split(' ').filter(Boolean));
  if (t1.size === 0 && t2.size === 0) return 1.0;
  if (t1.size === 0 || t2.size === 0) return 0.0;
  
  let intersection = 0;
  for (const token of t1) {
    if (t2.has(token)) intersection++;
  }
  const union = new Set([...t1, ...t2]).size;
  return Number(((intersection / union) * 100).toFixed(1));
}

function computeAuthorRecall(extractedAuthors: string[], gtAuthors: string[]): number {
  if (!gtAuthors || gtAuthors.length === 0) return 100;
  if (!extractedAuthors || extractedAuthors.length === 0) return 0;

  const extractedJoined = extractedAuthors.map(a => normalizeString(a)).join(' ');
  let matches = 0;

  for (const gtAuthor of gtAuthors) {
    const parts = gtAuthor.trim().split(/\s+/);
    const lastName = normalizeString(parts[parts.length - 1]);
    if (lastName.length > 2 && extractedJoined.includes(lastName)) {
      matches++;
    }
  }

  return Number(((matches / gtAuthors.length) * 100).toFixed(1));
}

// ── Supplementary Enrichment Provider Query ────────────────────────────────────
async function queryEnrichment(doi?: string, arxivId?: string): Promise<{
  source: 'CrossRef' | 'arXiv' | 'None';
  durationMs: number;
  canonicalTitle?: string;
  canonicalVenue?: string;
  citationCount?: number;
  publisher?: string;
  hasAuthorAffiliations: boolean;
  addedFields: string[];
}> {
  const start = Date.now();
  const addedFields: string[] = [];

  // Try CrossRef if DOI is available
  if (doi && !doi.includes('arXiv')) {
    try {
      const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
        headers: { 'User-Agent': 'FluxBenchmark/1.0 (mailto:dev@flux.app)' },
        signal: AbortSignal.timeout(3500),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const msg = data?.message;
        if (msg) {
          const citations = msg['is-referenced-by-count'] ?? 0;
          const publisher = msg.publisher;
          const venue = msg['container-title']?.[0] || msg.event?.name;
          const hasAffiliations = Array.isArray(msg.author) && msg.author.some((a: any) => Array.isArray(a.affiliation) && a.affiliation.length > 0);

          if (citations !== undefined) addedFields.push(`Citation Count (${citations.toLocaleString()})`);
          if (publisher) addedFields.push(`Publisher (${publisher})`);
          if (venue) addedFields.push(`Conference/Journal (${venue})`);
          if (hasAffiliations) addedFields.push('Author Affiliations & Institutional ROIs');
          if (msg.ISSN || msg.ISBN) addedFields.push('Standard Serial Numbers (ISSN/ISBN)');

          return {
            source: 'CrossRef',
            durationMs: Date.now() - start,
            canonicalTitle: msg.title?.[0],
            canonicalVenue: venue,
            citationCount: citations,
            publisher,
            hasAuthorAffiliations: Boolean(hasAffiliations),
            addedFields,
          };
        }
      }
    } catch {
      // Degrade gracefully to arXiv or none
    }
  }

  // Try arXiv API if arxivId is available
  const cleanArxiv = arxivId ? arxivId.replace(/^arxiv:/i, '').replace(/v\d+$/, '') : null;
  if (cleanArxiv) {
    try {
      const res = await fetch(`https://export.arxiv.org/api/query?id_list=${cleanArxiv}`, {
        signal: AbortSignal.timeout(3500),
      });
      if (res.ok) {
        const xml = await res.text();
        const titleMatch = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
        const commentMatch = xml.match(/<arxiv:comment[^>]*>([\s\S]*?)<\/arxiv:comment>/);
        const primaryCatMatch = xml.match(/<arxiv:primary_category[^>]*term="([^"]+)"/);
        const doiMatch = xml.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);

        if (primaryCatMatch?.[1]) addedFields.push(`Primary Category (${primaryCatMatch[1]})`);
        if (commentMatch?.[1]) addedFields.push(`Conference Comments (${commentMatch[1].trim()})`);
        if (doiMatch?.[1]) addedFields.push(`Journal DOI (${doiMatch[1].trim()})`);
        addedFields.push('Authoritative arXiv Atom Entry Link');

        return {
          source: 'arXiv',
          durationMs: Date.now() - start,
          canonicalTitle: titleMatch?.[1]?.replace(/\s+/g, ' ').trim(),
          canonicalVenue: commentMatch?.[1]?.replace(/\s+/g, ' ').trim() || primaryCatMatch?.[1],
          citationCount: undefined, // arXiv does not index citation metrics
          publisher: 'arXiv.org',
          hasAuthorAffiliations: false,
          addedFields,
        };
      }
    } catch {
      // Degrade gracefully
    }
  }

  return {
    source: 'None',
    durationMs: Date.now() - start,
    hasAuthorAffiliations: false,
    addedFields: [],
  };
}

// ── Main Concurrency Benchmark ─────────────────────────────────────────────────
async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('⚡ FLUX INTRINSIC METADATA EXTRACTION BENCHMARK (CONCURRENCY = 10)');
  console.log('='.repeat(80));

  const papersLinksPath = path.resolve('c:/flux/zotero/papers_links.json');
  const papersDir = path.resolve('c:/flux/zotero/papers');

  const allGroundTruth: GroundTruthPaper[] = JSON.parse(fs.readFileSync(papersLinksPath, 'utf-8'));

  // Target 10 representative papers across diverse conference formats, publishers, and sizes
  const targetFilenames = [
    'vaswani2017_attention_is_all_you_need.pdf',
    'he2016_deep_residual_learning.pdf',
    'devlin2019_bert.pdf',
    'brown2020_gpt3_few_shot.pdf',
    'silver2016_alphago_nature.pdf',
    'hu2021_lora.pdf',
    'lewis2020_rag.pdf',
    'touvron2023_llama.pdf',
    'goodfellow2014_gan.pdf',
    'rombach2022_latent_diffusion.pdf',
  ];

  const selectedPapers = targetFilenames.map((fname) => {
    const gt = allGroundTruth.find((p) => p.filename === fname);
    if (!gt) {
      throw new Error(`Paper not found in ground truth: ${fname}`);
    }
    return gt;
  });

  console.log(`\nSelected 10 Papers for Simultaneous Concurrent Extraction:`);
  selectedPapers.forEach((p, idx) => {
    const filePath = path.join(papersDir, p.filename);
    const sizeMb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
    console.log(` [${idx + 1}] ${p.title.slice(0, 45).padEnd(46)} | File: ${p.filename.slice(0, 32).padEnd(33)} | Size: ${sizeMb.padStart(5)} MB`);
  });

  // Preload buffers to measure pure concurrent parsing performance
  console.log('\nReading 10 PDF binaries into RAM...');
  const loadedBuffers = selectedPapers.map((p) => {
    const fullPath = path.join(papersDir, p.filename);
    return {
      paper: p,
      buffer: fs.readFileSync(fullPath),
    };
  });
  const totalBytes = loadedBuffers.reduce((acc, b) => acc + b.buffer.length, 0);
  console.log(`Total memory footprint of 10 PDFs: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

  const provider = new PdfProvider();

  // ── PHASE 1: SIMULTANEOUS CONCURRENT EXTRACTION ───────────────────────────────
  console.log('\n🚀 FIRING ALL 10 EXTRACTIONS SIMULTANEOUSLY (Promise.all)...');
  const benchWallStart = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;

  const extractionPromises = loadedBuffers.map(async ({ paper, buffer }) => {
    const itemStart = performance.now();
    try {
      const extractedDoc: ExtractedPdfDocument = await provider.extractDocumentFromBuffer(buffer, {
        maxPages: 25,
      });
      const itemDuration = Math.round(performance.now() - itemStart);
      return {
        paper,
        bufferSize: buffer.length,
        durationMs: itemDuration,
        doc: extractedDoc,
        error: null,
      };
    } catch (err: any) {
      const itemDuration = Math.round(performance.now() - itemStart);
      return {
        paper,
        bufferSize: buffer.length,
        durationMs: itemDuration,
        doc: null,
        error: err.message || String(err),
      };
    }
  });

  const rawResults = await Promise.all(extractionPromises);
  const benchWallDuration = Math.round(performance.now() - benchWallStart);
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMb = ((heapAfter - heapBefore) / 1024 / 1024).toFixed(2);

  console.log(`\n✅ ALL 10 EXTRACTIONS COMPLETED in ${benchWallDuration} ms total wall-clock time!`);
  console.log(`   Average per paper (concurrent): ${(benchWallDuration / 10).toFixed(1)} ms`);
  console.log(`   Heap memory delta: ${heapDeltaMb} MB`);

  // ── PHASE 2 & 3: ACCURACY SCORING & SUPPLEMENTARY ENRICHMENT ────────────────
  console.log('\n🔍 Evaluating Accuracy vs Ground Truth & Testing Supplementary Enrichment...');
  const scorecards: ExtractionScorecard[] = [];

  for (const res of rawResults) {
    const p = res.paper;
    const meta = res.doc?.metadata || {};

    const extractedTitle = meta.title || '';
    const extractedAuthors = meta.authors || [];
    const extractedYear = meta.year;
    const extractedDoi = meta.doi;
    const extractedArxiv = meta.arxivId;
    const abstract = meta.abstract || '';

    // Accuracy calculations
    const titleSim = computeTokenJaccard(extractedTitle, p.title);
    const titleExact = normalizeString(extractedTitle) === normalizeString(p.title);
    const authorRecall = computeAuthorRecall(extractedAuthors, p.authors);
    const yearMatch = extractedYear === p.year;
    const yearDiff = extractedYear ? Math.abs(extractedYear - p.year) : -1;

    let identifierType: 'DOI' | 'ARXIV' | 'BOTH' | 'NONE' = 'NONE';
    if (extractedDoi && extractedArxiv) identifierType = 'BOTH';
    else if (extractedDoi) identifierType = 'DOI';
    else if (extractedArxiv) identifierType = 'ARXIV';

    const identifierFound = identifierType !== 'NONE';
    const abstractExtracted = abstract.length > 50;

    // Test Supplementary Enrichment
    const enrichmentData = await queryEnrichment(extractedDoi, extractedArxiv);
    console.log(`   [${scorecards.length + 1}/10] ${p.filename.slice(0, 30).padEnd(30)} -> Title: ${titleSim}% | Authors: ${authorRecall}% | ID: ${identifierType} | Enrich: ${enrichmentData.source}`);

    scorecards.push({
      paperId: p.id,
      filename: p.filename,
      durationMs: res.durationMs,
      bufferSizeBytes: res.bufferSize,
      intrinsic: {
        title: extractedTitle,
        authors: extractedAuthors,
        year: extractedYear,
        doi: extractedDoi,
        arxivId: extractedArxiv,
        abstractLength: abstract.length,
        abstractSnippet: abstract ? abstract.slice(0, 140) + '...' : undefined,
        numberOfPages: meta.numberOfPages,
        keywordsCount: meta.keywords?.length || 0,
      },
      groundTruth: {
        title: p.title,
        authors: p.authors,
        year: p.year,
        doi: p.doi,
        venue: p.venue,
      },
      accuracy: {
        titleSimilarityPct: titleSim,
        titleExactMatch: titleExact,
        authorRecallPct: authorRecall,
        authorCountExtracted: extractedAuthors.length,
        authorCountExpected: p.authors.length,
        yearMatch,
        yearDiff,
        identifierFound,
        identifierType,
        abstractExtracted,
      },
      enrichment: enrichmentData,
    });
  }

  // ── SAVE REPORT ─────────────────────────────────────────────────────────────
  const outJsonPath = 'c:/flux/zotero/benchmark_results_10_papers.json';
  fs.writeFileSync(outJsonPath, JSON.stringify(scorecards, null, 2), 'utf-8');
  console.log(`\nSaved detailed benchmark JSON to: ${outJsonPath}`);

  // ── PRINT CONSOLE DASHBOARD ─────────────────────────────────────────────────
  printSummaryDashboard(scorecards, benchWallDuration);
}

function printSummaryDashboard(scorecards: ExtractionScorecard[], totalWallDuration: number) {
  console.log('\n' + '='.repeat(105));
  console.log('📊 BẢNG KẾT QUẢ ĐO LƯỜNG SỨC MẠNH NỘI TẠI (INTRINSIC EXTRACTION) & BỔ TRỢ (ENRICHMENT)');
  console.log('='.repeat(105));

  console.log(
    'Paper Name'.padEnd(28) + ' | ' +
    'Duration'.padStart(8) + ' | ' +
    'Title Sim'.padStart(9) + ' | ' +
    'Authors Recall'.padStart(14) + ' | ' +
    'Year'.padStart(5) + ' | ' +
    'ID Found'.padStart(9) + ' | ' +
    'Abstract'.padStart(8) + ' | ' +
    'Enrichment Venue / Citations'.padEnd(28)
  );
  console.log('-'.repeat(125));

  let totalTitleSim = 0;
  let totalAuthorRecall = 0;
  let yearMatches = 0;
  let idMatches = 0;
  let abstractMatches = 0;

  for (const s of scorecards) {
    const shortName = s.filename.replace('.pdf', '').slice(0, 26);
    const dur = `${s.durationMs}ms`;
    const titleSim = `${s.accuracy.titleSimilarityPct}%`;
    const authorRecall = `${s.accuracy.authorRecallPct}% (${s.accuracy.authorCountExtracted}/${s.accuracy.authorCountExpected})`;
    const yearStatus = s.accuracy.yearMatch ? '✅' : s.intrinsic.year ? `⚠️${s.intrinsic.year}` : '❌';
    const idStatus = s.accuracy.identifierFound ? `✅ ${s.accuracy.identifierType}` : '❌';
    const absStatus = s.accuracy.abstractExtracted ? `✅ ${s.intrinsic.abstractLength}c` : '❌';
    const enrichInfo = s.enrichment?.source !== 'None' 
      ? `[${s.enrichment?.source}] ${s.enrichment?.citationCount !== undefined ? s.enrichment.citationCount.toLocaleString() + ' cites' : s.enrichment?.canonicalVenue?.slice(0, 20)}`
      : 'None';

    console.log(
      shortName.padEnd(28) + ' | ' +
      dur.padStart(8) + ' | ' +
      titleSim.padStart(9) + ' | ' +
      authorRecall.padStart(14) + ' | ' +
      yearStatus.padStart(5) + ' | ' +
      idStatus.padStart(9) + ' | ' +
      absStatus.padStart(8) + ' | ' +
      enrichInfo.padEnd(28)
    );

    totalTitleSim += s.accuracy.titleSimilarityPct;
    totalAuthorRecall += s.accuracy.authorRecallPct;
    if (s.accuracy.yearMatch) yearMatches++;
    if (s.accuracy.identifierFound) idMatches++;
    if (s.accuracy.abstractExtracted) abstractMatches++;
  }

  console.log('='.repeat(125));
  console.log('🏆 TỔNG HỢP CHỈ SỐ TOÀN DIỆN (10 PAPERS CONCURRENT):');
  console.log(` • Tổng thời gian xử lý đồng thời (Wall-clock): ${totalWallDuration} ms (Trung bình: ${(totalWallDuration / 10).toFixed(1)} ms / paper)`);
  console.log(` • Độ chính xác Tiêu đề (Title Token Similarity): ${(totalTitleSim / 10).toFixed(1)}%`);
  console.log(` • Độ thu hồi Tác giả (Author Recall): ${(totalAuthorRecall / 10).toFixed(1)}%`);
  console.log(` • Trích xuất Năm phát hành (Year Match Rate): ${(yearMatches / 10 * 100).toFixed(0)}% (${yearMatches}/10)`);
  console.log(` • Tìm thấy Định danh bền vững (DOI/arXiv Identifier Rate): ${(idMatches / 10 * 100).toFixed(0)}% (${idMatches}/10)`);
  console.log(` • Trích xuất Tóm tắt (Abstract Coverage): ${(abstractMatches / 10 * 100).toFixed(0)}% (${abstractMatches}/10)`);
  console.log('='.repeat(125));
}

runBenchmark().catch((e) => {
  console.error('Fatal benchmark error:', e);
  process.exit(1);
});
