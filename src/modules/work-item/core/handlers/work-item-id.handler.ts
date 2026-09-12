import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { deriveProjectIdentifierPrefix } from '../utils/work-item.util';

export interface NextIdentifierResult {
  identifier: string;
  sequenceNumber: number;
}

@Injectable()
export class WorkItemIdHandler {
  constructor(private readonly prismaService: PrismaService) {}

  async nextIdentifier(projectId: string): Promise<NextIdentifierResult> {
    try {
      const project = await this.prismaService.project.update({
        where: { id: projectId },
        data: { taskSequence: { increment: 1 } },
        select: { name: true, identifier: true, taskSequence: true },
      });

      const prefix = deriveProjectIdentifierPrefix(project.identifier, project.name);

      return {
        identifier: `${prefix}-${project.taskSequence}`,
        sequenceNumber: project.taskSequence,
      };
    } catch {
      const project = await this.prismaService.project.findUnique({
        where: { id: projectId },
        select: { identifier: true, name: true },
      });
      const prefix = deriveProjectIdentifierPrefix(project?.identifier, project?.name);

      const lastTask = await this.prismaService.task.findFirst({
        where: { projectId },
        orderBy: { sequenceNumber: 'desc' },
        select: { sequenceNumber: true },
      });

      const sequenceNumber = (lastTask?.sequenceNumber ?? 0) + 1;
      return { identifier: `${prefix}-${sequenceNumber}`, sequenceNumber };
    }
  }
}
