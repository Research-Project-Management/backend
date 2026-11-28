/**
 * modules/pages/page/services/scaffold.service.ts
 * Domain/Application service encapsulating project page bootstrap, Overleaf-compatible
 * blank and example LaTeX templates, and companion references.bib initialization.
 */

import * as crypto from 'crypto';
import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import {
  ensureCanonicalPageId,
  escapeLatex,
  resolveSpaceRootDocIds,
  resolveUnicodePreamblePackages,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import { resolveProjectLabels } from './labels.service';

export interface CreateProjectPageParams {
  title?: string;
  description?: string;
  content?: string;
  status?: string;
  labels?: string[];
  labelIds?: string[];
  templateType?: string;
}

@Injectable()
export class PageScaffoldService {
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
      const [space, project, user] = await Promise.all([
        this.prisma.space?.findUnique
          ? Promise.resolve(
              this.prisma.space.findUnique({
                where: { id: projectId },
                include: {
                  project: { select: { name: true } },
                  ownerUser: {
                    select: {
                      email: true,
                      profile: { select: { name: true } },
                    },
                  },
                },
              }),
            ).catch(() => null)
          : Promise.resolve(null),
        this.prisma.project?.findUnique
          ? Promise.resolve(
              this.prisma.project.findUnique({
                where: { id: projectId },
                select: { name: true },
              }),
            ).catch(() => null)
          : Promise.resolve(null),
        userId && isUuid(userId) && this.prisma.user?.findUnique
          ? Promise.resolve(
              this.prisma.user.findUnique({
                where: { id: userId },
                select: {
                  email: true,
                  profile: { select: { name: true } },
                },
              }),
            ).catch(() => null)
          : Promise.resolve(null),
      ]);
      projectName =
        project?.name ||
        space?.project?.name ||
        space?.ownerUser?.profile?.name ||
        '';
      authorName =
        user?.profile?.name ||
        user?.email?.split('@')[0] ||
        space?.ownerUser?.profile?.name ||
        space?.ownerUser?.email?.split('@')[0] ||
        '';
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
    const unicodePreamble = resolveUnicodePreamblePackages([
      docTitle,
      authorName,
    ]);

    return [
      ...unicodePreamble.magicComments,
      '\\documentclass{article}',
      ...unicodePreamble.packages,
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
    const unicodePreamble = resolveUnicodePreamblePackages([
      docTitle,
      authorName,
    ]);

    return [
      ...unicodePreamble.magicComments,
      '\\documentclass{article}',
      ...unicodePreamble.packages,
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
  public async ensureExampleReferencesBib(
    projectId: string,
    pageId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const bibPath = '/references.bib';
    const client = tx ?? this.prisma;
    try {
      const canonicalPageId = await ensureCanonicalPageId(
        client,
        projectId,
        pageId,
      );
      const existing = await client.pageNode.findFirst({
        where: {
          spaceId: projectId,
          pageId: canonicalPageId,
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
          pageId: canonicalPageId,
          tx,
        });

        await client.pageNode.create({
          data: {
            spaceId: projectId,
            pageId: canonicalPageId,
            name: 'references.bib',
            path: bibPath,
            depth: 1,
            type: 'DOC',
            docId: createdDoc._id,
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
    const isExampleTemplate = body?.templateType === 'example';
    if (isExampleTemplate) {
      content = await this.buildExampleProjectTemplate(
        projectId,
        pageTitle,
        userId,
      );
    } else if (!content.trim()) {
      content = await this.buildBlankProjectTemplate(
        projectId,
        pageTitle,
        userId,
      );
    }

    const hasPageAggregateModel = Boolean(this.prisma.page);
    const [fetchedExistingNodes, existingRootDocIds] = await Promise.all([
      hasPageAggregateModel
        ? Promise.resolve([])
        : Promise.resolve(
            this.prisma.pageNode?.findMany?.({
              where: { spaceId: projectId, type: 'DOC' },
              select: { path: true, docId: true },
            }),
          ).catch(() => []),
      hasPageAggregateModel
        ? Promise.resolve(new Set<string>())
        : resolveSpaceRootDocIds(this.prisma, projectId),
    ]);

    const existingNodes = Array.isArray(fetchedExistingNodes)
      ? fetchedExistingNodes
      : [];
    const hasExistingRoot = hasPageAggregateModel
      ? false
      : existingNodes.some((n) =>
          Boolean(n.docId && existingRootDocIds.has(n.docId)),
        );
    const existingPaths = new Set(
      hasPageAggregateModel
        ? []
        : existingNodes.map((n) => (n.path || '').toLowerCase()),
    );

    let targetName = 'main.tex';
    if (!hasPageAggregateModel && existingPaths.has('/main.tex')) {
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

    const newPageId = crypto.randomUUID();
    const normalizedStatus: 'draft' | 'published' | 'archived' =
      body?.status === 'published' || body?.status === 'archived'
        ? body.status
        : 'draft';

    const executeScaffoldInTx = async (tx?: Prisma.TransactionClient) => {
      const db = tx ?? this.prisma;

      // 1. Persist Page Aggregate Root (rootDocId: null) BEFORE creating PageDoc so fk_page_docs_page_space is satisfied
      if (db.page?.create || db.page?.upsert) {
        const pagePayload = {
          id: newPageId,
          spaceId: projectId,
          rootDocId: null,
          title: pageTitle,
          description: body?.description ?? null,
          status: normalizedStatus,
          compiler: 'pdflatex',
          texlive: '2025',
          spellLang: 'en_US',
          createdById: userId && isUuid(userId) ? userId : null,
        };
        if (db.page.create) {
          await db.page.create({ data: pagePayload });
        } else if (db.page.upsert) {
          await db.page.upsert({
            where: { id: newPageId },
            create: pagePayload,
            update: {
              title: pageTitle,
              ...(body?.description !== undefined
                ? { description: body.description }
                : {}),
              ...(body?.status ? { status: normalizedStatus } : {}),
            },
          });
        }
      }

      // 2. Persist root PageDoc within the same transaction
      const createdDoc = await this.docstoreService.createDoc(projectId, {
        id: newPageId,
        pageId: newPageId,
        path: targetPath,
        text: content,
        version: 1,
        ranges: { title: pageTitle, labelIds, labels: attachedLabels },
        tx,
      });

      const resolvedPageId = createdDoc._id || newPageId;

      // 3. Wire Page.rootDocId to newly created root PageDoc
      if (isRootDoc && (db.page?.updateMany || db.page?.update)) {
        if (db.page.updateMany) {
          await db.page.updateMany({
            where: { id: newPageId, spaceId: projectId },
            data: { rootDocId: createdDoc._id },
          });
        } else if (db.page.update) {
          await db.page.update({
            where: { id: newPageId },
            data: { rootDocId: createdDoc._id },
          });
        }
      }

      // 4. Create root PageNode
      await db.pageNode.create({
        data: {
          spaceId: projectId,
          pageId: resolvedPageId,
          name: targetName,
          path: targetPath,
          depth: 1,
          type: 'DOC',
          docId: createdDoc._id,
        },
      });

      // 5. Persist resolved 3NF PageLabel rows
      if (attachedLabels.length > 0 && db.pageLabel?.createMany) {
        await db.pageLabel.createMany({
          data: attachedLabels.map((l) => ({
            pageId: resolvedPageId,
            labelId: l.id,
          })),
          skipDuplicates: true,
        });
      }

      // 6. Create companion references.bib inside transaction when example template requested
      if (isExampleTemplate) {
        await this.ensureExampleReferencesBib(projectId, resolvedPageId, tx);
      }

      return createdDoc;
    };

    const doc =
      typeof this.prisma.$transaction === 'function'
        ? await this.prisma.$transaction((tx) => executeScaffoldInTx(tx))
        : await executeScaffoldInTx(undefined);

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
