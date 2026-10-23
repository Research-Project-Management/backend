import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '@/core/infrastructure/database/prisma.service';
import { FriendshipStatus, ConversationType } from '@prisma/client';

@Injectable()
export class FriendshipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get list of accepted friends for a user.
   */
  async getFriends(userId: string) {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        OR: [{ requesterId: userId }, { addresseeId: userId }],
        status: FriendshipStatus.accepted,
      },
      include: {
        requester: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                name: true,
                avatar: true,
                institution: true,
              },
            },
          },
        },
        addressee: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                name: true,
                avatar: true,
                institution: true,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return friendships.map((f) => {
      const isRequester = f.requesterId === userId;
      const friendUser = isRequester ? f.addressee : f.requester;
      return {
        friendshipId: f.id,
        friend: {
          id: friendUser.id,
          email: friendUser.email,
          name: friendUser.profile?.name || friendUser.email.split('@')[0],
          avatar: friendUser.profile?.avatar || null,
          institution: friendUser.profile?.institution || null,
        },
        since: f.updatedAt,
      };
    });
  }

  /**
   * Get incoming and outgoing pending friend requests.
   */
  async getPendingRequests(userId: string) {
    const incoming = await this.prisma.friendship.findMany({
      where: {
        addresseeId: userId,
        status: FriendshipStatus.pending,
      },
      include: {
        requester: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const outgoing = await this.prisma.friendship.findMany({
      where: {
        requesterId: userId,
        status: FriendshipStatus.pending,
      },
      include: {
        addressee: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      incoming: incoming.map((req) => ({
        id: req.id,
        user: {
          id: req.requester.id,
          email: req.requester.email,
          name:
            req.requester.profile?.name || req.requester.email.split('@')[0],
          avatar: req.requester.profile?.avatar || null,
        },
        createdAt: req.createdAt,
      })),
      outgoing: outgoing.map((req) => ({
        id: req.id,
        user: {
          id: req.addressee.id,
          email: req.addressee.email,
          name:
            req.addressee.profile?.name || req.addressee.email.split('@')[0],
          avatar: req.addressee.profile?.avatar || null,
        },
        createdAt: req.createdAt,
      })),
    };
  }

  /**
   * Send a friend request to a target user.
   */
  async sendRequest(requesterId: string, targetUserId: string) {
    if (requesterId === targetUserId) {
      throw new BadRequestException(
        'You cannot send a friend request to yourself',
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    // Check existing relationship in either direction
    const existing = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: requesterId },
        ],
      },
    });

    if (existing) {
      if (existing.status === FriendshipStatus.accepted) {
        throw new BadRequestException('You are already friends with this user');
      }
      if (existing.status === FriendshipStatus.pending) {
        if (existing.requesterId === requesterId) {
          throw new BadRequestException('Friend request already sent');
        } else {
          // If the other user already sent a request, automatically accept it!
          return this.acceptRequest(requesterId, existing.id);
        }
      }
      if (existing.status === FriendshipStatus.blocked) {
        throw new ForbiddenException('Cannot send friend request');
      }

      // If declined, reset to pending with new requester
      return this.prisma.friendship.update({
        where: { id: existing.id },
        data: {
          requesterId,
          addresseeId: targetUserId,
          status: FriendshipStatus.pending,
        },
      });
    }

    return this.prisma.friendship.create({
      data: {
        requesterId,
        addresseeId: targetUserId,
        status: FriendshipStatus.pending,
      },
    });
  }

  /**
   * Accept an incoming friend request and initialize a direct conversation.
   */
  async acceptRequest(userId: string, requestId: string) {
    const request = await this.prisma.friendship.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException('Friend request not found');
    }
    if (request.addresseeId !== userId) {
      throw new ForbiddenException(
        'Only the recipient can accept this request',
      );
    }

    const updated = await this.prisma.friendship.update({
      where: { id: requestId },
      data: { status: FriendshipStatus.accepted },
    });

    // Ensure direct conversation exists
    await this.ensureDirectConversation(
      request.requesterId,
      request.addresseeId,
    );

    return updated;
  }

  /**
   * Decline an incoming friend request.
   */
  async declineRequest(userId: string, requestId: string) {
    const request = await this.prisma.friendship.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException('Friend request not found');
    }
    if (request.addresseeId !== userId) {
      throw new ForbiddenException(
        'Only the recipient can decline this request',
      );
    }

    return this.prisma.friendship.update({
      where: { id: requestId },
      data: { status: FriendshipStatus.declined },
    });
  }

  /**
   * Search users by name or email with current friendship status.
   * - When query is empty: ONLY suggests users who have a connection (shared project or mutual friends) and are not already friends.
   * - When query is provided: Searches users by query, prioritizing those with shared projects or mutual friends.
   */
  async searchUsers(userId: string, query?: string) {
    const cleanQuery = query?.trim().toLowerCase();

    // 1. Gather current user's projects
    const myProjectMemberships = await this.prisma.projectMember.findMany({
      where: { userId },
      select: {
        projectId: true,
        project: { select: { id: true, name: true } },
      },
    });
    const myProjectIds = myProjectMemberships.map((pm) => pm.projectId);
    const projectMap = new Map<string, string>();
    for (const pm of myProjectMemberships) {
      projectMap.set(pm.projectId, pm.project?.name || 'Project');
    }

    // 2. Gather current user's accepted friends
    const myAcceptedFriendships = await this.prisma.friendship.findMany({
      where: {
        status: FriendshipStatus.accepted,
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      select: { requesterId: true, addresseeId: true },
    });
    const myFriendIds = new Set<string>();
    for (const f of myAcceptedFriendships) {
      myFriendIds.add(f.requesterId === userId ? f.addresseeId : f.requesterId);
    }

    // 3. Find other members in current user's projects (Shared Project connection)
    const sharedProjectMembers =
      myProjectIds.length > 0
        ? await this.prisma.projectMember.findMany({
            where: {
              projectId: { in: myProjectIds },
              userId: { not: userId },
            },
            select: { userId: true, projectId: true },
          })
        : [];

    const sharedProjectsMap = new Map<string, string[]>();
    for (const sp of sharedProjectMembers) {
      const pName = projectMap.get(sp.projectId);
      if (pName) {
        const list = sharedProjectsMap.get(sp.userId) || [];
        if (!list.includes(pName)) list.push(pName);
        sharedProjectsMap.set(sp.userId, list);
      }
    }

    // 4. Find mutual friends (friends of friends)
    const mutualFriendsCountMap = new Map<string, number>();
    if (myFriendIds.size > 0) {
      const friendOfFriends = await this.prisma.friendship.findMany({
        where: {
          status: FriendshipStatus.accepted,
          OR: [
            { requesterId: { in: Array.from(myFriendIds) } },
            { addresseeId: { in: Array.from(myFriendIds) } },
          ],
        },
        select: { requesterId: true, addresseeId: true },
      });

      for (const mf of friendOfFriends) {
        const friendId = myFriendIds.has(mf.requesterId)
          ? mf.requesterId
          : mf.addresseeId;
        const otherId =
          mf.requesterId === friendId ? mf.addresseeId : mf.requesterId;
        if (otherId !== userId && !myFriendIds.has(otherId)) {
          mutualFriendsCountMap.set(
            otherId,
            (mutualFriendsCountMap.get(otherId) || 0) + 1,
          );
        }
      }
    }

    // 5. Query candidate users
    let users: Array<{
      id: string;
      email: string;
      profile: {
        name: string;
        avatar: string | null;
        institution: string | null;
      } | null;
    }> = [];

    if (!cleanQuery) {
      // ONLY suggest users with a connection (shared projects or mutual friends), not yet accepted friends
      const candidateIds = new Set<string>();
      for (const id of sharedProjectsMap.keys()) {
        if (!myFriendIds.has(id)) candidateIds.add(id);
      }
      for (const id of mutualFriendsCountMap.keys()) {
        if (!myFriendIds.has(id)) candidateIds.add(id);
      }

      if (candidateIds.size === 0) {
        return [];
      }

      users = await this.prisma.user.findMany({
        where: {
          id: { in: Array.from(candidateIds) },
          deletedAt: null,
        },
        select: {
          id: true,
          email: true,
          profile: {
            select: { name: true, avatar: true, institution: true },
          },
        },
        take: 20,
      });
    } else {
      // Search by query (prioritizing users with connections)
      users = await this.prisma.user.findMany({
        where: {
          id: { not: userId },
          deletedAt: null,
          OR: [
            { email: { contains: cleanQuery, mode: 'insensitive' } },
            {
              profile: { name: { contains: cleanQuery, mode: 'insensitive' } },
            },
          ],
        },
        select: {
          id: true,
          email: true,
          profile: {
            select: { name: true, avatar: true, institution: true },
          },
        },
        take: 30,
      });
    }

    if (users.length === 0) {
      return [];
    }

    // 6. Fetch friendship relations
    const friendships = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { requesterId: userId, addresseeId: { in: users.map((u) => u.id) } },
          { addresseeId: userId, requesterId: { in: users.map((u) => u.id) } },
        ],
      },
    });

    const statusMap = new Map<
      string,
      { status: FriendshipStatus; isRequester: boolean; id: string }
    >();
    for (const f of friendships) {
      const otherId = f.requesterId === userId ? f.addresseeId : f.requesterId;
      statusMap.set(otherId, {
        status: f.status,
        isRequester: f.requesterId === userId,
        id: f.id,
      });
    }

    // 7. Map and score
    const result = users.map((u) => {
      const rel = statusMap.get(u.id);
      const sharedProjects = sharedProjectsMap.get(u.id) || [];
      const mutualFriendsCount = mutualFriendsCountMap.get(u.id) || 0;
      const userName = u.profile?.name || u.email.split('@')[0];

      // Relevance score:
      // Shared projects: +20 pts each
      // Mutual friends: +10 pts each
      // Direct name prefix match: +15 pts
      // Email prefix match: +10 pts
      let relevanceScore = sharedProjects.length * 20 + mutualFriendsCount * 10;
      if (cleanQuery) {
        if (userName.toLowerCase().startsWith(cleanQuery)) relevanceScore += 15;
        if (u.email.toLowerCase().startsWith(cleanQuery)) relevanceScore += 10;
      }

      return {
        id: u.id,
        email: u.email,
        name: userName,
        avatar: u.profile?.avatar || null,
        institution: u.profile?.institution || null,
        friendship: rel
          ? {
              id: rel.id,
              status: rel.status,
              isRequester: rel.isRequester,
            }
          : null,
        connectionContext: {
          sharedProjects,
          mutualFriendsCount,
        },
        relevanceScore,
      };
    });

    // Sort by relevance score descending
    result.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return result.map(({ relevanceScore, ...u }) => u);
  }

  /**
   * Helper to ensure direct conversation exists between two users.
   */
  private async ensureDirectConversation(userId1: string, userId2: string) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        type: ConversationType.direct,
        AND: [
          { members: { some: { userId: userId1 } } },
          { members: { some: { userId: userId2 } } },
        ],
      },
    });

    if (existing) return existing;

    return this.prisma.conversation.create({
      data: {
        type: ConversationType.direct,
        createdById: userId1,
        members: {
          create: [
            { userId: userId1, role: 'member' },
            { userId: userId2, role: 'member' },
          ],
        },
      },
    });
  }
}
