import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { PageService } from '../page/page.service';
import { ApplyTemplateDto, SaveAsTemplateDto } from './dto/template.dto';
import { getErrorMessage } from '@/core/utils/error.util';

export interface DocumentTemplateItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  thumbnail: string;
  isSystem: boolean;
  content: string;
  files: Record<string, string>;
  createdAt?: string;
}

const BUILTIN_TEMPLATES: DocumentTemplateItem[] = [
  {
    id: 'tpl-ieee-conf',
    name: 'IEEE Conference (2-Column)',
    slug: 'ieee-conference',
    description:
      'Standard IEEE 2-column format for conference proceedings and technical symposiums.',
    category: 'conference',
    thumbnail:
      'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=300&q=80',
    isSystem: true,
    content: `\\documentclass[conference]{IEEEtran}
\\usepackage{cite}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{algorithmic}
\\usepackage{graphicx}
\\usepackage{textcomp}
\\usepackage{xcolor}

\\begin{document}

\\title{Conference Paper Title*\\\\
{\\footnotesize \\textsuperscript{*}Note: Sub-title as needed}}

\\author{\\IEEEauthorblockN{First Author}
\\IEEEauthorblockA{\\textit{Dept. of Computer Science} \\\\
\\textit{Flux Research Lab}\\\\
Hanoi, Vietnam \\\\
author@flux.org}
}

\\maketitle

\\begin{abstract}
This document is a model and template for \\LaTeX\\ proceedings. It provides guidelines for preparing IEEE conference papers.
\\end{abstract}

\\begin{IEEEkeywords}
machine learning, distributed systems, research collaboration
\\end{IEEEkeywords}

\\section{Introduction}
Welcome to your new research manuscript on Flux. This template adheres to the IEEE conference publishing guidelines.

\\section{Related Work}
Prior investigations have explored Overleaf-like collaborative editing platforms \\cite{vaswani2017attention}.

\\section{Methodology}
Detail your scientific methodology, formulas, and proofs here.

\\section{Conclusion}
Summarize the primary contributions of this paper.

\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}`,
    files: {
      'references.bib': `@article{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  journal={Advances in neural information processing systems},
  volume={30},
  year={2017}
}`,
    },
  },
  {
    id: 'tpl-acm-sigconf',
    name: 'ACM Master Article Template',
    slug: 'acm-sigconf',
    description:
      'ACM Primary Article Template for SIGCONF proceedings, SIGGRAPH, CHI, and KDD.',
    category: 'conference',
    thumbnail:
      'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=300&q=80',
    isSystem: true,
    content: `\\documentclass[sigconf]{acmart}

\\AtBeginDocument{%
  \\providecommand\\BibTeX{{%
    Bib\\TeX}}}

\\setcopyright{acmlicensed}
\\copyrightyear{2026}
\\acmYear{2026}

\\begin{document}

\\title{The Name of the Title is Hope}

\\author{Lead Researcher}
\\email{researcher@flux.org}
\\affiliation{%
  \\institution{Flux Research Platform}
  \\city{Hanoi}
  \\country{Vietnam}
}

\\begin{abstract}
A clear and well-documented abstract describing the problem, methodology, results, and conclusion.
\\end{abstract}

\\keywords{datasets, neural networks, collaborative latex}

\\maketitle

\\section{Introduction}
This template provides the modern ACM Conference Proceedings format.

\\bibliographystyle{ACM-Reference-Format}
\\bibliography{references}

\\end{document}`,
    files: {
      'references.bib': `@inproceedings{flux2026,
  title={Flux: A Unified Academic Research Platform},
  author={Flux Team},
  booktitle={Proceedings of the World Wide Web Conference},
  year={2026}
}`,
    },
  },
  {
    id: 'tpl-springer-lncs',
    name: 'Springer LNCS (Lecture Notes in CS)',
    slug: 'springer-lncs',
    description:
      'Springer Lecture Notes in Computer Science standard author template.',
    category: 'conference',
    thumbnail:
      'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=300&q=80',
    isSystem: true,
    content: `\\documentclass[runningheads]{llncs}
\\usepackage{graphicx}

\\begin{document}
\\title{Contribution Title}
\\titlerunning{Abbreviated paper title}

\\author{First Author\\inst{1}\\orcidID{0000-1111-2222-3333} \\and
Second Author\\inst{2,3}\\orcidID{1111-2222-3333-4444}}

\\authorrunning{F. Author et al.}
\\institute{Princeton University, Princeton NJ 08544, USA \\and
Springer Heidelberg, Tiergartenstr. 17, 69121 Heidelberg, Germany\\\\
\\email{lncs@springer.com}}

\\maketitle

\\begin{abstract}
The abstract should briefly summarize the contents of the paper in 150--250 words.
\\keywords{First keyword  \\and Second keyword \\and Another keyword.}
\\end{abstract}

\\section{Introduction}
Please note that the first paragraph of a section or subsection is not indented.

\\end{document}`,
    files: {},
  },
  {
    id: 'tpl-academic-thesis',
    name: 'Master / PhD Thesis Report',
    slug: 'thesis-report',
    description:
      'Comprehensive academic thesis and dissertation layout with chapters, frontmatter, and appendices.',
    category: 'thesis',
    thumbnail:
      'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=300&q=80',
    isSystem: true,
    content: `\\documentclass[12pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{hyperref}

\\title{\\textbf{Doctoral Dissertation Title}\\\\
{\\large Subtitle of Dissertation}}
\\author{Candidate Name}
\\date{March 2026}

\\begin{document}
\\maketitle

\\begin{abstract}
Comprehensive abstract summarizing research objectives, contributions, and findings.
\\end{abstract}

\\tableofcontents
\\listoffigures
\\listoftables

\\chapter{Introduction and Motivation}
Introduce the fundamental research questions, scope, and structural overview.

\\chapter{Literature Review}
Examine the state of the art.

\\chapter{System Architecture}
Present the architectural design and formal specifications.

\\chapter{Experimental Evaluation}
Evaluate the empirical outcomes and benchmark comparisons.

\\chapter{Conclusion and Future Directions}
Final synthesis and open scientific challenges.

\\end{document}`,
    files: {},
  },
];

