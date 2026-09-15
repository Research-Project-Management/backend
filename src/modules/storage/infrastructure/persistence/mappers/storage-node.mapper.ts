import { File as PrismaFile } from '@prisma/client';
import { StorageNode } from '../../../domain/entities/storage-node.entity';
import { FileScope } from '../../../domain/value-objects/file-scope.vo';

export class StorageNodeMapper {
  public static toDomain(record: PrismaFile): StorageNode {
    return new StorageNode({
      id: record.id,
      projectId: record.linkedToType === 'Project' ? record.linkedToId : null,
      parentId: record.parentId,
      name: record.filename,
      isFolder: record.isFolder,
      size: BigInt(record.size),
      mimeType: record.mimeType,
      blobId: record.blobId,
      scope: (record.linkedToType as FileScope) || FileScope.Personal,
      starred: record.starred,
      metadata: (record.metaData as Record<string, any>) || {},
      authorId: record.authorId,
      trashedAt: record.trashedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  public static toPrismaCreate(node: StorageNode) {
    return {
      id: node.id,
      filename: node.name,
      size: node.size,
      mimeType: node.mimeType,
      url: `/api/files/${encodeURIComponent(node.id)}/content`,
      isFolder: node.isFolder,
      starred: node.starred,
      metaData: node.metadata,
      parentId: node.parentId,
      linkedToType: node.scope,
      linkedToId: node.projectId,
      blobId: node.blobId,
      authorId: node.authorId,
      trashedAt: node.trashedAt,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }
}
