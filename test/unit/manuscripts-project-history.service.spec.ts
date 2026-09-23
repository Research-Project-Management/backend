/**
 * test/unit/manuscripts-project-history.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Project History Subsystem.
 * (Full Project History, Version Snapshots, Myers Diff & Labels Engine - Overleaf Parity).
 *
 * Validates:
 *  1. Domain Value Objects & Entities:
 *      - FileSnapshotVo (doc vs file, path normalization, JSON serialization)
 *      - DiffHunkVo (unified diff header, lines, word tokens)
 *      - FileDiffVo (added, deleted, modified, renamed statuses)
 *      - VersionLabel (validation, update, timestamps)
 *      - Snapshot (aggregate root, empty validation, labels, toFilesJson)
 *  2. Myers Diff Engine Adapter:
 *      - Classic Myers LCS line diffing
 *      - Intra-line word highlight tokens
 *      - File addition, deletion, modification, and rename detection
 *  3. In-Memory SPI Port Implementations:
 *      - MockHistoryRepository implementing IHistoryRepositoryPort
 *      - MockProjectCollector implementing IProjectCollectorPort
 *      - MockProjectRestorer implementing IProjectRestorerPort
 *  4. Inbound Use Cases:
 *      - CreateSnapshotUseCase (auto-increment version N+1, collector wiring, labels)
 *      - GetVersionListUseCase (ordered snapshots listing)
 *      - GetSnapshotByVersionUseCase (find by version, 404 on missing)
 *      - CompareVersionsDiffUseCase (diff between arbitrary historical versions)
 *      - LabelVersionUseCase (idempotent labeling, duplicate label rejection)
 *      - DeleteLabelUseCase (removing named milestone)
 *      - RestoreVersionUseCase (non-destructive restore creating version N+1)
 *  5. ProjectHistoryService & ProjectHistoryController:
 *      - DTO transformations and orchestration
 *      - REST API endpoints and HTTP status code mappings (404, 409, 400)
 */

import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ProjectHistoryService } from '@/modules/manuscripts/project-history/project-history.service';
import { ProjectHistoryController } from '@/modules/manuscripts/project-history/project-history.controller';
import { CreateSnapshotUseCase } from '@/modules/manuscripts/project-history/core/use-cases/create-snapshot.use-case';
import { GetVersionListUseCase } from '@/modules/manuscripts/project-history/core/use-cases/get-version-list.use-case';
import { GetSnapshotByVersionUseCase } from '@/modules/manuscripts/project-history/core/use-cases/get-snapshot-by-version.use-case';
import { CompareVersionsDiffUseCase } from '@/modules/manuscripts/project-history/core/use-cases/compare-versions-diff.use-case';
import { LabelVersionUseCase } from '@/modules/manuscripts/project-history/core/use-cases/label-version.use-case';
import { DeleteLabelUseCase } from '@/modules/manuscripts/project-history/core/use-cases/delete-label.use-case';
import { RestoreVersionUseCase } from '@/modules/manuscripts/project-history/core/use-cases/restore-version.use-case';

import { IHistoryRepositoryPort } from '@/modules/manuscripts/project-history/core/ports/history-repository.port';
import { IProjectCollectorPort } from '@/modules/manuscripts/project-history/core/ports/project-collector.port';
import { IProjectRestorerPort, RestoreResult } from '@/modules/manuscripts/project-history/core/ports/project-restorer.port';
import { MyersDiffEngineAdapter } from '@/modules/manuscripts/project-history/core/adapters/engine/myers-diff-engine.adapter';

import { Snapshot } from '@/modules/manuscripts/project-history/core/domain/entities/snapshot.entity';
import { VersionLabel } from '@/modules/manuscripts/project-history/core/domain/entities/version-label.entity';
import { FileSnapshotVo } from '@/modules/manuscripts/project-history/core/domain/value-objects/file-snapshot.vo';
import { DiffHunkVo } from '@/modules/manuscripts/project-history/core/domain/value-objects/diff-hunk.vo';
import { FileDiffVo } from '@/modules/manuscripts/project-history/core/domain/value-objects/file-diff.vo';

import { VersionNotFoundException } from '@/modules/manuscripts/project-history/core/domain/exceptions/version-not-found.exception';
import { DuplicateLabelException } from '@/modules/manuscripts/project-history/core/domain/exceptions/duplicate-label.exception';
import { EmptyProjectException } from '@/modules/manuscripts/project-history/core/domain/exceptions/empty-project.exception';