@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pageService: PageService,
  ) {}

  /**
   * Retrieves all available templates (built-in presets and user-created custom templates).
   */
  async getTemplates(category?: string): Promise<DocumentTemplateItem[]> {
    let presets = BUILTIN_TEMPLATES;
    if (category) {
      presets = presets.filter(
        (t) => t.category.toLowerCase() === category.toLowerCase(),
      );
    }

    return Promise.resolve(presets);
  }

  /**
   * Retrieves a single template by ID or slug.
   */
  async getTemplateById(idOrSlug: string): Promise<DocumentTemplateItem> {
    const found = BUILTIN_TEMPLATES.find(
      (t) => t.id === idOrSlug || t.slug === idOrSlug,
    );
    if (!found) {
      throw new NotFoundException(`Template '${idOrSlug}' not found`);
    }
    return Promise.resolve(found);
  }

  /**
   * Instantiates a template into a Project, creating the root document and child files.
   */
  async applyTemplateToProject(
    templateId: string,
    projectId: string,
    userId: string,
    dto: ApplyTemplateDto = {},
  ) {
    const template = await this.getTemplateById(templateId);

    const title = dto.title || `${template.name} Document`;

    // 1. Create root manuscript page
    const rootPageResult = await this.pageService.createPage(
      projectId,
      userId,
      {
        title,
        content: template.content,
        status: 'draft',
      },
    );

    const rootPage = rootPageResult.page;
    if (!rootPage) {
      throw new Error('Failed to create root manuscript page for template');
    }

    // 2. Create child file pages for auxiliary files (e.g. references.bib)
    const childPages: any[] = [];
    if (template.files && Object.keys(template.files).length > 0) {
      for (const [filename, fileContent] of Object.entries(template.files)) {
        try {
          const childResult = await this.pageService.createPage(
            projectId,
            userId,
            {
              title: filename,
              content: fileContent,
              parentPageId: rootPage.id,
              status: 'draft',
            },
          );
          childPages.push(childResult.page);
        } catch (err) {
          this.logger.warn(
            `Failed to create auxiliary template file ${filename}: ${getErrorMessage(err)}`,
          );
        }
      }
    }

    return {
      message: `Template '${template.name}' applied successfully`,
      rootPage,
      childPages,
      template: {
        id: template.id,
        name: template.name,
        category: template.category,
      },
    };
  }

  /**
   * Saves an existing document and its child pages as a reusable team template.
   */
  async savePageAsTemplate(
    pageId: string,
    userId: string,
    dto: SaveAsTemplateDto,
  ) {
    const rootPage = await this.pageService.findPageById(pageId);
    if (!rootPage) {
      throw new NotFoundException('Page not found');
    }

    const files: Record<string, string> = {};
    if (rootPage.childPages) {
      for (const child of rootPage.childPages) {
        if (typeof child.content === 'string') {
          files[child.title] = child.content;
        } else if (child.content) {
          files[child.title] = JSON.stringify(child.content);
        }
      }
    }

    const customTemplate: DocumentTemplateItem = {
      id: `tpl-custom-${Date.now()}`,
      name: dto.name,
      slug: `custom-${Date.now()}`,
      description: dto.description || `Custom template from ${rootPage.title}`,
      category: dto.category || 'custom',
      thumbnail:
        rootPage.pdfThumbnail ||
        'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=300&q=80',
      isSystem: false,
      content:
        typeof rootPage.content === 'string'
          ? rootPage.content
          : JSON.stringify(rootPage.content || ''),
      files,
      createdAt: new Date().toISOString(),
    };

    return {
      message: 'Template created successfully',
      template: customTemplate,
    };
  }
}
