import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { LibraryTestHarness } from '../library-test-harness';

jest.setTimeout(60000);

describe('Cross-Tenant Isolation & WorkspaceRoleGuard Authorization (Security E2E)', () => {
  let harness: LibraryTestHarness;
  let jwtService: JwtService;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
    jwtService = harness.moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await harness.close();
  });

  function makeAuthHeader(userId: string, email: string) {
    const token = jwtService.sign({ sub: userId, id: userId, email });
    return `Bearer ${token}`;
  }

  it('strictly rejects cross-tenant requests with HTTP 403 Forbidden', async () => {
    const tenantA = await harness.seedWorkspaceFixture();
    const tenantB = await harness.seedWorkspaceFixture();

    const userAToken = makeAuthHeader(
      tenantA.ownerUserId,
      `${tenantA.ownerUserId}@test.local`,
    );

    // User A attempts to access Workspace B's Zotero endpoints -> 403 Forbidden
    const zoteroConnRes = await request(harness.app.getHttpServer())
      .post(
        `/api/v1/workspaces/${tenantB.workspaceId}/library/integrations/zotero/connections`,
      )
      .set('Authorization', userAToken)
      .send({
        apiKey: 'some-key',
        accountName: 'Intruder Account',
      });

    expect(zoteroConnRes.status).toBe(403);

    // User A attempts to list Workspace B's Zotero connections -> 403 Forbidden
    const zoteroListRes = await request(harness.app.getHttpServer())
      .get(
        `/api/v1/workspaces/${tenantB.workspaceId}/library/integrations/zotero/connections`,
      )
      .set('Authorization', userAToken);

    expect(zoteroListRes.status).toBe(403);

    // User A attempts to list Workspace B's catalog items -> 403 Forbidden
    const catalogListRes = await request(harness.app.getHttpServer())
      .get(`/api/v1/workspaces/${tenantB.workspaceId}/library/items`)
      .set('Authorization', userAToken);

    expect(catalogListRes.status).toBe(403);

    // User A attempts to create notes in Workspace B -> 403 Forbidden
    const noteCreateRes = await request(harness.app.getHttpServer())
      .post(`/api/v1/workspaces/${tenantB.workspaceId}/library/notes`)
      .set('Authorization', userAToken)
      .send({
        title: 'Unauthorized Note',
        contentMd: 'Hacked',
      });

    expect(noteCreateRes.status).toBe(403);

    // User A attempts to pull sync changelog in Workspace B -> 403 Forbidden
    const syncPullRes = await request(harness.app.getHttpServer())
      .get(`/api/v1/workspaces/${tenantB.workspaceId}/library/sync/pull`)
      .set('Authorization', userAToken);

    expect(syncPullRes.status).toBe(403);
  });

  it('enforces WorkspaceRole hierarchy: MEMBER cannot execute ADMIN Zotero mutations', async () => {
    const tenant = await harness.seedWorkspaceFixture();

    // Create a regular MEMBER in tenant's workspace
    const memberUserId = `member-${Math.random().toString(36).substring(2, 8)}`;
    await harness.prisma.user.create({
      data: {
        id: memberUserId,
        email: `${memberUserId}@test.local`,
        name: 'Regular Member',
      },
    });

    await harness.prisma.workspaceMember.create({
      data: {
        workspaceId: tenant.workspaceId,
        userId: memberUserId,
        role: 'member',
      },
    });

    const memberToken = makeAuthHeader(
      memberUserId,
      `${memberUserId}@test.local`,
    );

    // MEMBER attempts to create Zotero connection (ADMIN/OWNER required) -> 403 Forbidden
    const memberConnRes = await request(harness.app.getHttpServer())
      .post(
        `/api/v1/workspaces/${tenant.workspaceId}/library/integrations/zotero/connections`,
      )
      .set('Authorization', memberToken)
      .send({
        apiKey: 'test-key',
        accountName: 'Member Account',
      });

    expect(memberConnRes.status).toBe(403);

    // MEMBER attempts to create Zotero binding -> 403 Forbidden
    const memberBindingRes = await request(harness.app.getHttpServer())
      .post(
        `/api/v1/workspaces/${tenant.workspaceId}/library/integrations/zotero/bindings`,
      )
      .set('Authorization', memberToken)
      .send({
        connectionId: 'conn-1',
        remoteLibraryId: '123',
      });

    expect(memberBindingRes.status).toBe(403);

    // MEMBER can still read items in the workspace (MEMBER role is allowed)
    const memberReadRes = await request(harness.app.getHttpServer())
      .get(`/api/v1/workspaces/${tenant.workspaceId}/library/items`)
      .set('Authorization', memberToken);

    expect(memberReadRes.status).toBe(200);
  });
});
