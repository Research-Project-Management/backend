/**
 * modules/manuscripts/docstore/services/bootstrap.service.ts
 * Domain/Application service encapsulating project page bootstrap, Overleaf-compatible
 * blank and example LaTeX templates, and companion references.bib initialization.
 */

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { escapeLatex } from '@/modules/manuscripts/core';
import { DocstoreService } from '../docstore.service';
import { resolveProjectLabels } from '../controllers/doc.helpers';

export interface CreateProjectPageParams {
  title?: string;
  content?: string;
  status?: string;
  labels?: string[];
  labelIds?: string[];
  templateType?: string;
}

@Injectable()
export class ManuscriptProjectBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docstoreService: DocstoreService,
  ) {}

  private async resolveProjectAndAuthorMetadata(
    projectId: string,
    title: string,
    userId: string | null,
  ): Promise<{ docTitle: string; authorName: string; dateStr: string }> {
    let projectName = '';
    let authorName = '';
    try {
      const [project, user] = await Promise.all([
        this.prisma.project.findUnique({
          where: { id: projectId },
          select: { name: true },
        }),
        userId && isUuid(userId)
          ? this.prisma.user.findUnique({
              where: { id: userId },
              select: {
                email: true,
                profile: { select: { name: true } },
              },
            })
          : Promise.resolve(null),
      ]);
      projectName = project?.name ?? '';
      authorName = user?.profile?.name || user?.email?.split('@')[0] || '';
    } catch {
      // Metadata is cosmetic; never block page creation
    }

    const fileBase = title.replace(/^\//, '').replace(/\.tex$/i, '');
    const docTitle =
      fileBase && fileBase !== 'main' ? fileBase : projectName || 'Untitled';
    const now = new Date();
    const month = now.toLocaleString('en-US', { month: 'long' });

    return {
      docTitle: escapeLatex(docTitle),
      authorName: escapeLatex(authorName),
      dateStr: `${month} ${now.getFullYear()}`,
    };
  }

  /**
   * Builds the default main document exactly like Overleaf's "Blank Project"
   * (services/web/app/templates/project_files/mainbasic.tex):
   *   \title{<project_name>} \author{<first> <last>} \date{<Month> <Year>}
   */
  public async buildBlankProjectTemplate(
    projectId: string,
    title: string,
    userId: string | null,
  ): Promise<string> {
    const { docTitle, authorName, dateStr } =
      await this.resolveProjectAndAuthorMetadata(projectId, title, userId);

    return [
      '\\documentclass{article}',
      '\\usepackage{graphicx} % Required for inserting images',
      '',
      `\\title{${docTitle}}`,
      `\\author{${authorName}}`,
      `\\date{${dateStr}}`,
      '',
      '\\begin{document}',
      '',
      '\\maketitle',
      '',
      '\\section{Introduction}',
      '',
      '\\end{document}',
      '',
    ].join('\n');
  }

  /**
   * Builds the comprehensive document matching Overleaf's "Example Project"
   * containing sections, math equations, tables, figures, and bibliographic citations.
   */
  public async buildExampleProjectTemplate(
    projectId: string,
    title: string,
    userId: string | null,
  ): Promise<string> {
    const { docTitle, authorName, dateStr } =
      await this.resolveProjectAndAuthorMetadata(projectId, title, userId);

    return [
      '\\documentclass{article}',
      '\\usepackage{graphicx} % Required for inserting images',
      '\\usepackage{amsmath,amssymb}',
      '\\usepackage{cite}',
      '',
      `\\title{${docTitle}}`,
      `\\author{${authorName}}`,
      `\\date{${dateStr}}`,
      '',
      '\\begin{document}',
      '',
      '\\maketitle',
      '',
      '\\begin{abstract}',
      'This document serves as an example starter project, illustrating standard LaTeX typesetting including mathematical notation, tabular structures, and automated reference citations.',
      '\\end{abstract}',
      '',
      '\\section{Introduction}',
      'LaTeX is widely used in academia and technical fields for producing structured, professional documents. This example introduces foundational capabilities that can be extended for papers, theses, or technical reports.',
      '',
      '\\section{Mathematical Formulations}',
      'Mathematical expressions can appear inline, such as $E = mc^2$ or $\\sum_{k=1}^{\\infty} \\frac{1}{k^2} = \\frac{\\pi^2}{6}$.',
      '',
      'Key formulations can also be displayed in numbered equation environments:',
      '\\begin{equation}',
      '\\label{eq:fourier}',
      '\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x) e^{-2\\pi i x \\xi} dx',
      '\\end{equation}',
      'Equation~\\eqref{eq:fourier} defines the continuous Fourier transform.',
      '',
      '\\section{Data Presentation}',
      'Table~\\ref{tab:benchmarks} demonstrates a clean numerical layout for experimental results.',
      '',
      '\\begin{table}[htbp]',
      '\\centering',
      '\\caption{Comparative performance metrics across evaluation trials.}',
      '\\label{tab:benchmarks}',
      '\\begin{tabular}{lccc}',
      '\\hline',
      '\\textbf{Model} & \\textbf{Precision (\\%)} & \\textbf{Recall (\\%)} & \\textbf{F1-Score} \\\\',
      '\\hline',
      'Baseline & 84.2 & 81.7 & 0.829 \\\\',
      'Flux Engine & \\textbf{92.5} & \\textbf{90.1} & \\textbf{0.913} \\\\',
      '\\hline',
      '\\end{tabular}',
      '\\end{table}',
      '',
      '\\section{Citations and References}',
      'Referencing external sources is essential in academic writing. You can cite bibliography entries defined in the companion \\texttt{references.bib} file, such as \\cite{knuth1984texbook} and \\cite{lamport1994latex}.',
      '',
      '\\bibliographystyle{plain}',
      '\\bibliography{references}',
      '',
      '\\end{document}',
      '',
    ].join('\n');
  }

  /**
   * Automatically creates references.bib in the project if it does not already exist
   */
  public async ensureExampleReferencesBib(projectId: string): Promise<void> {
    const bibPath = '/references.bib';
    try {
      const existing = await this.prisma.manuscriptNode.findFirst({
        where: {
          projectId,
          path: bibPath,
        },
      });
      if (!existing) {
        const bibContent = [
          '@book{knuth1984texbook,',
          '  author    = {Donald E. Knuth},',
          '  title     = {The {\\TeX}book},',
          '  year      = {1984},',
          '  publisher = {Addison-Wesley},',
          '  address   = {Reading, Massachusetts}',
          '}',
          '',
          '@book{lamport1994latex,',
          '  author    = {Leslie Lamport},',
          '  title     = {{\\LaTeX}: A Document Preparation System},',
          '  year      = {1994},',
          '  publisher = {Addison-Wesley},',
          '  edition   = {Second}',
          '}',
          '',
        ].join('\n');

        const createdDoc = await this.docstoreService.createDoc(projectId, {
          path: bibPath,
          text: bibContent,
          version: 1,
        });

        await this.prisma.manuscriptNode.create({
          data: {
            projectId,
            name: 'references.bib',
            path: bibPath,
            depth: 1,
            type: 'DOC',
            docId: createdDoc._id,
            isRootDoc: false,
            sizeBytes: Buffer.byteLength(bibContent, 'utf8'),
          },
        });
      }
    } catch {
      // Non-fatal if companion creation fails
    }
  }

  /**
   * Initializes a new project page with optional template population, default Overleaf
   * project settings, docstore entry, and root file-tree node.
   */
  public async createProjectPage(
    projectId: string,
    body: CreateProjectPageParams,
    userId: string | null,
  ) {
    const pageTitle = body?.title || 'Untitled';
    let content = body?.content || '';

    const labelIds: string[] = Array.isArray(body?.labels)
      ? body.labels
      : Array.isArray(body?.labelIds)
        ? body.labelIds
        : [];

    const attachedLabels = await resolveProjectLabels(
      this.prisma,
      projectId,
      labelIds,
    );

    if (!isUuid(projectId)) {
      throw new BadRequestException(
        'A valid UUID projectId is required to create a project page',
      );
    }

    // Mirror Overleaf Project Initialization:
    if (body?.templateType === 'example') {
      content = await this.buildExampleProjectTemplate(
        projectId,
        pageTitle,
        userId,
      );
      await this.ensureExampleReferencesBib(projectId);
    } else if (!content.trim()) {
      content = await this.buildBlankProjectTemplate(
        projectId,
        pageTitle,
        userId,
      );
    }

    // Ensure project settings are configured with Overleaf standard defaults
    try {
      const proj = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { settings: true },
      });
      const settings = (proj?.settings as Record<string, unknown>) || {};
      if (!settings.manuscript) {
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            settings: {
              ...settings,
              manuscript: {
                compiler: 'pdflatex',
                mainFile: 'main.tex',
                spellCheckLanguage: 'en_US',
                texLiveVersion: '2024',
              },
            },
          },
        });
      }
    } catch {
      // Non-fatal
    }

    // Determine whether a root document already exists for this project
    const existingNodes =
      (await this.prisma.manuscriptNode?.findMany?.({
        where: { projectId, type: 'DOC' },
        select: { path: true, isRootDoc: true },
      })) ?? [];
    const hasExistingRoot = existingNodes.some((n) => n.isRootDoc);
    const existingPaths = new Set(
      existingNodes.map((n) => (n.path || '').toLowerCase()),
    );

    let targetName = 'main.tex';
    if (existingPaths.has('/main.tex')) {
      const cleanBase =
        pageTitle
          .trim()
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .replace(/\.tex$/i, '') || 'document';
      let candidate = `${cleanBase}.tex`;
      let counter = 1;
      while (existingPaths.has(`/${candidate.toLowerCase()}`)) {
        candidate = `${cleanBase}_${counter++}.tex`;
      }
      targetName = candidate;
    }
    const targetPath = `/${targetName}`;
    const isRootDoc = !hasExistingRoot;

    const doc = await this.docstoreService.createDoc(projectId, {
      path: targetPath,
      text: content,
      version: 1,
      ranges: { title: pageTitle, labelIds, labels: attachedLabels },
    });

    const createdNode = await this.prisma.manuscriptNode.create({
      data: {
        projectId,
        name: targetName,
        path: targetPath,
        depth: 1,
        type: 'DOC',
        docId: doc._id,
        isRootDoc,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
      },
    });

    if (isRootDoc && createdNode?.id && this.prisma.manuscriptNode?.updateMany) {
      await Promise.resolve(
        this.prisma.manuscriptNode.updateMany({
          where: {
            projectId,
            isRootDoc: true,
            id: { not: createdNode.id },
          },
          data: { isRootDoc: false },
        }),
      ).catch(() => null);
    }

    return {
      page: {
        id: doc._id,
        title: pageTitle,
        content,
        status: body?.status || 'draft',
        projectId,
        labels: attachedLabels,
        mainFile: { id: doc._id, title: targetName },
        mainFileId: doc._id,
        rootPageId: doc._id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      mainFile: { id: doc._id, title: targetName },
      rootPageId: doc._id,
      mainFileId: doc._id,
    };
  }
}
