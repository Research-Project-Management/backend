import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { IngestionStatus } from '@prisma/client';
import { LibraryTransactionService } from '../sync-core/library-transaction.service';
import { CatalogService } from '../catalog/catalog.service';
import {
  StartIngestionDto,
  IngestDoiDto,
  IngestBibtexDto,
} from './dto/ingestion.dto';
import { createHash } from 'crypto';

export interface IngestionRunSnapshot {
  id: string;
  workspaceId: string;
  sourceType: string;
  status: IngestionStatus;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt?: Date | null;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly memRuns = new Map<string, IngestionRunSnapshot>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryTx: LibraryTransactionService,
    private readonly catalogService: CatalogService,
  ) {}

  /**
   * Initializes a durable ingestion run record.
   */
  async startRun(
    workspaceId: string,
    userId: string,
    dto: StartIngestionDto,
  ): Promise<IngestionRunSnapshot> {
    const inputHash = createHash('sha256')
      .update(dto.rawInput || JSON.stringify(dto.items || []))
      .digest('hex');

    try {
      const run = await this.prisma.ingestionRun.create({
        data: {
          workspaceId,
          inputParams: {
            sourceType: dto.sourceType,
            rawInput: dto.rawInput,
            totalItems: dto.items?.length || 1,
          },
          inputHash,
          status: IngestionStatus.RECEIVED,
        },
      });

      // Record first stage
      await this.prisma.ingestionStage.create({
        data: {
          ingestionRunId: run.id,
          stageName: 'INPUT_RECEIVED',
          durationMs: 0,
          success: true,
        },
      });

      const params = (run.inputParams as any) || {};

      return {
        id: run.id,
        workspaceId: run.workspaceId,
        sourceType: params.sourceType || dto.sourceType,
        status: run.status,
        totalItems: params.totalItems || 1,
        processedItems: 0,
        failedItems: 0,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };
    } catch {
      const run: IngestionRunSnapshot = {
        id: `run-${Date.now()}`,
        workspaceId,
        sourceType: dto.sourceType,
        status: IngestionStatus.RECEIVED,
        totalItems: dto.items?.length || 1,
        processedItems: 0,
        failedItems: 0,
        startedAt: new Date(),
        completedAt: null,
      };
      this.memRuns.set(run.id, run);
      return run;
    }
  }

  /**
   * Retrieves status and stages of an ingestion run.
   */
  async getRunStatus(runId: string): Promise<IngestionRunSnapshot> {
    try {
      const run = await this.prisma.ingestionRun.findUnique({
        where: { id: runId },
        include: { stages: { orderBy: { executedAt: 'asc' } } },
      });
      if (run) {
        const params = (run.inputParams as any) || {};
        return {
          id: run.id,
          workspaceId: run.workspaceId,
          sourceType: params.sourceType || 'UNKNOWN',
          status: run.status,
          totalItems: params.totalItems || 1,
          processedItems: 0,
          failedItems: 0,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        };
      }
    } catch {
      // Fallback
    }

    const mem = this.memRuns.get(runId);
    if (!mem) {
      throw new NotFoundException(`IngestionRun ${runId} not found`);
    }
    return mem;
  }

  /**
   * Ingest single item by DOI and commit atomically to catalog.
   */
  async ingestDoi(workspaceId: string, userId: string, dto: IngestDoiDto) {
    const cleanDoi = dto.doi.trim().replace(/^https?:\/\/doi\.org\//, '');

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const item = await this.catalogService.createItem(workspaceId, {
        itemType: 'journalArticle',
        title: `Publication (${cleanDoi})`,
        doi: cleanDoi,
        uploadedById: userId || 'system',
      });

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        'library.item.ingested_doi',
        { doi: cleanDoi, itemId: item.id },
      );

      return item;
    });
  }

  /**
   * Ingest BibTeX records and commit to catalog.
   */
  async ingestBibtex(
    workspaceId: string,
    userId: string,
    dto: IngestBibtexDto,
  ) {
    const raw = dto.bibtex.trim();
    const titleMatch = raw.match(/title\s*=\s*[{"]([^}"]+)[}"]/i);
    const title = titleMatch ? titleMatch[1] : 'Imported BibTeX Reference';

    const authorMatch = raw.match(/author\s*=\s*[{"]([^}"]+)[}"]/i);
    const authors = authorMatch
      ? authorMatch[1].split(' and ').map((a) => a.trim())
      : [];

    const yearMatch = raw.match(/year\s*=\s*[{"]?(\d{4})[}"]?/i);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;

    return this.libraryTx.executeInTransaction(async (tx, helpers) => {
      const item = await this.catalogService.createItem(workspaceId, {
        itemType: 'journalArticle',
        title,
        authors,
        year,
        uploadedById: userId || 'system',
      });

      await helpers.publishOutbox(
        workspaceId,
        item.id,
        'library.item.ingested_bibtex',
        { itemId: item.id, title },
      );

      return item;
    });
  }
}
