import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, LabelType, Label } from '@prisma/client';
import { ILabelRepository } from '@/modules/storage/file/types/storage-repository.interface';

@Injectable()
export class LabelRepository implements ILabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findWorkspaceLabels(
    workspaceId: string,
    type?: LabelType,
  ): Promise<Label[]> {
    return this.prisma.label.findMany({
      where: {
        workspaceId,
        ...(type && { type }),
      },
      orderBy: { name: 'asc' },
    });
  }

  async findLabelById(labelId: string): Promise<Label | null> {
    return this.prisma.label.findUnique({
      where: { id: labelId },
    });
  }

  async createLabel(
    data: Prisma.LabelCreateInput | Prisma.LabelUncheckedCreateInput,
  ): Promise<Label> {
    return this.prisma.label.create({
      data: data as Prisma.LabelCreateInput,
    });
  }

  async updateLabel(
    labelId: string,
    data: Prisma.LabelUpdateInput | Prisma.LabelUncheckedUpdateInput,
  ): Promise<Label> {
    return this.prisma.label.update({
      where: { id: labelId },
      data: data,
    });
  }

  async deleteLabel(labelId: string): Promise<Label> {
    return this.prisma.label.delete({
      where: { id: labelId },
    });
  }
}
