import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  NoopLiveCollaborationAdapter,
  NOOP_LIVE_COLLABORATION,
  SagaRunner,
  ManuscriptDomainEventBus,
  ProjectWorkspaceCollectorService,
} from '../../../src/modules/manuscripts/core';
import {
  ExportFormatRegistry,
  DocxExportStrategy,
  MarkdownExportStrategy,
  HtmlExportStrategy,
  PlainTexExportStrategy,
  transpileLatexDocumentForExport,
} from '../../../src/modules/manuscripts/export-import/domain/latex-export-transpiler';
import { ExportImportService } from '../../../src/modules/manuscripts/export-import/export-import.service';
import {
  BaseLatexEngine,
  LatexmkEngine,
} from '../../../src/modules/manuscripts/clsi/services/compile-pipeline.service';
import { RemoteClsiClientAdapter } from '../../../src/modules/manuscripts/clsi/services/remote-clsi.client';
import {
  AcademicSpellEngine,
  LanguageSpellProfileRegistry,
  LanguageCodeVo,
} from '../../../src/modules/manuscripts/spelling/domain/academic-spell.engine';
import {
  ReviewTransitionPolicy,
  defaultReviewTransitionPolicy,
} from '../../../src/modules/manuscripts/docstore/dto/review-status.dto';
import { LinkedFilesService } from '../../../src/modules/manuscripts/linked-files/linked-files.service';
import { TemplatesRepository } from '../../../src/modules/manuscripts/templates/templates.repository';
import {
  CrossrefArxivResolverAdapter,
  createResilientFetch,
} from '../../../src/modules/manuscripts/citations/domain/crossref-arxiv.resolver';
import { AcademicIdentifierVo } from '../../../src/modules/manuscripts/citations/domain/academic-identifier';
import { FastSyntaxLinter } from '../../../src/modules/manuscripts/diagnostics/domain/fast-syntax.linter';
import {
  classifyEvent,
  EVENT_RATE_CLASS_MAP,
} from '../../../src/modules/realtime/core/ws-rate-limiter';
import { assertRealtimeAccessDecision } from '../../../src/modules/realtime/core/ws-access.guard';
import { ProjectRolePolicy } from '../../../src/modules/project/access/guards/project-access.guard';
import { Role } from '../../../src/modules/project/access/enums/role.enum';
import * as Y from 'yjs';
import { LinePatcher } from '../../../src/modules/manuscripts/track-changes/domain/line-patcher';
import { DocstorePatcherAdapter } from '../../../src/modules/manuscripts/track-changes/adapters/track-changes.adapters';
import { GitBridgeService } from '../../../src/modules/manuscripts/git-bridge/git-bridge.service';
import { YjsCursorDiffEngine } from '../../../src/modules/realtime/manuscripts/yjs-cursor-diff.engine';

