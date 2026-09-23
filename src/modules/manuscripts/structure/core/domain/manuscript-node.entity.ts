/**
 * modules/manuscripts/structure/core/domain/manuscript-node.entity.ts
 * Domain Entity representing a file, folder, or document node in the project tree.
 */

import { NodePathVo } from './node-path.vo';

export type ManuscriptNodeType = 'FOLDER' | 'DOC' | 'FILE';

export interface ManuscriptNodeProps {
  id: string;
  projectId: string;
  parentId?: string | null;
  type: ManuscriptNodeType;
  name: string;
  path: string;
  depth: number;
  docId?: string | null;
  fileId?: string | null;
  isRootDoc: boolean;
  sizeBytes: number;
  hash?: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  children?: ManuscriptNodeEntity[];
}

export class ManuscriptNodeEntity {
  private props: ManuscriptNodeProps;

  constructor(props: ManuscriptNodeProps) {
    NodePathVo.validateFilename(props.name);
    this.props = {
      ...props,
      path: NodePathVo.normalize(props.path),
      depth: NodePathVo.depth(props.path),
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

  public isFolder(): boolean {
    return this.props.type === 'FOLDER';
  }

  public isDoc(): boolean {
    return this.props.type === 'DOC';
  }

  public isFile(): boolean {
    return this.props.type === 'FILE';
  }

  public setChildren(children: ManuscriptNodeEntity[]): void {
    this.props.children = children;
  }

  public markAsRootDoc(isRoot: boolean): void {
    this.props.isRootDoc = isRoot;
  }

  public rename(newName: string, newPath: string): void {
    NodePathVo.validateFilename(newName);
    this.props.name = newName;
    this.props.path = NodePathVo.normalize(newPath);
    this.props.depth = NodePathVo.depth(newPath);
  }

  public moveTo(newParentId: string | null, newPath: string): void {
    this.props.parentId = newParentId;
    this.props.path = NodePathVo.normalize(newPath);
    this.props.name = NodePathVo.basename(newPath);
    this.props.depth = NodePathVo.depth(newPath);
  }

  public toJSON(): Record<string, any> {
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
