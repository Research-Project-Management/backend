/**
 * project-history/project-history.repository.ts
 * Direct Injectable Repository and Adapters for Project History Snapshots & Version Labels.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as pathPosix from 'node:path/posix';
import { PrismaService, mapWithConcurrency } from '@/core';
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
import { DocumentUpdaterService } from '@/modules/manuscripts/document-updater/document-updater.service';
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

  public static toDomainSnapshot(prisma: PrismaSnapshotWithLabels): Snapshot {
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

  public static toDomain(prisma: PrismaSnapshotWithLabels): Snapshot {
    return this.toDomainSnapshot(prisma);
  }
}

@Injectable()
export class MyersDiffEngineAdapter extends IDiffEnginePort {
  private readonly engine = new MyersDiffEngine();

  public compareSnapshots(
    baseSnapshot: Snapshot,
    targetSnapshot: Snapshot,
  ): FileDiffVo[] {
    return this.engine.compareSnapshots(baseSnapshot, targetSnapshot);
  }

  public diffText(oldLines: string[], newLines: string[]): TextDiffResult {
    return this.engine.diffText(oldLines, newLines);
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
    private readonly documentUpdaterService: DocumentUpdaterService,
  ) {
    super();
  }

  public async collectCurrentState(
    projectId: string,
  ): Promise<Map<string, FileSnapshotVo>> {
    try {
      await this.documentUpdaterService.flushProject(projectId, true);
    } catch (err) {
      this.logger.warn(
        `Failed to flush project ${projectId} prior to snapshot collection: ${err}`,
      );
    }

    const nodes = await this.structureService.getAllNodes(projectId);
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
    private readonly documentUpdaterService: DocumentUpdaterService,
  ) {
    super();
  }

  public async restoreToState(
    projectId: string,
    snapshot: Snapshot,
  ): Promise<RestoreResult> {
    try {
      await this.documentUpdaterService.flushProject(projectId, true);
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
        if (existingNode && existingNode.isDoc() && existingNode.docId) {
          await this.docstoreService.updateDoc(projectId, existingNode.docId, {
            lines: fileVo.lines || [''],
          });
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
      } else if (fileVo.type === 'file' && fileVo.fileId) {
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
    return ManuscriptHistoryMapper.toDomainSnapshot(record);
  }

  public async saveSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    const created = await this.prisma.manuscriptSnapshot.upsert({
      where: {
        projectId_version: {
          projectId: snapshot.projectId,
          version: snapshot.version,
        },
      },
      create: {
        id: snapshot.id,
        projectId: snapshot.projectId,
        version: snapshot.version,
        summary: snapshot.summary,
        createdById: snapshot.createdById,
        isAutomatic: snapshot.isAutomatic,
        files: snapshot.toFilesJson() as Prisma.InputJsonValue,
        createdAt: snapshot.createdAt,
      },
      update: {
        summary: snapshot.summary,
        files: snapshot.toFilesJson() as Prisma.InputJsonValue,
      },
      include: {
        labels: true,
      },
    });

    return ManuscriptHistoryMapper.toDomainSnapshot(created);
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
    return ManuscriptHistoryMapper.toDomainSnapshot(found);
  }

  public async getLatestVersion(projectId: string): Promise<number> {
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
      include: {
        labels: true,
      },
    });

    return records.map((r) =>
      ManuscriptHistoryMapper.toDomainSnapshot(r as PrismaSnapshotWithLabels),
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