describe('Manuscripts Design Patterns & Audit Remediations', () => {
  describe('1. Null Object Pattern: NoopLiveCollaborationAdapter', () => {
    it('safely absorbs applyExternalText, getPresence, flushDocs, and evictDoc without throwing', async () => {
      const adapter = new NoopLiveCollaborationAdapter();
      expect(adapter.isNoop).toBe(true);
      await expect(
        adapter.applyExternalText('proj-1', 'doc-1', 'hello'),
      ).resolves.toBe(false);
      await expect(adapter.getPresence('proj-1', 'doc-1')).resolves.toEqual([]);
      await expect(adapter.flushDocs('proj-1', ['doc-1'])).resolves.toEqual([]);
      await expect(adapter.flushDoc('proj-1', 'doc-1')).resolves.toEqual([]);
      await expect(
        adapter.evictDoc('proj-1', 'doc-1'),
      ).resolves.toBeUndefined();
    });

    it('is used as the fallback by ProjectWorkspaceCollectorService and ManuscriptDomainEventBus when no gateway is mounted', async () => {
      const collector = new ProjectWorkspaceCollectorService();
      expect(collector.getLiveCollaborationPort()).toBe(
        NOOP_LIVE_COLLABORATION,
      );
      await expect(
        collector.flushProjectWorkspace('proj-1', ['doc-1']),
      ).resolves.toEqual([]);

      const bus = new ManuscriptDomainEventBus();
      await expect(
        bus.publish({
          type: 'manuscript.document.mutated',
          projectId: 'proj-1',
          docId: 'doc-1',
          lines: ['\\section{Intro}'],
          source: 'rest-docstore',
          occurredAt: Date.now(),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('2. Strategy + Registry Pattern: ExportFormatRegistry', () => {
    it('resolves built-in docx, md/markdown, html, and tex/latex strategies and supports custom format registration', () => {
      const registry = new ExportFormatRegistry();
      expect(registry.resolve('docx')).toBeInstanceOf(DocxExportStrategy);
      expect(registry.resolve('md')).toBeInstanceOf(MarkdownExportStrategy);
      expect(registry.resolve('MARKDOWN')).toBeInstanceOf(
        MarkdownExportStrategy,
      );
      expect(registry.resolve('html')).toBeInstanceOf(HtmlExportStrategy);
      expect(registry.resolve('tex')).toBeInstanceOf(PlainTexExportStrategy);
      expect(registry.resolve('unknown-format')).toBeInstanceOf(
        PlainTexExportStrategy,
      );

      // Register custom strategy without modifying existing code (Open/Closed Principle)
      registry.register({
        format: 'txt',
        transpile: (ctx) => ({
          filename: `${ctx.baseName}.txt`,
          mimeType: 'text/plain',
          content: ctx.content.trim(),
          isBase64: false,
          sizeBytes: Buffer.byteLength(ctx.content.trim(), 'utf8'),
        }),
      });
      const customResult = registry.resolve('txt').transpile({
        rawFilename: 'paper.tex',
        baseName: 'paper',
        content: '  hello world  ',
      });
      expect(customResult.filename).toBe('paper.txt');
      expect(customResult.mimeType).toBe('text/plain');
      expect(customResult.content).toBe('hello world');
    });

    it('transpileLatexDocumentForExport delegates to ExportFormatRegistry and resolves \\input macros', () => {
      const res = transpileLatexDocumentForExport({
        rawFilename: 'main.tex',
        content:
          '\\begin{document}\\section{Main}\\input{intro}\\end{document}',
        format: 'md',
        projectDocs: [
          {
            id: 'd2',
            path: 'intro.tex',
            lines: ['\\textbf{Included Child}'],
          },
        ],
      });
      expect(res.filename).toBe('main.md');
      expect(res.mimeType).toBe('text/markdown');
      expect(res.content).toContain('# Main');
      expect(res.content).toContain('**Included Child**');
    });
  });

  describe('3. Template Method Pattern: BaseLatexEngine & ExportImportService', () => {
    it('enforces shell-escape sandbox rejection and safe mainFile validation across LatexmkEngine (LSP)', async () => {
      const fakeRunner = {
        name: 'fake',
        run: jest.fn().mockResolvedValue({
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        }),
      };

      const engines: BaseLatexEngine[] = [
        new LatexmkEngine(fakeRunner),
      ];

      for (const engine of engines) {
        await expect(
          engine.compile({
            cwd: process.cwd(),
            mainFile: 'main.tex',
            shellEscape: true,
          }),
        ).rejects.toThrow(/Shell escape is strictly disabled/);

        await expect(
          engine.compile({
            cwd: process.cwd(),
            mainFile: '../secret.tex',
          }),
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('deduplicates exportProjectZip and exportProjectZipStream plan resolution with identical default naming', async () => {
      const aggregator = {
        collectProjectEntries: jest.fn().mockResolvedValue([]),
        collectLazyProjectEntries: jest.fn().mockResolvedValue([]),
      };
      const zipEngine = {
        buildZip: jest.fn().mockReturnValue(Buffer.from('PK-zip')),
        createZipStream: jest.fn().mockReturnValue({} as any),
        extractZip: jest.fn(),
      };
      const hydrator = {
        hydrateProjectEntries: jest.fn(),
      };

      const service = new ExportImportService(
        aggregator as any,
        zipEngine as any,
        hydrator as any,
      );

      const buffered = await service.exportProjectZip('proj-1', {});
      const streamed = await service.exportProjectZipStream('proj-1', {});

      expect(buffered.manifest.projectName).toBe('manuscript');
      expect(streamed.projectName).toBe('manuscript');
      expect(buffered.manifest.fileCount).toBe(1);
      expect(streamed.fileCount).toBe(1);
    });
  });

  describe('4. Circuit-Breaker Guard & Parameter Object: RemoteClsiClientAdapter', () => {
    it('supports both positional arguments and RemoteCompileRequest Parameter Object', async () => {
      const client = new RemoteClsiClientAdapter();
      const res = await client.tryRemoteClsiCompile({
        projectId: 'proj-1',
        mainFile: 'main.tex',
        source: '\\documentclass{article}',
        mergedFiles: {},
        dto: {} as any,
        cacheKey: 'cache-1',
      });
      expect(res).toBeNull();
    });
  });

  describe('5. Strategy + Registry Pattern: LanguageSpellProfileRegistry', () => {
    it('resolves morphology and dictionary per language via LanguageSpellProfileRegistry', () => {
      const spellEngine = new AcademicSpellEngine();
      const enVo = LanguageCodeVo.create('en-US');
      const frVo = LanguageCodeVo.create('fr-FR');

      expect(spellEngine.isCorrect('algorithm', enVo)).toBe(true);
      expect(spellEngine.isCorrect('algorithms', enVo)).toBe(true);
      expect(spellEngine.isCorrect('analyse', frVo)).toBe(true);

      const customRegistry = new LanguageSpellProfileRegistry();
      const dict = new Set([' customroot ']);
      customRegistry.register(
        {
          baseLanguage: 'en',
          dictionary: dict,
          getStems: (w) => [w],
        },
        true,
      );
      expect(customRegistry.resolve('unknown').baseLanguage).toBe('en');
    });
  });

  describe('6. Specification Pattern: ReviewTransitionPolicy', () => {
    it('enforces role and state transition rules declaratively', () => {
      const policy = new ReviewTransitionPolicy();

      // Contributor can request review from draft -> in_review
      expect(
        policy.evaluate({
          role: 'CONTRIBUTOR',
          fromStatus: 'draft',
          toStatus: 'in_review',
        }),
      ).toEqual({ allowed: true });

      // Viewer cannot request review
      const viewerRes = policy.evaluate({
        role: 'VIEWER',
        fromStatus: 'draft',
        toStatus: 'in_review',
      });
      expect(viewerRes.allowed).toBe(false);
      expect(viewerRes.violationType).toBe('forbidden');

      // Contributor cannot lock document
      const lockRes = policy.evaluate({
        role: 'CONTRIBUTOR',
        fromStatus: 'submitted',
        toStatus: 'locked',
      });
      expect(lockRes.allowed).toBe(false);
      expect(lockRes.violationType).toBe('forbidden');

      // Owner cannot make invalid state jump draft -> locked
      const invalidJump = defaultReviewTransitionPolicy.evaluate({
        role: 'OWNER',
        fromStatus: 'draft',
        toStatus: 'locked',
      });
      expect(invalidJump.allowed).toBe(false);
      expect(invalidJump.violationType).toBe('bad_request');
    });
  });

  describe('7. Saga / Compensation Pattern: SagaRunner & LinkedFilesService', () => {
    it('executes steps forward and runs compensations in reverse LIFO order on failure', async () => {
      const order: string[] = [];
      const saga = new SagaRunner()
        .addStep({
          name: 'step-1',
          execute: async () => {
            order.push('exec-1');
            return 'res-1';
          },
          compensate: async (res) => {
            order.push(`comp-1:${res}`);
          },
        })
        .addStep({
          name: 'step-2',
          execute: async () => {
            order.push('exec-2');
            return 'res-2';
          },
          compensate: async (res) => {
            order.push(`comp-2:${res}`);
          },
        })
        .addStep({
          name: 'step-3-fails',
          execute: async () => {
            order.push('exec-3');
            throw new Error('step-3 boom');
          },
          compensate: async () => {
            order.push('comp-3');
          },
        });

      await expect(saga.run()).rejects.toThrow('step-3 boom');
      expect(order).toEqual([
        'exec-1',
        'exec-2',
        'exec-3',
        'comp-2:res-2',
        'comp-1:res-1',
      ]);
    });

    it('rolls back orphan doc in LinkedFilesService.create when structureService.createNode fails', async () => {
      const deleteDocMock = jest.fn().mockResolvedValue(undefined);
      const docstoreService = {
        createDoc: jest.fn().mockResolvedValue({ _id: 'orphan-doc-1' }),
        deleteDoc: deleteDocMock,
      };
      const structureService = {
        createNode: jest
          .fn()
          .mockRejectedValue(new Error('DB constraint on node')),
      };
      const repo = {
        save: jest.fn(),
      };

      const service = new LinkedFilesService(
        repo as any,
        structureService as any,
        docstoreService as any,
      );
      jest.spyOn(service as any, 'downloadUrl').mockResolvedValue({
        buffer: Buffer.from('\\section{Hello}', 'utf8'),
        mimeType: 'text/plain',
      });

      await expect(
        service.create('proj-1', {
          name: 'chapter.tex',
          provider: 'url',
          url: 'https://example.com/chapter.tex',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(deleteDocMock).toHaveBeenCalledWith('proj-1', 'orphan-doc-1', {
        soft: false,
      });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rolls back created docs and Prisma project in TemplatesRepository.instantiate when node creation fails', async () => {
      const deleteProjectMock = jest.fn().mockResolvedValue({ id: 'proj-tpl-1' });
      const prismaMock = {
        $transaction: jest.fn(async (cb: any) =>
          cb({
            project: {
              create: jest.fn().mockResolvedValue({ id: 'proj-tpl-1' }),
            },
            projectMember: {
              create: jest.fn().mockResolvedValue({}),
            },
          }),
        ),
        project: {
          delete: deleteProjectMock,
        },
      };
      const deleteDocMock = jest.fn().mockResolvedValue(undefined);
      const docstoreMock = {
        createDoc: jest.fn().mockResolvedValue({ _id: 'doc-tpl-1' }),
        deleteDoc: deleteDocMock,
      };
      const structureMock = {
        mkdirp: jest.fn().mockResolvedValue({ id: 'folder-1' }),
        createNode: jest
          .fn()
          .mockRejectedValue(new Error('Structure node creation failed')),
        deleteNode: jest.fn().mockResolvedValue(undefined),
      };

      const repo = new TemplatesRepository(
        prismaMock as any,
        structureMock as any,
        docstoreMock as any,
      );

      await expect(
        repo.instantiate({
          template: {
            id: 'ieee-journal',
            versionId: 'v1',
            name: 'IEEE Journal',
            compiler: 'pdflatex',
            mainFile: 'main.tex',
            imageName: 'texlive-full',
            files: { 'main.tex': '\\documentclass{article}' },
          } as any,
          userId: 'user-1',
          projectName: 'Saga Template Test',
        }),
      ).rejects.toThrow(/Failed to hydrate template files for project/);

      expect(deleteDocMock).toHaveBeenCalledWith('proj-tpl-1', 'doc-tpl-1');
      expect(deleteProjectMock).toHaveBeenCalledWith({
        where: { id: 'proj-tpl-1' },
      });
    });
  });

  describe('8. Chain of Responsibility & Resilient Fetch Decorator: CrossrefArxivResolverAdapter', () => {
    it('falls back from CrossrefBibtexResolutionHandler to CrossrefJsonResolutionHandler when BibTeX content negotiation misses', async () => {
      const calls: string[] = [];
      const mockFetch = jest.fn(async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://doi.org/')) {
          return {
            ok: false,
            status: 406,
            text: async () => '',
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: {
              title: ['Attention Is All You Need'],
              author: [{ family: 'Vaswani', given: 'Ashish' }],
              issued: { 'date-parts': [[2017]] },
              type: 'proceedings-article',
              'container-title': ['Advances in Neural Information Processing Systems'],
            },
          }),
        } as Response;
      });

      const resolver = new CrossrefArxivResolverAdapter(mockFetch);
      const doiVo = AcademicIdentifierVo.parse('10.5555/3295222.3295349');
      expect(doiVo).not.toBeNull();

      const entry = await resolver.resolve(doiVo!);
      expect(calls.length).toBe(2);
      expect(entry).not.toBeNull();
      expect(entry?.key.value).toBe('vaswani2017attention');
      expect(entry?.title).toBe('Attention Is All You Need');
    });

    it('createResilientFetch retries once on transient HTTP 503 before succeeding', async () => {
      let attempts = 0;
      const baseFetch = jest.fn(async () => {
        attempts++;
        if (attempts === 1) {
          return { ok: false, status: 503 } as Response;
        }
        return { ok: true, status: 200 } as Response;
      });

      const resilient = createResilientFetch(baseFetch, {
        timeoutMs: 1000,
        maxRetries: 1,
      });
      const res = await resilient('https://api.crossref.org/works/10.1000/182');
      expect(res.ok).toBe(true);
      expect(attempts).toBe(2);
    });
  });

  describe('9. Strategy Rule Pipeline: FastSyntaxLinter AutoFix Rules', () => {
    it('executes default line auto-fix rules and allows registering custom rules (OCP)', () => {
      const linter = new FastSyntaxLinter();
      expect(linter.getAutoFixRuleIds()).toEqual([
        'SMART_QUOTES',
        'UNESCAPED_PERCENT',
        'NAKED_UNDERSCORE',
      ]);

      linter.registerAutoFixRule({
        id: 'CUSTOM_TODO_COMMENT',
        applyLine: (line, lineNum, fixes) => {
          if (line.includes('FIXMETOKEN')) {
            fixes.push({
              line: lineNum,
              rule: 'CUSTOM_TODO_COMMENT',
              description: 'Replaced FIXMETOKEN with \\textbf{TODO}',
            });
            return line.replace('FIXMETOKEN', '\\textbf{TODO}');
          }
          return line;
        },
      });

      const result = linter.autoFix('Hello “world” 50% done FIXMETOKEN');
      expect(result.isFixed).toBe(true);
      expect(result.fixedSource).toContain("``world''");
      expect(result.fixedSource).toContain('50\\% done');
      expect(result.fixedSource).toContain('\\textbf{TODO}');
    });
  });

  describe('10. Security & Access Patterns: WsRateLimiter Table, WsAccessGuard & ProjectRolePolicy', () => {
    it('classifies realtime events via declarative EVENT_RATE_CLASS_MAP lookup table', () => {
      expect(EVENT_RATE_CLASS_MAP['doc:cursor']).toBe('cursor');
      expect(classifyEvent('doc:sync:update')).toBe('update');
      expect(classifyEvent('project:chat:send')).toBe('chat');
      expect(classifyEvent('doc:join')).toBe('joinLeave');
      expect(classifyEvent('unknown:event')).toBe('other');
    });

    it('assertRealtimeAccessDecision translates access decisions into domain WS exceptions', () => {
      expect(() =>
        assertRealtimeAccessDecision('allowed', 'Denied'),
      ).not.toThrow();
      expect(() =>
        assertRealtimeAccessDecision('denied', 'Denied read', 'read'),
      ).toThrow();
      expect(() =>
        assertRealtimeAccessDecision('denied', 'Denied write', 'write'),
      ).toThrow();
    });

    it('ProjectRolePolicy evaluates role aliases and hierarchy cleanly without ExecutionContext', () => {
      expect(
        ProjectRolePolicy.satisfiesRequiredRoles(Role.CONTRIBUTOR, ['member']),
      ).toBe(true);
      expect(
        ProjectRolePolicy.satisfiesRequiredRoles(Role.OWNER, ['admin']),
      ).toBe(true);
      expect(
        ProjectRolePolicy.satisfiesRequiredRoles(Role.REVIEWER, ['viewer']),
      ).toBe(true);
      expect(
        ProjectRolePolicy.satisfiesRequiredRoles(Role.REVIEWER, ['admin']),
      ).toBe(false);

      expect(
        ProjectRolePolicy.satisfiesMinRole(Role.COORDINATOR, Role.CONTRIBUTOR),
      ).toBe(true);
      expect(
        ProjectRolePolicy.satisfiesMinRole(Role.REVIEWER, Role.CONTRIBUTOR),
      ).toBe(false);
    });
  });

  describe('11. Phase 4 — Symmetric Dual Strategy Table & Template Method: LinePatcher & DocstorePatcherAdapter', () => {
    it('applies symmetric insert/delete and accept/reject patch strategies via CHANGE_PATCH_STRATEGIES', () => {
      const base = ['line 1', 'line 2', 'line 3'];

      // Accept insert -> inserts text at line 1 (0-based index 1)
      const accInsert = LinePatcher.computeAcceptedPatch(base, {
        type: 'insert',
        text: 'inserted\n',
        range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
      } as any);
      expect(accInsert.mutated).toBe(true);
      expect(accInsert.lines).toEqual(['line 1', 'inserted', 'line 2', 'line 3']);

      // Reject insert -> removes the inserted range [1,0 -> 2,0]
      const rejInsert = LinePatcher.computeRejectedPatch(accInsert.lines, {
        type: 'insert',
        text: 'inserted\n',
        range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
      } as any);
      expect(rejInsert.mutated).toBe(true);
      expect(rejInsert.lines).toEqual(base);

      // Reject delete -> restores deleted text if absent at range
      const afterDelete = ['line 1', 'line 3'];
      const rejDelete = LinePatcher.computeRejectedPatch(afterDelete, {
        type: 'delete',
        text: 'line 2\n',
        range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
      } as any);
      expect(rejDelete.mutated).toBe(true);
      expect(rejDelete.lines).toEqual(base);
    });

    it('DocstorePatcherAdapter.revertChange skips updateDoc when patch is a no-op (mutated === false)', async () => {
      const updateDocMock = jest.fn();
      const docstoreService = {
        getDoc: jest.fn().mockResolvedValue({
          lines: ['already present'],
          version: 4,
        }),
        updateDoc: updateDocMock,
      };
      const adapter = new DocstorePatcherAdapter(docstoreService as any);

      // Reverting a delete whose text is already present at [0,0] is a no-op
      await adapter.revertChange('proj-1', 'doc-1', {
        type: 'delete',
        text: 'already present',
        range: { startLine: 0, startCol: 0, endLine: 0, endCol: 15 },
      } as any);

      expect(updateDocMock).not.toHaveBeenCalled();
    });
  });

  describe('12. Phase 4 — Saga + Memento Rollback in GitBridgeService.applyPush & DomainEventBus Eviction', () => {
    it('restores Memento snapshot of previously mutated files when a subsequent file in GitBridgeService.applyPush fails', async () => {
      const updateDocMock = jest
        .fn()
        .mockResolvedValueOnce({ version: 2 }) // first file succeeds
        .mockRejectedValueOnce(new Error('Disk quota exceeded')) // second file fails
        .mockResolvedValueOnce({ version: 3 }); // compensation restore of first file

      const docstoreService = {
        getDoc: jest.fn(async (_projId: string, docId: string) => {
          if (docId === 'doc-a') return { _id: 'doc-a', lines: ['old A'], version: 1 };
          if (docId === 'doc-b') return { _id: 'doc-b', lines: ['old B'], version: 1 };
          return null;
        }),
        updateDoc: updateDocMock,
        deleteDoc: jest.fn(),
        createDoc: jest.fn(),
      };
      const structureService = {
        getNodeByPath: jest.fn(async (_projId: string, path: string) => {
          if (path === '/a.tex') {
            return {
              id: 'node-a',
              name: 'a.tex',
              parentId: 'root',
              type: 'DOC',
              docId: 'doc-a',
            };
          }
          if (path === '/b.tex') {
            return {
              id: 'node-b',
              name: 'b.tex',
              parentId: 'root',
              type: 'DOC',
              docId: 'doc-b',
            };
          }
          return null;
        }),
      };
      const gitCliMock = {
        diffNameStatus: jest
          .fn()
          .mockResolvedValue('M\0a.tex\0M\0b.tex\0'),
        readBlob: jest.fn(async (_projId: string, _sha: string, path: string) =>
          Buffer.from(path === 'a.tex' ? 'new A' : 'new B', 'utf8'),
        ),
      };

      const gitBridge = new GitBridgeService(
        {} as any,
        docstoreService as any,
        {} as any,
        structureService as any,
        undefined,
        gitCliMock as any,
      );

      await expect(
        gitBridge.applyPush('proj-1', 'old-sha-1', 'new-sha-2'),
      ).rejects.toThrow('Disk quota exceeded');

      // 3rd call to updateDoc should be the Memento compensation restoring ['old A']
      expect(updateDocMock).toHaveBeenCalledTimes(3);
      expect(updateDocMock.mock.calls[2]).toEqual([
        'proj-1',
        'doc-a',
        {
          lines: ['old A'],
          version: 2,
        },
      ]);
    });

    it('ManuscriptDomainEventBus preserves active restoredDocIds (synced via applyExternalText) and only evicts explicit evictedDocIds on manuscript.history.restored', async () => {
      const evictDocMock = jest.fn().mockResolvedValue(undefined);
      const moduleRefMock = {
        get: jest.fn().mockReturnValue({
          isNoop: false,
          evictDoc: evictDocMock,
        }),
      };
      const bus = new ManuscriptDomainEventBus(moduleRefMock as any);

      await bus.publish({
        type: 'manuscript.history.restored',
        projectId: 'proj-1',
        snapshotId: 'snap-99',
        restoredDocIds: ['doc-1', 'doc-2'],
        evictedDocIds: ['doc-deleted-3'],
        userId: 'user-1',
        occurredAt: Date.now(),
      });

      expect(evictDocMock).toHaveBeenCalledTimes(1);
      expect(evictDocMock).toHaveBeenCalledWith('proj-1', 'doc-deleted-3');
    });
  });

  describe('13. Phase 4 — Pure Domain Diff Engine: YjsCursorDiffEngine', () => {
    it('computes multi-hunk LCS cursor-preserving edits and preserves unchanged middle lines in Y.Text', () => {
      const current = ['\\section{One}', 'Keep this middle line', '\\section{Two}'].join('\n');
      const next = ['\\section{One Updated}', 'Keep this middle line', '\\section{Two Updated}'].join('\n');

      const edits = YjsCursorDiffEngine.computeCursorPreservingEdits(current, next);
      expect(edits.length).toBe(2);

      const doc = new Y.Doc();
      const yText = doc.getText('codemirror');
      yText.insert(0, current);

      // Anchor a relative position inside the unchanged middle line
      const midOffset = current.indexOf('middle');
      const relPos = Y.createRelativePositionFromTypeIndex(yText, midOffset);

      YjsCursorDiffEngine.applyEditsToYText(doc, yText, current, next, 'unit-test');
      expect(yText.toString()).toBe(next);

      const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, doc);
      expect(absPos).not.toBeNull();
      expect(next.slice(absPos!.index, absPos!.index + 6)).toBe('middle');
    });
  });

  describe('14. Phase 5 — Adversarial Deepening & Invariant Verification', () => {
    it('LinePatcher accepts and rejects multi-line insertions starting with "\\n" and point-range insertions', () => {
      const base = ['\\section{One}', '\\section{Two}'];

      // 1. Accepting a multi-line insertion that starts with a leading newline '\n'
      const newlineInsert = LinePatcher.computeAcceptedPatch(base, {
        type: 'insert',
        text: '\n\\subsection{Inserted}',
        range: { startLine: 0, startCol: 13, endLine: 0, endCol: 13 },
      } as any);
      expect(newlineInsert.mutated).toBe(true);
      expect(newlineInsert.lines).toEqual([
        '\\section{One}',
        '\\subsection{Inserted}',
        '\\section{Two}',
      ]);

      // Calling accept a second time on the already-patched lines must be idempotent (mutated: false)
      const secondAccept = LinePatcher.computeAcceptedPatch(newlineInsert.lines, {
        type: 'insert',
        text: '\n\\subsection{Inserted}',
        range: { startLine: 0, startCol: 13, endLine: 0, endCol: 13 },
      } as any);
      expect(secondAccept.mutated).toBe(false);

      // 2. Rejecting a point-range insertion (startLine === endLine && startCol === endCol)
      const pointReject = LinePatcher.computeRejectedPatch(newlineInsert.lines, {
        type: 'insert',
        text: '\n\\subsection{Inserted}',
        range: { startLine: 0, startCol: 13, endLine: 0, endCol: 13 },
      } as any);
      expect(pointReject.mutated).toBe(true);
      expect(pointReject.lines).toEqual(base);
    });

    it('YjsCursorDiffEngine never splits UTF-16 surrogate pairs across oldSpan or newSpan boundaries', () => {
      // Mathematical bold capital A: \uD835\uDC00, Mathematical bold capital B: \uD835\uDC01
      const oldText = 'prefix \uD835\uDC00 suffix';
      const newText = 'prefix \uD835\uDC01 suffix';

      const edit = YjsCursorDiffEngine.trimSpanToSingleEdit(0, oldText, newText);
      expect(edit).not.toBeNull();
      // Even though both share high surrogate \uD835, prefix must step back so the surrogate pair is replaced whole
      expect(edit!.index).toBe(7);
      expect(edit!.deleteLen).toBe(2);
      expect(edit!.insertText).toBe('\uD835\uDC01');
    });

    it('GitBridgeService.restoreEntryMemento removes newly created replacement node and restores soft-deleted binary FILE on rollback', async () => {
      const deletedNodes: string[] = [];
      const createdNodes: any[] = [];
      const restoreFileMock = jest.fn().mockResolvedValue(true);

      let currentNode: any = {
        id: 'node-orig-file',
        name: 'figure.png',
        parentId: 'root',
        type: 'FILE',
        fileId: 'file-orig-1',
      };

      const structureService = {
        getNodeByPath: jest.fn(async (_projId: string, path: string) => {
          if (path === '/figure.png') return currentNode;
          return null;
        }),
        mkdirp: jest.fn().mockResolvedValue({ id: 'root' }),
        deleteNode: jest.fn(async (_projId: string, nodeId: string) => {
          deletedNodes.push(nodeId);
          currentNode = null;
        }),
        createNode: jest.fn(async (_projId: string, dto: any) => {
          const created = { id: `node-new-${createdNodes.length + 1}`, ...dto };
          createdNodes.push(created);
          currentNode = created;
          return created;
        }),
      };

      const filestoreService = {
        deleteFile: jest.fn().mockResolvedValue(undefined),
        restoreFile: restoreFileMock,
        uploadFileFromBuffer: jest
          .fn()
          .mockResolvedValueOnce({ id: 'file-new-2' })
          .mockRejectedValueOnce(new Error('S3 upload failed on second file')),
      };

      const gitCliMock = {
        diffNameStatus: jest
          .fn()
          .mockResolvedValue('M\0figure.png\0A\0second.png\0'),
        readBlob: jest.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      };

      const gitBridge = new GitBridgeService(
        {} as any,
        {} as any,
        filestoreService as any,
        structureService as any,
        undefined,
        gitCliMock as any,
      );

      await expect(
        gitBridge.applyPush('proj-1', 'sha-1', 'sha-2'),
      ).rejects.toThrow('S3 upload failed on second file');

      // Should have restored the original soft-deleted binary file and recreated node with file-orig-1
      expect(restoreFileMock).toHaveBeenCalledWith('proj-1', 'file-orig-1');
      expect(currentNode?.fileId).toBe('file-orig-1');
    });
  });
});
