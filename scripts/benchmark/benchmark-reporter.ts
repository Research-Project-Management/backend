/**
 * backend/scripts/benchmark/benchmark-reporter.ts
 *
 * Formats empirical comparison metrics into structured JSON and Markdown reports.
 */

import fs from 'fs';
import path from 'path';
import {
  AggregateStats,
  BenchmarkFinalReport,
  ItemComparisonResult,
} from './types';

const RESULTS_DIR = path.resolve(__dirname, 'results');

export class BenchmarkReporter {
  static computeAggregate(items: Array<{ extracted: any; score: any }>): AggregateStats {
    if (items.length === 0) {
      return {
        sampleCount: 0,
        titleMeanF1: 0,
        titleMeanLevenshtein: 0,
        doiAccuracyPercent: 0,
        yearAccuracyPercent: 0,
        authorMeanJaccard: 0,
        meanCompletenessScore: 0,
        overallAccuracyScore: 0,
        meanLatencyMs: 0,
      };
    }

    const count = items.length;
    let sumF1 = 0;
    let sumLev = 0;
    let sumDoi = 0;
    let sumYear = 0;
    let sumAuth = 0;
    let sumComp = 0;
    let sumOverall = 0;
    let sumLatency = 0;
    let wafBlockedCount = 0;

    for (const item of items) {
      sumF1 += item.score.titleTokenF1;
      sumLev += item.score.titleLevenshtein;
      if (item.score.doiExactMatch) sumDoi++;
      if (item.score.yearMatch) sumYear++;
      sumAuth += item.score.authorJaccard;
      sumComp += item.score.completenessScore;
      sumOverall += item.score.overallAccuracy;
      sumLatency += item.extracted.executionMs || 0;
      if (item.extracted.wafBlocked) wafBlockedCount++;
    }

    return {
      sampleCount: count,
      titleMeanF1: parseFloat((sumF1 / count).toFixed(4)),
      titleMeanLevenshtein: parseFloat((sumLev / count).toFixed(4)),
      doiAccuracyPercent: parseFloat(((sumDoi / count) * 100).toFixed(1)),
      yearAccuracyPercent: parseFloat(((sumYear / count) * 100).toFixed(1)),
      authorMeanJaccard: parseFloat((sumAuth / count).toFixed(4)),
      meanCompletenessScore: parseFloat((sumComp / count).toFixed(4)),
      overallAccuracyScore: parseFloat(((sumOverall / count) * 100).toFixed(1)),
      wafBypassRatePercent: parseFloat((((count - wafBlockedCount) / count) * 100).toFixed(1)),
      meanLatencyMs: Math.round(sumLatency / count),
    };
  }

