import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectLink } from '@prisma/client';
import { LinkRepository } from './link.repository';
import { CreateProjectLinkDto } from './dto/create-link.dto';
import { UpdateProjectLinkDto } from './dto/update-link.dto';

@Injectable()
export class LinkService {
  constructor(private readonly linkRepo: LinkRepository) {}

  async getLinks(projectId: string): Promise<ProjectLink[]> {
    return this.linkRepo.findMany(projectId);
  }

  async createLink(
    projectId: string,
    userId: string,
    dto: CreateProjectLinkDto,
  ): Promise<ProjectLink> {
    return this.linkRepo.create(projectId, userId, dto);
  }

  async updateLink(
    projectId: string,
    linkId: string,
    dto: UpdateProjectLinkDto,
  ): Promise<ProjectLink> {
    const link = await this.linkRepo.findById(linkId);
    if (!link || link.projectId !== projectId) {
      throw new NotFoundException(
        `Link "${linkId}" not found in project "${projectId}"`,
      );
    }

    return this.linkRepo.update(linkId, dto);
  }

  async deleteLink(projectId: string, linkId: string): Promise<ProjectLink> {
    const link = await this.linkRepo.findById(linkId);
    if (!link || link.projectId !== projectId) {
      throw new NotFoundException(
        `Link "${linkId}" not found in project "${projectId}"`,
      );
    }

    return this.linkRepo.delete(linkId);
  }
}
