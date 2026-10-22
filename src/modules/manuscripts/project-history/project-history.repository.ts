/**
 * project-history/project-history.repository.ts
 * Direct Injectable Repository and Adapters for Project History Snapshots & Version Labels.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as pathPosix from 'node:path/posix';
import { PrismaService, mapWithConcurrency } from '@/core';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';
import {
  Prisma,
  ManuscriptSnapshot as PrismaSnapshot,
  ManuscriptLabel as PrismaLabel,
} from '@prisma/client';
import {
  IHistoryRepositoryPort,
  IDiffEnginePort,
  TextDiffResult,
  IProjectCollectorPort,
  IProjectRestorerPort,
  RestoreResult,
  Snapshot,
  VersionLabel,
  FileSnapshotVo,
  FileDiffVo,
  SnapshotNormalizer,
  RawSnapshotFileEntry,
  MyersDiffEngine,
} from './domain';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import type { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/domain';

export type { RawSnapshotFileEntry };

export type PrismaSnapshotWithLabels = PrismaSnapshot & {
  labels?: PrismaLabel[];
};

export class ManuscriptHistoryMapper {
  public static toDomainLabel(prisma: PrismaLabel): VersionLabel {
    return VersionLabel.create({
      id: prisma.id,
      projectId: prisma.projectId,
      snapshotId: prisma.snapshotId,
      version: prisma.version,
      label: prisma.label,
      createdById: prisma.createdById,
      createdAt: prisma.createdAt,
      updatedAt: prisma.updatedAt,
    });
  }

  public static parseSnapshotFiles(
    rawFiles: unknown,
  ): Map<string, FileSnapshotVo> {
    return SnapshotNormalizer.parseSnapshotFiles(rawFiles);
  }

  public static toDomainHeader(record: { id: string; projectId: string; version: number; summary: string | null; createdById: string | null; isAutomatic: boolean; createdAt: Date; sizeBytes?: number; labels?: PrismaLabel[]; }): Snapshot {
    const labels = record.labels ? record.labels.map((l) => this.toDomainLabel(l)) : [];
    return Snapshot.create({
      id: record.id,
      projectId: record.projectId,
      version: record.version,
      summary: record.summary,
      createdById: record.createdById,
      isAutomatic: record.isAutomatic,
      files: new Map(),
      fileCount: record.sizeBytes !== undefined && record.sizeBytes > 0 ? 1 : 1,
      labels,
      createdAt: record.createdAt,
    });
  }

  public static toDomain(prisma: PrismaSnapshotWithLabels): Snapshot {
    const filesMap = SnapshotNormalizer.parseSnapshotFiles(prisma.files);
    const labels = prisma.labels
      ? prisma.labels.map((l) => this.toDomainLabel(l))
      : [];

    return Snapshot.create({
      id: prisma.id,
      projectId: prisma.projectId,
      version: prisma.version,
      summary: prisma.summary,
      createdById: prisma.createdById,
      isAutomatic: prisma.isAutomatic,
      files: filesMap,
      labels,
      createdAt: prisma.createdAt,
    });
  }
}

const COLLECT_CONCURRENCY = 6;

@Injectable()
export class ManuscriptCollectorAdapter extends IProjectCollectorPort {
  private readonly logger = new Logger(ManuscriptCollectorAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    private readonly filestoreService: FilestoreService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    super();
  }

  public async collectCurrentState(
    projectId: string,
  ): Promise<Map<string, FileSnapshotVo>> {
    const nodes = await this.structureService.getAllNodes(projectId);

    try {
      const live = this.moduleRef?.get(LiveCollaborationPort, { strict: false });
      if (live) {
        const docIds = nodes.filter((n) => n.docId).map((n) => n.docId as string);
        await live.flushDocs(projectId, docIds);
      }
    } catch {
      // non-blocking live flush fallback
    }

    const filesMap = new Map<string, FileSnapshotVo>();

    const collected = await mapWithConcurrency<
      ManuscriptNodeEntity,
      FileSnapshotVo | null
    >(
      nodes.filter((n) => !n.isFolder()),
      COLLECT_CONCURRENCY,
      async (node: ManuscriptNodeEntity): Promise<FileSnapshotVo | null> => {
        if (node.isDoc() && node.docId) {
          try {
            const doc = await this.docstoreService.getDoc(
              projectId,
              node.docId,
            );
            return FileSnapshotVo.createDoc(
              node.path,
              node.docId,
              doc.lines || [''],
              doc.hash || '',
              node.isRootDoc,
            );
          } catch (error) {
            this.logger.error(
              `Error collecting doc ${node.docId} at path ${node.path}: ${error}`,
            );
          }
        } else if (node.type === 'FILE' && node.fileId) {
          try {
            const fileMeta = await this.filestoreService.getFileMetadata(
              projectId,
              node.fileId,
            );
            const hashString = fileMeta.hash
              ? fileMeta.hash.getValue()
              : node.hash || '';
            return FileSnapshotVo.createFile(
              node.path,
              node.fileId,
              hashString,
              fileMeta.sizeBytes || node.sizeBytes || 0,
            );
          } catch (error) {
            this.logger.error(
              `Error collecting file ${node.fileId} at path ${node.path}: ${error}`,
            );
          }
        }
        return null;
      },
    );
    for (const vo of collected) {
      if (vo) filesMap.set(vo.path, vo);
    }

    return filesMap;
  }
}

@Injectable()
export class ManuscriptRestorerAdapter extends IProjectRestorerPort {
  private readonly logger = new Logger(ManuscriptRestorerAdapter.name);

  constructor(
    private readonly structureService: StructureService,
    private readonly docstoreService: DocstoreService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    super();
  }

  public async restoreToState(
    projectId: string,
    snapshot: Snapshot,
  ): Promise<RestoreResult> {
    try {
      const live = this.moduleRef?.get(LiveCollaborationPort, { strict: false });
      if (live) {
        await live.flushDocs(projectId, []);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to flush project ${projectId} prior to restore: ${err}`,
      );
    }

    const currentNodes = await this.structureService.getAllNodes(projectId);
    const currentByPath = new Map<string, ManuscriptNodeEntity>(
      currentNodes.map((n: ManuscriptNodeEntity) => [n.path, n]),
    );
    const snapshotFiles = snapshot.files;
    const restoredDocIds: string[] = [];

    const requiredFolders = new Set<string>();
    for (const filePath of snapshotFiles.keys()) {
      let dir = pathPosix.dirname(filePath);
      while (dir && dir !== '.' && dir !== '/') {
        requiredFolders.add(dir);
        dir = pathPosix.dirname(dir);
      }
    }

    for (const node of currentNodes) {
      if (!node.isFolder() && !snapshotFiles.has(node.path)) {
        try {
          await this.structureService.deleteNode(projectId, node.id);
        } catch (err) {
          this.logger.warn(
            `Could not delete post-snapshot node ${node.path} (${node.id}): ${err}`,
          );
        }
      }
    }

    const orphanFolders = currentNodes
      .filter(
        (node) =>
          node.isFolder() &&
          node.path !== '/' &&
          !requiredFolders.has(node.path),
      )
      .sort((a, b) => b.path.length - a.path.length);

    for (const folder of orphanFolders) {
      try {
        await this.structureService.deleteNode(projectId, folder.id);
      } catch (err) {
        this.logger.warn(
          `Could not delete post-snapshot folder ${folder.path} (${folder.id}): ${err}`,
        );
      }
    }

    for (const [filePath, fileVo] of snapshotFiles.entries()) {
      const fileName = pathPosix.basename(filePath);
      const parentDir = pathPosix.dirname(filePath);

      if (parentDir && parentDir !== '.' && parentDir !== '/') {
        try {
          await this.structureService.mkdirp(projectId, parentDir);
        } catch (err) {
          this.logger.warn(`Could not ensure directory ${parentDir}: ${err}`);
        }
      }

      const existingNode = currentByPath.get(filePath);

      if (fileVo.type === 'doc') {
        let docIdToSync: string | null = null;
        if (fileVo.docId && this.prisma?.manuscriptDoc?.updateMany) {
          await this.prisma.manuscriptDoc
            .updateMany({
              where: { id: fileVo.docId, projectId },
              data: { deleted: false, deletedAt: null },
            })
            .catch(() => {});
        }
        if (existingNode && existingNode.isDoc() && existingNode.docId) {
          if (this.prisma?.manuscriptDoc?.updateMany) {
            await this.prisma.manuscriptDoc
              .updateMany({
                where: { id: existingNode.docId, projectId },
                data: { deleted: false, deletedAt: null },
              })
              .catch(() => {});
          }
          await this.docstoreService.updateDoc(projectId, existingNode.docId, {
            lines: fileVo.lines || [''],
          });
          docIdToSync = existingNode.docId;
          restoredDocIds.push(existingNode.docId);

          if (fileVo.isRootDoc) {
            await this.structureService.setRootDoc(projectId, existingNode.id);
          }
        } else {
          if (existingNode) {
            await this.structureService.deleteNode(projectId, existingNode.id);
          }

          const createdDoc = await this.docstoreService.createDoc(projectId, {
            path: filePath,
            lines: fileVo.lines || [''],
          });
          docIdToSync = createdDoc._id;
          restoredDocIds.push(createdDoc._id);

          const newNode = await this.structureService.createNode(projectId, {
            name: fileName,
            path: filePath,
            type: 'DOC',
            docId: createdDoc._id,
            isRootDoc: fileVo.isRootDoc,
          });

          if (fileVo.isRootDoc) {
            await this.structureService.setRootDoc(projectId, newNode.id);
          }
        }

        if (docIdToSync) {
          try {
            const live = this.moduleRef?.get(LiveCollaborationPort, {
              strict: false,
            });
            if (live) {
              await live.applyExternalText(
                projectId,
                docIdToSync,
                (fileVo.lines || ['']).join('\n'),
              );
            }
          } catch {
            // non-blocking fallback
          }
        }
      } else if (fileVo.type === 'file' && fileVo.fileId) {
        if (this.prisma?.manuscriptFile?.updateMany) {
          await this.prisma.manuscriptFile
            .updateMany({
              where: { id: fileVo.fileId, projectId },
              data: { deleted: false, deletedAt: null },
            })
            .catch(() => {});
        }
        if (existingNode) {
          if (
            existingNode.type !== 'FILE' ||
            existingNode.fileId !== fileVo.fileId
          ) {
            await this.structureService.deleteNode(projectId, existingNode.id);
            await this.structureService.createNode(projectId, {
              name: fileName,
              path: filePath,
              type: 'FILE',
              fileId: fileVo.fileId,
            });
          }
        } else {
          await this.structureService.createNode(projectId, {
            name: fileName,
            path: filePath,
            type: 'FILE',
            fileId: fileVo.fileId,
          });
        }
      }
    }

    return {
      restoredFilesCount: snapshotFiles.size,
      restoredDocIds,
    };
  }
}

@Injectable()
export class ProjectHistoryRepository extends IHistoryRepositoryPort {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  public toDomain(record: PrismaSnapshotWithLabels): Snapshot {
    return ManuscriptHistoryMapper.toDomain(record);
  }

  private async resolveNextVersion(
    projectId: string,
    fallbackVersion: number,
  ): Promise<number> {
    if (typeof this.prisma.manuscriptSnapshot.aggregate === 'function') {
      const agg = await this.prisma.manuscriptSnapshot.aggregate({
        where: { projectId },
        _max: { version: true },
      });
      return Math.max(fallbackVersion, (agg?._max?.version ?? 0) + 1);
    }
    const latest = await this.getLatestVersion(projectId);
    return Math.max(fallbackVersion, latest + 1);
  }

  public async saveSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    let candidateVersion = snapshot.version;
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const created = await this.prisma.manuscriptSnapshot.create({
          data: {
            id: snapshot.id,
            projectId: snapshot.projectId,
            version: candidateVersion,
            summary: snapshot.summary,
            createdById: snapshot.createdById,
            isAutomatic: snapshot.isAutomatic,
            files: snapshot.toFilesJson() as Prisma.InputJsonValue,
            createdAt: snapshot.createdAt,
          },
          include: {
            labels: true,
          },
        });
        return ManuscriptHistoryMapper.toDomain(created);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'P2002' && attempt < maxAttempts - 1) {
          candidateVersion = await this.resolveNextVersion(
            snapshot.projectId,
            candidateVersion + 1,
          );
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `Failed to save immutable snapshot for project ${snapshot.projectId} after ${maxAttempts} attempts`,
    );
  }

  public async findByVersion(
    projectId: string,
    version: number,
  ): Promise<Snapshot | null> {
    const found = await this.prisma.manuscriptSnapshot.findUnique({
      where: {
        projectId_version: {
          projectId,
          version,
        },
      },
      include: {
        labels: true,
      },
    });

    if (!found) return null;
    return ManuscriptHistoryMapper.toDomain(found);
  }

  public async getLatestVersion(projectId: string): Promise<number> {
    if (typeof this.prisma.manuscriptSnapshot.aggregate === 'function') {
      const agg = await this.prisma.manuscriptSnapshot.aggregate({
        where: { projectId },
        _max: { version: true },
      });
      if (agg?._max?.version !== undefined) {
        return agg._max.version ?? 0;
      }
    }
    const latest = await this.prisma.manuscriptSnapshot.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return latest ? latest.version : 0;
  }

  public async listVersions(projectId: string): Promise<Snapshot[]> {
    const records = await this.prisma.manuscriptSnapshot.findMany({
      where: { projectId },
      orderBy: { version: 'asc' },
      select: {
        id: true,
        projectId: true,
        version: true,
        summary: true,
        createdById: true,
        isAutomatic: true,
        sizeBytes: true,
        createdAt: true,
        labels: true,
      },
    });

    return records.map((r) =>
      ManuscriptHistoryMapper.toDomainHeader(r),
    );
  }

  public async saveLabel(label: VersionLabel): Promise<VersionLabel> {
    const saved = await this.prisma.manuscriptLabel.upsert({
      where: {
        projectId_label: {
          projectId: label.projectId,
          label: label.label,
        },
      },
      create: {
        id: label.id,
        projectId: label.projectId,
        snapshotId: label.snapshotId,
        version: label.version,
        label: label.label,
        createdById: label.createdById,
        createdAt: label.createdAt,
        updatedAt: label.updatedAt,
      },
      update: {
        snapshotId: label.snapshotId,
        version: label.version,
        label: label.label,
        updatedAt: label.updatedAt,
      },
    });

    return ManuscriptHistoryMapper.toDomainLabel(saved);
  }

  public async deleteLabel(projectId: string, labelId: string): Promise<void> {
    await this.prisma.manuscriptLabel.deleteMany({
      where: {
        id: labelId,
        projectId,
      },
    });
  }

  public async findLabelByName(
    projectId: string,
    label: string,
  ): Promise<VersionLabel | null> {
    const found = await this.prisma.manuscriptLabel.findUnique({
      where: {
        projectId_label: {
          projectId,
          label,
        },
      },
    });

    if (!found) return null;
    return ManuscriptHistoryMapper.toDomainLabel(found);
  }
}
