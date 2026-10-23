import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '@/core/infrastructure/database/prisma.service';
import { ConversationType, ConversationMemberRole } from '@prisma/client';

@Injectable()
export class ProjectChannelService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check if user is a member or owner of the project.
   */
  async checkProjectAccess(
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          where: { userId },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const isOwner = project.createdById === userId;
    const isMember = project.members.length > 0;

    if (!isOwner && !isMember) {
      throw new ForbiddenException('You are not a member of this project');
    }

    return true;
  }

  /**
   * Check if user has admin/owner/coordinator privileges in the project.
   */
  async checkProjectAdmin(projectId: string, userId: string): Promise<boolean> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        members: {
          where: { userId },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (project.createdById === userId) {
      return true;
    }

    const member = project.members[0];
    if (member && (member.role === 'owner' || member.role === 'coordinator')) {
      return true;
    }

    throw new ForbiddenException(
      'Only project owners or coordinators can perform this action',
    );
  }

  /**
   * Enable chat for a project. Automatically provisions the default `#general` channel
   * and populates members from the ProjectMember table.
   */
  async enableProjectChat(projectId: string, userId: string) {
    await this.checkProjectAdmin(projectId, userId);

    // Check if general channel already exists
    let generalChannel = await this.prisma.conversation.findFirst({
      where: {
        projectId,
        type: ConversationType.project_channel,
        isDefault: true,
      },
    });

    // Fetch all current project members + creator
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });

    const userIds = new Set<string>();
    if (project?.createdById) userIds.add(project.createdById);
    project?.members.forEach((m) => userIds.add(m.userId));

    if (!generalChannel) {
      generalChannel = await this.prisma.conversation.create({
        data: {
          type: ConversationType.project_channel,
          name: 'general',
          topic: 'General project discussions and coordination',
          projectId,
          isDefault: true,
          createdById: userId,
          members: {
            create: Array.from(userIds).map((uId) => ({
              userId: uId,
              role:
                uId === userId
                  ? ConversationMemberRole.owner
                  : ConversationMemberRole.member,
            })),
          },
        },
      });
    } else {
      // Sync any missing members into the channel
      for (const uId of userIds) {
        await this.prisma.conversationMember.upsert({
          where: {
            conversationId_userId: {
              conversationId: generalChannel.id,
              userId: uId,
            },
          },
          update: {},
          create: {
            conversationId: generalChannel.id,
            userId: uId,
            role:
              uId === userId
                ? ConversationMemberRole.owner
                : ConversationMemberRole.member,
          },
        });
      }
    }

    return generalChannel;
  }

  /**
   * Create a new custom channel within the project.
   */
  async createChannel(
    projectId: string,
    userId: string,
    dto: { name: string; topic?: string },
  ) {
    await this.checkProjectAdmin(projectId, userId);

    const cleanName = dto.name
      .trim()
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/\s+/g, '-');
    if (!cleanName) {
      throw new BadRequestException('Channel name is invalid');
    }

    // Check duplicate channel name in same project
    const existing = await this.prisma.conversation.findFirst({
      where: {
        projectId,
        name: cleanName,
        type: ConversationType.project_channel,
      },
    });

    if (existing) {
      throw new BadRequestException(
        `Channel #${cleanName} already exists in this project`,
      );
    }

    // Fetch project members to enroll
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { members: true },
    });

    const userIds = new Set<string>();
    if (project?.createdById) userIds.add(project.createdById);
    project?.members.forEach((m) => userIds.add(m.userId));

    return this.prisma.conversation.create({
      data: {
        type: ConversationType.project_channel,
        name: cleanName,
        topic: dto.topic?.trim() || null,
        projectId,
        isDefault: false,
        createdById: userId,
        members: {
          create: Array.from(userIds).map((uId) => ({
            userId: uId,
            role:
              uId === userId
                ? ConversationMemberRole.owner
                : ConversationMemberRole.member,
          })),
        },
      },
    });
  }

  /**
   * Delete a channel (default channel cannot be deleted).
   */
  async deleteChannel(projectId: string, channelId: string, userId: string) {
    await this.checkProjectAdmin(projectId, userId);

    const channel = await this.prisma.conversation.findUnique({
      where: { id: channelId },
    });

    if (!channel || channel.projectId !== projectId) {
      throw new NotFoundException('Channel not found in this project');
    }

    if (channel.isDefault) {
      throw new BadRequestException(
        'Cannot delete the default #general channel',
      );
    }

    await this.prisma.conversation.delete({
      where: { id: channelId },
    });

    return { success: true };
  }

  /**
   * Get all channels of a project.
   */
  async getProjectChannels(projectId: string, userId: string) {
    await this.checkProjectAccess(projectId, userId);

    return this.prisma.conversation.findMany({
      where: {
        projectId,
        type: ConversationType.project_channel,
      },
      include: {
        members: {
          where: { userId },
          select: {
            lastReadAt: true,
            isMuted: true,
            isPinned: true,
          },
        },
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async listProjectChannels(projectId: string, userId: string) {
    return this.getProjectChannels(projectId, userId);
  }
}
