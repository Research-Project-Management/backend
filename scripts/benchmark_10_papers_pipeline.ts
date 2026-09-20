import * as dotenv from 'dotenv';
dotenv.config();

import { ArxivProvider } from '../src/modules/library/ingestion/metadata/providers/arxiv.provider';
import { OpenAlexProvider } from '../src/modules/library/ingestion/metadata/providers/openalex.provider';
import { CrossRefProvider } from '../src/modules/library/ingestion/metadata/providers/crossref.provider';
import { MetadataCache } from '../src/modules/library/ingestion/metadata/cache/metadata.cache';
import { ReconciliationService } from '../src/modules/library/ingestion/metadata/services/reconciliation.service';
import { ExecutorService } from '../src/modules/library/ingestion/metadata/services/executor.service';
import { MetadataService } from '../src/modules/library/ingestion/metadata/metadata.service';
import { ItemsMapper } from '../src/modules/library/catalog/infrastructure/mappers/items.mapper';

const BENCHMARK_PAPERS = [
  { id: '1706.03762', expectedTitle: 'Attention Is All You Need', minCitations: 5000, minRefs: 20 },
  { id: '1512.03385', expectedTitle: 'Deep Residual Learning for Image Recognition', minCitations: 4000, minRefs: 20 },
  { id: '1810.04805', expectedTitle: 'BERT: Pre-training of Deep Bidirectional Transformers', minCitations: 20000, minRefs: 25 },
  { id: '1412.6980', expectedTitle: 'Adam: A Method for Stochastic Optimization', minCitations: 50000, minRefs: 15 },
  { id: '1406.2661', expectedTitle: 'Generative Adversarial Networks', minCitations: 4000, minRefs: 0 },
  { id: '1301.3781', expectedTitle: 'Efficient Estimation of Word Representations in Vector Space', minCitations: 10000, minRefs: 0 },
  { id: '1310.4546', expectedTitle: 'Distributed Representations of Words and Phrases and their Compositionality', minCitations: 15000, minRefs: 15 },
  { id: '1312.6114', expectedTitle: 'Auto-Encoding Variational Bayes', minCitations: 10000, minRefs: 10 },
  { id: '1409.0473', expectedTitle: 'Neural Machine Translation by Jointly Learning to Align and Translate', minCitations: 10000, minRefs: 15 },
  { id: '1409.1556', expectedTitle: 'Very Deep Convolutional Networks for Large-Scale Image Recognition', minCitations: 50000, minRefs: 20 },
];

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('BENCHMARK EVALUATION: 10 Landmark Academic Papers (10k+ Citations)');
  console.log('Testing End-to-End Resolution & Metadata Reconciliation Flow');
  console.log('='.repeat(80) + '\n');

  const cache = new MetadataCache();
  const reconciler = new ReconciliationService();
  const executor = new ExecutorService();
  const arxiv = new ArxivProvider();
  const openalex = new OpenAlexProvider();
  const crossref = new CrossRefProvider();

  const metadataService = new MetadataService(
    [arxiv, openalex, crossref],
    cache,
    reconciler,
    executor,
  );

  let passedCount = 0;
  const results: any[] = [];

  for (let i = 0; i < BENCHMARK_PAPERS.length; i++) {
    const target = BENCHMARK_PAPERS[i];
    const indexStr = `[${i + 1}/${BENCHMARK_PAPERS.length}]`;
    const start = Date.now();

    try {
      // 1. Resolve paper via multi-provider cascade
      const resolved = await metadataService.resolve({
        query: target.id,
        forceRefresh: true,
      });

      if (!resolved || !resolved.metadata) {
        console.error(`${indexStr} FAIL: No metadata returned for arXiv:${target.id}`);
        continue;
      }

      const m = resolved.metadata;
      const durationMs = Date.now() - start;

      // 2. Validate field integrity
      const titleValid = Boolean(m.title && m.title.length > 5 && !m.title.toLowerCase().includes('noname'));
      const authorsValid = Boolean(m.authors && m.authors.length > 0);
      const yearValid = Boolean(m.year && m.year >= 2013 && m.year <= 2026);
      const doiValid = Boolean(m.doi || m.arxivId);
      const citationValid = Boolean(typeof m.citationCount === 'number' && m.citationCount > 0);
      const abstractValid = Boolean(m.abstract && m.abstract.length > 50);

      const allValid = titleValid && authorsValid && yearValid && doiValid && citationValid && abstractValid;

      if (allValid) {
        passedCount++;
      }

      const domainItem = ItemsMapper.toDomain({
        id: `bench-${target.id}`,
        title: m.title,
        authors: m.authors,
        creators: m.creators,
        year: m.year,
        doi: m.doi,
        arxivId: m.arxivId || target.id,
        citationCount: m.citationCount,
        referenceCount: m.referenceCount,
        abstract: m.abstract,
        publicationTitle: m.publicationTitle || m.journal,
        journal: m.journal,
        itemType: m.itemType || 'preprint',
      });

      results.push({
        id: target.id,
        title: domainItem.title,
        authorsCount: domainItem.authors?.length,
        firstAuthor: domainItem.authors?.[0],
        year: domainItem.year,
        doi: domainItem.doi,
        arxivId: domainItem.arxivId,
        citations: domainItem.citationCount,
        references: domainItem.referenceCount,
        venue: domainItem.publicationTitle || domainItem.journal,
        abstractLength: domainItem.abstract?.length,
        status: allValid ? 'PASSED' : 'PARTIAL',
        durationMs,
      });

      console.log(`${indexStr} ${allValid ? 'PASS' : 'WARN'} (${durationMs}ms) arXiv:${target.id}`);
      console.log(`   Title:       "${m.title}"`);
      console.log(`   Authors (${m.authors?.length}): ${(m.authors || []).slice(0, 3).join(', ')}${(m.authors?.length || 0) > 3 ? ' et al.' : ''}`);
      console.log(`   Year:        ${m.year}`);
      console.log(`   DOI:         ${m.doi || 'N/A'}`);
      console.log(`   Citations:   ${m.citationCount != null ? Number(m.citationCount).toLocaleString() : 'N/A'}`);
      console.log(`   References:  ${m.referenceCount != null ? Number(m.referenceCount).toLocaleString() : 'N/A'}`);
      console.log(`   Venue:       ${domainItem.publicationTitle || domainItem.journal || 'N/A'}`);
      console.log(`   Abstract:    ${m.abstract ? m.abstract.slice(0, 100) + '...' : 'MISSING'}\n`);
    } catch (err: any) {
      console.error(`${indexStr} ERROR for arXiv:${target.id}: ${err.message}\n`);
    }
  }

  console.log('='.repeat(80));
  console.log(`BENCHMARK SUMMARY: ${passedCount}/${BENCHMARK_PAPERS.length} PAPERS FULLY VALIDATED`);
  console.log('='.repeat(80));
  console.table(
    results.map((r) => ({
      Paper: r.id,
      Title: r.title.length > 35 ? r.title.slice(0, 32) + '...' : r.title,
      Authors: r.authorsCount,
      Year: r.year,
      Citations: r.citations?.toLocaleString() ?? '—',
      References: r.references?.toLocaleString() ?? '—',
      Venue: r.venue ?? 'arXiv',
      Status: r.status,
    }))
  );
}

runBenchmark().catch(console.error);
