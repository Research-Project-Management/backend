import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import { buildMockUser } from '@test/factories';
import { PrismaService } from '@/core';
import { StickyRepository } from '@/modules/project/sticky/sticky.repository';
import { StickyService } from '@/modules/project/sticky/sticky.service';

describe('StickyService', () => {
  let service: StickyService;
  let repo: jest.Mocked<StickyRepository>;
  let mockStickyFindFirst: jest.Mock;

  const mockUser = buildMockUser();

  const mockSticky = {
    id: '01920b92-7f12-7890-a123-456789abcdef',
    title: 'Hypothesis Note',
    content: '<p>Initial thesis argument</p>',
    color: 'yellow-1',
    positionX: 10,
    positionY: 20,
    order: 0,
    userId: mockUser.id,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: mockUser,
  };

  beforeEach(() => {
    repo = fromPartial<jest.Mocked<StickyRepository>>({
      findStickyById: jest.fn(),
      findStickiesByUserId: jest.fn(),
      countStickiesByUserId: jest.fn(),
      createSticky: jest.fn(),
      updateSticky: jest.fn(),
      deleteSticky: jest.fn(),
      findStickiesByIds: jest.fn(),
      reorderStickies: jest.fn(),
    });
    mockStickyFindFirst = jest.fn();

    service = new StickyService(
      repo,
      fromPartial<PrismaService>({
        sticky: { findFirst: mockStickyFindFirst },
      }),
    );
  });

  it('lists and searches formatted personal stickies with x/y coordinates', async () => {
    repo.findStickiesByUserId.mockResolvedValue([mockSticky as never]);

    const all = await service.getStickies(mockUser.id);
    expect(all.stickies[0].position).toEqual({ x: 10, y: 20 });

    await service.getStickies(mockUser.id, 'thesis');
    expect(repo.findStickiesByUserId).toHaveBeenLastCalledWith(
      mockUser.id,
      'thesis',
    );
  });

  it('creates stickies with UUID v7, rejects when latest draft is empty, rotates colors, and strips XSS script tags', async () => {
    repo.countStickiesByUserId.mockResolvedValue(2);
    mockStickyFindFirst.mockResolvedValueOnce(null);
    repo.createSticky.mockResolvedValueOnce({ ...mockSticky, order: 2 } as never);

    const created = await service.createSticky(mockUser.id, {
      title: 'New Note',
      content: '<p>Content</p>',
      color: 'mint-1',
    });
    expect(created.sticky?.order).toBe(2);
    expect(repo.createSticky).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        userId: mockUser.id,
      }),
    );

    // Reject creating a new sticky when latest note is still empty
    mockStickyFindFirst.mockResolvedValueOnce({
      id: 'latest-empty',
      title: '',
      content: '<p></p>',
      color: 'yellow-1',
    });
    await expect(
      service.createSticky(mockUser.id, { content: '<p></p>' }),
    ).rejects.toThrow(
      'Please add content to your existing draft note before creating a new one',
    );

    // Auto color rotation + DOMPurify script stripping
    mockStickyFindFirst.mockResolvedValueOnce({
      id: 'prev-note',
      title: 'Previous Note',
      content: '<p>Active research ideas</p>',
      color: 'yellow-1',
    });
    repo.createSticky.mockResolvedValueOnce({
      ...mockSticky,
      color: 'lavender-1',
    } as never);

    await service.createSticky(mockUser.id, {
      content: '<p>Valid text<script>alert("xss")</script></p>',
    });
    expect(repo.createSticky).toHaveBeenLastCalledWith(
      expect.objectContaining({
        color: 'lavender-1',
        content: '<p>Valid text</p>',
      }),
    );
  });

  it('enforces 404 and 403 ownership checks on getStickyById and deleteSticky', async () => {
    repo.findStickyById.mockResolvedValueOnce(null);
    await expect(
      service.getStickyById('non-existent', mockUser.id),
    ).rejects.toThrow(NotFoundException);

    repo.findStickyById.mockResolvedValueOnce({
      ...mockSticky,
      userId: 'other-user',
    } as never);
    await expect(
      service.getStickyById(mockSticky.id, mockUser.id),
    ).rejects.toThrow(ForbiddenException);

    repo.findStickyById.mockResolvedValueOnce(mockSticky as never);
    const got = await service.getStickyById(mockSticky.id, mockUser.id);
    expect(got.sticky?.position).toEqual({ x: 10, y: 20 });

    repo.findStickyById.mockResolvedValueOnce(null);
    await expect(
      service.deleteSticky('non-existent', mockUser.id),
    ).rejects.toThrow(NotFoundException);

    repo.findStickyById.mockResolvedValueOnce({
      ...mockSticky,
      userId: 'other-user',
    } as never);
    await expect(
      service.deleteSticky(mockSticky.id, mockUser.id),
    ).rejects.toThrow(ForbiddenException);

    repo.findStickyById.mockResolvedValueOnce(mockSticky as never);
    repo.deleteSticky.mockResolvedValueOnce({
      ...mockSticky,
      deletedAt: new Date(),
    } as never);
    await expect(
      service.deleteSticky(mockSticky.id, mockUser.id),
    ).resolves.toMatchObject({ success: true });
  });
});
