import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { UploadAssetDto, DocumentAssetItem } from './dto/asset.dto';
import { PageStatus, Prisma } from '@prisma/client';
import { slugifyTitle, validateSafePath } from '../core/utils/document.utils';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { RedisCacheService } from '@/core/cache/redis.service';
import { DOCUMENT_REDIS_KEYS } from '../core/constants/redis-keys.constant';

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
    @Optional() private readonly cache?: RedisCacheService,
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

    if (cleanFilename.includes('/') || cleanFilename.includes('\\')) {
      throw new BadRequestException('Asset filename cannot contain path separators (/ or \\)');
    }

    try {
      validateSafePath(cleanFilename, 'Asset filename');
      if (dto.path) {
        validateSafePath(dto.path, 'Asset path');
      }
    } catch (err: any) {
      throw new BadRequestException(err.message);
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

    const cleanPath = (dto.path || cleanFilename).replace(/\\/g, '/');

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
      ...(fileId ? { fileId } : {}),
      ...(storageUrl ? { storageUrl } : {}),
      ...(!fileId ? { base64: dto.contentBase64 } : {}),
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

    if (this.cache && projectId) {
      await this.cache.del(DOCUMENT_REDIS_KEYS.projectTree(projectId));
    }

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
    const assets: DocumentAssetItem[] = [];
    const seenNames = new Set<string>();

    if (this.prisma?.page) {
      const pages = await this.prisma.page.findMany({
        where: {
          projectId,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      const safePages = Array.isArray(pages) ? pages : [];
      for (const p of safePages) {
        const content = p.content as Record<string, any> | null;
        const ext = p.title.split('.').pop()?.toLowerCase() || '';

        if (content && content.isAsset) {
          const item: DocumentAssetItem = {
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
          };
          assets.push(item);
          seenNames.add(item.filename);
        } else if (ASSET_EXTENSIONS.has(ext)) {
          const item: DocumentAssetItem = {
            id: p.id,
            filename: p.title,
            path: p.title,
            mimeType: inferMimeType(p.title),
            sizeBytes: 0,
            projectId: p.projectId,
            parentPageId: p.parentPageId,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          };
          assets.push(item);
          seenNames.add(item.filename);
        }
      }
    }

    // 2. Discover storage files attached to project or page
    if (this.prisma?.file) {
      try {
        const relatedIds = [projectId];
        if (this.prisma.page) {
          const page = await this.prisma.page.findUnique({
            where: { id: projectId },
            select: { projectId: true },
          });
          if (page?.projectId) {
            relatedIds.push(page.projectId);
          }
        }

        const storageFiles = await this.prisma.file.findMany({
          where: {
            trashedAt: null,
            isFolder: false,
            OR: [
              { linkedToId: { in: relatedIds } },
              { parentId: { in: relatedIds } },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });

        const safeStorageFiles = Array.isArray(storageFiles) ? storageFiles : [];
        for (const sf of safeStorageFiles) {
          if (seenNames.has(sf.filename)) continue;
          seenNames.add(sf.filename);

          const meta = (sf.metaData as Record<string, any>) || {};
          assets.push({
            id: sf.id,
            filename: sf.filename,
            path: meta.path || sf.filename,
            mimeType: sf.mimeType,
            sizeBytes: Number(sf.size),
            fileId: sf.id,
            storageUrl: sf.url || `/api/files/${encodeURIComponent(sf.id)}/content`,
            projectId,
            parentPageId: sf.parentId || null,
            createdAt: sf.createdAt,
            updatedAt: sf.updatedAt,
          });
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to scan storage files for project assets: ${err?.message}`,
        );
      }
    }

    return assets;
  }

  /**
   * Retrieves full binary payload of an asset.
   */
  async getAsset(assetId: string, userId?: string): Promise<DocumentAssetItem> {
    const page = this.prisma?.page
      ? await this.prisma.page.findFirst({
          where: { id: assetId, deletedAt: null },
        })
      : null;

    if (page) {
      if (userId && page.projectId) {
        await this.verifyProjectAccess(page.projectId, userId, [
          'owner',
          'contributor',
          'commenter',
          'viewer',
        ]);
      }
    }

    if (!page) {
      if (this.prisma?.file) {
        const fileNode = await this.prisma.file.findFirst({
          where: { id: assetId, trashedAt: null },
        });
        if (fileNode) {
          if (userId && fileNode.authorId !== userId && fileNode.linkedToId) {
            await this.verifyProjectAccess(fileNode.linkedToId, userId, [
              'owner',
              'contributor',
              'commenter',
              'viewer',
            ]);
          }
          let base64 = '';
          if (this.storagePort?.readOwnedFile) {
            try {
              const fileOutput = await this.storagePort.readOwnedFile({
                fileId: fileNode.id,
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
          const meta = (fileNode.metaData as Record<string, any>) || {};
          return {
            id: fileNode.id,
            filename: fileNode.filename,
            path: meta.path || fileNode.filename,
            mimeType: fileNode.mimeType,
            sizeBytes: Number(fileNode.size),
            contentBase64: base64,
            fileId: fileNode.id,
            storageUrl: fileNode.url || `/api/files/${encodeURIComponent(fileNode.id)}/content`,
            projectId: fileNode.linkedToId || '',
            parentPageId: fileNode.parentId || null,
            createdAt: fileNode.createdAt,
            updatedAt: fileNode.updatedAt,
          };
        }
      }
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
    const fileMap: Record<string, string> = {};

    // 1. Scan page assets
    if (this.prisma?.page) {
      try {
        const pages = await this.prisma.page.findMany({
          where: {
            projectId,
            deletedAt: null,
          },
        });

        const safePages = Array.isArray(pages) ? pages : [];
        for (const p of safePages) {
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
      } catch (err: any) {
        this.logger.warn(
          `Failed to scan page assets for project map: ${err?.message}`,
        );
      }
    }

    // 2. Discover storage files attached to project or page (StorageNode)
    if (this.prisma?.file && this.storagePort?.readOwnedFile) {
      try {
        const relatedIds = [projectId];
        if (this.prisma.page) {
          const page = await this.prisma.page.findUnique({
            where: { id: projectId },
            select: { projectId: true },
          });
          if (page?.projectId) {
            relatedIds.push(page.projectId);
          }
        }

        const storageFiles = await this.prisma.file.findMany({
          where: {
            trashedAt: null,
            isFolder: false,
            OR: [
              { linkedToId: { in: relatedIds } },
              { parentId: { in: relatedIds } },
            ],
          },
        });

        const safeStorageFiles = Array.isArray(storageFiles) ? storageFiles : [];
        for (const f of safeStorageFiles) {
          if (fileMap[f.filename]) continue;

          try {
            const fileOutput = await this.storagePort.readOwnedFile({
              fileId: f.id,
            });
            if (fileOutput.buffer) {
              const base64Data = fileOutput.buffer.toString('base64');
              fileMap[f.filename] = base64Data;
              const meta = (f.metaData as Record<string, any>) || {};
              if (
                meta.path &&
                typeof meta.path === 'string' &&
                meta.path !== f.filename
              ) {
                fileMap[meta.path] = base64Data;
              }
            }
          } catch (err: any) {
            this.logger.warn(
              `Failed to read storage node ${f.id} for project map: ${err?.message}`,
            );
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to scan storage files for project map: ${err?.message}`,
        );
      }
    }

    return fileMap;
  }

  /**
   * Soft-deletes an asset and cleans up underlying storage object if present.
   */
  async deleteAsset(assetId: string, userId?: string): Promise<{ ok: boolean }> {
    const page = this.prisma?.page
      ? await this.prisma.page.findFirst({
          where: { id: assetId, deletedAt: null },
        })
      : null;

    if (page) {
      if (userId && page.projectId) {
        await this.verifyProjectAccess(page.projectId, userId, [
          'owner',
          'contributor',
        ]);
      }
    }

    if (!page) {
      if (this.prisma?.file) {
        const fileNode = await this.prisma.file.findFirst({
          where: { id: assetId, trashedAt: null },
        });
        if (fileNode) {
          if (userId && fileNode.authorId !== userId && fileNode.linkedToId) {
            await this.verifyProjectAccess(fileNode.linkedToId, userId, [
              'owner',
              'contributor',
            ]);
          }
          if (this.storagePort?.deleteFile) {
            await this.storagePort.deleteFile(fileNode.id);
          }
          await this.prisma.file.update({
            where: { id: assetId },
            data: { trashedAt: new Date() },
          });
          if (this.cache && fileNode.linkedToId) {
            await this.cache.del(DOCUMENT_REDIS_KEYS.projectTree(fileNode.linkedToId));
          }
          return { ok: true };
        }
      }
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

    if (this.cache && page.projectId) {
      await this.cache.del(DOCUMENT_REDIS_KEYS.projectTree(page.projectId));
    }

    return { ok: true };
  }

  private async verifyProjectAccess(
    projectId: string,
    userId: string,
    requiredRoles?: string[],
  ): Promise<void> {
    if (!this.prisma?.projectMember) return;
    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId, userId },
      },
    });
    if (!member) {
      throw new ForbiddenException(
        'Access denied: You are not a member of the project owning this asset',
      );
    }
    if (requiredRoles && requiredRoles.length > 0) {
      const normalized = member.role.toLowerCase();
      const hasRole = requiredRoles.some((r) => r.toLowerCase() === normalized);
      if (!hasRole) {
        throw new ForbiddenException(
          `Access denied: Required role (${requiredRoles.join(', ')}), current role (${member.role})`,
        );
      }
    }
  }
}
