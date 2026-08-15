import { Injectable, NotFoundException } from '@nestjs/common';
import { FileRepository } from './file.repository';
import { R2Service } from '../r2/r2.service';
import { Prisma } from '@prisma/client';
import {
  PresignDto,
  UploadFileDto,
  CreateFolderDto,
  UpdateFileDto,
  ShareFileDto,
} from './dto/file.dto';

export type FormattedFile<
  T extends {
    id: string;
    parentId?: string | null;
  },
> = T & {
  parent?: string | null;
};

@Injectable()
export class FileService {
  constructor(
    private readonly fileRepo: FileRepository,
    private readonly r2Service: R2Service,
  ) {}

  private formatFile<
    T extends {
      id: string;
      parentId?: string | null;
    },
  >(f: T): FormattedFile<T>;
  private formatFile(f: null | undefined): null;
  private formatFile<
    T extends {
      id: string;
      parentId?: string | null;
    },
  >(f: T | null | undefined): FormattedFile<T> | null;
  private formatFile<
    T extends {
      id: string;
      parentId?: string | null;
    },
  >(f: T | null | undefined): FormattedFile<T> | null {
    if (!f) return null;
    return {
      ...f,
      parent: f.parentId,
    };
  }

  async presign(dto: PresignDto) {
    const key = dto.filename.startsWith('/')
      ? dto.filename.slice(1)
      : dto.filename;
    return this.r2Service.getPresignedUploadUrl(key, dto.mimeType);
  }

  async upload(
    userId: string,
    scope: { workspaceId?: string; projectId?: string; pageId?: string },
    dto: UploadFileDto,
  ) {
    const linkedToType = scope.pageId
      ? 'Page'
      : scope.projectId
        ? 'Project'
        : scope.workspaceId
          ? 'Workspace'
          : null;
    const linkedToId =
      scope.pageId || scope.projectId || scope.workspaceId || null;

    const file = await this.fileRepo.createFile({
      filename: dto.filename,
      isFolder: false,
      size: dto.size || 0,
      mimeType: dto.mimeType || 'application/octet-stream',
      url: dto.url || '',
      thumbnail: dto.thumbnail || null,
      parentId: dto.parentId || null,
      metaData: (dto.metaData as Prisma.InputJsonValue) || {},
      authorId: userId,
      workspaceId: scope.workspaceId || null,
      linkedToType,
      linkedToId,
    });

    return { file: this.formatFile(file) };
  }

  async createFolder(
    userId: string,
    scope: { workspaceId?: string; projectId?: string; pageId?: string },
    dto: CreateFolderDto,
  ) {
    const linkedToType = scope.pageId
      ? 'Page'
      : scope.projectId
        ? 'Project'
        : scope.workspaceId
          ? 'Workspace'
          : null;
    const linkedToId =
      scope.pageId || scope.projectId || scope.workspaceId || null;

    const folder = await this.fileRepo.createFile({
      filename: dto.filename || dto.name || 'Untitled Folder',
      isFolder: true,
      parentId: dto.parentId || null,
      authorId: userId,
      workspaceId: scope.workspaceId || null,
      linkedToType,
      linkedToId,
    });

    return { folder: this.formatFile(folder) };
  }

  async getFile(fileId: string) {
    const file = await this.fileRepo.findFileById(fileId);

    if (!file) {
      throw new NotFoundException('File not found');
    }

    return { file: this.formatFile(file) };
  }

  async updateFile(fileId: string, dto: UpdateFileDto) {
    const file = await this.fileRepo.updateFile(fileId, {
      ...(dto.filename !== undefined && { filename: dto.filename }),
      ...(dto.starred !== undefined && { starred: dto.starred }),
      ...(dto.parentId !== undefined && { parentId: dto.parentId }),
      ...(dto.metaData !== undefined && {
        metaData: dto.metaData as Prisma.InputJsonValue,
      }),
    });

    return { file: this.formatFile(file) };
  }

  async deleteFile(fileId: string) {
    await this.fileRepo.updateFile(fileId, {
      trashedAt: new Date(),
    });
    return { message: 'File moved to trash' };
  }

