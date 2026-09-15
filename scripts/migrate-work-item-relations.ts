import { PrismaClient, WorkItemRelationType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting migration of legacy WorkItem data to normalized tables...');

  const workItems = await prisma.workItem.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      projectId: true,
      assigneeId: true,
      assigneeIds: true,
      labels: true,
      relations: true,
      authorId: true,
    },
  });

  console.log(`Found ${workItems.length} active work items to verify/migrate.`);

  let totalAssigneesMigrated = 0;
  let totalRelationsMigrated = 0;
  let totalLabelsMigrated = 0;

  for (const item of workItems) {
    // 1. Migrate Assignees
    const assigneesToUpsert = new Set<string>();
    if (item.assigneeId) {
      assigneesToUpsert.add(item.assigneeId);
    }
    if (Array.isArray(item.assigneeIds)) {
      item.assigneeIds.forEach((id: any) => {
        if (typeof id === 'string' && id.trim()) {
          assigneesToUpsert.add(id.trim());
        }
      });
    }

    for (const userId of assigneesToUpsert) {
      const userExists = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!userExists) continue;

      const isPrimary = userId === item.assigneeId;
      await prisma.workItemAssignee.upsert({
        where: {
          workItemId_userId: {
            workItemId: item.id,
            userId,
          },
        },
        create: {
          workItemId: item.id,
          userId,
          isPrimary,
        },
        update: {
          isPrimary,
        },
      });
      totalAssigneesMigrated++;
    }

    // 2. Migrate Relations
    if (Array.isArray(item.relations)) {
      for (const rel of item.relations as any[]) {
        const targetId = rel.targetId || rel.workItemId || rel.targetWorkItemId;
        let typeStr = (rel.type || 'relates_to').toLowerCase();
        let relType: WorkItemRelationType = WorkItemRelationType.relates_to;

        if (typeStr === 'blocks') relType = WorkItemRelationType.blocks;
        else if (typeStr === 'blocked_by' || typeStr === 'blockedby') relType = WorkItemRelationType.blocked_by;
        else if (typeStr === 'duplicate_of' || typeStr === 'duplicate') relType = WorkItemRelationType.duplicate_of;

        if (targetId && targetId !== item.id) {
          const targetExists = await prisma.workItem.findUnique({
            where: { id: targetId },
            select: { id: true },
          });

          if (targetExists) {
            await prisma.workItemRelation.upsert({
              where: {
                sourceId_targetId_type: {
                  sourceId: item.id,
                  targetId,
                  type: relType,
                },
              },
              create: {
                sourceId: item.id,
                targetId,
                type: relType,
              },
              update: {},
            });
            totalRelationsMigrated++;
          }
        }
      }
    }

    // 3. Migrate Labels
    if (Array.isArray(item.labels) && item.labels.length > 0) {
      for (const labelName of item.labels) {
        if (!labelName || typeof labelName !== 'string') continue;
        const trimmed = labelName.trim();
        if (!trimmed) continue;

        let label = await prisma.label.findFirst({
          where: {
            projectId: item.projectId,
            name: { equals: trimmed, mode: 'insensitive' },
          },
        });

        if (!label) {
          label = await prisma.label.create({
            data: {
              name: trimmed,
              projectId: item.projectId,
              createdById: item.authorId,
            },
          });
        }

        await prisma.workItemLabelAssignment.upsert({
          where: {
            workItemId_labelId: {
              workItemId: item.id,
              labelId: label.id,
            },
          },
          create: {
            workItemId: item.id,
            labelId: label.id,
          },
          update: {},
        });
        totalLabelsMigrated++;
      }
    }
  }

  console.log('✅ Migration completed successfully:');
  console.log(` - WorkItem Assignees processed: ${totalAssigneesMigrated}`);
  console.log(` - WorkItem Relations processed: ${totalRelationsMigrated}`);
  console.log(` - WorkItem Label Assignments processed: ${totalLabelsMigrated}`);
}

main()
  .catch((e) => {
    console.error('❌ Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
