export type CompilerType = 'pdflatex' | 'latex' | 'xelatex' | 'lualatex';

export class CompilerTypeVo {
  private static readonly VALID_COMPILERS = new Set<string>([
    'pdflatex',
    'latex',
    'xelatex',
    'lualatex',
  ]);

  static isValid(compiler: string): compiler is CompilerType {
    return this.VALID_COMPILERS.has(compiler.toLowerCase());
  }

  static fromString(compiler?: string): CompilerType {
    if (!compiler) return 'pdflatex';
    const clean = compiler.toLowerCase().trim();
    if (this.isValid(clean)) {
      return clean;
    }
    return 'pdflatex';
  }
}

export type TemplateCategoryString =
  | 'journal'
  | 'book'
  | 'letter'
  | 'assignment'
  | 'poster'
  | 'presentation'
  | 'report'
  | 'cv'
  | 'thesis'
  | 'conference'
  | 'other';

export class TemplateCategoryVo {
  private static readonly VALID_CATEGORIES = new Set<string>([
    'journal',
    'book',
    'letter',
    'assignment',
    'poster',
    'presentation',
    'report',
    'cv',
    'thesis',
    'conference',
    'other',
  ]);

  static isValid(category: string): category is TemplateCategoryString {
    return this.VALID_CATEGORIES.has(category.toLowerCase());
  }

  static fromString(category?: string): TemplateCategoryString {
    if (!category) return 'other';
    const clean = category.toLowerCase().trim();
    if (this.isValid(clean)) {
      return clean;
    }
    return 'other';
  }
}

export interface TemplateFileBlueprint {
  path: string;
  content: string;
  isBinary?: boolean;
}

export interface CreateManuscriptTemplateProps {
  id?: string;
  versionId?: string;
  name: string;
  category?: string;
  description?: string | null;
  compiler?: string;
  imageName?: string | null;
  mainFile?: string;
  thumbnailUrl?: string | null;
  author?: string;
  tags?: string[];
  isOfficial?: boolean;
  downloadCount?: number;
  files?: Record<string, string>;
  createdAt?: Date;
  updatedAt?: Date;
}

export class ManuscriptTemplateEntity {
  private readonly _id: string;
  private readonly _versionId: string;
  private _name: string;
  private _category: TemplateCategoryString;
  private _description: string | null;
  private _compiler: CompilerType;
  private _imageName: string | null;
  private _mainFile: string;
  private _thumbnailUrl: string | null;
  private _author: string;
  private _tags: string[];
  private _isOfficial: boolean;
  private _downloadCount: number;
  private _files: Record<string, string>;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  constructor(props: {
    id: string;
    versionId: string;
    name: string;
    category: TemplateCategoryString;
    description: string | null;
    compiler: CompilerType;
    imageName: string | null;
    mainFile: string;
    thumbnailUrl: string | null;
    author: string;
    tags: string[];
    isOfficial: boolean;
    downloadCount: number;
    files: Record<string, string>;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this._id = props.id;
    this._versionId = props.versionId;
    this._name = props.name;
    this._category = props.category;
    this._description = props.description;
    this._compiler = props.compiler;
    this._imageName = props.imageName;
    this._mainFile = props.mainFile;
    this._thumbnailUrl = props.thumbnailUrl;
    this._author = props.author;
    this._tags = props.tags;
    this._isOfficial = props.isOfficial;
    this._downloadCount = props.downloadCount;
    this._files = props.files;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(
    props: CreateManuscriptTemplateProps,
  ): ManuscriptTemplateEntity {
    const id = props.id || crypto.randomUUID();
    const versionId = props.versionId || `v-${id.slice(0, 8)}`;
    const category = TemplateCategoryVo.fromString(props.category);
    const compiler = CompilerTypeVo.fromString(props.compiler);
    const mainFile = props.mainFile || 'main.tex';
    const files = props.files
      ? { ...props.files }
      : {
          [mainFile]:
            '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
        };

    return new ManuscriptTemplateEntity({
      id,
      versionId,
      name: props.name.trim(),
      category,
      description: props.description ?? null,
      compiler,
      imageName: props.imageName ?? null,
      mainFile,
      thumbnailUrl: props.thumbnailUrl ?? null,
      author: props.author || 'Flux Community',
      tags: props.tags ? [...props.tags] : [],
      isOfficial: props.isOfficial ?? false,
      downloadCount: props.downloadCount ?? 0,
      files,
      createdAt: props.createdAt || new Date(),
      updatedAt: props.updatedAt || new Date(),
    });
  }

  get id(): string {
    return this._id;
  }

  get versionId(): string {
    return this._versionId;
  }

  get name(): string {
    return this._name;
  }

  get category(): TemplateCategoryString {
    return this._category;
  }

  get description(): string | null {
    return this._description;
  }

  get compiler(): CompilerType {
    return this._compiler;
  }

  get imageName(): string | null {
    return this._imageName;
  }

  get mainFile(): string {
    return this._mainFile;
  }

  get thumbnailUrl(): string | null {
    return this._thumbnailUrl;
  }

  get author(): string {
    return this._author;
  }

  get tags(): string[] {
    return [...this._tags];
  }

  get isOfficial(): boolean {
    return this._isOfficial;
  }

  get downloadCount(): number {
    return this._downloadCount;
  }

  get files(): Record<string, string> {
    return { ...this._files };
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  incrementDownloadCount(): void {
    this._downloadCount += 1;
    this._updatedAt = new Date();
  }

  updateDetails(
    props: Partial<{
      name: string;
      description: string | null;
      category: TemplateCategoryString;
      compiler: CompilerType;
      mainFile: string;
      imageName: string | null;
      thumbnailUrl: string | null;
      tags: string[];
      files: Record<string, string>;
    }>,
  ): void {
    if (props.name !== undefined) this._name = props.name.trim();
    if (props.description !== undefined) this._description = props.description;
    if (props.category !== undefined) this._category = props.category;
    if (props.compiler !== undefined) this._compiler = props.compiler;
    if (props.mainFile !== undefined) this._mainFile = props.mainFile;
    if (props.imageName !== undefined) this._imageName = props.imageName;
    if (props.thumbnailUrl !== undefined)
      this._thumbnailUrl = props.thumbnailUrl;
    if (props.tags !== undefined) this._tags = [...props.tags];
    if (props.files !== undefined) this._files = { ...props.files };
    this._updatedAt = new Date();
  }

  toPlainObject() {
    return {
      id: this._id,
      versionId: this._versionId,
      name: this._name,
      title: this._name,
      category: this._category,
      description: this._description,
      compiler: this._compiler,
      imageName: this._imageName,
      mainFile: this._mainFile,
      defaultRootDoc: this._mainFile,
      fileCount: Object.keys(this._files).length,
      thumbnailUrl: this._thumbnailUrl,
      author: this._author,
      tags: this._tags,
      isOfficial: this._isOfficial,
      downloadCount: this._downloadCount,
      files: this._files,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