  async restoreFile(fileId: string) {
    await this.fileRepo.updateFile(fileId, {
      trashedAt: null,
    });
    return { message: 'File restored successfully' };
  }

  async permanentlyDeleteFile(fileId: string) {
    const file = await this.fileRepo.findFileById(fileId);

    if (file) {
      const deletePromises: Promise<unknown>[] = [
        this.fileRepo.deleteFile(fileId),
      ];
      if (file.url && file.url.includes('/api/files/r2/')) {
        const key = file.url.replace('/api/files/r2/', '');
        deletePromises.push(this.r2Service.deleteObject(key));
      }
      await Promise.all(deletePromises);
    }

    return { message: 'File permanently deleted' };
  }

  async toggleStar(fileId: string) {
    const file = await this.fileRepo.findFileById(fileId);
    if (!file) throw new NotFoundException('File not found');

    const updated = await this.fileRepo.updateFile(fileId, {
      starred: !file.starred,
    });

    return { file: this.formatFile(updated) };
  }

  async renameFile(fileId: string, filename: string) {
    const file = await this.fileRepo.updateFile(fileId, {
      filename,
    });
    return { file: this.formatFile(file) };
  }

  async moveFile(fileId: string, parentId?: string) {
    const file = await this.fileRepo.updateFile(fileId, {
      parentId: parentId || null,
    });
    return { file: this.formatFile(file) };
  }

  async shareFile(fileId: string, dto: ShareFileDto) {
    const share = await this.fileRepo.upsertFileShare(
      fileId,
      dto.userId,
      dto.permission || 'view',
    );

    return { message: 'File shared successfully', share };
  }

  // ── Scoped Queries ──────────────────────────────────────────────────────────

  async getFiles(scope: {
    workspaceId?: string;
    projectId?: string;
    pageId?: string;
    parentId?: string;
  }) {
    const linkedToType = scope.pageId
      ? 'Page'
      : scope.projectId
        ? 'Project'
        : scope.workspaceId
          ? 'Workspace'
          : undefined;
    const linkedToId = scope.pageId || scope.projectId || scope.workspaceId;

    const files = await this.fileRepo.findFiles(
      {
        trashedAt: null,
        ...(linkedToId && { linkedToId, linkedToType }),
        ...(scope.workspaceId && { workspaceId: scope.workspaceId }),
        ...(scope.parentId !== undefined && { parentId: scope.parentId }),
      },
      [{ isFolder: 'desc' }, { filename: 'asc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getHomeFiles(workspaceId: string) {
    const files = await this.fileRepo.findFiles(
      {
        workspaceId,
        trashedAt: null,
        parentId: null,
      },
      [{ isFolder: 'desc' }, { createdAt: 'desc' }],
      50,
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getMyFiles(userId: string, workspaceId?: string, projectId?: string) {
    const files = await this.fileRepo.findFiles(
      {
        authorId: userId,
        trashedAt: null,
        ...(workspaceId && { workspaceId }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ createdAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getStarredFiles(workspaceId?: string, projectId?: string) {
    const files = await this.fileRepo.findFiles(
      {
        starred: true,
        trashedAt: null,
        ...(workspaceId && { workspaceId }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ updatedAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getSharedFiles(
    userId: string,
    workspaceId?: string,
    projectId?: string,
  ) {
    const shares = await this.fileRepo.findFileShares(userId);

    const files = shares
      .map((s) => s.file)
      .filter((f) => {
        if (!f || f.trashedAt) return false;
        if (workspaceId && f.workspaceId !== workspaceId) return false;
        if (
          projectId &&
          (f.linkedToId !== projectId || f.linkedToType !== 'Project')
        )
          return false;
        return true;
      });

    return { files: files.map((f) => this.formatFile(f)) };
  }

  async getTrashedFiles(workspaceId?: string, projectId?: string) {
    const files = await this.fileRepo.findFiles(
      {
        trashedAt: { not: null },
        ...(workspaceId && { workspaceId }),
        ...(projectId && { linkedToId: projectId, linkedToType: 'Project' }),
      },
      [{ trashedAt: 'desc' }],
    );

    return { files: files.map((f) => this.formatFile(f)) };
  }
}
