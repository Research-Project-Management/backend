/**
 * modules/manuscripts/structure/core/domain/manuscript-node.entity.ts
 * Domain Entity representing a file, folder, or document node in the project tree.
 */

import { NodePathVo } from './node-path.vo';
import {
  CannotDeleteRootFolderError,
  CyclicMoveError,
  StructureError,
} from './structure-errors';

export type ManuscriptNodeType = 'FOLDER' | 'DOC' | 'FILE';

export interface SerializedTreeNode {
  id: string;
  name: string;
  path: string;
  type: ManuscriptNodeType;
  depth: number;
  isRootDoc: boolean;
  docId?: string | null;
  fileId?: string | null;
  sizeBytes: number;
  hash?: string | null;
  sortOrder: number;
  children: SerializedTreeNode[];
}

export interface ManuscriptNodeProps {
  id: string;
  projectId: string;
  parentId?: string | null;
  type: ManuscriptNodeType;
  name: string;
  path: string;
  depth?: number;
  docId?: string | null;
  fileId?: string | null;
  isRootDoc?: boolean;
  sizeBytes?: number;
  hash?: string | null;
  sortOrder?: number;
  createdAt?: Date;
  updatedAt?: Date;
  children?: ManuscriptNodeEntity[];
}

export class ManuscriptNodeEntity {
  private props: Required<
    Pick<
      ManuscriptNodeProps,
      | 'id'
      | 'projectId'
      | 'type'
      | 'name'
      | 'path'
      | 'depth'
      | 'isRootDoc'
      | 'sizeBytes'
      | 'sortOrder'
      | 'createdAt'
      | 'updatedAt'
    >
  > &
    ManuscriptNodeProps;

  constructor(props: ManuscriptNodeProps) {
    NodePathVo.validateFilename(props.name);
    this.props = {
      ...props,
      path: NodePathVo.normalize(props.path),
      depth: NodePathVo.depth(props.path),
      isRootDoc: props.isRootDoc ?? false,
      sizeBytes: props.sizeBytes ?? 0,
      sortOrder: props.sortOrder ?? 0,
      createdAt: props.createdAt ?? new Date(),
      updatedAt: props.updatedAt ?? new Date(),
    };
  }

  public get id(): string {
    return this.props.id;
  }

  public get projectId(): string {
    return this.props.projectId;
  }

  public get parentId(): string | null {
    return this.props.parentId ?? null;
  }

  public get type(): ManuscriptNodeType {
    return this.props.type;
  }

  public get name(): string {
    return this.props.name;
  }

  public get path(): string {
    return this.props.path;
  }

  public get depth(): number {
    return this.props.depth;
  }

  public get docId(): string | null {
    return this.props.docId ?? null;
  }

  public get fileId(): string | null {
    return this.props.fileId ?? null;
  }

  public get isRootDoc(): boolean {
    return this.props.isRootDoc;
  }

  public get sizeBytes(): number {
    return this.props.sizeBytes;
  }

  public get hash(): string | null {
    return this.props.hash ?? null;
  }

  public get sortOrder(): number {
    return this.props.sortOrder;
  }

  public get createdAt(): Date {
    return this.props.createdAt;
  }

  public get updatedAt(): Date {
    return this.props.updatedAt;
  }

  public get children(): ManuscriptNodeEntity[] {
    return this.props.children || [];
  }

  public static readonly VALID_ROOT_EXTENSIONS = [
    '.tex',
    '.rtex',
    '.rnw',
  ] as const;

  public isFolder(): boolean {
    return this.props.type === 'FOLDER';
  }

  public isDoc(): boolean {
    return this.props.type === 'DOC';
  }

  public isFile(): boolean {
    return this.props.type === 'FILE';
  }

  public isRootFolder(): boolean {
    return this.props.path === '/';
  }

  public canContainChildren(): boolean {
    return this.isFolder();
  }

  public assertCanContainChildren(role = 'Parent node'): void {
    if (!this.canContainChildren()) {
      throw new StructureError(`${role} must be a FOLDER`);
    }
  }

  public assertMutableTarget(): void {
    if (this.isRootFolder()) {
      throw new CannotDeleteRootFolderError();
    }
  }

  public canBeRootDoc(): boolean {
    if (!this.isDoc()) return false;
    const lowerName = this.props.name.toLowerCase();
    return ManuscriptNodeEntity.VALID_ROOT_EXTENSIONS.some((ext) =>
      lowerName.endsWith(ext),
    );
  }

  public assertCanBeRootDoc(): void {
    if (!this.isDoc() && !this.props.name.toLowerCase().endsWith('.tex')) {
      throw new StructureError(
        `Cannot set node of type ${this.type} as root document. Must be a LaTeX document (.tex).`,
      );
    }
  }

  public setChildren(children: ManuscriptNodeEntity[]): void {
    this.props.children = children;
  }

  public markAsRootDoc(isRoot: boolean): void {
    this.props.isRootDoc = isRoot;
  }

  public renameTo(newName: string): {
    oldPath: string;
    newPath: string;
    newName: string;
    depth: number;
  } {
    this.assertMutableTarget();
    NodePathVo.validateFilename(newName);
    const oldPath = this.props.path;
    const parentPath = NodePathVo.dirname(oldPath);
    const newPath = NodePathVo.join(parentPath, newName);
    this.props.name = newName;
    this.props.path = newPath;
    this.props.depth = NodePathVo.depth(newPath);
    return { oldPath, newPath, newName, depth: this.props.depth };
  }

  public rename(newName: string, newPath: string): void {
    NodePathVo.validateFilename(newName);
    this.props.name = newName;
    this.props.path = NodePathVo.normalize(newPath);
    this.props.depth = NodePathVo.depth(newPath);
  }

  public validateMoveTo(destPath: string): string {
    this.assertMutableTarget();
    const normDest = NodePathVo.normalize(destPath);
    if (
      this.isFolder() &&
      (normDest === this.props.path ||
        NodePathVo.isDescendant(this.props.path, normDest))
    ) {
      throw new CyclicMoveError(this.props.path, normDest);
    }
    return normDest;
  }

  public moveTo(newParentId: string | null, newPath: string): void {
    const normDest = this.validateMoveTo(newPath);
    this.props.parentId = newParentId;
    this.props.path = normDest;
    this.props.name = NodePathVo.basename(normDest);
    this.props.depth = NodePathVo.depth(normDest);
  }

  public toTreeNode(children: SerializedTreeNode[] = []): SerializedTreeNode {
    return {
      id: this.id,
      name: this.name,
      path: this.path,
      type: this.type,
      depth: this.depth,
      isRootDoc: this.isRootDoc,
      docId: this.docId,
      fileId: this.fileId,
      sizeBytes: this.sizeBytes,
      hash: this.hash,
      sortOrder: this.sortOrder,
      children,
    };
  }

  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      projectId: this.projectId,
      parentId: this.parentId,
      type: this.type,
      name: this.name,
      path: this.path,
      depth: this.depth,
      docId: this.docId,
      fileId: this.fileId,
      isRootDoc: this.isRootDoc,
      sizeBytes: this.sizeBytes,
      hash: this.hash,
      sortOrder: this.sortOrder,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      children: this.children.map((c) => c.toJSON()),
    };
  }
}
