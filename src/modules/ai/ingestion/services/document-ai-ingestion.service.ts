import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '@/core';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';
import { EngineService } from '../../engine/engine.service';
import { ScientificChunkingService } from './scientific-chunking.service';
import { FileUploadedEvent } from '@/modules/storage';

@Injectable()
export class DocumentAiIngestionService {
  private readonly logger = new Logger(DocumentAiIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PORT) private readonly storagePort: IStoragePort,
    @Inject(LIBRARY_FACADE)
    private readonly libraryFacade: ILibraryFacade,
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

    const currentMeta = (file.metaData as Record<string, unknown>) || {};

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

      // 3. Extract text and academic metadata via LibraryFacade
      const extractedDoc =
        await this.libraryFacade.extractDocumentFromBuffer(storageFile.buffer);

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
          typeof uploadResult.id === 'string'
            ? uploadResult.id
            : typeof uploadResult.docId === 'string'
              ? uploadResult.docId
              : null;
      } catch (engineErr) {
        this.logger.warn(
          `Flux-AI vector upload deferred for file ${fileId}: ${String(engineErr)}`,
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

      // 8. Propagate ragDocId and metadata to linked Library Attachment & Item via LibraryFacade
      if (isIndexed && ragDocId) {
        try {
          const attachment =
            typeof this.libraryFacade.findAttachmentByFileId === 'function'
              ? await this.libraryFacade.findAttachmentByFileId(fileId)
              : await this.prisma.attachment.findFirst({
                  where: { fileId, deletedAt: null },
                  select: { id: true, itemId: true, metadata: true },
                });
          if (attachment) {
            await this.libraryFacade.updateAttachmentProcessingStatus(
              attachment.id,
              'indexed',
              {
                ragDocId,
                ragStatus: 'indexed',
              },
            );

            if (attachment.itemId) {
              await this.libraryFacade.updateItemAiMetadata(attachment.itemId, {
                ragDocId,
                ragStatus: 'indexed',
              });
            }
          }
        } catch (propagateErr) {
          this.logger.debug(
            `Non-fatal: could not propagate ragDocId to attachment/item: ${String(propagateErr)}`,
          );
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `AI RAG Ingestion failed for file ${fileId}: ${errorMessage}`,
        stack,
      );
      await this.prisma.file.update({
        where: { id: fileId },
        data: {
          metaData: {
            ...currentMeta,
            ragStatus: 'failed',
            ragError: errorMessage,
          },
        },
      });
    }
  }
}
