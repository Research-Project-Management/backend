import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage, tryCatch } from '@/core/utils/error.util';
import { normalizeDoi } from '../utils/metadata.util';

export interface UnpaywallResult {
  doi: string;
  isOa: boolean;
  oaStatus?: string;
  pdfUrl?: string;
  title?: string;
  journalName?: string;
}

@Injectable()
export class UnpaywallProvider {
  private readonly logger = new Logger(UnpaywallProvider.name);
  private readonly BASE_URL = 'https://api.unpaywall.org/v2';
  private readonly EMAIL = 'admin@researchmanagement.local';

  /**
   * Resolve Open Access full-text PDF URL from DOI via Unpaywall
   */
  async resolveOaPdf(doi: string): Promise<UnpaywallResult | null> {
    if (!doi) return null;

    const cleanDoi = normalizeDoi(doi);
    if (!cleanDoi) return null;

    const url = `${this.BASE_URL}/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(this.EMAIL)}`;

    const responseResult = await tryCatch(
      fetch(url, {
        headers: {
          'User-Agent':
            'ResearchManagementPlatform/1.0 (academic-research-bot)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }),
    );

    if (!responseResult.ok || !responseResult.value.ok) {
      return null;
    }

    const jsonResult = await tryCatch(responseResult.value.json());
    if (!jsonResult.ok || !jsonResult.value) {
      return null;
    }

    const data = jsonResult.value;
    const isOa = Boolean(data.is_oa);
    const bestOaLocation = data.best_oa_location;
    const pdfUrl =
      bestOaLocation?.url_for_pdf || bestOaLocation?.url || undefined;

    return {
      doi: cleanDoi,
      isOa,
      oaStatus: data.oa_status,
      pdfUrl,
      title: data.title,
      journalName: data.journal_name,
    };
  }
}
