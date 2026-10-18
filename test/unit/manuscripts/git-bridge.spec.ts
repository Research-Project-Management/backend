import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { spawnSync } from 'child_process';
import {
  GitCliAdapter,
  GitBridgeRepository,
  GitBridgeService,
  generateToken,
  parseToken,
  tokenMatches,
  parseBasicAuth,
  parseRepoName,
  toProjectPath,
  isTextPath,
  parseNameStatusZ,
  canWrite,
} from '@/modules/manuscripts/git-bridge';

const PID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('git-bridge domain', () => {
  it('token roundtrip + basic auth', () => {
    const { token, id, hash } = generateToken(PID);
    expect(parseToken(token)).toEqual({ userId: PID, tokenId: id });
    expect(tokenMatches(token, { id, hash, label: '', createdAt: '' })).toBe(
      true,
    );
    expect(
      tokenMatches(token + 'x', { id, hash, label: '', createdAt: '' }),
    ).toBe(false);
    const header = 'Basic ' + Buffer.from(`me:${token}`).toString('base64');
    expect(parseBasicAuth(header)?.password).toBe(token);
  });
  it('repo name, paths, classification, perms', () => {
    expect(parseRepoName(`${PID}.git`)).toBe(PID);
    expect(parseRepoName('../x.git')).toBeNull();
    expect(toProjectPath('a/b.tex')).toBe('/a/b.tex');
    expect(() => toProjectPath('../etc/passwd')).toThrow();
    expect(() => toProjectPath('.git/config')).toThrow();
    expect(isTextPath('main.tex', Buffer.from('hi'))).toBe(true);
    expect(isTextPath('fig.png', Buffer.from('hi'))).toBe(false);
    expect(isTextPath('x.tex', Buffer.from([0, 1, 2]))).toBe(false);
    expect(parseNameStatusZ('M\0a.tex\0D\0b.png\0A\0c/d.tex\0')).toEqual([
      { status: 'M', path: 'a.tex' },
      { status: 'D', path: 'b.png' },
      { status: 'A', path: 'c/d.tex' },
    ]);
    expect(canWrite('reviewer')).toBe(false);
    expect(canWrite('contributor')).toBe(true);
  });
});

describe('git-bridge sync with real git', () => {
  let root: string;
  let prevRoot: string | undefined;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-git-test-'));
    prevRoot = process.env.GIT_BRIDGE_ROOT;
    process.env.GIT_BRIDGE_ROOT = path.join(root, 'repos');
  });
  afterAll(async () => {
    process.env.GIT_BRIDGE_ROOT = prevRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('materializes project, accepts a real push and applies it back', async () => {
    // In-memory project model behind the real service APIs used by GitSyncUseCase.
    const docs = new Map<
      string,
      { id: string; lines: string[]; version: number; deleted: boolean }
    >();
    const files = new Map<string, { id: string; content: Buffer }>();
    const nodes: any[] = [];
    let seq = 0;
    const addNode = (n: any) => nodes.push({ id: `n${++seq}`, ...n });
    docs.set('d1', {
      id: 'd1',
      lines: ['\\documentclass{article}', 'Hello'],
      version: 1,
      deleted: false,
    });
    files.set('f1', {
      id: 'f1',
      content: Buffer.from([137, 80, 78, 71, 0, 1]),
    });
    addNode({ type: 'DOC', path: '/main.tex', docId: 'd1' });
    addNode({ type: 'FILE', path: '/fig.png', fileId: 'f1' });

    const docstore: any = {
      getDoc: async (_p: string, id: string) => docs.get(id),
      updateDoc: jest.fn(async (_p: string, id: string, dto: any) => {
        const d = docs.get(id)!;
        d.lines = dto.lines;
        d.version = dto.version;
        return { doc: d };
      }),
      createDoc: jest.fn(async (_p: string, dto: any) => {
        const id = `d${++seq}`;
        docs.set(id, { id, lines: dto.lines, version: 0, deleted: false });
        return { id };
      }),
      patchDoc: jest.fn(async (_p: string, id: string, dto: any) => {
        docs.get(id)!.deleted = !!dto.deleted;
      }),
    };
    const filestore: any = {
      openReadStream: async (_p: string, id: string) => ({
        stream: Readable.from([files.get(id)!.content]),
      }),
      deleteFile: jest.fn(async () => undefined),
      uploadFileFromBuffer: jest.fn(
        async (_p: string, _n: string, b: Buffer) => {
          const id = `f${++seq}`;
          files.set(id, { id, content: b });
          return { id };
        },
      ),
    };
    const structure: any = {
      getAllNodes: async () => nodes,
      getNodeByPath: async (_p: string, p: string) =>
        nodes.find((n) => n.path === p) ?? null,
      deleteNode: jest.fn(async (_p: string, id: string) => {
        const i = nodes.findIndex((n) => n.id === id);
        if (i >= 0) nodes.splice(i, 1);
      }),
      mkdirp: jest.fn(async (_p: string, dir: string) => {
        let n = nodes.find((x) => x.path === dir);
        if (!n) {
          addNode({ type: 'FOLDER', path: dir });
          n = nodes[nodes.length - 1];
        }
        return n;
      }),
      createNode: jest.fn(async (_p: string, dto: any) => {
        const parent = nodes.find((x) => x.id === dto.parentId);
        addNode({
          type: dto.type,
          path: `${parent ? parent.path : ''}/${dto.name}`,
          docId: dto.docId,
          fileId: dto.fileId,
        });
      }),
    };

    const git = new GitCliAdapter();
    const repo = new GitBridgeRepository(undefined, git);
    const sync = new GitBridgeService(repo, docstore, filestore, structure);

    const tip1 = await sync.materialize(PID);
    expect(tip1).toMatch(/^[0-9a-f]{40}$/);
    expect(await sync.materialize(PID)).toBe(tip1); // unchanged -> no new commit

    // Clone over the file transport, edit, push (exercises receive-pack).
    const clone = path.join(root, 'clone');
    const g = (args: string[], cwd = clone) => {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    g(
      [
        'clone',
        '-c',
        'core.autocrlf=false',
        '--quiet',
        git.bareDir(PID),
        clone,
      ],
      root,
    );
    expect(await fs.readFile(path.join(clone, 'main.tex'), 'utf8')).toBe(
      '\\documentclass{article}\nHello',
    );
    await fs.writeFile(
      path.join(clone, 'main.tex'),
      '\\documentclass{article}\nHello git',
    );
    await fs.mkdir(path.join(clone, 'chapters'));
    await fs.writeFile(path.join(clone, 'chapters', 'intro.tex'), 'Intro');
    await fs.rm(path.join(clone, 'fig.png'));
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'edit']);
    g(['push', '-q', 'origin', 'HEAD:main']);

    const tip2 = await git.resolveRef(PID);
    expect(tip2).not.toBe(tip1);
    const applied = await sync.applyPush(PID, tip1, tip2!);
    expect(applied.updated).toEqual(['/main.tex']);
    expect(applied.created).toEqual(['/chapters/intro.tex']);
    expect(applied.deleted).toEqual(['/fig.png']);
    expect(docs.get('d1')!.lines).toEqual([
      '\\documentclass{article}',
      'Hello git',
    ]);
    expect(filestore.deleteFile).toHaveBeenCalledWith(PID, 'f1', false); // soft delete
    expect(nodes.some((n) => n.path === '/chapters/intro.tex' && n.docId)).toBe(
      true,
    );

    // Project now equals pushed tree -> materialize must not create a new commit.
    expect(await sync.materialize(PID)).toBe(tip2);
  }, 60_000);
});
