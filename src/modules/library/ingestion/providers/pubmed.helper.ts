import {
  cleanBibliographicText,
  cleanAbstractText,
  AcademicHttpClient,
} from '@/modules/library/core';
import { getAcademicUserAgent } from '@/modules/library/core/constants/academic-client.constants';
import type { ProviderResult } from '@/modules/library/ingestion/types/metadata.types';

export function parseMedlineDate(raw: string): string | undefined {
  const str = raw.trim();
  if (!str) return undefined;
  const MONTHS: Record<string, string> = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  };
  const iso = str.match(/^(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?/);
  if (iso) {
    const m = iso[2].padStart(2, '0');
    return iso[3]
      ? `${iso[1]}-${m}-${iso[3].padStart(2, '0')}`
      : `${iso[1]}-${m}`;
  }
  const med = str.match(/^(\d{4})(?:\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{1,2}))?)?/);
  if (!med) return str;
  const year = med[1];
  const month = med[2] ? MONTHS[med[2].toLowerCase()] : undefined;
  if (!month) return med[2] ? str : year;
  return med[3]
    ? `${year}-${month}-${med[3].padStart(2, '0')}`
    : `${year}-${month}`;
}

export async function enrichFromEuropePmc(
  result: ProviderResult,
  cleanPmid: string,
  rawTags: string[],
  httpClient?: AcademicHttpClient,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const epmcUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:${encodeURIComponent(cleanPmid)}%20AND%20SRC:MED&resultType=core&format=json`;
    const headers = {
      'User-Agent': getAcademicUserAgent('PubMed'),
      Accept: 'application/json',
    };
    let response: Response;
    if (httpClient) {
      ({ response } = await httpClient.request(epmcUrl, { headers, signal }));
    } else {
      response = await fetch(epmcUrl, { headers, signal });
    }
    if (!response.ok) return;
    const data = (await response.json()) as {
      resultList?: {
        result?: Array<{
          abstractText?: string;
          meshHeadingList?: {
            meshHeading?: Array<{
              descriptorName?: string;
              meshQualifierList?: {
                meshQualifier?: Array<{ qualifierName?: string }>;
              };
            }>;
          };
          keywordList?: { keyword?: Array<string | null> };
        }>;
      };
    };
    const item = data?.resultList?.result?.[0];
    if (!item) return;

    const meshList = item.meshHeadingList?.meshHeading || [];
    for (const mh of meshList) {
      const desc = cleanBibliographicText(mh.descriptorName || '');
      if (!desc) continue;
      const quals = mh.meshQualifierList?.meshQualifier || [];
      if (quals.length > 0) {
        for (const q of quals) {
          const qual = cleanBibliographicText(q.qualifierName || '');
          if (qual) rawTags.push(`${desc}/${qual}`);
        }
      } else {
        rawTags.push(desc);
      }
    }

    const kwList = item.keywordList?.keyword || [];
    for (const kw of kwList) {
      if (typeof kw === 'string') {
        const cleaned = cleanBibliographicText(kw);
        if (cleaned) rawTags.push(cleaned);
      }
    }

    if (!result.metadata.abstract && typeof item.abstractText === 'string') {
      const cleanedAbs = cleanAbstractText(item.abstractText);
      if (cleanedAbs) result.metadata.abstract = cleanedAbs;
    }
  } catch {
    // EuropePMC fallback enrichment skipped
  }
}
