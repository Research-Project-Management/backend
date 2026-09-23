/**
 * test/unit/manuscripts-structure.service.spec.ts
 * Comprehensive unit test suite for Manuscripts Structure (Project File Tree & Hierarchy).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { GetFileTreeUseCase } from '@/modules/manuscripts/structure/core/use-cases/get-file-tree.use-case';
import { CreateNodeUseCase } from '@/modules/manuscripts/structure/core/use-cases/create-node.use-case';
import { MoveNodeUseCase } from '@/modules/manuscripts/structure/core/use-cases/move-node.use-case';
import { RenameNodeUseCase } from '@/modules/manuscripts/structure/core/use-cases/rename-node.use-case';
import { DeleteNodeUseCase } from '@/modules/manuscripts/structure/core/use-cases/delete-node.use-case';
import { ResolveRootDocUseCase } from '@/modules/manuscripts/structure/core/use-cases/resolve-root-doc.use-case';
import { BuildCompilerFilesUseCase } from '@/modules/manuscripts/structure/core/use-cases/build-compiler-files.use-case';
import { IStructureRepository, CreateNodeParams } from '@/modules/manuscripts/structure/core/ports/structure-repository.port';
import { IRootDocDetector } from '@/modules/manuscripts/structure/core/ports/root-doc-detector.port';
import { ITreePublisher } from '@/modules/manuscripts/structure/core/ports/tree-publisher.port';
import { HeuristicRootDocDetector } from '@/modules/manuscripts/structure/core/adapters/engine/heuristic-root-doc.detector';
import { InMemoryTreePublisher } from '@/modules/manuscripts/structure/core/adapters/event/in-memory-tree.publisher';
import { ManuscriptNodeEntity } from '@/modules/manuscripts/structure/core/domain/manuscript-node.entity';
import { NodePathVo } from '@/modules/manuscripts/structure/core/domain/node-path.vo';
import {
  CyclicMoveError,
  DuplicateNodePathError,
  InvalidNodeNameError,
  NodeNotFoundError,
  RootDocNotFoundError,
} from '@/modules/manuscripts/structure/core/domain/structure-errors';

/**
 * In-Memory Test Double for IStructureRepository
 */
class InMemoryStructureRepository implements IStructureRepository {
  public nodes = new Map<string, ManuscriptNodeEntity>();

  public clear() {
    this.nodes.clear();
  }

