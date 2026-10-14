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
    if (!tx.workItemLabel || !tx.workItemLabelAssignment) return;
    if (!Array.isArray(rawLabels)) return;

    if (isUpdate) {
      await tx.workItemLabelAssignment.deleteMany({
        where: { workItemId },
      });
    }

    const uniqueLabelNames: string[] = Array.from(
      new Set(
        rawLabels
          .filter(
            (l: unknown): l is string =>
              typeof l === 'string' && Boolean(l.trim()),
          )
          .map((l: string) => l.trim()),
      ),
    );

    if (uniqueLabelNames.length === 0) return;

    const existingLabels = await tx.workItemLabel.findMany({
      where: {
        projectId,
        name: { in: uniqueLabelNames, mode: 'insensitive' },
      },
    });

    const existingMap = new Map<string, (typeof existingLabels)[0]>(
      existingLabels.map((l) => [l.name.toLowerCase(), l]),
    );

    const missingNames: string[] = uniqueLabelNames.filter(
      (name: string) => !existingMap.has(name.toLowerCase()),
    );

    if (missingNames.length > 0) {
      await tx.workItemLabel.createMany({
        data: missingNames.map((name: string) => ({
          name,
          projectId,
          createdById: authorId,
        })),
        skipDuplicates: true,
      });
    }

    const allLabels = await tx.workItemLabel.findMany({
      where: {
        projectId,
        name: { in: uniqueLabelNames, mode: 'insensitive' },
      },
    });

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
}
