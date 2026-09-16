import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../core/database/prisma.service';
import { RetractionDetails } from '../types/retraction.types';
import { RetractionDatabaseService } from '../services/retraction-database.service';
import {
  getAcademicContactEmail,
  getAcademicUserAgent,
} from '../../core/constants/academic-client.constants';

@Injectable()
export class RetractionScannerProvider {
  private readonly logger = new Logger(RetractionScannerProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly retractionDb: RetractionDatabaseService,
  ) {}

  /**
   * Scans a DOI and/or title for retraction markers.
   * Checks local Retraction Watch dataset & in-memory index first (0ms),
   * then title heuristics, then external provider.
   */
  async scan(
    doi?: string | null,
    pmid?: string | null,
    title?: string | null,
  ): Promise<RetractionDetails | null> {
    const cleanDoiVal = doi?.trim().toLowerCase();
    const cleanPmidVal = pmid?.trim();

    // 1. Check local Retraction Watch dataset & in-memory fast index
    if (cleanDoiVal || cleanPmidVal) {
      const localResult = await this.retractionDb.checkRetraction(
        cleanDoiVal,
        cleanPmidVal,
      );

      if (localResult === false) {
        // Confirmed clean via verified cache / known non-retracted paper
        return null;
      }

      if (localResult) {
        // Confirmed retracted from Retraction Watch seed dataset or local DB
        return localResult;
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
          // Save to local retraction database
          await this.retractionDb.saveRetraction(
            cleanDoiVal,
            onlineResult,
            cleanPmidVal,
          );
          return onlineResult;
        } else {
          // Record as verified clean to eliminate redundant online calls on future scans
          await this.retractionDb.saveClean(cleanDoiVal, cleanPmidVal);
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
      // Query Crossref API with timeout and polite pool
      const mailto = getAcademicContactEmail();
      const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': getAcademicUserAgent('RetractionScanner'),
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