  public async createNode(params: CreateNodeParams): Promise<ManuscriptNodeEntity> {
    const id = `node-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const depth = NodePathVo.depth(params.path);

    const entity = new ManuscriptNodeEntity({
      id,
      projectId: params.projectId,
      parentId: params.parentId || null,
      type: params.type,
      name: params.name,
      path: params.path,
      depth,
      docId: params.docId || null,
      fileId: params.fileId || null,
      isRootDoc: params.isRootDoc || false,
      sizeBytes: params.sizeBytes || 0,
      hash: params.hash || null,
      sortOrder: params.sortOrder || 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    this.nodes.set(entity.id, entity);
    return entity;
  }

  public async findById(projectId: string, nodeId: string): Promise<ManuscriptNodeEntity | null> {
    const node = this.nodes.get(nodeId);
    return node && node.projectId === projectId ? node : null;
  }

  public async findByPath(projectId: string, path: string): Promise<ManuscriptNodeEntity | null> {
    const normalized = NodePathVo.normalize(path);
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId && node.path === normalized) {
        return node;
      }
    }
    return null;
  }

  public async getAllNodes(projectId: string): Promise<ManuscriptNodeEntity[]> {
    return Array.from(this.nodes.values())
      .filter((n) => n.projectId === projectId)
      .sort((a, b) => a.depth - b.depth);
  }

  public async getRootDoc(projectId: string): Promise<ManuscriptNodeEntity | null> {
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId && node.isRootDoc) {
        return node;
      }
    }
    return null;
  }

  public async setRootDoc(projectId: string, nodeId: string): Promise<void> {
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId) {
        node.markAsRootDoc(node.id === nodeId);
      }
    }
  }

  public async unsetRootDoc(projectId: string): Promise<void> {
    for (const node of this.nodes.values()) {
      if (node.projectId === projectId) {
        node.markAsRootDoc(false);
      }
    }
  }

  public async moveSubtree(
    projectId: string,
    sourcePath: string,
    destPath: string,
    newParentId: string | null
  ): Promise<void> {
    const normSource = NodePathVo.normalize(sourcePath);
    const normDest = NodePathVo.normalize(destPath);
    const sourcePrefix = normSource + '/';

    for (const node of this.nodes.values()) {
      if (node.projectId !== projectId) continue;

      if (node.path === normSource) {
        node.moveTo(newParentId, normDest);
      } else if (node.path.startsWith(sourcePrefix)) {
        const relative = node.path.substring(normSource.length);
        const newChildPath = normDest + relative;
        node.moveTo(node.parentId, newChildPath);
      }
    }
  }

  public async renameNode(
    projectId: string,
    nodeId: string,
    newName: string,
    newPath: string
  ): Promise<ManuscriptNodeEntity> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new NodeNotFoundError(nodeId);
    node.rename(newName, newPath);
    return node;
  }

  public async deleteSubtree(projectId: string, path: string): Promise<ManuscriptNodeEntity[]> {
    const normalized = NodePathVo.normalize(path);
    const prefix = normalized + '/';
    const deleted: ManuscriptNodeEntity[] = [];

    for (const [id, node] of this.nodes.entries()) {
      if (node.projectId === projectId) {
        if (node.path === normalized || node.path.startsWith(prefix)) {
          deleted.push(node);
          this.nodes.delete(id);
        }
      }
    }

    return deleted;
  }

  public async updateSortOrder(
    projectId: string,
    nodeId: string,
    sortOrder: number
  ): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node && node.projectId === projectId) {
      (node as any).props.sortOrder = sortOrder;
    }
  }
}

describe('Manuscripts - Structure Subsystem (Overleaf Parity & Materialized Path)', () => {
  let service: StructureService;
  let repository: InMemoryStructureRepository;
  let detector: HeuristicRootDocDetector;
  const PROJECT_ID = '00000000-0000-7000-8000-000000000001';

  beforeEach(async () => {
    repository = new InMemoryStructureRepository();
    detector = new HeuristicRootDocDetector();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StructureService,
        GetFileTreeUseCase,
        CreateNodeUseCase,
        MoveNodeUseCase,
        RenameNodeUseCase,
        DeleteNodeUseCase,
        ResolveRootDocUseCase,
        BuildCompilerFilesUseCase,
        {
          provide: IStructureRepository,
          useValue: repository,
        },
        {
          provide: IRootDocDetector,
          useValue: detector,
        },
        {
          provide: ITreePublisher,
          useClass: InMemoryTreePublisher,
        },
      ],
    }).compile();

    service = module.get<StructureService>(StructureService);
  });

  // =========================================================================
  // 1. PATH VALUE OBJECT TESTS
  // =========================================================================
  describe('NodePathVo (Virtual Path Operations)', () => {
    it('should normalize paths properly', () => {
      expect(NodePathVo.normalize('chapters\\intro.tex')).toBe('/chapters/intro.tex');
      expect(NodePathVo.normalize('//chapters///sec1/')).toBe('/chapters/sec1');
      expect(NodePathVo.normalize('/')).toBe('/');
      expect(NodePathVo.normalize('')).toBe('/');
    });

    it('should extract dirname and basename', () => {
      expect(NodePathVo.dirname('/chapters/intro.tex')).toBe('/chapters');
      expect(NodePathVo.basename('/chapters/intro.tex')).toBe('intro.tex');
      expect(NodePathVo.dirname('/main.tex')).toBe('/');
      expect(NodePathVo.basename('/main.tex')).toBe('main.tex');
      expect(NodePathVo.depth('/chapters/sub/file.tex')).toBe(3);
    });

    it('should correctly detect descendant relationships', () => {
      expect(NodePathVo.isDescendant('/chapters', '/chapters/intro.tex')).toBe(true);
      expect(NodePathVo.isDescendant('/chapters', '/chapters/sub/doc.tex')).toBe(true);
      expect(NodePathVo.isDescendant('/chapters', '/main.tex')).toBe(false);
      expect(NodePathVo.isDescendant('/chapters', '/chapters')).toBe(false);
    });

    it('should validate filenames and reject invalid characters', () => {
      expect(() => NodePathVo.validateFilename('')).toThrow(InvalidNodeNameError);
      expect(() => NodePathVo.validateFilename('bad/name')).toThrow(InvalidNodeNameError);
      expect(() => NodePathVo.validateFilename('bad\0name')).toThrow(InvalidNodeNameError);
      expect(() => NodePathVo.validateFilename('..')).toThrow(InvalidNodeNameError);
      expect(() => NodePathVo.validateFilename('valid-name.tex')).not.toThrow();
    });
  });

  // =========================================================================
  // 2. CREATION & AUTO-MKDIRP TESTS
  // =========================================================================
  describe('CreateNodeUseCase & Auto-mkdirp', () => {
    it('should create root document node', async () => {
      const node = await service.createNode(PROJECT_ID, {
        name: 'main.tex',
        path: '/main.tex',
        type: 'DOC',
        isRootDoc: true,
      });

      expect(node.id).toBeDefined();
      expect(node.name).toBe('main.tex');
      expect(node.path).toBe('/main.tex');
      expect(node.depth).toBe(1);
      expect(node.isRootDoc).toBe(true);
    });

    it('should automatically create missing intermediate folders via mkdirp', async () => {
      const node = await service.createNode(PROJECT_ID, {
        name: 'chart.png',
        path: '/assets/images/figures/chart.png',
        type: 'FILE',
      });

      expect(node.name).toBe('chart.png');
      expect(node.path).toBe('/assets/images/figures/chart.png');

      // Verify intermediate folders were automatically created
      const assetsFolder = await service.getNodeByPath(PROJECT_ID, '/assets');
      const imagesFolder = await service.getNodeByPath(PROJECT_ID, '/assets/images');
      const figuresFolder = await service.getNodeByPath(PROJECT_ID, '/assets/images/figures');

      expect(assetsFolder).toBeDefined();
      expect(assetsFolder?.isFolder()).toBe(true);
      expect(imagesFolder).toBeDefined();
      expect(figuresFolder).toBeDefined();
      expect(node.parentId).toBe(figuresFolder?.id);
    });

    it('should reject duplicate path creation', async () => {
      await service.createNode(PROJECT_ID, {
        name: 'intro.tex',
        path: '/intro.tex',
        type: 'DOC',
      });

      await expect(
        service.createNode(PROJECT_ID, {
          name: 'intro.tex',
          path: '/intro.tex',
          type: 'DOC',
        })
      ).rejects.toThrow(DuplicateNodePathError);
    });
  });

  // =========================================================================
  // 3. HIERARCHICAL TREE RETRIEVAL
  // =========================================================================
  describe('GetFileTreeUseCase (Hierarchical Structure)', () => {
    it('should return nested tree sorted with folders first and main.tex top', async () => {
      // Create root folders & files
      await service.createNode(PROJECT_ID, { name: 'chapters', type: 'FOLDER', path: '/chapters' });
      await service.createNode(PROJECT_ID, { name: 'appendix.tex', type: 'DOC', path: '/appendix.tex' });
      await service.createNode(PROJECT_ID, { name: 'main.tex', type: 'DOC', path: '/main.tex', isRootDoc: true });
      await service.createNode(PROJECT_ID, { name: 'c1.tex', type: 'DOC', path: '/chapters/c1.tex' });
      await service.createNode(PROJECT_ID, { name: 'c2.tex', type: 'DOC', path: '/chapters/c2.tex' });

      const tree = await service.getFileTree(PROJECT_ID);

      // Root level: 'chapters' folder first, then 'main.tex' (isRootDoc), then 'appendix.tex'
      expect(tree.length).toBe(3);
      expect(tree[0].name).toBe('chapters');
      expect(tree[0].type).toBe('FOLDER');
      expect(tree[0].children.length).toBe(2);
      expect(tree[0].children[0].name).toBe('c1.tex');
      expect(tree[0].children[1].name).toBe('c2.tex');

      expect(tree[1].name).toBe('main.tex');
      expect(tree[1].isRootDoc).toBe(true);

      expect(tree[2].name).toBe('appendix.tex');
    });
  });

  // =========================================================================
  // 4. MOVE SUBTREE & CYCLE DETECTION
  // =========================================================================
  describe('MoveNodeUseCase (Subtree & Cycle Protection)', () => {
    it('should move folder and cascade path updates to all child files', async () => {
      const srcFolder = await service.createNode(PROJECT_ID, { name: 'src', type: 'FOLDER', path: '/src' });
      await service.createNode(PROJECT_ID, { name: 'a.tex', type: 'DOC', path: '/src/a.tex' });
      await service.createNode(PROJECT_ID, { name: 'b.tex', type: 'DOC', path: '/src/b.tex' });

      const destFolder = await service.createNode(PROJECT_ID, { name: 'archive', type: 'FOLDER', path: '/archive' });

      // Move /src into /archive
      await service.moveNode(PROJECT_ID, srcFolder.id, { destParentId: destFolder.id });

      const movedFolder = await service.getNodeById(PROJECT_ID, srcFolder.id);
      expect(movedFolder?.path).toBe('/archive/src');

      const childA = await service.getNodeByPath(PROJECT_ID, '/archive/src/a.tex');
      const childB = await service.getNodeByPath(PROJECT_ID, '/archive/src/b.tex');
      expect(childA).toBeDefined();
      expect(childB).toBeDefined();

      // Old paths should no longer exist
      const oldChildA = await service.getNodeByPath(PROJECT_ID, '/src/a.tex');
      expect(oldChildA).toBeNull();
    });

    it('should prevent cyclic moves (moving parent into its own descendant)', async () => {
      const parent = await service.createNode(PROJECT_ID, { name: 'parent', type: 'FOLDER', path: '/parent' });
      const child = await service.createNode(PROJECT_ID, { name: 'child', type: 'FOLDER', path: '/parent/child' });

      await expect(
        service.moveNode(PROJECT_ID, parent.id, { destParentId: child.id })
      ).rejects.toThrow(CyclicMoveError);
    });
  });

  // =========================================================================
  // 5. RENAME NODE & CASCADING PATH UPDATES
  // =========================================================================
  describe('RenameNodeUseCase', () => {
    it('should rename file and update path', async () => {
      const node = await service.createNode(PROJECT_ID, { name: 'draft.tex', type: 'DOC', path: '/draft.tex' });
      const renamed = await service.renameNode(PROJECT_ID, node.id, { name: 'final.tex' });

      expect(renamed.name).toBe('final.tex');
      expect(renamed.path).toBe('/final.tex');
    });

    it('should rename folder and cascade updated prefix to children', async () => {
      const folder = await service.createNode(PROJECT_ID, { name: 'docs', type: 'FOLDER', path: '/docs' });
      await service.createNode(PROJECT_ID, { name: 'intro.tex', type: 'DOC', path: '/docs/intro.tex' });

      await service.renameNode(PROJECT_ID, folder.id, { name: 'manuscripts' });

      const renamedFolder = await service.getNodeById(PROJECT_ID, folder.id);
      expect(renamedFolder?.path).toBe('/manuscripts');

      const child = await service.getNodeByPath(PROJECT_ID, '/manuscripts/intro.tex');
      expect(child).toBeDefined();
      expect(child?.name).toBe('intro.tex');
    });
  });

  // =========================================================================
  // 6. DELETE SUBTREE & ROOTDOC RESET
  // =========================================================================
  describe('DeleteNodeUseCase', () => {
    it('should delete folder and all child nodes, resetting rootDoc if deleted', async () => {
      const folder = await service.createNode(PROJECT_ID, { name: 'tex', type: 'FOLDER', path: '/tex' });
      const mainDoc = await service.createNode(PROJECT_ID, {
        name: 'main.tex',
        type: 'DOC',
        path: '/tex/main.tex',
        isRootDoc: true,
      });

      expect((await service.getRootDoc(PROJECT_ID))?.id).toBe(mainDoc.id);

      const deleted = await service.deleteNode(PROJECT_ID, folder.id);
      expect(deleted.length).toBe(2);

      expect(await service.getNodeByPath(PROJECT_ID, '/tex')).toBeNull();
      expect(await service.getNodeByPath(PROJECT_ID, '/tex/main.tex')).toBeNull();

      // rootDoc was deleted, should now be null
      const currentRoot = await service.getRootDoc(PROJECT_ID);
      expect(currentRoot).toBeNull();
    });
  });

  // =========================================================================
  // 7. HEURISTIC ROOTDOC RESOLUTION (OVERLEAF _rootDocSort)
  // =========================================================================
  describe('HeuristicRootDocDetector & Entrypoint Resolution', () => {
    it('should prioritize main.tex with \\documentclass over subfiles and larger files', async () => {
      const doc1 = await service.createNode(PROJECT_ID, {
        name: 'chapter1.tex',
        type: 'DOC',
        path: '/chapter1.tex',
      });
      const mainDoc = await service.createNode(PROJECT_ID, {
        name: 'main.tex',
        type: 'DOC',
        path: '/main.tex',
      });

      const docContents = new Map<string, string[]>();
      docContents.set(doc1.id, ['\\section{Chapter 1}', 'Detailed content line 1', 'Detailed content line 2']);
      docContents.set(mainDoc.id, ['\\documentclass{article}', '\\begin{document}', '\\input{chapter1}', '\\end{document}']);

      const detected = await service.autoDetectRootDoc(PROJECT_ID, docContents);
      expect(detected).toBeDefined();
      expect(detected?.id).toBe(mainDoc.id);
      expect(detected?.name).toBe('main.tex');
    });

    it('should prioritize shallower depth files when filenames are non-canonical', async () => {
      repository.clear();
      const deepDoc = await service.createNode(PROJECT_ID, {
        name: 'paper.tex',
        type: 'DOC',
        path: '/nested/deep/paper.tex',
      });
      const rootDocCandidate = await service.createNode(PROJECT_ID, {
        name: 'paper.tex',
        type: 'DOC',
        path: '/paper.tex',
      });

      const docContents = new Map<string, string[]>();
      docContents.set(deepDoc.id, ['\\documentclass{book}', 'Deep text']);
      docContents.set(rootDocCandidate.id, ['\\documentclass{article}', 'Root text']);

      const detected = await service.autoDetectRootDoc(PROJECT_ID, docContents);
      expect(detected?.id).toBe(rootDocCandidate.id);
      expect(detected?.path).toBe('/paper.tex');
    });
  });

  // =========================================================================
  // 8. DIRECT CLSI COMPILER PAYLOAD GENERATION
  // =========================================================================
  describe('BuildCompilerFilesUseCase (CLSI Direct Integration)', () => {
    it('should generate WorkspaceFile[] with relative paths and resolved rootDocPath', async () => {
      await service.createNode(PROJECT_ID, {
        name: 'main.tex',
        type: 'DOC',
        path: '/main.tex',
        isRootDoc: true,
      });
      await service.createNode(PROJECT_ID, {
        name: 'intro.tex',
        type: 'DOC',
        path: '/chapters/intro.tex',
      });
      await service.createNode(PROJECT_ID, {
        name: 'figure.pdf',
        type: 'FILE',
        path: '/images/figure.pdf',
      });

      const contentsMap = new Map<string, { lines: string[]; hash?: string | null }>();
      const allNodes = await service.getAllNodes(PROJECT_ID);
      const mainNode = allNodes.find((n) => n.name === 'main.tex')!;
      const introNode = allNodes.find((n) => n.name === 'intro.tex')!;

      contentsMap.set(mainNode.id, { lines: ['\\documentclass{article}', '\\input{chapters/intro}'], hash: 'hash-main' });
      contentsMap.set(introNode.id, { lines: ['\\section{Intro}', 'Content here.'], hash: 'hash-intro' });

      const payload = await service.buildCompilerPayload(PROJECT_ID, contentsMap);

      expect(payload.rootDocPath).toBe('main.tex');
      expect(payload.files.length).toBe(3);

      const paths = payload.files.map((f) => f.path);
      expect(paths).toContain('main.tex');
      expect(paths).toContain('chapters/intro.tex');
      expect(paths).toContain('images/figure.pdf');

      const mainFile = payload.files.find((f) => f.path === 'main.tex');
      expect(mainFile?.content).toContain('\\documentclass{article}');
      expect(mainFile?.hash).toBe('hash-main');
    });
  });
});
