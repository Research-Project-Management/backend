import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '../../../../core/utils/error.util';
import { UnifiedAcademicMetadata } from './types/fetcher.types';
import { createHash } from 'crypto';

@Injectable()
export class PubmedFetcher {
  private readonly logger = new Logger(PubmedFetcher.name);
  private readonly BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

  /**
   * Fetch biomedical article metadata from NCBI PubMed E-Utilities by PMID
   */
  async fetchByPmid(pmid: string): Promise<UnifiedAcademicMetadata | null> {
    if (!pmid) return null;

    const cleanPmid = pmid.replace(/^pmid:?\s*/i, '').trim();
    if (!/^\d+$/.test(cleanPmid)) return null;

    const url = `${this.BASE_URL}?db=pubmed&id=${encodeURIComponent(cleanPmid)}&retmode=json`;

    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent': 'ResearchManagementPlatform/1.0 (mailto:admin@researchmanagement.local; academic-research-bot)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) {
      this.logger.warn(`PubMed fetch failed for PMID: ${cleanPmid}`);
      return null;
    }

    const jsonResult = await tryCatch(responseResult.value.json() as Promise<any>);
    if (!jsonResult.ok || !jsonResult.value?.result?.[cleanPmid]) {
      return null;
    }

    const item = jsonResult.value.result[cleanPmid];
    if (item.error) return null;

    const title = (item.title || 'Untitled PubMed Article').replace(/\.$/, '').trim();
    const authors: string[] = Array.isArray(item.authors)
      ? item.authors.map((a: any) => a.name).filter(Boolean)
      : [];

    let year: number | null = null;
    if (item.pubdate) {
      const match = item.pubdate.match(/^(\d{4})/);
      if (match) year = Number(match[1]);
    }

    // Extract DOI if available in articleids
    let doi: string | undefined;
    if (Array.isArray(item.articleids)) {
      const doiObj = item.articleids.find((id: any) => id.idtype === 'doi');
      if (doiObj?.value) doi = doiObj.value;
    }

    const rawSnapshotHash = createHash('md5').update(JSON.stringify(item)).digest('hex');

    return {
      title,
      authors,
      year,
      pmid: cleanPmid,
      doi,
      journal: item.source || item.fulljournalname || undefined,
      volume: item.volume || undefined,
      issue: item.issue || undefined,
      pages: item.pages || undefined,
      itemType: 'journalArticle',
      url: `https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/`,
      provenance: {
        originProvider: 'PubMed',
        resolvedAt: new Date().toISOString(),
        canonicalId: `pmid:${cleanPmid}`,
        canonicalUrl: `https://pubmed.ncbi.nlm.nih.gov/${cleanPmid}/`,
        confidenceScore: 1.0,
        rawSnapshotHash,
        isOpenAccess: false,
      },
    };
  }
}