  static generateReport(
    linksResults: ItemComparisonResult[],
    papersResults: ItemComparisonResult[],
  ): BenchmarkFinalReport {
    const legacyLinksStats = this.computeAggregate(linksResults.map((r) => r.legacy));
    const currentLinksStats = this.computeAggregate(linksResults.map((r) => r.current));

    const legacyPapersStats = this.computeAggregate(papersResults.map((r) => r.legacy));
    const currentPapersStats = this.computeAggregate(papersResults.map((r) => r.current));

    const totalEvaluated = linksResults.length + papersResults.length;
    const legacyOverall = totalEvaluated > 0
      ? (legacyLinksStats.overallAccuracyScore * linksResults.length +
         legacyPapersStats.overallAccuracyScore * papersResults.length) / totalEvaluated
      : 0;

    const currentOverall = totalEvaluated > 0
      ? (currentLinksStats.overallAccuracyScore * linksResults.length +
         currentPapersStats.overallAccuracyScore * papersResults.length) / totalEvaluated
      : 0;

    // Publisher Breakdown
    const pubMap: BenchmarkFinalReport['publisherBreakdown'] = {};
    for (const item of [...linksResults, ...papersResults]) {
      const pub = item.domainOrPublisher || 'Unknown';
      if (!pubMap[pub]) {
        pubMap[pub] = {
          count: 0,
          legacyAccuracy: 0,
          currentAccuracy: 0,
          legacyWafBlockedCount: 0,
          currentWafBlockedCount: 0,
        };
      }
      pubMap[pub].count++;
      pubMap[pub].legacyAccuracy += item.legacy.score.overallAccuracy;
      pubMap[pub].currentAccuracy += item.current.score.overallAccuracy;
      if (item.legacy.extracted.wafBlocked) pubMap[pub].legacyWafBlockedCount++;
      if (item.current.extracted.wafBlocked) pubMap[pub].currentWafBlockedCount++;
    }

    for (const pub of Object.keys(pubMap)) {
      const c = pubMap[pub].count;
      pubMap[pub].legacyAccuracy = parseFloat(((pubMap[pub].legacyAccuracy / c) * 100).toFixed(1));
      pubMap[pub].currentAccuracy = parseFloat(((pubMap[pub].currentAccuracy / c) * 100).toFixed(1));
    }

    const report: BenchmarkFinalReport = {
      timestamp: new Date().toISOString(),
      sampleConfig: {
        requestedSamples: totalEvaluated,
        evaluatedLinks: linksResults.length,
        evaluatedPapers: papersResults.length,
      },
      summary: {
        links: {
          legacy: legacyLinksStats,
          current: currentLinksStats,
          improvementPercent: parseFloat((currentLinksStats.overallAccuracyScore - legacyLinksStats.overallAccuracyScore).toFixed(1)),
        },
        papers: {
          legacy: legacyPapersStats,
          current: currentPapersStats,
          improvementPercent: parseFloat((currentPapersStats.overallAccuracyScore - legacyPapersStats.overallAccuracyScore).toFixed(1)),
        },
        overall: {
          legacyAccuracy: parseFloat(legacyOverall.toFixed(1)),
          currentAccuracy: parseFloat(currentOverall.toFixed(1)),
          absoluteGain: parseFloat((currentOverall - legacyOverall).toFixed(1)),
        },
      },
      publisherBreakdown: pubMap,
      detailedComparisons: [...linksResults, ...papersResults],
    };

    return report;
  }

