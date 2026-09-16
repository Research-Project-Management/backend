import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { UploadAssetDto, DocumentAssetItem } from './dto/asset.dto';
import { PageStatus, Prisma } from '@prisma/client';
import { slugifyTitle } from '../core/utils/document.utils';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';

const ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'eps',
  'pdf',
  'sty',
  'cls',
  'bst',
  'bib',
  'csv',
  'dat',
  'txt',
]);

function inferMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    eps: 'application/postscript',
    pdf: 'application/pdf',
    sty: 'text/x-tex',
    cls: 'text/x-tex',
    bst: 'text/plain',
    bib: 'application/x-bibtex',
    csv: 'text/csv',
    dat: 'text/plain',
    txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

@Injectable()
export class AssetService {
  private readonly logger = new Logger(AssetService.name);
  private static readonly MAX_ASSET_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
  ) {}

  /**
   * Uploads and stores a research document asset (image, figure, sty, cls, data).
   */
  async uploadAsset(
    projectId: string,
    userId: string,
    dto: UploadAssetDto,
  ): Promise<DocumentAssetItem> {
    const cleanFilename = dto.filename.trim();
    if (!cleanFilename) {
      throw new BadRequestException('Asset filename cannot be empty');
    }

    const ext = cleanFilename.split('.').pop()?.toLowerCase() || '';
    if (!ASSET_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        `Unsupported asset file format: .${ext}. Supported formats: ${Array.from(ASSET_EXTENSIONS).join(', ')}`,
      );
    }

    const mimeType = dto.mimeType || inferMimeType(cleanFilename);
    const buffer = Buffer.from(dto.contentBase64, 'base64');
    const sizeBytes = buffer.length;

    if (sizeBytes > AssetService.MAX_ASSET_SIZE_BYTES) {
      throw new BadRequestException(
        `Asset size exceeds limit of ${AssetService.MAX_ASSET_SIZE_BYTES / (1024 * 1024)}MB`,
      );
    }

    const cleanPath = dto.path || cleanFilename;

    let fileId: string | undefined;
    let storageUrl: string | undefined;

    if (this.storagePort) {
      try {
        const uploadRes = await this.storagePort.uploadFile({
          userId,
          filename: cleanFilename,
          buffer,
          mimeType,
          projectId,
          source: 'document',
        });
        fileId = uploadRes.fileId;
        storageUrl = uploadRes.url;
      } catch (err: any) {
        this.logger.warn(
          `Failed to offload document asset to storage port: ${err?.message}`,
        );
      }
    }

    const assetPayload: Record<string, any> = {
      isAsset: true,
      filename: cleanFilename,
      path: cleanPath,
      mimeType,
      sizeBytes,
      base64: dto.contentBase64,
      ...(fileId ? { fileId } : {}),
      ...(storageUrl ? { storageUrl } : {}),
    };

    const isImage = mimeType.startsWith('image/');
    const icon = isImage ? 'image' : 'paperclip';

    const page = await this.prisma.page.create({
      data: {
        title: cleanFilename,
        slug: slugifyTitle(cleanFilename),
        icon,
        content: assetPayload,
        status: PageStatus.published,
        project: { connect: { id: projectId } },
        author: { connect: { id: userId } },
        ...(dto.parentPageId
          ? { parentPage: { connect: { id: dto.parentPageId } } }
          : {}),
      },
    });

    return {
      id: page.id,
      filename: cleanFilename,
      path: cleanPath,
      mimeType,
      sizeBytes,
      fileId,
      storageUrl,
      projectId,
      parentPageId: page.parentPageId,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
  }

  /**
   * Lists all binary assets attached to a document project.
   */
  async getProjectAssets(projectId: string): Promise<DocumentAssetItem[]> {
    const pages = await this.prisma.page.findMany({
      where: {
        projectId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const assets: DocumentAssetItem[] = [];

    for (const p of pages) {
      const content = p.content as Record<string, any> | null;
      const ext = p.title.split('.').pop()?.toLowerCase() || '';

      if (content && content.isAsset) {
        assets.push({
          id: p.id,
          filename: content.filename || p.title,
          path: content.path || p.title,
          mimeType: content.mimeType || inferMimeType(p.title),
          sizeBytes:
            typeof content.sizeBytes === 'number' ? content.sizeBytes : 0,
          fileId: content.fileId,
          storageUrl: content.storageUrl,
          projectId: p.projectId,
          parentPageId: p.parentPageId,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        });
      } else if (ASSET_EXTENSIONS.has(ext)) {
        assets.push({
          id: p.id,
          filename: p.title,
          path: p.title,
          mimeType: inferMimeType(p.title),
          sizeBytes: 0,
          projectId: p.projectId,
          parentPageId: p.parentPageId,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        });
      }
    }

    return assets;
  }

  /**
   * Retrieves full binary payload of an asset.
   */
  async getAsset(assetId: string): Promise<DocumentAssetItem> {
    const page = await this.prisma.page.findFirst({
      where: { id: assetId, deletedAt: null },
    });

    if (!page) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    const content = page.content as Record<string, any> | null;
    let base64 = content?.base64 || '';
    const mimeType = content?.mimeType || inferMimeType(page.title);

    if (!base64 && content?.fileId && this.storagePort?.readOwnedFile) {
      try {
        const fileOutput = await this.storagePort.readOwnedFile({
          fileId: content.fileId,
        });
        if (fileOutput.buffer) {
          base64 = fileOutput.buffer.toString('base64');
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to read asset buffer from storage port: ${err?.message}`,
        );
      }
    }

    const sizeBytes =
      content?.sizeBytes || (base64 ? Buffer.from(base64, 'base64').length : 0);

    return {
      id: page.id,
      filename: content?.filename || page.title,
      path: content?.path || page.title,
      mimeType,
      sizeBytes,
      contentBase64: base64,
      fileId: content?.fileId,
      storageUrl: content?.storageUrl,
      projectId: page.projectId,
      parentPageId: page.parentPageId,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    };
  }

  /**
   * Returns a map of relative file path -> base64 string for all project assets.
   * Directly consumed by CompilerService to inject figures/images into the compilation workspace.
   */
  async getProjectAssetMap(projectId: string): Promise<Record<string, string>> {
    const pages = await this.prisma.page.findMany({
      where: {
        projectId,
        deletedAt: null,
      },
    });

    const fileMap: Record<string, string> = {};

    for (const p of pages) {
      const content = p.content as Record<string, any> | null;
      if (content && content.isAsset) {
        const filePath = content.path || content.filename || p.title;
        if (content.base64) {
          fileMap[filePath] = content.base64;
        } else if (content.fileId && this.storagePort?.readOwnedFile) {
          try {
            const fileOutput = await this.storagePort.readOwnedFile({
              fileId: content.fileId,
            });
            if (fileOutput.buffer) {
              fileMap[filePath] = fileOutput.buffer.toString('base64');
            }
          } catch (err: any) {
            this.logger.warn(
              `Failed to read asset from storage for project map: ${err?.message}`,
            );
          }
        }
      }
    }

    return fileMap;
  }

  /**
   * Soft-deletes an asset and cleans up underlying storage object if present.
   */
  async deleteAsset(assetId: string): Promise<{ ok: boolean }> {
    const page = await this.prisma.page.findFirst({
      where: { id: assetId, deletedAt: null },
    });

    if (!page) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    const content = page.content as Record<string, any> | null;
    if (content?.fileId && this.storagePort?.deleteFile) {
      try {
        await this.storagePort.deleteFile(content.fileId);
      } catch (err: any) {
        this.logger.warn(
          `Failed to delete storage file for asset ${content.fileId}: ${err?.message}`,
        );
      }
    }

    await this.prisma.page.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });

    return { ok: true };
  }
}
