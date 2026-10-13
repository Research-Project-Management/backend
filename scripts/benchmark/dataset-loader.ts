/**
 * backend/scripts/benchmark/dataset-loader.ts
 *
 * Loads stratified and balanced test subsets from source/ dataset.
 */

import fs from 'fs';
import path from 'path';
import { BenchmarkLinkSample, BenchmarkPaperSample } from './types';

const BASE_DIR = path.resolve(__dirname, '../../../source');
const LINKS_JSON = path.join(BASE_DIR, 'links.json');
const PAPERS_MANIFEST = path.join(BASE_DIR, 'papers_manifest.json');
const PAPERS_DIR = path.join(BASE_DIR, 'papers');

export class DatasetLoader {
  /**
   * Loads stratified sample of links ensuring coverage across all 15 publishers.
   */
  static loadLinks(count: number): BenchmarkLinkSample[] {
    if (!fs.existsSync(LINKS_JSON)) {
      throw new Error(`Links dataset not found at ${LINKS_JSON}`);
    }

    const allLinks: BenchmarkLinkSample[] = JSON.parse(fs.readFileSync(LINKS_JSON, 'utf-8'));
    if (count >= allLinks.length) {
      return allLinks;
    }

    // Stratified sampling across domains
    const byDomain = new Map<string, BenchmarkLinkSample[]>();
    for (const l of allLinks) {
      if (!byDomain.has(l.domain)) byDomain.set(l.domain, []);
      byDomain.get(l.domain)!.push(l);
    }

    const result: BenchmarkLinkSample[] = [];
    const domains = Array.from(byDomain.keys());
    const perDomain = Math.max(1, Math.floor(count / domains.length));

    for (const d of domains) {
      const items = byDomain.get(d) || [];
      result.push(...items.slice(0, perDomain));
    }

    // Fill remaining if needed
    if (result.length < count) {
      const seen = new Set(result.map((r) => r.url));
      for (const l of allLinks) {
        if (!seen.has(l.url)) {
          result.push(l);
          seen.add(l.url);
          if (result.length >= count) break;
        }
      }
    }

    return result.slice(0, count);
  }

  /**
   * Loads paper samples with existing PDF files on disk.
   */
  static loadPapers(count: number): BenchmarkPaperSample[] {
    if (!fs.existsSync(PAPERS_MANIFEST)) {
      throw new Error(`Papers manifest not found at ${PAPERS_MANIFEST}`);
    }

    const allPapers: BenchmarkPaperSample[] = JSON.parse(fs.readFileSync(PAPERS_MANIFEST, 'utf-8'));
    const validPapers = allPapers.filter((p) => {
      const pPath = path.isAbsolute(p.filepath) ? p.filepath : path.join(PAPERS_DIR, p.filename);
      return fs.existsSync(pPath);
    });

    if (count >= validPapers.length) {
      return validPapers;
    }

    // Stratified sampling across sources (arXiv, PLOS, ACL, PMC)
    const byPublisher = new Map<string, BenchmarkPaperSample[]>();
    for (const p of validPapers) {
      const pub = p.publisher || 'Unknown';
      if (!byPublisher.has(pub)) byPublisher.set(pub, []);
      byPublisher.get(pub)!.push(p);
    }

    const result: BenchmarkPaperSample[] = [];
    const pubs = Array.from(byPublisher.keys());
    const perPub = Math.max(1, Math.floor(count / pubs.length));

    for (const pub of pubs) {
      const items = byPublisher.get(pub) || [];
      result.push(...items.slice(0, perPub));
    }

    if (result.length < count) {
      const seen = new Set(result.map((r) => r.filename));
      for (const p of validPapers) {
        if (!seen.has(p.filename)) {
          result.push(p);
          seen.add(p.filename);
          if (result.length >= count) break;
        }
      }
    }

    return result.slice(0, count);
  }
}
