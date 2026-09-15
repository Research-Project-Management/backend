import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { OutlineItem } from './dto/outline.dto';

interface SectionPattern {
  regex: RegExp;
  level: number;
  levelName: string;
}

const LATEX_PATTERNS: SectionPattern[] = [
  { regex: /^\\part\*?(?:\[[^\]]*\])?\{(.+?)\}/, level: 0, levelName: 'Part' },
  {
    regex: /^\\chapter\*?(?:\[[^\]]*\])?\{(.+?)\}/,
    level: 0,
    levelName: 'Chapter',
  },
  {
    regex: /^\\section\*?(?:\[[^\]]*\])?\{(.+?)\}/,
    level: 1,
    levelName: 'Section',
  },
  {
    regex: /^\\subsection\*?(?:\[[^\]]*\])?\{(.+?)\}/,
    level: 2,
    levelName: 'Subsection',
  },
  {
    regex: /^\\subsubsection\*?(?:\[[^\]]*\])?\{(.+?)\}/,
    level: 3,
    levelName: 'Subsubsection',
  },
  {
    regex: /^\\paragraph\*?(?:\[[^\]]*\])?\{(.+?)\}/,
    level: 4,
    levelName: 'Paragraph',
  },
];

const MARKDOWN_PATTERNS: SectionPattern[] = [
  { regex: /^#\s+(.+)$/, level: 0, levelName: 'H1' },
  { regex: /^##\s+(.+)$/, level: 1, levelName: 'H2' },
  { regex: /^###\s+(.+)$/, level: 2, levelName: 'H3' },
  { regex: /^####\s+(.+)$/, level: 3, levelName: 'H4' },
  { regex: /^#####\s+(.+)$/, level: 4, levelName: 'H5' },
];

@Injectable()
export class OutlineService {
  private readonly logger = new Logger(OutlineService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse headings and sections from raw text string (LaTeX or Markdown).
   */
  parseOutlineFromSource(
    source: string,
    filename: string = 'main.tex',
    pageId?: string,
  ): OutlineItem[] {
    if (!source) return [];

    const lines = source.split('\n');
    const entries: OutlineItem[] = [];
    let counter = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart();
      if (!line || line.startsWith('%')) continue;

      let matched = false;

      // Try LaTeX patterns first
      for (const { regex, level, levelName } of LATEX_PATTERNS) {
        const match = line.match(regex);
        if (match) {
          entries.push({
            id: `${pageId || 'doc'}-heading-${counter++}`,
            level,
            levelName,
            title: match[1].trim(),
            line: i + 1,
            file: filename,
            pageId,
          });
          matched = true;
          break;
        }
      }

      if (matched) continue;

      // Fallback: Markdown patterns
      for (const { regex, level, levelName } of MARKDOWN_PATTERNS) {
        const match = line.match(regex);
        if (match) {
          entries.push({
            id: `${pageId || 'doc'}-heading-${counter++}`,
            level,
            levelName,
            title: match[1].trim(),
            line: i + 1,
            file: filename,
            pageId,
          });
          break;
        }
      }
    }

    return entries;
  }

  /**
   * Constructs a nested hierarchical tree (levels 0 -> 1 -> 2 -> ...) from flat entries.
   */
  buildNestedOutlineTree(entries: OutlineItem[]): OutlineItem[] {
    const rootNodes: OutlineItem[] = [];
    const stack: OutlineItem[] = [];

    for (const item of entries) {
      const node: OutlineItem = { ...item, children: [] };

      while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
        stack.pop();
      }

      if (stack.length === 0) {
        rootNodes.push(node);
      } else {
        const parent = stack[stack.length - 1];
        parent.children = parent.children || [];
        parent.children.push(node);
      }

      stack.push(node);
    }

    return rootNodes;
  }

  /**
   * Extracts outline across the whole document (including child sections/files).
   */
  async getDocumentOutline(pageId: string) {
    const rootPage = await this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      include: {
        childPages: {
          where: { deletedAt: null },
          orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!rootPage) {
      throw new NotFoundException(`Document page ${pageId} not found`);
    }

    const rawRoot = rootPage.content;
    const rootStr =
      typeof rawRoot === 'string'
        ? rawRoot
        : rawRoot && typeof rawRoot === 'object'
          ? (rawRoot as any).source || (rawRoot as any).text || ''
          : '';

    const rootFilename = rootPage.title.endsWith('.tex')
      ? rootPage.title
      : 'main.tex';
    const allEntries: OutlineItem[] = this.parseOutlineFromSource(
      rootStr,
      rootFilename,
      rootPage.id,
    );

    // Process child section pages
    if (rootPage.childPages && rootPage.childPages.length > 0) {
      for (const child of rootPage.childPages) {
        const childRaw = child.content;
        const childStr =
          typeof childRaw === 'string'
            ? childRaw
            : childRaw && typeof childRaw === 'object'
              ? (childRaw as any).source || (childRaw as any).text || ''
              : '';

        const childFilename = child.title.endsWith('.tex')
          ? child.title
          : `${child.title}.tex`;
        const childEntries = this.parseOutlineFromSource(
          childStr,
          childFilename,
          child.id,
        );
        allEntries.push(...childEntries);
      }
    }

    const tree = this.buildNestedOutlineTree(allEntries);

    return {
      entries: allEntries,
      tree,
      totalHeadings: allEntries.length,
      documentId: pageId,
      documentTitle: rootPage.title,
    };
  }
}
