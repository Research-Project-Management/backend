/**
 * backend/scripts/benchmark/run-empirical-benchmark.ts
 *
 * Master CLI Orchestrator executing the Empirical Accuracy Benchmark:
 * Comparing Legacy (External API Pipeline: CrossRef/OpenAlex/arXiv)
 * Against Current (Local-First / Zero-API: Academic Regex & Layout Cascade).
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/benchmark/run-empirical-benchmark.ts --samples=100 --target=all
 */

import fs from 'fs';
import path from 'path';
import { DatasetLoader } from './dataset-loader';
import { LegacyApiEngine } from './legacy-api-engine';
import { CurrentRegexEngine } from './current-regex-engine';
import { AccuracyEvaluator } from './accuracy-evaluator';
import { BenchmarkReporter } from './benchmark-reporter';
import { ItemComparisonResult } from './types';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const sampleArg = args.find((a) => a.startsWith('--samples='));
  const sampleCount = sampleArg ? parseInt(sampleArg.split('=')[1], 10) : 100;

  const targetArg = args.find((a) => a.startsWith('--target='));
  const target = targetArg ? targetArg.split('=')[1] : 'all'; // 'all' | 'links' | 'papers'

  const isVerbose = args.includes('--verbose');

  console.log('='.repeat(95));
  console.log('FLUX EMPIRICAL BENCHMARK: LEGACY (EXTERNAL APIS) VS. CURRENT (LOCAL REGEX / ZERO-API)');
  console.log('='.repeat(95));
  console.log(`Configuration:`);
  console.log(`- Samples per track: ${sampleCount}`);
  console.log(`- Target: ${target}`);
  console.log(`- Architecture A (Legacy):  External Academic APIs (CrossRef, OpenAlex, arXiv)`);
  console.log(`- Architecture B (Current): Local-First Academic Regex & Layout Cascade (Zero-API / 100% Offline)`);
  console.log(`- Evaluation Focus:         Độ chính xác (Accuracy) & Độ toàn vẹn thông tin\n`);

  const linksResults: ItemComparisonResult[] = [];
  const papersResults: ItemComparisonResult[] = [];

  // ── TRACK 1: Link Ingestion Benchmark ────────────────────────────────────────
  if (target === 'all' || target === 'links') {
    console.log('-----------------------------------------------------------------------------------');
    console.log(`[TRACK 1/2] BENCHMARKING ACADEMIC LINKS: External API vs. Local Embedded Regex (N = ${sampleCount})`);
    console.log('-----------------------------------------------------------------------------------');

    const linkSamples = DatasetLoader.loadLinks(sampleCount);
    console.log(`Loaded ${linkSamples.length} stratified link samples across 15 publishers.\n`);

    for (let i = 0; i < linkSamples.length; i++) {
      const item = linkSamples[i];
      const prefix = `[Link ${i + 1}/${linkSamples.length}] [${item.domain}]`;

      try {
        // 1. Run Legacy (External APIs)
        const legacyExtracted = await LegacyApiEngine.resolveUrl(item.url);
        const legacyScore = AccuracyEvaluator.evaluate(legacyExtracted, {
          title: item.title,
          doi: item.doi,
          year: item.year,
        });

        // 2. Run Current (Local Regex - Zero API)
        const currentExtracted = await CurrentRegexEngine.extractUrl(item.url);
        const currentScore = AccuracyEvaluator.evaluate(currentExtracted, {
          title: item.title,
          doi: item.doi,
          year: item.year,
        });

        linksResults.push({
          sampleId: item.index,
          type: 'LINK',
          targetIdentifier: item.url,
          domainOrPublisher: item.domain,
          groundTruth: {
            title: item.title,
            doi: item.doi,
            year: item.year,
          },
          legacy: {
            extracted: legacyExtracted,
            score: legacyScore,
          },
          current: {
            extracted: currentExtracted,
            score: currentScore,
          },
        });

        const legAcc = (legacyScore.overallAccuracy * 100).toFixed(0);
        const curAcc = (currentScore.overallAccuracy * 100).toFixed(0);
        const diff = currentScore.overallAccuracy - legacyScore.overallAccuracy;
        const statusSymbol = diff > 0 ? '[+] ' : diff < 0 ? '[-] ' : '[=] ';

        console.log(
          `${prefix} Legacy (API): ${legAcc}% (${legacyExtracted.executionMs}ms) | Current (Regex): ${curAcc}% (${currentExtracted.executionMs}ms) | ${statusSymbol}${Math.abs(Math.round(diff * 100))}%`,
        );

        if (isVerbose && Math.abs(diff) > 0.3) {
          console.log(`  GT Title:      ${item.title.slice(0, 65)}`);
          console.log(`  API Title:     ${(legacyExtracted.title || 'EMPTY').slice(0, 65)} [${legacyExtracted.engineUsed}]`);
          console.log(`  Regex Title:   ${(currentExtracted.title || 'EMPTY').slice(0, 65)} [${currentExtracted.engineUsed}]`);
        }
      } catch (err: any) {
        console.warn(`${prefix} Error in link loop: ${err?.message || err}`);
      }

      await sleep(100); // Politeness delay between remote API calls
    }
  }

  // ── TRACK 2: PDF Paper Ingestion Benchmark ──────────────────────────────────
  if (target === 'all' || target === 'papers') {
    console.log('\n-----------------------------------------------------------------------------------');
    console.log(`[TRACK 2/2] BENCHMARKING ACADEMIC PDFS: External API vs. Local 4-Tier Regex (N = ${sampleCount})`);
    console.log('-----------------------------------------------------------------------------------');

    const paperSamples = DatasetLoader.loadPapers(sampleCount);
    console.log(`Loaded ${paperSamples.length} validated PDF papers from source/papers/.\n`);

    for (let i = 0; i < paperSamples.length; i++) {
      const item = paperSamples[i];
      const prefix = `[PDF ${i + 1}/${paperSamples.length}] [${item.publisher}]`;

      try {
        const pPath = path.isAbsolute(item.filepath)
          ? item.filepath
          : path.resolve(__dirname, '../../../source/papers', item.filename);

        if (!fs.existsSync(pPath)) {
          console.warn(`${prefix} File missing on disk: ${item.filename}`);
          continue;
        }

        const buffer = fs.readFileSync(pPath);

        // 1. Run Legacy (Extract anchor and query External APIs)
        const legacyExtracted = await LegacyApiEngine.resolvePdf(buffer, item.filename);
        const legacyScore = AccuracyEvaluator.evaluate(legacyExtracted, {
          title: item.title,
          doi: item.doi,
          year: item.year,
        });

        // 2. Run Current (100% Local-First 4-Tier Cascade: XMP -> Regex -> Layout -> SLM)
        const currentExtracted = await CurrentRegexEngine.extractPdf(buffer, item.filename);
        const currentScore = AccuracyEvaluator.evaluate(currentExtracted, {
          title: item.title,
          doi: item.doi,
          year: item.year,
        });

        papersResults.push({
          sampleId: item.index,
          type: 'PAPER',
          targetIdentifier: item.filename,
          domainOrPublisher: item.publisher,
          groundTruth: {
            title: item.title,
            doi: item.doi,
            year: item.year,
          },
          legacy: {
            extracted: legacyExtracted,
            score: legacyScore,
          },
          current: {
            extracted: currentExtracted,
            score: currentScore,
          },
        });

        const legAcc = (legacyScore.overallAccuracy * 100).toFixed(0);
        const curAcc = (currentScore.overallAccuracy * 100).toFixed(0);
        const diff = currentScore.overallAccuracy - legacyScore.overallAccuracy;
        const statusSymbol = diff > 0 ? '[+] ' : diff < 0 ? '[-] ' : '[=] ';

        console.log(
          `${prefix} Legacy (API): ${legAcc}% (${legacyExtracted.executionMs}ms) | Current (Local): ${curAcc}% (${currentExtracted.executionMs}ms) | ${statusSymbol}${Math.abs(Math.round(diff * 100))}% [${currentExtracted.engineUsed}]`,
        );

        if (isVerbose && Math.abs(diff) > 0.3) {
          console.log(`  GT Title:      ${item.title.slice(0, 65)}`);
          console.log(`  API Title:     ${(legacyExtracted.title || 'EMPTY').slice(0, 65)} [${legacyExtracted.engineUsed}]`);
          console.log(`  Local Title:   ${(currentExtracted.title || 'EMPTY').slice(0, 65)} [${currentExtracted.engineUsed}]`);
        }
      } catch (err: any) {
        console.warn(`${prefix} Error in paper loop: ${err?.message || err}`);
      }

      await sleep(100); // Politeness delay between remote API calls
    }
  }

  // ── GENERATE FINAL COMPARISON REPORT ────────────────────────────────────────
  console.log('\n' + '='.repeat(95));
  console.log('AGGREGATING SCIENTIFIC ACCURACY METRICS (LEGACY API VS. CURRENT LOCAL REGEX)');
  console.log('='.repeat(95));

  const report = BenchmarkReporter.generateReport(linksResults, papersResults);
  BenchmarkReporter.saveReport(report);

  console.log('===================================================================================');
  console.log('EMPIRICAL ACCURACY RESULTS:');
  console.log(`- Evaluated Links:   ${linksResults.length} samples`);
  console.log(`  Legacy (API):      ${report.summary.links.legacy.overallAccuracyScore}% (Avg Latency: ${report.summary.links.legacy.meanLatencyMs}ms)`);
  console.log(`  Current (Regex):   ${report.summary.links.current.overallAccuracyScore}% (Avg Latency: ${report.summary.links.current.meanLatencyMs}ms)`);
  console.log(`- Evaluated Papers:  ${papersResults.length} PDF files`);
  console.log(`  Legacy (API):      ${report.summary.papers.legacy.overallAccuracyScore}% (Avg Latency: ${report.summary.papers.legacy.meanLatencyMs}ms)`);
  console.log(`  Current (Local):   ${report.summary.papers.current.overallAccuracyScore}% (Avg Latency: ${report.summary.papers.current.meanLatencyMs}ms)`);
  console.log('-----------------------------------------------------------------------------------');
  console.log(`- OVERALL ACCURACY:  Legacy (API) ${report.summary.overall.legacyAccuracy}% vs Current (Local-First) ${report.summary.overall.currentAccuracy}%`);
  console.log(`  Accuracy Difference: ${report.summary.overall.absoluteGain >= 0 ? '+' : ''}${report.summary.overall.absoluteGain}%`);
  console.log('===================================================================================\n');
}

main().catch((err) => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});
