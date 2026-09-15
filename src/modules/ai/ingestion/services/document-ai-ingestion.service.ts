import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { PdfProvider } from '@/modules/library/attachments/providers/pdf.provider';
import { EngineService } from '../../engine/engine.service';
import { ScientificChunkingService } from './scientific-chunking.service';
import { FileUploadedEvent } from '@/modules/storage/domain/events/file-uploaded.event';

@Injectable()
export class DocumentAiIngestionService {
  private readonly logger = new Logger(DocumentAiIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storagePort: IStoragePort,
    private readonly pdfProvider: PdfProvider,
    private readonly chunkingService: ScientificChunkingService,
    private readonly engineService: EngineService,
  ) {}

  /**
   * Ingests a scientific file into the AI Assistant vector knowledge base.
   */
  async ingestFile(event: FileUploadedEvent): Promise<void> {
    const fileId = event.fileId;

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file || file.trashedAt) {
      this.logger.warn(
        `Storage file ${fileId} not found or deleted. Skipping AI ingestion.`,
      );
      return;
    }

    const currentMeta = (file.metaData as Record<string, any>) || {};

    // Idempotency: Skip if already indexed
    if (currentMeta.ragStatus === 'indexed' && currentMeta.ragDocId) {
      this.logger.debug(
        `File ${fileId} already indexed into AI RAG (ragDocId: ${currentMeta.ragDocId}). Skipping.`,
      );
      return;
    }

    this.logger.log(
      `Starting AI RAG ingestion for file ${fileId} (${event.filename})...`,
    );

    // 1. Mark status as processing
    await this.prisma.file.update({
      where: { id: fileId },
      data: {
        metaData: {
          ...currentMeta,
          ragStatus: 'processing',
          ragStartedAt: new Date().toISOString(),
        },
      },
    });

    try {
      // 2. Read physical binary buffer via StoragePort
      const storageFile = await this.storagePort.readOwnedFile({
        fileId,
        userId: event.authorId,
        projectId: event.projectId ?? undefined,
      });

      if (!storageFile.buffer || storageFile.buffer.length === 0) {
        throw new Error(
          `Empty file buffer returned from storage for file ${fileId}`,
        );
      }

      // 3. Extract text and academic metadata (unpdf + Grobid)
      const extractedDoc = await this.pdfProvider.extractDocumentFromBuffer(
        storageFile.buffer,
      );

      // 4. Perform scientific semantic chunking
      const chunks = this.chunkingService.chunkPdfDocument(extractedDoc, {
        title: extractedDoc.metadata.title || event.filename,
        authors: extractedDoc.metadata.authors,
        doi: extractedDoc.metadata.doi,
        year: extractedDoc.metadata.year,
      });

      // 5. Assemble formatted Markdown for vector embedding & RAG retrieval
      const title = extractedDoc.metadata.title || event.filename;
      const authors =
        extractedDoc.metadata.authors?.join(', ') || 'Unknown Authors';
      const abstract =
        extractedDoc.metadata.abstract || 'No abstract extracted.';
      const doi = extractedDoc.metadata.doi || 'N/A';
      const year = extractedDoc.metadata.year || 'N/A';

      const markdownHeader =
        `# ${title}\n\n` +
        `**Authors:** ${authors}\n` +
        `**Year:** ${year} | **DOI:** ${doi}\n\n` +
        `## Abstract\n${abstract}\n\n` +
        `---\n\n## Content Chunks\n\n`;

      const markdownBody = chunks
        .map((c) => c.fullChunkText)
        .join('\n\n---\n\n');
      const fullDocumentMarkdown = `${markdownHeader}${markdownBody}`;

      // 6. Upload to FLux-AI / Qdrant vector database
      let ragDocId: string | null = null;
      try {
        const uploadResult = await this.engineService.uploadDocument(
          Buffer.from(fullDocumentMarkdown, 'utf8'),
          'text/markdown',
          `${event.filename}.md`,
          {
            userId: event.authorId,
            scopeId: event.projectId || event.authorId,
            projectId: event.projectId ?? undefined,
            title,
            tags: 'scientific-paper,rag,drive',
          },
        );

        ragDocId =
          (uploadResult as any)?.id || (uploadResult as any)?.docId || null;
      } catch (engineErr: any) {
        this.logger.warn(
          `Flux-AI vector upload deferred for file ${fileId}: ${engineErr.message}`,
        );
      }

      // 7. Update file metadata with extraction results and RAG status
      const isIndexed = Boolean(ragDocId);
      await this.prisma.file.update({
        where: { id: fileId },
        data: {
          metaData: {
            ...currentMeta,
            ragDocId: ragDocId || undefined,
            ragStatus: isIndexed ? 'indexed' : 'failed',
            ragIndexedAt: isIndexed ? new Date().toISOString() : undefined,
            ragError: isIndexed
              ? undefined
              : 'Vector engine unreachable, text extracted locally',
            title: extractedDoc.metadata.title,
            authors: extractedDoc.metadata.authors,
            doi: extractedDoc.metadata.doi,
            arxivId: extractedDoc.metadata.arxivId,
            year: extractedDoc.metadata.year,
            abstract: extractedDoc.metadata.abstract,
            chunkCount: chunks.length,
            pageCount: extractedDoc.pages.length,
          },
        },
      });

      this.logger.log(
        `AI RAG Ingestion finished for file ${fileId}: status=${isIndexed ? 'indexed' : 'offline_fallback'}, chunks=${chunks.length}`,
      );
    } catch (err: any) {
      this.logger.error(
        `AI RAG Ingestion failed for file ${fileId}: ${err.message}`,
        err.stack,
      );
      await this.prisma.file.update({
        where: { id: fileId },
        data: {
          metaData: {
            ...currentMeta,
            ragStatus: 'failed',
            ragError: err.message,
          },
        },
      });
    }
  }
}
