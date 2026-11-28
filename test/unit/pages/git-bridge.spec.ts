import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as isoGit from 'isomorphic-git';
import { fromPartial } from '@total-typescript/shoehorn';
import {
  AccessTokenVo,
  GitBridgeRepository,
  LfsUnsupportedError,
  MAX_TOKENS,
  MaintenanceService,
  PackAdapter,
  PktReportBuilder,
  PushRejectedError,
  RepoAdapter,
  RepoPathVo,
  SyncService,
  TokenLimitError,
  TokenService,
  canWrite,
  hasSideband,
  isLfsPointer,
  parseAuthHeader,
  parseRepoId,
  pktLine,
  type TokenRecord,
} from '@/modules/pages/git-bridge';
import { DocstoreService } from '@/modules/pages/docstore';
import { FilestoreService } from '@/modules/pages/filestore';
import { StructureService } from '@/modules/pages/structure';
import { SnapshotService } from '@/modules/pages/history';

describe('GitBridge BCNF Schema + GoF Deep Module Suite', () => {
  let tmpDir: string;
  let prevEnv: string | undefined;

  const REPO_ID = '0195f000-0000-7000-8000-000000000001';
  const USER_ID = '0195f000-0000-7000-8000-000000000099';
  const SNAP_ID = '0195f000-0000-7000-8000-000000000777';

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-git-bcnf-'));
    prevEnv = process.env.GIT_BRIDGE_ROOT;
    process.env.GIT_BRIDGE_ROOT = tmpDir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.GIT_BRIDGE_ROOT;
    else process.env.GIT_BRIDGE_ROOT = prevEnv;
    await fsp
      .rm(tmpDir, { recursive: true, force: true })
      .catch(() => undefined);
  });

  describe('1. GoF Domain Value Objects & 1NF Atomic Token Hint', () => {
    it('validates RepoPathVo invariants, separates 1NF 8-char hint from prefix, and parses auth', () => {
      expect(parseRepoId(`${REPO_ID}.git`)).toBe(REPO_ID);
      expect(parseRepoId('../etc/passwd.git')).toBeNull();

      const vo = RepoPathVo.fromRepo('chapters/intro.tex');
      expect(vo.repo).toBe('chapters/intro.tex');
      expect(vo.project).toBe('/chapters/intro.tex');
      expect(vo.dir).toBe('/chapters');
      expect(vo.name).toBe('intro.tex');

      expect(() => RepoPathVo.fromRepo('../secret.tex')).toThrow();
      expect(() => RepoPathVo.fromRepo('.git/config')).toThrow();

      const tok = AccessTokenVo.generate('My CLI');
      expect(tok.hint).toHaveLength(8);
      expect(tok.prefix).toBe(`fluxpat_${tok.hint}`);
      expect(AccessTokenVo.verifyHash(tok.hash, tok.hash)).toBe(true);
      expect(
        AccessTokenVo.isPlausible('fluxgit_legacy_token_rejected_123456'),
      ).toBe(false);

      const basic =
        'Basic ' +
        Buffer.from(`git:${tok.plaintext}`, 'utf8').toString('base64');
      expect(parseAuthHeader(basic)).toBe(tok.plaintext);
      expect(parseAuthHeader(`Bearer ${tok.plaintext}`)).toBe(tok.plaintext);
    });

    it('detects Git LFS pointers and builds plain & sideband pkt-line reports', () => {
      const lfs = Buffer.from(
        'version https://git-lfs.github.com/spec/v1\n' +
          'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n' +
          'size 12345\n',
        'utf8',
      );
      expect(isLfsPointer(lfs)).toBe(true);
      expect(isLfsPointer(Buffer.from('\\documentclass{article}\n'))).toBe(
        false,
      );

      const sbFrame = pktLine(
        Buffer.concat([Buffer.from([0x01]), pktLine('unpack ok\n')]),
      );
      expect(hasSideband(sbFrame)).toBe(true);
      expect(hasSideband(pktLine('unpack ok\n'))).toBe(false);

      const sb = PktReportBuilder.reject('LFS forbidden', {
        sideband: true,
      }).toString('utf8');
      expect(sb).toContain('Flux Git Bridge: LFS forbidden');
      expect(sb).toContain('ng refs/heads/main LFS forbidden');
    });
  });

  describe('2. TokenService (BCNF GitAccessToken + Caching Proxy + 10-Token Cap)', () => {
    it('stores atomic 8-char tokenHint, formats view prefix, caches auth, and evicts on revoke', async () => {
      const store = new Map<string, TokenRecord>();
      let seq = 0;

      const repo = fromPartial<GitBridgeRepository>({
        pruneUserExpired: jest.fn(async () => 0),
        countActiveTokens: jest.fn(
          async (uid: string, now: Date) =>
            Array.from(store.values()).filter(
              (r) => r.userId === uid && r.expiresAt > now,
            ).length,
        ),
        createToken: jest.fn(async (data) => {
          expect(data.tokenHint).toHaveLength(8);
          seq += 1;
          const id = `0195f000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
          const rec: TokenRecord = {
            id,
            ...data,
            lastUsedAt: null,
            createdAt: new Date(),
          };
          store.set(id, rec);
          return rec;
        }),
        findByHash: jest.fn(
          async (hash: string) =>
            Array.from(store.values()).find((r) => r.tokenHash === hash) ??
            null,
        ),
        deleteToken: jest.fn(async (uid: string, id: string) => {
          const found = store.get(id);
          if (!found || found.userId !== uid) return null;
          store.delete(id);
          return found;
        }),
        isActiveUser: jest.fn(async () => true),
        touchToken: jest.fn(async () => undefined),
      });

      const svc = new TokenService(repo);
      const created = await svc.create(USER_ID, 'Laptop');
      expect(created.prefix.startsWith('fluxpat_')).toBe(true);

      const header =
        'Basic ' +
        Buffer.from(`git:${created.token}`, 'utf8').toString('base64');
      expect(await svc.authenticate(header)).toBe(USER_ID);
      expect(await svc.authenticate(header)).toBe(USER_ID);
      expect(repo.findByHash).toHaveBeenCalledTimes(1);

      expect(await svc.revoke(USER_ID, created.id)).toBe(true);
      expect(await svc.authenticate(header)).toBeNull();

      for (let i = 0; i < MAX_TOKENS; i++) {
        await svc.create(USER_ID, `Tok ${i}`);
      }
      await expect(svc.create(USER_ID, 'Extra')).rejects.toThrow(
        TokenLimitError,
      );
    });
  });

  describe('3. RepoAdapter (Composite DirNode + Merkle Proxy + Guard Chains)', () => {
    it('commits without .work directory, ignores .gitignore exclusions, and skips unchanged trees', async () => {
      const gitRepo = new RepoAdapter();
      const entries = [
        {
          path: RepoPathVo.fromRepo('.gitignore'),
          content: Buffer.from('*.pdf\nfigures/\n', 'utf8'),
        },
        {
          path: RepoPathVo.fromRepo('main.tex'),
          content: Buffer.from('\\documentclass{article}\n', 'utf8'),
        },
        {
          path: RepoPathVo.fromRepo('output.pdf'),
          content: Buffer.from('%PDF-1.5', 'utf8'),
        },
        {
          path: RepoPathVo.fromRepo('figures/plot.png'),
          content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      ];

      const c1 = await gitRepo.commitTree(REPO_ID, entries, 'Init');
      await expect(
        fsp.access(path.join(tmpDir, `${REPO_ID}.work`)),
      ).rejects.toThrow();

      const files = await isoGit.listFiles({
        fs,
        gitdir: gitRepo.bareDir(REPO_ID),
        ref: c1.headOid,
      });
      expect(files.sort()).toEqual([
        '.gitignore',
        'figures/plot.png',
        'main.tex',
        'output.pdf',
      ]);

      const c2 = await gitRepo.commitTree(REPO_ID, entries, 'No-op');
      expect(c2.headOid).toBe(c1.headOid);
      expect(c2.treeOid).toBe(c1.treeOid);
    });

    it('rejects submodules (160000), symlinks (120000), and Git LFS pointers', async () => {
      const gitRepo = new RepoAdapter();
      const { headOid: baseSha } = await gitRepo.commitTree(
        REPO_ID,
        [
          {
            path: RepoPathVo.fromRepo('main.tex'),
            content: Buffer.from('v1\n'),
          },
        ],
        'Base',
      );
      const gitdir = gitRepo.bareDir(REPO_ID);
      const author = {
        name: 'U',
        email: 'u@x',
        timestamp: 1700000000,
        timezoneOffset: 0,
      };

      const subTree = await isoGit.writeTree({
        fs,
        gitdir,
        tree: [{ mode: '160000', path: 'sub', oid: baseSha, type: 'commit' }],
      });
      const subSha = await isoGit.writeCommit({
        fs,
        gitdir,
        commit: {
          message: 'sub\n',
          tree: subTree,
          parent: [baseSha],
          author,
          committer: author,
        },
      });
      await expect(
        gitRepo.diffCommits(REPO_ID, baseSha, subSha),
      ).rejects.toThrow(PushRejectedError);

      const symBlob = await isoGit.writeBlob({
        fs,
        gitdir,
        blob: Buffer.from('/etc/passwd'),
      });
      const symTree = await isoGit.writeTree({
        fs,
        gitdir,
        tree: [{ mode: '120000', path: 'sym.tex', oid: symBlob, type: 'blob' }],
      });
      const symSha = await isoGit.writeCommit({
        fs,
        gitdir,
        commit: {
          message: 'sym\n',
          tree: symTree,
          parent: [baseSha],
          author,
          committer: author,
        },
      });
      await expect(
        gitRepo.diffCommits(REPO_ID, baseSha, symSha),
      ).rejects.toThrow(PushRejectedError);

      const lfsBlob = await isoGit.writeBlob({
        fs,
        gitdir,
        blob: Buffer.from(
          'version https://git-lfs.github.com/spec/v1\n' +
            'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n' +
            'size 999\n',
        ),
      });
      const lfsTree = await isoGit.writeTree({
        fs,
        gitdir,
        tree: [{ mode: '100644', path: 'big.bin', oid: lfsBlob, type: 'blob' }],
      });
      const lfsSha = await isoGit.writeCommit({
        fs,
        gitdir,
        commit: {
          message: 'lfs\n',
          tree: lfsTree,
          parent: [baseSha],
          author,
          committer: author,
        },
      });
      await expect(
        gitRepo.diffCommits(REPO_ID, baseSha, lfsSha),
      ).rejects.toThrow(LfsUnsupportedError);
    });
  });

  describe('4. SyncService (EntryMemento Saga + History Snapshot + BCNF GitPushEvent Lineage)', () => {
    it('rolls back EntryMemento on failure, and persists PageGitRepo + GitPushEvent linked to SnapshotId on success', async () => {
      const gitRepo = new RepoAdapter();
      const { headOid: baseSha } = await gitRepo.commitTree(
        REPO_ID,
        [
          {
            path: RepoPathVo.fromRepo('main.tex'),
            content: Buffer.from('line 1\n'),
          },
        ],
        'Init',
      );

      const gitdir = gitRepo.bareDir(REPO_ID);
      const texOid = await isoGit.writeBlob({
        fs,
        gitdir,
        blob: Buffer.from('line 1\nline 2\n'),
      });
      const pngOid = await isoGit.writeBlob({
        fs,
        gitdir,
        blob: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
      });
      const figsOid = await isoGit.writeTree({
        fs,
        gitdir,
        tree: [{ mode: '100644', path: 'fig.png', oid: pngOid, type: 'blob' }],
      });
      const rootOid = await isoGit.writeTree({
        fs,
        gitdir,
        tree: [
          { mode: '040000', path: 'figs', oid: figsOid, type: 'tree' },
          { mode: '100644', path: 'main.tex', oid: texOid, type: 'blob' },
        ],
      });
      const who = {
        name: 'Alice',
        email: 'alice@uni.edu',
        timestamp: 1700000100,
        timezoneOffset: 0,
      };
      const pushedSha = await isoGit.writeCommit({
        fs,
        gitdir,
        commit: {
          message: 'Add figure\n\nBody text',
          tree: rootOid,
          parent: [baseSha],
          author: who,
          committer: who,
        },
      });
      await gitRepo.setMainRef(REPO_ID, pushedSha);

      let mainLines = ['line 1', ''];
      let mainRev = 3;

      const repo = fromPartial<GitBridgeRepository>({
        resolveTarget: jest.fn(async () => ({
          repoId: REPO_ID,
          spaceId: REPO_ID,
          pageId: REPO_ID,
        })),
        recordPushTransition: jest.fn(async () => 1),
        resetGcPushCount: jest.fn(async () => undefined),
      });

      const docstore = fromPartial<DocstoreService>({
        getAllDocs: jest.fn(async () => [
          fromPartial({
            _id: 'doc-main',
            lines: mainLines,
            version: mainRev,
            deleted: false,
          }),
        ]),
        updateDoc: jest.fn(async (_sid, _did, dto) => {
          mainLines = dto.lines ?? [];
          mainRev = dto.version ?? mainRev + 1;
          return fromPartial({ _id: 'doc-main', version: mainRev });
        }),
        patchDoc: jest.fn(async () => fromPartial({})),
      });

      let failUpload = true;
      const filestore = fromPartial<FilestoreService>({
        uploadFileFromBuffer: jest.fn(async () => {
          if (failUpload) throw new Error('S3 outage');
          return fromPartial({ id: 'file-1' });
        }),
      });

      const mainNode = fromPartial({
        id: 'node-main',
        name: 'main.tex',
        path: '/main.tex',
        parentId: null,
        type: 'DOC' as const,
        docId: 'doc-main',
        fileId: null,
        isRootDoc: true,
      });

      const structure = fromPartial<StructureService>({
        getAllNodes: jest.fn(async () => [mainNode]),
        getNodeByPath: jest.fn(async (_sid, p) =>
          p === '/main.tex' ? mainNode : null,
        ),
        mkdirp: jest.fn(async () => fromPartial({ id: 'dir-figs' })),
        createNode: jest.fn(async () => fromPartial({ id: 'node-fig' })),
      });

      const snapshots = fromPartial<SnapshotService>({
        createSnapshot: jest.fn(async () =>
          fromPartial({ id: SNAP_ID, version: 2 }),
        ),
      });

      const sync = new SyncService(
        repo,
        gitRepo,
        new PackAdapter(gitRepo),
        docstore,
        filestore,
        structure,
        undefined,
        undefined,
        undefined,
        snapshots,
      );

      await expect(
        sync.applyPush(REPO_ID, baseSha, pushedSha, USER_ID),
      ).rejects.toThrow('S3 outage');
      expect(mainLines).toEqual(['line 1', '']);
      expect(repo.recordPushTransition).not.toHaveBeenCalled();

      failUpload = false;
      const res = await sync.applyPush(REPO_ID, baseSha, pushedSha, USER_ID);
      expect(res.updated).toEqual(['/main.tex']);
      expect(res.created).toEqual(['/figs/fig.png']);
      expect(await gitRepo.resolveRef(REPO_ID)).toBe(pushedSha);
      expect(repo.recordPushTransition).toHaveBeenCalledWith({
        pageId: REPO_ID,
        pusherId: USER_ID,
        snapshotId: SNAP_ID,
        beforeOid: baseSha,
        afterOid: pushedSha,
        rootTreeOid: rootOid,
        commitSubject: 'Add figure',
        addedCount: 1,
        modifiedCount: 1,
        deletedCount: 0,
        totalBytes: 19,
      });
    });

    it('deletes files without NodeNotFoundError and updates binary files with syncStructureNode: false (no duplicate PageNode)', async () => {
      const gitRepo = new RepoAdapter();
      const v1Png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
      const v2Png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02, 0x03]);

      const { headOid: baseSha } = await gitRepo.commitTree(
        REPO_ID,
        [
          {
            path: RepoPathVo.fromRepo('main.tex'),
            content: Buffer.from('\\documentclass{article}\n'),
          },
          {
            path: RepoPathVo.fromRepo('obsolete.tex'),
            content: Buffer.from('remove me\n'),
          },
          {
            path: RepoPathVo.fromRepo('figs/fig.png'),
            content: v1Png,
          },
        ],
        'Initial tree',
      );

      const gitdir = gitRepo.bareDir(REPO_ID);
      const mainOid = await isoGit.writeBlob({
        fs,
        gitdir,
        blob: Buffer.from('\\documentclass{article}\n'),
      });
      const v2PngOid = await isoGit.writeBlob({
        fs,
        gitdir,
        blob: v2Png,
      });
      const figsTreeOid = await isoGit.writeTree({
        fs,
        gitdir,
        tree: [{ mode: '100644', path: 'fig.png', oid: v2PngOid, type: 'blob' }],
      });
      const nextRootOid = await isoGit.writeTree({
        fs,
        gitdir,
        tree: [
          { mode: '040000', path: 'figs', oid: figsTreeOid, type: 'tree' },
          { mode: '100644', path: 'main.tex', oid: mainOid, type: 'blob' },
        ],
      });
      const who = {
        name: 'Alice',
        email: 'alice@uni.edu',
        timestamp: 1700000200,
        timezoneOffset: 0,
      };
      const nextSha = await isoGit.writeCommit({
        fs,
        gitdir,
        commit: {
          message: 'Delete obsolete.tex and update figs/fig.png\n',
          tree: nextRootOid,
          parent: [baseSha],
          author: who,
          committer: who,
        },
      });
      await gitRepo.setMainRef(REPO_ID, nextSha);

      const nodesByPath = new Map<
        string,
        {
          id: string;
          name: string;
          path: string;
          parentId: string | null;
          type: 'DOC' | 'FILE' | 'FOLDER';
          docId?: string | null;
          fileId?: string | null;
          isRootDoc?: boolean;
        }
      >([
        [
          '/figs',
          {
            id: 'dir-figs',
            name: 'figs',
            path: '/figs',
            parentId: null,
            type: 'FOLDER',
          },
        ],
        [
          '/main.tex',
          {
            id: 'node-main',
            name: 'main.tex',
            path: '/main.tex',
            parentId: null,
            type: 'DOC',
            docId: 'doc-main',
            isRootDoc: true,
          },
        ],
        [
          '/obsolete.tex',
          {
            id: 'node-obsolete',
            name: 'obsolete.tex',
            path: '/obsolete.tex',
            parentId: null,
            type: 'DOC',
            docId: 'doc-obsolete',
          },
        ],
        [
          '/figs/fig.png',
          {
            id: 'node-fig-v1',
            name: 'fig.png',
            path: '/figs/fig.png',
            parentId: 'dir-figs',
            type: 'FILE',
            fileId: 'file-fig-v1',
          },
        ],
      ]);

      const repo = fromPartial<GitBridgeRepository>({
        resolveTarget: jest.fn(async () => ({
          repoId: REPO_ID,
          spaceId: REPO_ID,
          pageId: REPO_ID,
        })),
        recordPushTransition: jest.fn(async () => 1),
        resetGcPushCount: jest.fn(async () => undefined),
      });

      const patchDoc = jest.fn(async () => {
        throw new Error('patchDoc must not pre-delete PageNode before structure.deleteNode');
      });
      const deleteFile = jest.fn(async () => {
        throw new Error('deleteFile must not pre-delete PageNode before structure.deleteNode');
      });

      const docstore = fromPartial<DocstoreService>({
        getAllDocs: jest.fn(async () => [
          fromPartial({
            _id: 'doc-main',
            lines: ['\\documentclass{article}', ''],
            version: 1,
            deleted: false,
          }),
          fromPartial({
            _id: 'doc-obsolete',
            lines: ['remove me', ''],
            version: 1,
            deleted: false,
          }),
        ]),
        patchDoc,
      });

      const uploadFileFromBuffer = jest.fn(
        async (
          _sid: string,
          _name: string,
          _buf: Buffer,
          _mime?: string,
          opts?: { syncStructureNode?: boolean; pageId?: string | null },
        ) => {
          if (opts?.syncStructureNode !== false) {
            nodesByPath.set('/figs/fig.png', {
              id: 'auto-dup-node',
              name: 'fig.png',
              path: '/figs/fig.png',
              parentId: 'dir-figs',
              type: 'FILE',
              fileId: 'file-fig-v2',
            });
          }
          return fromPartial({ id: 'file-fig-v2' });
        },
      );

      const filestore = fromPartial<FilestoreService>({
        uploadFileFromBuffer,
        deleteFile,
      });

      const deleteNode = jest.fn(async (_sid: string, nodeId: string) => {
        const entry = Array.from(nodesByPath.entries()).find(
          ([, n]) => n.id === nodeId,
        );
        if (!entry) {
          const notFound = new Error(`Node ${nodeId} not found`);
          notFound.name = 'NodeNotFoundError';
          throw notFound;
        }
        nodesByPath.delete(entry[0]);
        return [fromPartial(entry[1])];
      });

      const createNode = jest.fn(async (_sid: string, dto) => {
        const fullPath =
          dto.parentId === 'dir-figs' ? `/figs/${dto.name}` : `/${dto.name}`;
        if (nodesByPath.has(fullPath)) {
          throw new Error(`Duplicate node at ${fullPath}`);
        }
        const created = {
          id: 'node-fig-v2',
          name: dto.name,
          path: fullPath,
          parentId: dto.parentId ?? null,
          type: dto.type,
          fileId: dto.fileId ?? null,
        };
        nodesByPath.set(fullPath, created);
        return fromPartial(created);
      });

      const structure = fromPartial<StructureService>({
        getAllNodes: jest.fn(async () =>
          Array.from(nodesByPath.values()).map((n) => fromPartial(n)),
        ),
        getNodeByPath: jest.fn(async (_sid: string, p: string) => {
          const found = nodesByPath.get(p);
          return found ? fromPartial(found) : null;
        }),
        deleteNode,
        createNode,
      });

      const sync = new SyncService(
        repo,
        gitRepo,
        new PackAdapter(gitRepo),
        docstore,
        filestore,
        structure,
      );

      const summary = await sync.applyPush(REPO_ID, baseSha, nextSha, USER_ID);

      expect(summary.deleted).toEqual(['/obsolete.tex']);
      expect(summary.updated).toEqual(['/figs/fig.png']);
      expect(summary.created).toEqual([]);
      expect(patchDoc).not.toHaveBeenCalled();
      expect(deleteFile).not.toHaveBeenCalled();
      expect(uploadFileFromBuffer).toHaveBeenCalledWith(
        REPO_ID,
        'figs/fig.png',
        v2Png,
        undefined,
        { syncStructureNode: false, pageId: REPO_ID },
      );
      expect(createNode).toHaveBeenCalledTimes(1);
      expect(nodesByPath.has('/obsolete.tex')).toBe(false);
      expect(nodesByPath.get('/figs/fig.png')?.fileId).toBe('file-fig-v2');
    });
  });

  describe('5. MaintenanceService (BCNF Eviction Index + Disk Sweep)', () => {
    it('combines DB findIdleMaterializedPageIds with disk sweep and marks evicted in PageGitRepo', async () => {
      const hotId = '0195f000-0000-7000-8000-000000000011';
      const coldId = '0195f000-0000-7000-8000-000000000022';

      const gitRepo = new RepoAdapter();
      await gitRepo.ensureBare(hotId);
      await gitRepo.ensureBare(coldId);

      const repo = fromPartial<GitBridgeRepository>({
        pruneAllExpired: jest.fn(async () => 2),
        findIdleMaterializedPageIds: jest.fn(async () => [coldId]),
        markReposEvicted: jest.fn(async () => undefined),
        findSpacePageIds: jest.fn(async () => [hotId]),
      });

      const maint = new MaintenanceService(gitRepo, repo);
      const future = Date.now() + 48 * 60 * 60 * 1000;
      (gitRepo.getTouchedMap() as Map<string, number>).set(hotId, future - 500);

      const res = await maint.sweep(24 * 60 * 60 * 1000, future);
      expect(res).toEqual({ evictedRepos: 1, prunedTokens: 2 });
      expect(repo.markReposEvicted).toHaveBeenCalledWith([coldId]);

      await expect(
        fsp.access(path.join(gitRepo.bareDir(coldId), 'HEAD')),
      ).rejects.toThrow();
      await expect(
        fsp.access(path.join(gitRepo.bareDir(hotId), 'HEAD')),
      ).resolves.toBeUndefined();
    });

    it('enforces Project Space membership role over stale page.createdById in GitBridgeRepository.resolveRole', async () => {
      const projectId = '0195f000-0000-7000-8000-000000000050';
      const prisma = {
        page: {
          findUnique: jest.fn().mockResolvedValue({
            spaceId: projectId,
            deletedAt: null,
            createdById: USER_ID,
            space: {
              type: 'project',
              ownerUserId: null,
              projectId,
            },
          }),
        },
        projectMember: {
          findUnique: jest.fn().mockResolvedValue({ role: 'reviewer' }),
        },
        project: {
          findFirst: jest.fn().mockResolvedValue({ createdById: 'other-owner' }),
        },
      };

      const repo = new GitBridgeRepository(prisma as never);
      const role = await repo.resolveRole(REPO_ID, USER_ID);
      expect(role).toBe('reviewer');
      expect(canWrite(role)).toBe(false);
    });
  });
});
