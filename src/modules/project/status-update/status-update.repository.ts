import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { CreateProjectStatusUpdateDto } from './dto/create-status-update.dto';
import { UpdateProjectStatusUpdateDto } from './dto/update-status-update.dto';

@Injectable()
export class StatusUpdateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findManyByProjectId(projectId: string) {
    return this.prisma.projectUpdate.findMany({
      where: { projectId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findLatestByProjectId(projectId: string) {
    return this.prisma.projectUpdate.findFirst({
      where: { projectId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(updateId: string) {
    return this.prisma.projectUpdate.findUnique({
      where: { id: updateId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
    });
  }

  async create(
    projectId: string,
    userId: string,
    dto: CreateProjectStatusUpdateDto,
  ) {
    return this.prisma.projectUpdate.create({
      data: {
        projectId,
        createdById: userId,
        status: dto.status,
        message: dto.message,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
    });
  }

  async update(updateId: string, dto: UpdateProjectStatusUpdateDto) {
    return this.prisma.projectUpdate.update({
      where: { id: updateId },
      data: {
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.message !== undefined ? { message: dto.message } : {}),
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            avatar: true,
          },
        },
      },
    });
  }

  async delete(updateId: string) {
    return this.prisma.projectUpdate.delete({
      where: { id: updateId },
    });
  }
}
