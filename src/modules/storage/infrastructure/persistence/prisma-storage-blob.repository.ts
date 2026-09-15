import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { IStorageBlobRepository } from '../../domain/ports/storage-blob.repository.port';
import { StorageBlob } from '../../domain/entities/storage-blob.entity';
import { ContentHash } from '../../domain/value-objects/content-hash.vo';
import { StorageBlobMapper } from './mappers/storage-blob.mapper';

@Injectable()
export class PrismaStorageBlobRepository implements IStorageBlobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<StorageBlob | null> {
    const record = await this.prisma.storageBlob.findUnique({
      where: { id },
    });
    return record ? StorageBlobMapper.toDomain(record) : null;
  }

  async findByHash(contentHash: ContentHash): Promise<StorageBlob | null> {
    const record = await this.prisma.storageBlob.findUnique({
      where: {
        contentHash: Uint8Array.from(contentHash.toBytes()),
      },
    });
    return record ? StorageBlobMapper.toDomain(record) : null;
  }

  async create(blob: StorageBlob): Promise<StorageBlob> {
    const data = StorageBlobMapper.toPrismaCreate(blob);
    const created = await this.prisma.storageBlob.create({
      data: {
        ...data,
        contentHash: Uint8Array.from(blob.contentHash.toBytes()),
      },
    });
    return StorageBlobMapper.toDomain(created);
  }

  async update(blob: StorageBlob): Promise<StorageBlob> {
    const data = StorageBlobMapper.toPrismaCreate(blob);
    const updated = await this.prisma.storageBlob.update({
      where: { id: blob.id },
      data: {
        refCount: data.refCount,
        status: data.status,
        tombstoneAt: data.tombstoneAt,
      },
    });
    return StorageBlobMapper.toDomain(updated);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.storageBlob.delete({
      where: { id },
    });
  }

  async findTombstonedBlobs(
    threshold: Date,
    limit: number,
  ): Promise<StorageBlob[]> {
    const records = await this.prisma.storageBlob.findMany({
      where: {
        refCount: { lte: 0 },
        tombstoneAt: { lt: threshold },
      },
      take: limit,
    });
    return records.map(StorageBlobMapper.toDomain);
  }
}
