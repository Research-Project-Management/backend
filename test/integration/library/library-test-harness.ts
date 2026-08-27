import { Test, TestingModule } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/core/database/prisma.service';
import { RedisCacheService } from '../../../src/core/cache/redis-cache.service';
import { LibraryFeatureFlagsService } from '../../../src/modules/library/common/library-feature-flags';
import { VersionMismatchException } from '../../../src/modules/library/common/library-mutation.dto';

export interface TestWorkspaceFixture {
  workspaceId: string;
  workspaceSlug: string;
  ownerUserId: string;
}

export class LibraryTestHarness {
  private readonly createdWorkspaces = new Set<string>();
  private readonly createdUsers = new Set<string>();

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
    if (!process.env.ZOTERO_ENCRYPTION_KEY && !process.env.ENCRYPTION_SECRET) {
      process.env.ZOTERO_ENCRYPTION_KEY =
        'flux-research-zotero-secret-key-32-chars-long!';
    }
    if (!process.env.URL_CAPTURE_SECRET) {
      process.env.URL_CAPTURE_SECRET =
        'test_secret_key_minimum_32_bytes_entropy_abcdef1234567890';
    }

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
   * Creates and persists an isolated workspace fixture with real User & Workspace database rows.
   */
  async seedWorkspaceFixture(customId?: string): Promise<TestWorkspaceFixture> {
    const uniqueSuffix =
      Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    const workspaceId = customId || `ws-${uniqueSuffix}`;
    const ownerUserId = `user-${uniqueSuffix}`;
    const workspaceSlug = `slug-${uniqueSuffix}`;

    await this.prisma.user.upsert({
      where: { id: ownerUserId },
      create: {
        id: ownerUserId,
        email: `${ownerUserId}@test.local`,
        name: `Test User ${uniqueSuffix}`,
      },
      update: {},
    });

    await this.prisma.workspace.upsert({
      where: { id: workspaceId },
      create: {
        id: workspaceId,
        name: `Test Workspace ${uniqueSuffix}`,
        url: `https://${workspaceId}.test.local`,
        slug: workspaceSlug,
        createdById: ownerUserId,
      },
      update: {},
    });

    await this.prisma.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId: ownerUserId,
        },
      },
      create: {
        workspaceId,
        userId: ownerUserId,
        role: 'owner',
      },
      update: {},
    });

    this.createdWorkspaces.add(workspaceId);
    this.createdUsers.add(ownerUserId);

    return {
      workspaceId,
      workspaceSlug,
      ownerUserId,
    };
  }

  /**
   * Legacy helper returning fixture metadata.
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
      for (const wsId of this.createdWorkspaces) {
        await this.prisma.workspace.deleteMany({ where: { id: wsId } });
      }
      for (const userId of this.createdUsers) {
        await this.prisma.user.deleteMany({ where: { id: userId } });
      }
      const redis = this.moduleRef.get(RedisCacheService, { strict: false });
      if (redis) {
        await redis.onModuleDestroy();
      }
      await this.app.close();
      await this.prisma.onModuleDestroy();
    } catch {
      // ignore
    }
  }
}
