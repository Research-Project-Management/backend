import { Injectable } from '@nestjs/common';
import { ProjectLink } from '@prisma/client';
import { PrismaService } from '@/core/database/prisma.service';
import { CreateProjectLinkDto } from './dto/create-link.dto';
import { UpdateProjectLinkDto } from './dto/update-link.dto';

@Injectable()
export class LinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(projectId: string): Promise<ProjectLink[]> {
    return this.prisma.projectLink.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(linkId: string): Promise<ProjectLink | null> {
    return this.prisma.projectLink.findUnique({
      where: { id: linkId },
    });
  }

  async create(
    projectId: string,
    userId: string,
    dto: CreateProjectLinkDto,
  ): Promise<ProjectLink> {
    return this.prisma.projectLink.create({
      data: {
        projectId,
        createdById: userId,
        title: dto.title,
        url: dto.url,
      },
    });
  }

  async update(linkId: string, dto: UpdateProjectLinkDto): Promise<ProjectLink> {
    return this.prisma.projectLink.update({
      where: { id: linkId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.url !== undefined ? { url: dto.url } : {}),
      },
    });
  }

  async delete(linkId: string): Promise<ProjectLink> {
    return this.prisma.projectLink.delete({
      where: { id: linkId },
    });
  }
}
