import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUuid } from '@/core';

@Injectable()
export class SyncHandler {
  async syncAssignees(
    tx: Prisma.TransactionClient,
    workItemId: string,
    primaryAssigneeId: string | null | undefined,
    rawAssigneeIds: unknown,
    isUpdate = false,
  ): Promise<void> {
    if (!tx.workItemAssignee) return;

    const assigneeIdsToSync: string[] = [];
    if (primaryAssigneeId && isUuid(primaryAssigneeId)) {
      assigneeIdsToSync.push(primaryAssigneeId);
    }

    if (Array.isArray(rawAssigneeIds)) {
      rawAssigneeIds.forEach((id: unknown) => {
        if (
          typeof id === 'string' &&
          id &&
          isUuid(id) &&
          !assigneeIdsToSync.includes(id)
        ) {
          assigneeIdsToSync.push(id);
        }
      });
    }

    if (isUpdate) {
      await tx.workItemAssignee.deleteMany({
        where: { workItemId },
      });
    }

    if (assigneeIdsToSync.length > 0) {
      await tx.workItemAssignee.createMany({
        data: assigneeIdsToSync.map((userId) => ({
          workItemId,
          userId,
          isPrimary: userId === primaryAssigneeId,
        })),
        skipDuplicates: true,
      });
    }
  }

  async syncLabels(
    tx: Prisma.TransactionClient,
    workItemId: string,
    projectId: string,
    authorId: string,
    rawLabels: unknown[],
    isUpdate = false,
  ): Promise<void> {
    if (!tx.spaceLabel || !tx.workItemLabelAssignment) return;
    if (!Array.isArray(rawLabels)) return;

    if (isUpdate) {
      await tx.workItemLabelAssignment.deleteMany({
        where: { workItemId },
      });
    }

    const uniqueRawTokens: string[] = Array.from(
      new Set(
        rawLabels
          .filter(
            (l: unknown): l is string =>
              typeof l === 'string' && Boolean(l.trim()),
          )
          .map((l: string) => l.trim()),
      ),
    );

    if (uniqueRawTokens.length === 0) return;

    const uuidTokens = uniqueRawTokens.filter((t) => isUuid(t));
    const nameTokens = uniqueRawTokens.filter((t) => !isUuid(t));

    const existingLabels = await tx.spaceLabel.findMany({
      where: {
        spaceId: projectId,
        ...(uuidTokens.length > 0 && nameTokens.length > 0
          ? {
              OR: [
                { id: { in: uuidTokens } },
                { name: { in: nameTokens, mode: 'insensitive' } },
              ],
            }
          : uuidTokens.length > 0
            ? { id: { in: uuidTokens } }
            : { name: { in: nameTokens, mode: 'insensitive' } }),
      },
    });

    const existingMap = new Map<string, (typeof existingLabels)[0]>();
    for (const l of existingLabels) {
      existingMap.set(l.name.toLowerCase(), l);
      existingMap.set(l.id, l);
    }

    const missingNames: string[] = nameTokens.filter(
      (name: string) => !existingMap.has(name.toLowerCase()),
    );

    if (missingNames.length > 0) {
      await tx.spaceLabel.createMany({
        data: missingNames.map((name: string) => ({
          name,
          spaceId: projectId,
          createdById: authorId,
        })),
        skipDuplicates: true,
      });
    }

    const allLabels =
      missingNames.length > 0
        ? await tx.spaceLabel.findMany({
            where: {
              spaceId: projectId,
              ...(uuidTokens.length > 0
                ? {
                    OR: [
                      { id: { in: uuidTokens } },
                      { name: { in: nameTokens, mode: 'insensitive' } },
                    ],
                  }
                : { name: { in: nameTokens, mode: 'insensitive' } }),
            },
          })
        : existingLabels;

    if (allLabels.length > 0) {
      await tx.workItemLabelAssignment.createMany({
        data: allLabels.map((label) => ({
          workItemId,
          labelId: label.id,
        })),
        skipDuplicates: true,
      });
    }
  }

  async bulkSyncAssignees(
    tx: {
      workItemAssignee?: {
        deleteMany: (args: {
          where: Prisma.WorkItemAssigneeWhereInput;
        }) => Promise<unknown>;
        createMany: (args: {
          data: Array<{
            workItemId: string;
            userId: string;
            isPrimary: boolean;
          }>;
          skipDuplicates: boolean;
        }) => Promise<unknown>;
      };
    },
    workItemIds: string[],
    assigneeId: string | null | undefined,
  ): Promise<void> {
    if (!tx.workItemAssignee || workItemIds.length === 0) return;
    await tx.workItemAssignee.deleteMany({
      where: { workItemId: { in: workItemIds } },
    });
    if (assigneeId && isUuid(assigneeId)) {
      await tx.workItemAssignee.createMany({
        data: workItemIds.map((workItemId) => ({
          workItemId,
          userId: assigneeId,
          isPrimary: true,
        })),
        skipDuplicates: true,
      });
    }
  }

  async bulkSyncLabels(
    tx: {
      spaceLabel?: {
        findMany: (args: {
          where: Prisma.SpaceLabelWhereInput;
          select: { id: true };
        }) => Promise<Array<{ id: string }>>;
      };
      workItemLabelAssignment?: {
        deleteMany: (args: {
          where: Prisma.WorkItemLabelAssignmentWhereInput;
        }) => Promise<unknown>;
        createMany: (args: {
          data: Array<{ workItemId: string; labelId: string }>;
          skipDuplicates: boolean;
        }) => Promise<unknown>;
      };
    },
    projectId: string,
    workItemIds: string[],
    labels: string[],
  ): Promise<void> {
    if (!tx.workItemLabelAssignment || workItemIds.length === 0) return;
    await tx.workItemLabelAssignment.deleteMany({
      where: { workItemId: { in: workItemIds } },
    });
    if (labels.length > 0 && tx.spaceLabel) {
      const matchedLabels = await tx.spaceLabel.findMany({
        where: {
          spaceId: projectId,
          OR: [
            { name: { in: labels, mode: 'insensitive' } },
            { id: { in: labels.filter((l) => isUuid(l)) } },
          ],
        },
        select: { id: true },
      });
      if (matchedLabels.length > 0) {
        const assignments: Array<{ workItemId: string; labelId: string }> = [];
        for (const workItemId of workItemIds) {
          for (const label of matchedLabels) {
            assignments.push({ workItemId, labelId: label.id });
          }
        }
        await tx.workItemLabelAssignment.createMany({
          data: assignments,
          skipDuplicates: true,
        });
      }
    }
  }
}