// ---------------------------------------------------------------------------
// Mock Implementations for Ports (SPIs)
// ---------------------------------------------------------------------------

class InMemoryHistoryRepository extends IHistoryRepositoryPort {
  private snapshots = new Map<string, Snapshot>(); // key: `${projectId}:${version}`
  private labels = new Map<string, VersionLabel>(); // key: id

  private snapKey(projectId: string, version: number): string {
    return `${projectId}:${version}`;
  }

  public async saveSnapshot(snapshot: Snapshot): Promise<Snapshot> {
    this.snapshots.set(this.snapKey(snapshot.projectId, snapshot.version), snapshot);
    for (const label of snapshot.labels) {
      this.labels.set(label.id, label);
    }
    return snapshot;
  }

  public async findByVersion(projectId: string, version: number): Promise<Snapshot | null> {
    const snap = this.snapshots.get(this.snapKey(projectId, version));
    return snap ?? null;
  }

  public async getLatestVersion(projectId: string): Promise<number> {
    let max = 0;
    for (const snap of this.snapshots.values()) {
      if (snap.projectId === projectId && snap.version > max) {
        max = snap.version;
      }
    }
    return max;
  }

  public async listVersions(projectId: string): Promise<Snapshot[]> {
    const list: Snapshot[] = [];
    for (const snap of this.snapshots.values()) {
      if (snap.projectId === projectId) {
        list.push(snap);
      }
    }
    return list.sort((a, b) => a.version - b.version);
  }

  public async saveLabel(label: VersionLabel): Promise<VersionLabel> {
    this.labels.set(label.id, label);
    const snap = this.snapshots.get(this.snapKey(label.projectId, label.version));
    if (snap) {
      // replace or add
      snap.removeLabel(label.id);
      snap.addLabel(label);
    }
    return label;
  }

  public async deleteLabel(projectId: string, labelId: string): Promise<void> {
    const label = this.labels.get(labelId);
    if (label && label.projectId === projectId) {
      this.labels.delete(labelId);
      const snap = this.snapshots.get(this.snapKey(label.projectId, label.version));
      if (snap) {
        snap.removeLabel(labelId);
      }
    }
  }

  public async findLabelByName(projectId: string, label: string): Promise<VersionLabel | null> {
    for (const l of this.labels.values()) {
      if (l.projectId === projectId && l.label.toLowerCase() === label.toLowerCase()) {
        return l;
      }
    }
    return null;
  }

  public clear(): void {
    this.snapshots.clear();
    this.labels.clear();
  }
}

class MockProjectCollector extends IProjectCollectorPort {
  public currentState = new Map<string, FileSnapshotVo>();

  public async collectCurrentState(projectId: string): Promise<Map<string, FileSnapshotVo>> {
    return new Map(this.currentState);
  }
}

class MockProjectRestorer extends IProjectRestorerPort {
  public lastRestoredProjectId: string | null = null;
  public lastRestoredSnapshot: Snapshot | null = null;
  public collectorToUpdate: MockProjectCollector | null = null;

  public async restoreToState(projectId: string, snapshot: Snapshot): Promise<RestoreResult> {
    this.lastRestoredProjectId = projectId;
    this.lastRestoredSnapshot = snapshot;
    if (this.collectorToUpdate) {
      this.collectorToUpdate.currentState = new Map(snapshot.files);
    }
    return {
      restoredFilesCount: snapshot.fileCount,
      restoredDocIds: Array.from(snapshot.files.values())
        .filter((f) => f.type === 'doc' && f.docId)
        .map((f) => f.docId!),
    };
  }
}

// ---------------------------------------------------------------------------
// Unit Test Suite
// ---------------------------------------------------------------------------

