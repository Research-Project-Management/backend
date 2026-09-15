import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { UploadAssetDto, DocumentAssetItem } from './dto/asset.dto';
import { PageStatus, Prisma } from '@prisma/client';
import { slugifyTitle } from '../core/utils/document.utils';

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

  constructor(private readonly prisma: PrismaService) {}

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

    const assetPayload = {
      isAsset: true,
      filename: cleanFilename,
      path: cleanPath,
      mimeType,
      sizeBytes,
      base64: dto.contentBase64,
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
    const base64 = content?.base64 || '';
    const mimeType = content?.mimeType || inferMimeType(page.title);
    const sizeBytes =
      content?.sizeBytes || Buffer.from(base64, 'base64').length;

    return {
      id: page.id,
      filename: content?.filename || page.title,
      path: content?.path || page.title,
      mimeType,
      sizeBytes,
      contentBase64: base64,
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
      if (content && content.isAsset && content.base64) {
        const filePath = content.path || content.filename || p.title;
        fileMap[filePath] = content.base64;
      }
    }

    return fileMap;
  }

  /**
   * Soft-deletes an asset.
   */
  async deleteAsset(assetId: string): Promise<{ ok: boolean }> {
    const page = await this.prisma.page.findFirst({
      where: { id: assetId, deletedAt: null },
    });

    if (!page) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    await this.prisma.page.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });

    return { ok: true };
  }
}
