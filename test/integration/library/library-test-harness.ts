import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/core/database/prisma.service';
import { RedisCacheService } from '../../../src/core/cache/redis-cache.service';
import { LibraryFeatureFlagsService } from '../../../src/contexts/library/common/library-feature-flags';
import { VersionMismatchException } from '../../../src/contexts/library/common/library-mutation.dto';

export interface TestWorkspaceFixture {
  workspaceId: string;
  workspaceSlug: string;
  ownerUserId: string;
}

export class LibraryTestHarness {
  constructor(
    public readonly app: NestFastifyApplication,
    public readonly moduleRef: TestingModule,
    public readonly prisma: PrismaService,
    public readonly featureFlags: LibraryFeatureFlagsService,
  ) {}

  /**
   * Initializes the NestJS application with Fastify and Global Validation Pipes.
   */
  static async create(): Promise<LibraryTestHarness> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const prisma = moduleRef.get(PrismaService);
    const featureFlags = moduleRef.get(LibraryFeatureFlagsService);

    return new LibraryTestHarness(app, moduleRef, prisma, featureFlags);
  }

  /**
   * Creates an isolated workspace fixture for multi-tenant boundary testing.
   */
  createWorkspaceFixture(customId?: string): TestWorkspaceFixture {
    const uniqueSuffix = Math.random().toString(36).substring(2, 9);
    const workspaceId = customId || `ws-test-${uniqueSuffix}`;
    return {
      workspaceId,
      workspaceSlug: `slug-${workspaceId}`,
      ownerUserId: `user-${uniqueSuffix}`,
    };
  }

  /**
   * Asserts that queries on workspaceA never return data belonging to workspaceB.
   */
  async assertWorkspaceIsolation<
    T extends { workspaceId?: string; id?: string },
  >(
    queryFnA: () => Promise<T[]>,
    queryFnB: () => Promise<T[]>,
    workspaceAId: string,
    workspaceBId: string,
  ): Promise<void> {
    const resultsA = await queryFnA();
    const resultsB = await queryFnB();

    const idsInA = new Set(resultsA.map((r) => r.id));
    const idsInB = new Set(resultsB.map((r) => r.id));

    // Zero overlap in entity IDs
    for (const id of idsInA) {
      if (id && idsInB.has(id)) {
        throw new Error(
          `Workspace isolation failure: entity ${id} present in both ${workspaceAId} and ${workspaceBId}`,
        );
      }
    }

    // All entities in A belong strictly to workspaceA
    for (const r of resultsA) {
      if (r.workspaceId && r.workspaceId !== workspaceAId) {
        throw new Error(
          `Tenant leakage: result contains workspaceId ${r.workspaceId} but expected ${workspaceAId}`,
        );
      }
    }
  }

  /**
   * Asserts that a concurrent mutation with a stale expected version throws VersionMismatchException.
   */
  async assertOptimisticConcurrency(
    mutateFn: (expectedVersion: number) => Promise<any>,
    initialVersion: number,
  ): Promise<void> {
    // 1. Successful update on correct version
    await mutateFn(initialVersion);

    // 2. Attempt update with stale version must fail with 409 Conflict / VersionMismatchException
    let failed = false;
    try {
      await mutateFn(initialVersion); // Stale!
    } catch (err: any) {
      failed = true;
      const isMismatch =
        err instanceof VersionMismatchException ||
        err?.status === 409 ||
        err?.response?.error?.code === 'VERSION_MISMATCH';
      if (!isMismatch) {
        throw new Error(
          `Expected 409 VERSION_MISMATCH but received: ${err?.message || err}`,
        );
      }
    }

    if (!failed) {
      throw new Error(
        'Optimistic concurrency failure: stale update was permitted without throwing VersionMismatchException',
      );
    }
  }

  /**
   * Executes an operation within a transactional boundary for atomic invariants testing.
   */
  async executeTransaction<T>(operation: (tx: any) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      return operation(tx);
    });
  }

  /**
   * Closes the application and tears down database and cache connections cleanly.
   */
  async close(): Promise<void> {
    try {
      const redis = this.moduleRef.get(RedisCacheService, { strict: false });
      if (redis) {
        await redis.onModuleDestroy();
      }
      await this.prisma.onModuleDestroy();
      await this.app.close();
    } catch {
      // ignore
    }
  }
}
