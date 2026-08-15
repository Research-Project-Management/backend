import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, MemberRole } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type ProjectWithMembers = Prisma.ProjectGetPayload<{
  include: {
    members: {
      include: {
        user: { select: typeof USER_SELECT };
      };
    };
  };
}> & {
  workspace?: {
    id: string;
    name: string;
    url: string;
  };
};

@Injectable()
export class ProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findWorkspaceProjects(workspaceId: string) {
    return this.prisma.project.findMany({
      where: { workspaceId, isActive: true },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findProjectById(projectId: string): Promise<ProjectWithMembers | null> {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        workspace: {
          select: { id: true, name: true, url: true },
        },
      },
    });
  }

  async createProject(
    data: Prisma.ProjectCreateInput | Prisma.ProjectUncheckedCreateInput,
  ): Promise<ProjectWithMembers> {
    return this.prisma.project.create({
      data: data as Prisma.ProjectCreateInput,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  async updateProject(
    projectId: string,
    data: Prisma.ProjectUpdateInput | Prisma.ProjectUncheckedUpdateInput,
  ): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: data,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  async findProjectMembers(projectId: string) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async findProjectMember(projectId: string, userId: string) {
    return this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async createProjectMember(
    projectId: string,
    userId: string,
    role: MemberRole | (string & {}),
  ) {
    return this.prisma.projectMember.create({
      data: {
        projectId,
        userId,
        role: role as MemberRole,
      },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async updateProjectMemberRole(
    projectId: string,
    userId: string,
    role: MemberRole | (string & {}),
  ) {
    return this.prisma.projectMember.update({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
      data: { role: role as MemberRole },
      include: {
        user: { select: USER_SELECT },
      },
    });
  }

  async deleteProjectMember(projectId: string, userId: string) {
    return this.prisma.projectMember.delete({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });
  }
}
