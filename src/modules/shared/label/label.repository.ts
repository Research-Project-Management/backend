import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, LabelType } from '@prisma/client';

@Injectable()
export class LabelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findWorkspaceLabels(workspaceId: string, type?: LabelType) {
    return this.prisma.label.findMany({
      where: {
        workspaceId,
        ...(type && { type }),
      },
      orderBy: { name: 'asc' },
    });
  }

  async createLabel(
    data: Prisma.LabelCreateInput | Prisma.LabelUncheckedCreateInput,
  ) {
    return this.prisma.label.create({
      data: data as Prisma.LabelCreateInput,
    });
  }

  async updateLabel(
    labelId: string,
    data: Prisma.LabelUpdateInput | Prisma.LabelUncheckedUpdateInput,
  ) {
    return this.prisma.label.update({
      where: { id: labelId },
      data: data,
    });
  }

  async deleteLabel(labelId: string) {
    return this.prisma.label.delete({
      where: { id: labelId },
    });
  }
}
