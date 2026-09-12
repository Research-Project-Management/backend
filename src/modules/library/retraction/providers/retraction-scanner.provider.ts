import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { RetractionDetails } from '../types/retraction.types';

@Injectable()
export class RetractionScannerProvider {
  private readonly logger = new Logger(RetractionScannerProvider.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Scans a DOI and/or title for retraction markers.
   * Checks database cache first, then title heuristics, then external provider.
   */
  async scan(
    doi?: string | null,
    pmid?: string | null,
    title?: string | null,
  ): Promise<RetractionDetails | null> {
    const cleanDoiVal = doi?.trim().toLowerCase();
    const cleanPmidVal = pmid?.trim();

    // 1. Check local cache (RetractionRecord)
    if (cleanDoiVal || cleanPmidVal) {
      const cached = await this.prisma.retractionRecord.findFirst({
        where: {
          OR: [
            ...(cleanDoiVal ? [{ doi: cleanDoiVal }] : []),
            ...(cleanPmidVal ? [{ pmid: cleanPmidVal }] : []),
          ],
        },
      });

      if (cached) {
        return {
          nature: cached.nature as any,
          reason: cached.reason || '',
          noticeUrl: cached.noticeUrl || undefined,
          date: cached.retractionDate
            ? cached.retractionDate.toISOString()
            : undefined,
          source: cached.source as any,
        };
      }
    }

    // 2. Check title heuristics (many publishers or databases prepend "RETRACTED:" or "WITHDRAWN:")
    if (title) {
      const lowerTitle = title.trim().toLowerCase();
      if (
        lowerTitle.startsWith('retracted:') ||
        lowerTitle.startsWith('retraction:') ||
        lowerTitle.startsWith('withdrawn:') ||
        lowerTitle.includes('(retracted)') ||
        lowerTitle.includes('[retracted]')
      ) {
        return {
          nature: 'retraction',
          reason: 'Identified from publication title notation',
          source: 'manual',
        };
      }
      if (
        lowerTitle.startsWith('expression of concern:') ||
        lowerTitle.includes('expression of concern')
      ) {
        return {
          nature: 'expression_of_concern',
          reason: 'Identified from publication title notation',
          source: 'manual',
        };
      }
    }

    // 3. Online Scan via Crossref / OpenAlex if DOI is available
    if (cleanDoiVal) {
      try {
        const onlineResult = await this.queryOnlineRetraction(cleanDoiVal);
        if (onlineResult) {
          // Save to local cache
          await this.prisma.retractionRecord.upsert({
            where: { doi: cleanDoiVal },
            create: {
              doi: cleanDoiVal,
              pmid: cleanPmidVal || null,
              nature: onlineResult.nature,
              reason: onlineResult.reason || '',
              noticeUrl: onlineResult.noticeUrl || null,
              retractionDate: onlineResult.date
                ? new Date(onlineResult.date)
                : null,
              source: onlineResult.source,
            },
            update: {
              nature: onlineResult.nature,
              reason: onlineResult.reason || '',
              noticeUrl: onlineResult.noticeUrl || null,
              retractionDate: onlineResult.date
                ? new Date(onlineResult.date)
                : null,
              source: onlineResult.source,
            },
          });

          return onlineResult;
        }
      } catch (err: any) {
        this.logger.debug(
          `Online retraction scan for ${cleanDoiVal} skipped/failed: ${err?.message}`,
        );
      }
    }

    return null;
  }

  private async queryOnlineRetraction(
    doi: string,
  ): Promise<RetractionDetails | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    try {
      // Query Crossref API with timeout
      const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'FluxResearch/1.0 (mailto:support@flux.dev)',
        },
      });

      if (!res.ok) return null;
      const data: any = await res.json();
      const message = data?.message;
      if (!message) return null;

      // Check Crossref update-to relations
      const updateTo = message['update-to'];
      if (Array.isArray(updateTo) && updateTo.length > 0) {
        for (const update of updateTo) {
          const updateType = (update.type || '').toLowerCase();
          if (updateType === 'retraction') {
            return {
              nature: 'retraction',
              reason: update.label || 'Retracted by publisher',
              noticeUrl: update.doi
                ? `https://doi.org/${update.doi}`
                : undefined,
              date: update.updated?.['date-time'] || undefined,
              source: 'crossref',
            };
          }
          if (
            updateType === 'expression_of_concern' ||
            updateType === 'concern'
          ) {
            return {
              nature: 'expression_of_concern',
              reason: update.label || 'Publisher issued expression of concern',
              noticeUrl: update.doi
                ? `https://doi.org/${update.doi}`
                : undefined,
              source: 'crossref',
            };
          }
        }
      }

      // Check Crossref assertions
      const assertions = message.assertion;
      if (Array.isArray(assertions)) {
        for (const ass of assertions) {
          const name = (ass.name || '').toLowerCase();
          if (name === 'retraction' || name === 'retracted') {
            return {
              nature: 'retraction',
              reason: ass.value || 'Publisher retraction notice recorded',
              source: 'crossref',
            };
          }
        }
      }
    } catch {
      // Ignore network timeout/failure
    } finally {
      clearTimeout(timeout);
    }

    return null;
  }
}
