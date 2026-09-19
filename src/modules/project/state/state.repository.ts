import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Project, ProjectState } from '@prisma/client';

@Injectable()
export class StateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findProjectState(
    projectId: string,
  ): Promise<{ id: string; state: ProjectState; name: string } | null> {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, state: true, name: true },
    });
  }

  async updateProjectState(
    projectId: string,
    state: ProjectState,
  ): Promise<Project> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { state },
    });
  }
}
