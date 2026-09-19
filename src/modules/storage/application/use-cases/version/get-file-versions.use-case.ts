import { Injectable, Inject } from '@nestjs/common';
import { STORAGE_VERSION_REPOSITORY } from '../../../storage.tokens';
import { IStorageVersionRepository } from '../../../domain/ports/storage-version.repository.port';
import { StorageAccessPolicy } from '../../policies/storage-access.policy';

export interface FileVersionDto {
  id: string;
  versionNumber: number;
  size: number;
  changeComment: string | null;
  createdAt: string;
  isCurrent: boolean;
  author: {
    id: string;
    name: string;
    avatar: string | null;
  } | null;
}

export interface GetFileVersionsOutput {
  fileId: string;
  filename: string;
  currentVersionNumber: number;
  totalVersions: number;
  versions: FileVersionDto[];
}

@Injectable()
export class GetFileVersionsUseCase {
  constructor(
    @Inject(STORAGE_VERSION_REPOSITORY)
    private readonly versionRepo: IStorageVersionRepository,
    private readonly accessPolicy: StorageAccessPolicy,
  ) {}

  async execute(
    fileId: string,
    userId: string,
  ): Promise<GetFileVersionsOutput> {
    const node = await this.accessPolicy.assertCanAccess(
      userId,
      fileId,
      'read',
    );

    const versions = await this.versionRepo.findByFileId(fileId);

    // If no version history exists yet, provide a virtual v1 for the existing file
    if (versions.length === 0) {
      return {
        fileId: node.id,
        filename: node.name,
        currentVersionNumber: 1,
        totalVersions: 1,
        versions: [
          {
            id: `initial-${node.id}`,
            versionNumber: 1,
            size: Number(node.size),
            changeComment: 'Bản khởi tạo (Initial version)',
            createdAt: node.createdAt.toISOString(),
            isCurrent: true,
            author: null,
          },
        ],
      };
    }

    // Sort descending by versionNumber
    const sorted = [...versions].sort(
      (a, b) => b.versionNumber - a.versionNumber,
    );
    const maxVersion = sorted[0]?.versionNumber || 1;

    const dtos: FileVersionDto[] = sorted.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      size: Number(v.sizeBytes),
      changeComment: v.changeComment,
      createdAt: v.createdAt.toISOString(),
      isCurrent: v.blobId === node.blobId || v.versionNumber === maxVersion,
      author: v.author
        ? {
            id: v.author.id,
            name: v.author.name || 'Research Contributor',
            avatar: v.author.avatar || null,
          }
        : null,
    }));

    return {
      fileId: node.id,
      filename: node.name,
      currentVersionNumber:
        dtos.find((d) => d.isCurrent)?.versionNumber ?? maxVersion,
      totalVersions: dtos.length,
      versions: dtos,
    };
  }
}
