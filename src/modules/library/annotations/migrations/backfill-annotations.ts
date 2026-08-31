import { PrismaClient } from '@prisma/client';

export interface BackfillAnnotationsResult {
  totalAnnotations: number;
  normalizedCount: number;
  unchangedCount: number;
  errors: Array<{ annotationId: string; error: string }>;
  dryRun: boolean;
}

export type BoundingBox = [number, number, number, number];

export function normalizeRectCoords(raw: any): BoundingBox | null {
  if (!raw) return null;

  if (Array.isArray(raw)) {
    if (raw.length === 4 && raw.every((n) => typeof n === 'number')) {
      return [raw[0], raw[1], raw[2], raw[3]];
    }
    if (raw.length > 0 && typeof raw[0] === 'object') {
      return normalizeRectCoords(raw[0]);
    }
    return null;
  }

  if (typeof raw === 'object') {
    if (
      typeof raw.x1 === 'number' &&
      typeof raw.y1 === 'number' &&
      typeof raw.x2 === 'number' &&
      typeof raw.y2 === 'number'
    ) {
      return [raw.x1, raw.y1, raw.x2, raw.y2];
    }
    if (
      typeof raw.x === 'number' &&
      typeof raw.y === 'number' &&
      typeof raw.width === 'number' &&
      typeof raw.height === 'number'
    ) {
      return [raw.x, raw.y, raw.x + raw.width, raw.y + raw.height];
    }
    if (
      typeof raw.left === 'number' &&
      typeof raw.top === 'number' &&
      typeof raw.right === 'number' &&
      typeof raw.bottom === 'number'
    ) {
      return [raw.left, raw.top, raw.right, raw.bottom];
    }
  }

  return null;
}

export async function runBackfillAnnotations(
  prisma: PrismaClient,
  options: {
    batchSize?: number;
    dryRun?: boolean;
  } = {},
): Promise<BackfillAnnotationsResult> {
  const batchSize = options.batchSize ?? 50;
  const dryRun = options.dryRun ?? false;

  const allAnnotations = await prisma.annotation.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      rectCoords: true,
    },
  });

  const result: BackfillAnnotationsResult = {
    totalAnnotations: allAnnotations.length,
    normalizedCount: 0,
    unchangedCount: 0,
    errors: [],
    dryRun,
  };

  for (let i = 0; i < allAnnotations.length; i += batchSize) {
    const batch = allAnnotations.slice(i, i + batchSize);

    for (const annotation of batch) {
      try {
        const normalized = normalizeRectCoords(annotation.rectCoords);

        if (normalized) {
          const currentJson = JSON.stringify(annotation.rectCoords);
          const newJson = JSON.stringify(normalized);

          if (currentJson !== newJson) {
            if (!dryRun) {
              await prisma.annotation.update({
                where: { id: annotation.id },
                data: { rectCoords: normalized },
              });
            }
            result.normalizedCount++;
          } else {
            result.unchangedCount++;
          }
        } else {
          result.unchangedCount++;
        }
      } catch (err: any) {
        result.errors.push({
          annotationId: annotation.id,
          error: err.message || String(err),
        });
      }
    }
  }

  return result;
}

// Standalone execution entrypoint
if (require.main === module) {
  const prisma = new PrismaClient();
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Starting Annotations Backfill (DryRun=${dryRun})...`);

  runBackfillAnnotations(prisma, { dryRun })
    .then((res) => {
      console.log('Annotations backfill finished with result:');
      console.log(JSON.stringify(res, null, 2));
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('Annotations backfill failed:', err);
      return prisma.$disconnect();
    });
}
