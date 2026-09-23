/**
 * export-import/core/domain/entities/project-template.entity.ts
 * Domain Entity representing a pre-configured LaTeX project template.
 */

export interface TemplateFileSpec {
  path: string;
  content: string | Buffer;
  isBinary?: boolean;
}

export interface CreateProjectTemplateProps {
  id: string;
  title: string;
  category: 'article' | 'conference' | 'thesis' | 'presentation' | 'report';
  description: string;
  author: string;
  thumbnailUrl?: string | null;
  files: TemplateFileSpec[];
  defaultRootDoc?: string;
}

export class ProjectTemplate {
  public readonly id: string;
  public readonly title: string;
  public readonly category: string;
  public readonly description: string;
  public readonly author: string;
  public readonly thumbnailUrl: string | null;
  public readonly files: TemplateFileSpec[];
  public readonly defaultRootDoc: string;

  constructor(props: CreateProjectTemplateProps) {
    this.id = props.id;
    this.title = props.title;
    this.category = props.category;
    this.description = props.description;
    this.author = props.author;
    this.thumbnailUrl = props.thumbnailUrl ?? null;
    this.files = props.files;
    this.defaultRootDoc = props.defaultRootDoc || 'main.tex';
  }

  public toJSON(): Record<string, any> {
    return {
      id: this.id,
      title: this.title,
      category: this.category,
      description: this.description,
      author: this.author,
      thumbnailUrl: this.thumbnailUrl,
      fileCount: this.files.length,
      defaultRootDoc: this.defaultRootDoc,
    };
  }
}
