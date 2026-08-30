import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import {
  ZoteroConnection,
  ZoteroBinding,
  ZoteroItemBinding,
  ZoteroSyncRun,
  ZoteroSyncFailure,
  Prisma,
} from '@prisma/client';

@Injectable()
export class ZoteroRepository {
  private readonly logger = new Logger(ZoteroRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Connection Operations ─────────────────────────────────────────────────

  async findConnectionById(
    workspaceId: string,
    id: string,
  ): Promise<ZoteroConnection | null> {
    return this.prisma.zoteroConnection.findFirst({
      where: { id, workspaceId },
      include: { bindings: true },
    });
  }

  async findConnectionsByWorkspace(
    workspaceId: string,
  ): Promise<ZoteroConnection[]> {
    return this.prisma.zoteroConnection.findMany({
      where: { workspaceId },
      include: { bindings: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createConnection(
    data: Prisma.ZoteroConnectionUncheckedCreateInput,
  ): Promise<ZoteroConnection> {
    return this.prisma.zoteroConnection.create({
      data,
    });
  }

  async updateConnection(
    workspaceId: string,
    id: string,
    data: Prisma.ZoteroConnectionUpdateInput,
  ): Promise<ZoteroConnection> {
    return this.prisma.zoteroConnection.update({
      where: { id },
      data,
    });
  }

  async deleteConnection(
    workspaceId: string,
    id: string,
  ): Promise<ZoteroConnection> {
    return this.prisma.zoteroConnection.delete({
      where: { id },
    });
  }

  // ── Binding Operations ────────────────────────────────────────────────────

  async findBindingById(
    workspaceId: string,
    id: string,
  ): Promise<(ZoteroBinding & { connection: ZoteroConnection }) | null> {
    return this.prisma.zoteroBinding.findFirst({
      where: { id, workspaceId },
      include: { connection: true },
    });
  }

  async findBindingsByWorkspace(
    workspaceId: string,
  ): Promise<(ZoteroBinding & { connection: ZoteroConnection })[]> {
    return this.prisma.zoteroBinding.findMany({
      where: { workspaceId },
      include: { connection: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findBindingsByConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<ZoteroBinding[]> {
    return this.prisma.zoteroBinding.findMany({
      where: { workspaceId, connectionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createBinding(
    data: Prisma.ZoteroBindingUncheckedCreateInput,
  ): Promise<ZoteroBinding> {
    return this.prisma.zoteroBinding.create({
      data,
    });
  }

  async updateBinding(
    workspaceId: string,
    id: string,
    data: Prisma.ZoteroBindingUpdateInput,
  ): Promise<ZoteroBinding> {
    return this.prisma.zoteroBinding.update({
      where: { id },
      data,
    });
  }

  async deleteBinding(workspaceId: string, id: string): Promise<ZoteroBinding> {
    return this.prisma.zoteroBinding.delete({
      where: { id },
    });
  }

  // ── Item Binding Operations ───────────────────────────────────────────────

  async findItemBinding(
    workspaceId: string,
    bindingId: string,
    remoteKey: string,
  ): Promise<ZoteroItemBinding | null> {
    return this.prisma.zoteroItemBinding.findFirst({
      where: { workspaceId, bindingId, remoteKey },
    });
  }

  async findItemBindingByEntity(
    workspaceId: string,
    entityType: string,
    entityId: string,
  ): Promise<ZoteroItemBinding | null> {
    return this.prisma.zoteroItemBinding.findFirst({
      where: { workspaceId, entityType, entityId },
    });
  }

  async findItemBindingsByRemoteKeys(
    workspaceId: string,
    bindingId: string,
    remoteKeys: string[],
  ): Promise<ZoteroItemBinding[]> {
    return this.prisma.zoteroItemBinding.findMany({
      where: {
        workspaceId,
        bindingId,
        remoteKey: { in: remoteKeys },
      },
    });
  }

  async upsertItemBinding(
    bindingId: string,
    remoteKey: string,
    createData: Prisma.ZoteroItemBindingUncheckedCreateInput,
    updateData: Prisma.ZoteroItemBindingUpdateInput,
  ): Promise<ZoteroItemBinding> {
    return this.prisma.zoteroItemBinding.upsert({
      where: {
        bindingId_remoteKey: {
          bindingId,
          remoteKey,
        },
      },
      create: createData,
      update: updateData,
    });
  }

  async deleteItemBinding(
    workspaceId: string,
    id: string,
  ): Promise<ZoteroItemBinding> {
    return this.prisma.zoteroItemBinding.delete({
      where: { id },
    });
  }

  // ── Sync Run Operations ───────────────────────────────────────────────────

  async createSyncRun(
    data: Prisma.ZoteroSyncRunUncheckedCreateInput,
  ): Promise<ZoteroSyncRun> {
    return this.prisma.zoteroSyncRun.create({
      data,
    });
  }

  async updateSyncRun(
    id: string,
    data: Prisma.ZoteroSyncRunUpdateInput,
  ): Promise<ZoteroSyncRun> {
    return this.prisma.zoteroSyncRun.update({
      where: { id },
      data,
    });
  }

  async createSyncFailure(
    data: Prisma.ZoteroSyncFailureUncheckedCreateInput,
  ): Promise<ZoteroSyncFailure> {
    return this.prisma.zoteroSyncFailure.create({
      data,
    });
  }

  async findRecentSyncRuns(
    workspaceId: string,
    bindingId?: string,
    limit: number = 20,
  ): Promise<ZoteroSyncRun[]> {
    return this.prisma.zoteroSyncRun.findMany({
      where: {
        workspaceId,
        ...(bindingId ? { bindingId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }
}
