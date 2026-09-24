import { Injectable } from '@nestjs/common';
import { IProjectAccessPort } from '../../domain/ports/project-access.port';
import { PrismaService } from '../../../../../core/database/prisma.service';

@Injectable()
export class PrismaProjectAccessAdapter implements IProjectAccessPort {
  constructor(private readonly prisma: PrismaService) {}

  async canAccessProject(userId: string, projectId: string): Promise<boolean> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });
    if (!project) return false;
    return (
      project.createdById === userId ||
      project.members.some((m: any) => m.userId === userId)
    );
  }

  async isProjectOwner(userId: string, projectId: string): Promise<boolean> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });
    if (!project) return false;
    return (
      project.createdById === userId ||
      project.members.some((m: any) => m.userId === userId && m.role === 'owner')
    );
  }
}
