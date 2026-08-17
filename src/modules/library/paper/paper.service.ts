import { Injectable, NotFoundException } from '@nestjs/common';
import { PaperRepository } from './paper.repository';
import { Prisma, AttachmentType, RagStatus } from '@prisma/client';
import {
  IngestPaperDto,
  UploadPaperDto,
  AddAttachmentDto,
  UpdatePaperDto,
  ImportStoragePaperDto,
} from './dto/paper.dto';
import { FileService } from '@/modules/storage/file/file.service';
import { BibtexFormatter } from '../reference/formatters/bibtex.formatter';

@Injectable()
export class PaperService {
  constructor(
    private readonly paperRepo: PaperRepository,
    private readonly fileService: FileService,
    private readonly bibtexFormatter: BibtexFormatter,
  ) {}

  async getPapers(
    workspaceId: string,
    query?: {
      collectionId?: string;
      search?: string;
      limit?: number;
      skip?: number;
    },
  ) {
    const ws = await this.paperRepo.prisma.workspace.findFirst({
      where: { OR: [{ id: workspaceId }, { url: workspaceId }] },
      select: { id: true },
    });
    const targetWsId = ws?.id || workspaceId;

    const where: Prisma.PaperWhereInput = {
      workspaceId: targetWsId,
      deletedAt: null,
      ...(query?.collectionId && { collectionId: query.collectionId }),
    };

    if (query?.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { doi: { contains: query.search, mode: 'insensitive' } },
        { abstract: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [papers, total] = await Promise.all([
      this.paperRepo.findPapers(where, {
        orderBy: [{ createdAt: 'desc' }],
        take: query?.limit ? Number(query.limit) : 50,
        skip: query?.skip ? Number(query.skip) : 0,
      }),
      this.paperRepo.countPapers(where),
    ]);

    return {
      papers,
      total,
    };
  }

  async getPaperById(paperId: string) {
    const paper = await this.paperRepo.findPaperById(paperId);

    if (!paper || paper.deletedAt) {
      throw new NotFoundException('Paper not found');
    }

    return { paper };
  }

  async uploadPaper(workspaceId: string, userId: string, dto: UploadPaperDto) {
    const ws = await this.paperRepo.prisma.workspace.findFirst({
      where: { OR: [{ id: workspaceId }, { url: workspaceId }] },
      select: { id: true },
    });
    const targetWsId = ws?.id || workspaceId;

    let targetUserId = userId;
    if (!targetUserId) {
      const u = await this.paperRepo.prisma.user.findFirst({
        select: { id: true },
      });
      targetUserId = u?.id || '';
    }

    const citationKey =
      dto.citationKey ||
      this.bibtexFormatter.generateCitationKey(
        dto.title,
        dto.authors,
        dto.year,
      );

    const paper = await this.paperRepo.createPaper({
      title: dto.title,
      filename: dto.filename,
      fileUrl: dto.fileUrl,
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/pdf',
      authors: dto.authors || [],
      year: dto.year || null,
      doi: dto.doi || '',
      abstract: dto.abstract || '',
      journal: dto.journal || '',
      publisher: dto.publisher || '',
      keywords: dto.keywords || [],
      volume: dto.volume || '',
      issue: dto.issue || '',
      pages: dto.pages || '',
      issn: dto.issn || '',
      isbn: dto.isbn || '',
      url: dto.url || '',
      type: dto.type || '',
      language: dto.language || '',
      journalAbbr: dto.journalAbbr || '',
      shortTitle: dto.shortTitle || '',
      rights: dto.rights || '',
      citationKey,
      notes: (dto.notes as any) || [],
      workspaceId: targetWsId,
      uploadedById: targetUserId,
      collectionId: dto.collectionId || null,
      primaryFile: {
        fileId: dto.fileId || null,
        filename: dto.filename,
        url: dto.fileUrl,
        size: dto.size || 0,
        mimeType: dto.mimeType || 'application/pdf',
      },
    });

    return { paper };
  }

  async ingestPaper(workspaceId: string, userId: string, dto: IngestPaperDto) {
    const citationKey =
      dto.citationKey ||
      this.bibtexFormatter.generateCitationKey(
        dto.title || 'Paper',
        dto.authors,
        dto.year,
      );

    const paper = await this.paperRepo.createPaper({
      title: dto.title || 'Untitled Paper',
      filename: dto.filename || 'paper.pdf',
      fileUrl: dto.fileUrl || '',
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/pdf',
      authors: dto.authors || [],
      year: dto.year || null,
      doi: dto.doi || '',
      citationKey,
      workspaceId,
      uploadedById: userId,
      collectionId: dto.collectionId || null,
      primaryFile: {
        fileId: dto.fileId || null,
        filename: dto.filename || 'paper.pdf',
        url: dto.fileUrl || '',
        size: dto.size || 0,
        mimeType: dto.mimeType || 'application/pdf',
      },
    });

    return { paper };
  }

  async importFromStorage(
    workspaceId: string,
    userId: string,
    dto: ImportStoragePaperDto,
  ) {
    const fileResult = await this.fileService.getFile(dto.fileId);
    const file = fileResult?.file;

    if (!file) {
      throw new NotFoundException('Storage file not found');
    }

    const title = dto.title || file.filename.replace(/\.[^/.]+$/, '');
    const citationKey =
      dto.citationKey ||
      this.bibtexFormatter.generateCitationKey(title, dto.authors);

    const paper = await this.paperRepo.createPaper({
      title,
      filename: file.filename,
      fileUrl: file.url || '',
      size: file.size || 0,
      mimeType: file.mimeType || 'application/pdf',
      authors: dto.authors || [],
      doi: dto.doi || '',
      citationKey,
      workspaceId,
      uploadedById: userId,
      collectionId: dto.collectionId || null,
      primaryFile: {
        fileId: file.id,
        filename: file.filename,
        url: file.url || '',
        size: file.size || 0,
        mimeType: file.mimeType || 'application/pdf',
      },
    });

    return { paper };
  }

  async updatePaper(paperId: string, dto: UpdatePaperDto) {
    const paper = await this.paperRepo.updatePaper(paperId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.authors !== undefined && { authors: dto.authors }),
      ...(dto.year !== undefined && { year: dto.year }),
      ...(dto.doi !== undefined && { doi: dto.doi }),
      ...(dto.abstract !== undefined && { abstract: dto.abstract }),
      ...(dto.keywords !== undefined && { keywords: dto.keywords }),
      ...(dto.itemType !== undefined && { itemType: dto.itemType }),
      ...(dto.editors !== undefined && { editors: dto.editors }),
      ...(dto.journal !== undefined && { journal: dto.journal }),
      ...(dto.publicationTitle !== undefined && {
        publicationTitle: dto.publicationTitle,
      }),
      ...(dto.publicationDate !== undefined && {
        publicationDate: dto.publicationDate,
      }),
      ...(dto.publisher !== undefined && { publisher: dto.publisher }),
      ...(dto.place !== undefined && { place: dto.place }),
      ...(dto.labels !== undefined && { labels: dto.labels }),
      ...(dto.volume !== undefined && { volume: dto.volume }),
      ...(dto.issue !== undefined && { issue: dto.issue }),
      ...(dto.section !== undefined && { section: dto.section }),
      ...(dto.pages !== undefined && { pages: dto.pages }),
      ...(dto.url !== undefined && { url: dto.url }),
      ...(dto.citationKey !== undefined && { citationKey: dto.citationKey }),
      ...(dto.collectionId !== undefined && {
        collectionId: dto.collectionId || null,
      }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
    });

    return { paper };
  }

  async deletePaper(paperId: string) {
    await this.paperRepo.updatePaper(paperId, {
      deletedAt: new Date(),
    });
    return { message: 'Paper deleted successfully' };
  }

  async restorePaper(paperId: string) {
    await this.paperRepo.updatePaper(paperId, {
      deletedAt: null,
    });
    return { message: 'Paper restored successfully' };
  }

  async addAttachment(paperId: string, dto: AddAttachmentDto) {
    const attachment = await this.paperRepo.createAttachment({
      paperId,
      filename: dto.filename,
      url: dto.url,
      fileId: dto.fileId || null,
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/octet-stream',
      attachmentType: dto.attachmentType || AttachmentType.supplementary,
    });

    return {
      message: 'Attachment added successfully',
      attachment,
    };
  }

  async removeAttachment(paperId: string, attachmentId: string) {
    await this.paperRepo.deleteAttachment(attachmentId);
    return { message: 'Attachment removed successfully' };
  }

  async exportBibtex(paperId: string) {
    const paper = await this.paperRepo.findPaperById(paperId);
    if (!paper) throw new NotFoundException('Paper not found');
    return this.bibtexFormatter.formatEntry(paper);
  }

  async triggerReindex(paperId: string, _userId: string) {
    await this.paperRepo.updatePaper(paperId, {
      ragStatus: RagStatus.pending,
      ragLastAttemptAt: new Date(),
    });

    return { message: 'RAG indexing queued' };
  }
}