describe('Manuscripts Project History Subsystem (Overleaf Parity)', () => {
  const projectId = '01928374-beef-4000-8000-000000000001';
  const userId = '01928374-beef-4000-8000-000000000002';

  let diffEngine: MyersDiffEngineAdapter;
  let historyRepo: InMemoryHistoryRepository;
  let collector: MockProjectCollector;
  let restorer: MockProjectRestorer;

  let createSnapshotUseCase: CreateSnapshotUseCase;
  let getVersionListUseCase: GetVersionListUseCase;
  let getSnapshotByVersionUseCase: GetSnapshotByVersionUseCase;
  let compareVersionsDiffUseCase: CompareVersionsDiffUseCase;
  let labelVersionUseCase: LabelVersionUseCase;
  let deleteLabelUseCase: DeleteLabelUseCase;
  let restoreVersionUseCase: RestoreVersionUseCase;

  let historyService: ProjectHistoryService;
  let historyController: ProjectHistoryController;

  beforeEach(() => {
    diffEngine = new MyersDiffEngineAdapter();
    historyRepo = new InMemoryHistoryRepository();
    collector = new MockProjectCollector();
    restorer = new MockProjectRestorer();
    restorer.collectorToUpdate = collector;

    createSnapshotUseCase = new CreateSnapshotUseCase(historyRepo, collector);
    getVersionListUseCase = new GetVersionListUseCase(historyRepo);
    getSnapshotByVersionUseCase = new GetSnapshotByVersionUseCase(historyRepo);
    compareVersionsDiffUseCase = new CompareVersionsDiffUseCase(historyRepo, diffEngine);
    labelVersionUseCase = new LabelVersionUseCase(historyRepo);
    deleteLabelUseCase = new DeleteLabelUseCase(historyRepo);
    restoreVersionUseCase = new RestoreVersionUseCase(historyRepo, restorer, createSnapshotUseCase);

    historyService = new ProjectHistoryService(
      createSnapshotUseCase,
      getVersionListUseCase,
      getSnapshotByVersionUseCase,
      compareVersionsDiffUseCase,
      labelVersionUseCase,
      deleteLabelUseCase,
      restoreVersionUseCase,
    );

    historyController = new ProjectHistoryController(historyService);
  });

  // =========================================================================
  // 1. Domain Entities & Value Objects
  // =========================================================================
  describe('1. Domain Value Objects & Entities', () => {
    it('FileSnapshotVo: creates doc snapshot and calculates byte size and paths', () => {
      const docVo = FileSnapshotVo.createDoc('main.tex', 'doc-123', ['\\documentclass{article}', '\\begin{document}', 'Hello', '\\end{document}'], 'hash-1', true);
      expect(docVo.path).toBe('/main.tex');
      expect(docVo.type).toBe('doc');
      expect(docVo.docId).toBe('doc-123');
      expect(docVo.lines).toHaveLength(4);
      expect(docVo.isRootDoc).toBe(true);
      expect(docVo.sizeBytes).toBeGreaterThan(0);

      const json = docVo.toJSON();
      expect(json.path).toBe('/main.tex');
      expect(json.type).toBe('doc');
      expect(json.docId).toBe('doc-123');
    });

    it('FileSnapshotVo: creates binary file snapshot', () => {
      const fileVo = FileSnapshotVo.createFile('/figures/diagram.png', 'file-456', 'hash-binary', 1048576);
      expect(fileVo.path).toBe('/figures/diagram.png');
      expect(fileVo.type).toBe('file');
      expect(fileVo.fileId).toBe('file-456');
      expect(fileVo.sizeBytes).toBe(1048576);
      expect(fileVo.lines).toBeNull();
      expect(fileVo.isRootDoc).toBe(false);
    });

    it('DiffHunkVo: formats hunk header correctly', () => {
      const hunk = new DiffHunkVo({
        oldStartLine: 10,
        oldLineCount: 5,
        newStartLine: 10,
        newLineCount: 7,
        lines: [
          { type: 'unchanged', text: 'context' },
          { type: 'deleted', text: 'old line' },
          { type: 'added', text: 'new line' },
        ],
      });
      expect(hunk.header).toBe('@@ -10,5 +10,7 @@');
      expect(hunk.lines).toHaveLength(3);
    });

    it('VersionLabel: validates label name and updates label', () => {
      expect(() =>
        VersionLabel.create({
          projectId,
          snapshotId: 'snap-1',
          version: 1,
          label: '   ',
        }),
      ).toThrow('Version label cannot be empty.');

      const label = VersionLabel.create({
        projectId,
        snapshotId: 'snap-1',
        version: 1,
        label: 'v1.0-draft',
        createdById: userId,
      });
      expect(label.label).toBe('v1.0-draft');
      expect(label.version).toBe(1);

      label.updateLabel('v1.0-final');
      expect(label.label).toBe('v1.0-final');
      expect(() => label.updateLabel('')).toThrow('Version label cannot be empty.');
    });

    it('Snapshot: throws EmptyProjectException if project files map is empty', () => {
      expect(() =>
        Snapshot.create({
          projectId,
          version: 1,
          files: new Map(),
        }),
      ).toThrow(EmptyProjectException);
    });

    it('Snapshot: manages file lookups and version labels', () => {
      const files = new Map<string, FileSnapshotVo>();
      files.set('/main.tex', FileSnapshotVo.createDoc('main.tex', 'doc-1', ['Hello'], 'h1', true));
      files.set('/ref.bib', FileSnapshotVo.createDoc('ref.bib', 'doc-2', ['@article{...}'], 'h2', false));

      const snapshot = Snapshot.create({
        projectId,
        version: 1,
        summary: 'Initial revision',
        createdById: userId,
        files,
      });

      expect(snapshot.version).toBe(1);
      expect(snapshot.summary).toBe('Initial revision');
      expect(snapshot.fileCount).toBe(2);
      expect(snapshot.getFile('main.tex')?.docId).toBe('doc-1');
      expect(snapshot.getFile('/nonexistent.tex')).toBeNull();

      const label = VersionLabel.create({
        projectId,
        snapshotId: snapshot.id,
        version: 1,
        label: 'Milestone 1',
      });
      snapshot.addLabel(label);
      expect(snapshot.labels).toHaveLength(1);
      expect(snapshot.labels[0].label).toBe('Milestone 1');

      snapshot.removeLabel(label.id);
      expect(snapshot.labels).toHaveLength(0);

      const filesJson = snapshot.toFilesJson();
      expect(filesJson['/main.tex']).toBeDefined();
      expect(filesJson['/ref.bib']).toBeDefined();
    });
  });

  // =========================================================================
  // 2. Myers Diff Engine Adapter
  // =========================================================================
  describe('2. Myers Diff Engine Adapter', () => {
    it('diffText: detects identical content with 0 additions and 0 deletions', () => {
      const lines = ['line 1', 'line 2', 'line 3'];
      const result = diffEngine.diffText(lines, lines);
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
      expect(result.hunks).toHaveLength(0);
    });

    it('diffText: calculates line additions, deletions, and hunks correctly', () => {
      const oldLines = ['Intro', 'This is paragraph 1.', 'Conclusion'];
      const newLines = ['Intro', 'This is updated paragraph 1.', 'Extra paragraph.', 'Conclusion'];

      const result = diffEngine.diffText(oldLines, newLines);
      expect(result.deletions).toBe(1); // 'This is paragraph 1.'
      expect(result.additions).toBe(2); // 'This is updated paragraph 1.', 'Extra paragraph.'
      expect(result.hunks).toHaveLength(1);

      const hunk = result.hunks[0];
      expect(hunk.lines.some((l) => l.type === 'deleted')).toBe(true);
      expect(hunk.lines.some((l) => l.type === 'added')).toBe(true);
      expect(hunk.lines.some((l) => l.type === 'unchanged')).toBe(true);
    });

    it('diffText: identifies word-level changes on adjacent line changes', () => {
      const oldLines = ['Hello world from Overleaf'];
      const newLines = ['Hello beautiful world from Flux'];

      const result = diffEngine.diffText(oldLines, newLines);
      expect(result.deletions).toBe(1);
      expect(result.additions).toBe(1);

      const hunk = result.hunks[0];
      const delLine = hunk.lines.find((l) => l.type === 'deleted');
      const addLine = hunk.lines.find((l) => l.type === 'added');

      expect(delLine?.words).toBeDefined();
      expect(addLine?.words).toBeDefined();
    });

    it('compareSnapshots: detects added, deleted, modified, and renamed files', () => {
      // Base snapshot
      const baseFiles = new Map<string, FileSnapshotVo>();
      baseFiles.set('/main.tex', FileSnapshotVo.createDoc('main.tex', 'doc-1', ['Line 1', 'Line 2'], 'h-main-v1'));
      baseFiles.set('/deleted.tex', FileSnapshotVo.createDoc('deleted.tex', 'doc-2', ['To be deleted'], 'h-del'));
      baseFiles.set('/old-name.tex', FileSnapshotVo.createDoc('old-name.tex', 'doc-3', ['Renamed content'], 'h-rename'));
      baseFiles.set('/image.png', FileSnapshotVo.createFile('/image.png', 'f-1', 'h-img-1', 100));

      const baseSnapshot = Snapshot.create({
        projectId,
        version: 1,
        files: baseFiles,
      });

      // Target snapshot
      const targetFiles = new Map<string, FileSnapshotVo>();
      targetFiles.set('/main.tex', FileSnapshotVo.createDoc('main.tex', 'doc-1', ['Line 1', 'Line 2 modified'], 'h-main-v2'));
      targetFiles.set('/new-name.tex', FileSnapshotVo.createDoc('new-name.tex', 'doc-3', ['Renamed content'], 'h-rename'));
      targetFiles.set('/added.tex', FileSnapshotVo.createDoc('added.tex', 'doc-4', ['Newly added file'], 'h-added'));
      targetFiles.set('/image.png', FileSnapshotVo.createFile('/image.png', 'f-1', 'h-img-2', 150));

      const targetSnapshot = Snapshot.create({
        projectId,
        version: 2,
        files: targetFiles,
      });

      const fileDiffs = diffEngine.compareSnapshots(baseSnapshot, targetSnapshot);
      expect(fileDiffs.length).toBeGreaterThanOrEqual(4);

      const modifiedDoc = fileDiffs.find((f) => f.path === '/main.tex');
      expect(modifiedDoc).toBeDefined();
      expect(modifiedDoc?.status).toBe('modified');
      expect(modifiedDoc?.additions).toBe(1);
      expect(modifiedDoc?.deletions).toBe(1);

      const deletedDoc = fileDiffs.find((f) => f.path === '/deleted.tex');
      expect(deletedDoc).toBeDefined();
      expect(deletedDoc?.status).toBe('deleted');
      expect(deletedDoc?.deletions).toBe(1);

      const renamedDoc = fileDiffs.find((f) => f.path === '/new-name.tex');
      expect(renamedDoc).toBeDefined();
      expect(renamedDoc?.status).toBe('renamed');
      expect(renamedDoc?.oldPath).toBe('/old-name.tex');

      const addedDoc = fileDiffs.find((f) => f.path === '/added.tex');
      expect(addedDoc).toBeDefined();
      expect(addedDoc?.status).toBe('added');
      expect(addedDoc?.additions).toBe(1);

      const modifiedFile = fileDiffs.find((f) => f.path === '/image.png');
      expect(modifiedFile).toBeDefined();
      expect(modifiedFile?.status).toBe('modified');
      expect(modifiedFile?.type).toBe('file');
    });
  });

  // =========================================================================
  // 3. Inbound Use Cases
  // =========================================================================
  describe('3. Inbound Use Cases', () => {
    beforeEach(() => {
      collector.currentState.set(
        '/main.tex',
        FileSnapshotVo.createDoc('main.tex', 'd-1', ['\\begin{document}', 'Initial', '\\end{document}'], 'h-init', true),
      );
    });

    it('CreateSnapshotUseCase: creates version 1 and version 2 sequentially', () => {
      return (async () => {
        const snap1 = await createSnapshotUseCase.execute({
          projectId,
          summary: 'Version 1',
          createdById: userId,
          label: 'v1.0',
        });

        expect(snap1.version).toBe(1);
        expect(snap1.summary).toBe('Version 1');
        expect(snap1.labels).toHaveLength(1);
        expect(snap1.labels[0].label).toBe('v1.0');

        // Mutate collector state for version 2
        collector.currentState.set(
          '/main.tex',
          FileSnapshotVo.createDoc('main.tex', 'd-1', ['\\begin{document}', 'Updated', '\\end{document}'], 'h-upd', true),
        );

        const snap2 = await createSnapshotUseCase.execute({
          projectId,
          summary: 'Version 2',
          createdById: userId,
        });

        expect(snap2.version).toBe(2);
        expect(snap2.summary).toBe('Version 2');

        const latestVersion = await historyRepo.getLatestVersion(projectId);
        expect(latestVersion).toBe(2);
      })();
    });

    it('CreateSnapshotUseCase: rejects duplicate label name', async () => {
      await createSnapshotUseCase.execute({
        projectId,
        label: 'release-1.0',
      });

      await expect(
        createSnapshotUseCase.execute({
          projectId,
          label: 'release-1.0',
        }),
      ).rejects.toThrow(DuplicateLabelException);
    });

    it('GetVersionListUseCase: returns ordered snapshots', async () => {
      await createSnapshotUseCase.execute({ projectId, summary: 'V1' });
      await createSnapshotUseCase.execute({ projectId, summary: 'V2' });
      await createSnapshotUseCase.execute({ projectId, summary: 'V3' });

      const list = await getVersionListUseCase.execute(projectId);
      expect(list).toHaveLength(3);
      expect(list.map((s) => s.version)).toEqual([1, 2, 3]);
    });

    it('GetSnapshotByVersionUseCase: returns snapshot or throws 404', async () => {
      await createSnapshotUseCase.execute({ projectId, summary: 'V1' });

      const snap = await getSnapshotByVersionUseCase.execute(projectId, 1);
      expect(snap.version).toBe(1);
      expect(snap.getFile('/main.tex')).toBeDefined();

      await expect(getSnapshotByVersionUseCase.execute(projectId, 99)).rejects.toThrow(
        VersionNotFoundException,
      );
    });

    it('CompareVersionsDiffUseCase: compares version 1 and version 2', async () => {
      // V1
      await createSnapshotUseCase.execute({ projectId });

      // V2 (add chapter.tex)
      collector.currentState.set(
        '/chapter.tex',
        FileSnapshotVo.createDoc('chapter.tex', 'd-2', ['Chapter 1 content'], 'h-ch1'),
      );
      await createSnapshotUseCase.execute({ projectId });

      const diffResult = await compareVersionsDiffUseCase.execute(projectId, 1, 2);
      expect(diffResult.baseVersion).toBe(1);
      expect(diffResult.targetVersion).toBe(2);
      expect(diffResult.filesChanged).toBe(1);
      expect(diffResult.files[0].path).toBe('/chapter.tex');
      expect(diffResult.files[0].status).toBe('added');
      expect(diffResult.totalAdditions).toBe(1);
      expect(diffResult.totalDeletions).toBe(0);
    });

    it('LabelVersionUseCase & DeleteLabelUseCase: manages tags and labels', async () => {
      await createSnapshotUseCase.execute({ projectId, summary: 'V1' });
      await createSnapshotUseCase.execute({ projectId, summary: 'V2' });

      // Label V1
      const label = await labelVersionUseCase.execute({
        projectId,
        version: 1,
        label: 'Submitted to IEEE',
        createdById: userId,
      });
      expect(label.label).toBe('Submitted to IEEE');
      expect(label.version).toBe(1);

      // Attempt to label V2 with existing label name on V1 -> DuplicateLabelException
      await expect(
        labelVersionUseCase.execute({
          projectId,
          version: 2,
          label: 'Submitted to IEEE',
        }),
      ).rejects.toThrow(DuplicateLabelException);

      // Attempt to label non-existent version -> VersionNotFoundException
      await expect(
        labelVersionUseCase.execute({
          projectId,
          version: 100,
          label: 'Random',
        }),
      ).rejects.toThrow(VersionNotFoundException);

      // Delete label
      await deleteLabelUseCase.execute(projectId, label.id);
      const retrievedSnap = await getSnapshotByVersionUseCase.execute(projectId, 1);
      expect(retrievedSnap.labels).toHaveLength(0);
    });

    it('RestoreVersionUseCase: non-destructive rollback commits brand-new version N+1', async () => {
      // V1: initial main.tex
      await createSnapshotUseCase.execute({ projectId, summary: 'V1 initial' });

      // V2: modified main.tex + added bad.tex
      collector.currentState.set(
        '/main.tex',
        FileSnapshotVo.createDoc('main.tex', 'd-1', ['Corrupted text'], 'h-bad', true),
      );
      collector.currentState.set(
        '/bad.tex',
        FileSnapshotVo.createDoc('bad.tex', 'd-bad', ['Do not want this'], 'h-bad2'),
      );
      await createSnapshotUseCase.execute({ projectId, summary: 'V2 corrupted' });

      // Restore to V1
      const restoreOutput = await restoreVersionUseCase.execute({
        projectId,
        targetVersion: 1,
        userId,
      });

      expect(restoreOutput.targetSnapshot.version).toBe(1);
      expect(restoreOutput.newSnapshot.version).toBe(3); // Committed as N+1 = 3!
      expect(restoreOutput.newSnapshot.summary).toBe('Restored to version 1');
      expect(restoreOutput.restoreResult.restoredFilesCount).toBe(1);

      // Check current collector state: reverted back to V1
      expect(collector.currentState.size).toBe(1);
      expect(collector.currentState.has('/main.tex')).toBe(true);
      expect(collector.currentState.has('/bad.tex')).toBe(false);
      expect(collector.currentState.get('/main.tex')?.lines).toEqual([
        '\\begin{document}',
        'Initial',
        '\\end{document}',
      ]);

      // Total versions in history should now be 3
      const list = await getVersionListUseCase.execute(projectId);
      expect(list).toHaveLength(3);
      expect(list.map((s) => s.version)).toEqual([1, 2, 3]);
    });
  });

  // =========================================================================
  // 4. ProjectHistoryService & Controller Integration
  // =========================================================================
  describe('4. ProjectHistoryService & Controller Integration', () => {
    beforeEach(() => {
      collector.currentState.set(
        '/main.tex',
        FileSnapshotVo.createDoc('main.tex', 'doc-main', ['\\documentclass{article}'], 'h-main', true),
      );
    });

    it('historyService.createSnapshot & listVersions: maps DTOs properly', async () => {
      const snapDto = await historyService.createSnapshot(
        projectId,
        { summary: 'First commit', isAutomatic: false, label: 'v1.0-alpha' },
        userId,
      );

      expect(snapDto.version).toBe(1);
      expect(snapDto.summary).toBe('First commit');
      expect(snapDto.fileCount).toBe(1);
      expect(snapDto.labels).toHaveLength(1);
      expect(snapDto.labels[0].label).toBe('v1.0-alpha');
      expect(snapDto.files['/main.tex']).toBeDefined();

      const list = await historyService.listVersions(projectId);
      expect(list).toHaveLength(1);
      expect(list[0].version).toBe(1);
    });

    it('historyController.getSnapshot: returns full snapshot or throws 404', async () => {
      await historyService.createSnapshot(projectId, { summary: 'V1' });

      const snap = await historyController.getSnapshot(projectId, 1);
      expect(snap.version).toBe(1);

      await expect(historyController.getSnapshot(projectId, 999)).rejects.toThrow(NotFoundException);
    });

    it('historyController.compareVersions: compares diff via controller query', async () => {
      await historyService.createSnapshot(projectId, { summary: 'V1' });

      collector.currentState.set(
        '/main.tex',
        FileSnapshotVo.createDoc('main.tex', 'doc-main', ['\\documentclass{article}', '% comment'], 'h-main-2', true),
      );
      await historyService.createSnapshot(projectId, { summary: 'V2' });

      const diff = await historyController.compareVersions(projectId, {
        baseVersion: 1,
        targetVersion: 2,
      });

      expect(diff.baseVersion).toBe(1);
      expect(diff.targetVersion).toBe(2);
      expect(diff.filesChanged).toBe(1);
      expect(diff.totalAdditions).toBe(1);
    });

    it('historyController.labelVersion & deleteLabel: handles conflict and delete', async () => {
      await historyService.createSnapshot(projectId, { summary: 'V1' });

      const labelDto = await historyController.labelVersion(projectId, 1, { label: 'Camera Ready' });
      expect(labelDto.label).toBe('Camera Ready');
      expect(labelDto.version).toBe(1);

      // Create snapshot 2
      await historyService.createSnapshot(projectId, { summary: 'V2' });

      // Duplicate label on V2 throws ConflictException (409)
      await expect(
        historyController.labelVersion(projectId, 2, { label: 'Camera Ready' }),
      ).rejects.toThrow(ConflictException);

      // Delete label
      await historyController.deleteLabel(projectId, labelDto.id);
      const snap = await historyController.getSnapshot(projectId, 1);
      expect(snap.labels).toHaveLength(0);
    });

    it('historyController.restoreVersion: rolls back and returns new version', async () => {
      await historyService.createSnapshot(projectId, { summary: 'V1 baseline' });

      collector.currentState.set(
        '/main.tex',
        FileSnapshotVo.createDoc('main.tex', 'doc-main', ['Corrupt line'], 'h-corrupt', true),
      );
      await historyService.createSnapshot(projectId, { summary: 'V2 bad' });

      const result = await historyController.restoreVersion(projectId, { targetVersion: 1 });
      expect(result.restoredSnapshot.version).toBe(1);
      expect(result.newSnapshot.version).toBe(3);
      expect(result.newSnapshot.summary).toBe('Restored to version 1');
      expect(result.restoreResult.restoredFilesCount).toBe(1);
    });

    it('historyController: maps EmptyProjectException to BadRequestException (400)', async () => {
      collector.currentState.clear(); // Empty project

      await expect(
        historyController.createSnapshot(projectId, { summary: 'Empty' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