  static saveReport(report: BenchmarkFinalReport) {
    if (!fs.existsSync(RESULTS_DIR)) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    const jsonPath = path.join(RESULTS_DIR, 'benchmark_report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

    // Build Markdown Summary
    const mdPath = path.join(RESULTS_DIR, 'benchmark_summary.md');
    let md = `# Empirical Benchmark Report: Legacy (External APIs) vs. Current (Local-First Regex / Zero-API)\n\n`;
    md += `*Generated: ${new Date().toLocaleString()}*\n\n`;
    md += `## 1. Executive Summary\n\n`;
    md += `| Test Track | Evaluated Samples | Legacy (External APIs) | Current (Local Regex / Zero-API) | Accuracy Difference |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: |\n`;
    md += `| **Links Ingestion** | ${report.sampleConfig.evaluatedLinks} | **${report.summary.links.legacy.overallAccuracyScore}%** (${report.summary.links.legacy.meanLatencyMs}ms) | **${report.summary.links.current.overallAccuracyScore}%** (${report.summary.links.current.meanLatencyMs}ms) | **${report.summary.links.improvementPercent >= 0 ? '+' : ''}${report.summary.links.improvementPercent}%** |\n`;
    md += `| **PDF Paper Ingestion** | ${report.sampleConfig.evaluatedPapers} | **${report.summary.papers.legacy.overallAccuracyScore}%** (${report.summary.papers.legacy.meanLatencyMs}ms) | **${report.summary.papers.current.overallAccuracyScore}%** (${report.summary.papers.current.meanLatencyMs}ms) | **${report.summary.papers.improvementPercent >= 0 ? '+' : ''}${report.summary.papers.improvementPercent}%** |\n`;
    md += `| **Overall Combined** | **${report.sampleConfig.requestedSamples}** | **${report.summary.overall.legacyAccuracy}%** | **${report.summary.overall.currentAccuracy}%** | **${report.summary.overall.absoluteGain >= 0 ? '+' : ''}${report.summary.overall.absoluteGain}%** |\n\n`;

    md += `## 2. In-Depth Metric Breakdown\n\n`;
    md += `### A. PDF Paper Ingestion (External API Retrieval vs. Local-First Zero-API Cascade)\n\n`;
    md += `| Metric | Legacy (API Query via DOI/Text) | Current (Local Regex / Layout / XMP) | Comparison Insight |\n`;
    md += `| :--- | :---: | :---: | :--- |\n`;
    md += `| **Title Token F1** | ${(report.summary.papers.legacy.titleMeanF1 * 100).toFixed(1)}% | **${(report.summary.papers.current.titleMeanF1 * 100).toFixed(1)}%** | Local Layout Heuristic clusters font sizes directly from page |\n`;
    md += `| **DOI Match Rate** | ${report.summary.papers.legacy.doiAccuracyPercent}% | **${report.summary.papers.current.doiAccuracyPercent}%** | Academic Regex Catalog scans ISO 26324 patterns offline |\n`;
    md += `| **Year Match Rate** | ${report.summary.papers.legacy.yearAccuracyPercent}% | **${report.summary.papers.current.yearAccuracyPercent}%** | Publication date validation |\n`;
    md += `| **Author Jaccard** | ${(report.summary.papers.legacy.authorMeanJaccard * 100).toFixed(1)}% | **${(report.summary.papers.current.authorMeanJaccard * 100).toFixed(1)}%** | Footnote & affiliation cleaning |\n`;
    md += `| **Mean Completeness** | ${(report.summary.papers.legacy.meanCompletenessScore * 100).toFixed(1)}% | **${(report.summary.papers.current.meanCompletenessScore * 100).toFixed(1)}%** | Quality Gate validation |\n`;
    md += `| **Average Latency** | ${report.summary.papers.legacy.meanLatencyMs} ms | **${report.summary.papers.current.meanLatencyMs} ms** | Local-First Zero-API processing speed |\n\n`;

    md += `### B. Link Ingestion (Remote API Resolution vs. Direct Embedded Regex)\n\n`;
    md += `| Metric | Legacy (CrossRef / OpenAlex API) | Current (Embedded Meta Tag Regex) | Comparison Insight |\n`;
    md += `| :--- | :---: | :---: | :--- |\n`;
    md += `| **DOI Match Rate** | ${report.summary.links.legacy.doiAccuracyPercent}% | **${report.summary.links.current.doiAccuracyPercent}%** | Highwire Press & Dublin Core direct regex |\n`;
    md += `| **Title Accuracy** | ${(report.summary.links.legacy.titleMeanF1 * 100).toFixed(1)}% | **${(report.summary.links.current.titleMeanF1 * 100).toFixed(1)}%** | Direct document title vs API record |\n`;
    md += `| **Average Latency** | ${report.summary.links.legacy.meanLatencyMs} ms | **${report.summary.links.current.meanLatencyMs} ms** | Remote round-trip vs Single HTTP fetch |\n\n`;

    md += `## 3. Publisher Domain Breakdown\n\n`;
    md += `| Publisher / Domain | Tested | Legacy Acc. | Current Acc. | Legacy WAF Blocks | Current WAF Blocks |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: |\n`;
    for (const [pub, data] of Object.entries(report.publisherBreakdown)) {
      md += `| ${pub} | ${data.count} | ${data.legacyAccuracy}% | **${data.currentAccuracy}%** | ${data.legacyWafBlockedCount} | **${data.currentWafBlockedCount}** |\n`;
    }

    fs.writeFileSync(mdPath, md, 'utf-8');
    console.log(`\nReports generated successfully:`);
    console.log(`- JSON: ${jsonPath}`);
    console.log(`- Markdown: ${mdPath}\n`);
  }
}
