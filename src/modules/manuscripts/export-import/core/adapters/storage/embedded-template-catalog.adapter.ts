/**
 * export-import/core/adapters/storage/embedded-template-catalog.adapter.ts
 * Driven Adapter managing a catalog of embedded international academic LaTeX templates.
 */

import { Injectable } from '@nestjs/common';
import { ITemplateCatalogPort } from '../../ports/template-catalog.port';
import { ProjectTemplate } from '../../domain/entities/project-template.entity';

@Injectable()
export class EmbeddedTemplateCatalogAdapter extends ITemplateCatalogPort {
  private readonly templates: Map<string, ProjectTemplate> = new Map();

  constructor() {
    super();
    this.seedDefaultTemplates();
  }

  public async listTemplates(): Promise<ProjectTemplate[]> {
    return Array.from(this.templates.values());
  }

  public async getTemplateById(templateId: string): Promise<ProjectTemplate | null> {
    return this.templates.get(templateId) || null;
  }

  private seedDefaultTemplates(): void {
    const defaultTemplates: ProjectTemplate[] = [
      new ProjectTemplate({
        id: 'ieee-transactions',
        title: 'IEEE Transactions Journal Template',
        category: 'article',
        description: 'Standard two-column template for IEEE journals and transactions with IEEEtran class.',
        author: 'IEEE Publications',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[journal]{IEEEtran}
\\usepackage{amsmath,amsfonts}
\\usepackage{graphicx}
\\usepackage{cite}

\\begin{document}
\\title{Sample IEEE Transactions Paper}
\\author{Author Name, \\IEEEmembership{Member, IEEE}}
\\maketitle

\\begin{abstract}
This is a standard IEEE Transactions abstract highlighting the primary contributions of the research.
\\end{abstract}

\\begin{IEEEkeywords}
Artificial Intelligence, Computer Science, Signal Processing.
\\end{IEEEkeywords}

\\section{Introduction}
\\IEEEPARstart{T}{his} document demonstrates the layout of an IEEE Transactions submission.

\\section{Methodology}
Equations and formal derivations are presented here:
\\begin{equation}
E = mc^2
\\end{equation}

\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}`,
          },
          {
            path: 'references.bib',
            content: `@article{shannon1948,
  author={Shannon, Claude E.},
  journal={Bell System Technical Journal},
  title={A Mathematical Theory of Communication},
  year={1948},
  volume={27},
  number={3},
  pages={379--423}
}`,
          },
        ],
      }),
      new ProjectTemplate({
        id: 'acm-sigconf',
        title: 'ACM Conference Proceedings (SIGCONF)',
        category: 'conference',
        description: 'Official ACM master article template for proceedings and conferences (acmart).',
        author: 'Association for Computing Machinery',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[sigconf]{acmart}

\\title{ACM SIGCONF Research Paper}
\\author{First Author}
\\affiliation{%
  \\institution{University Name}
  \\country{USA}
}

\\begin{document}

\\begin{abstract}
Concise overview of the ACM conference paper.
\\end{abstract}

\\maketitle

\\section{Introduction}
Introduction to the problem and related work.

\\bibliographystyle{ACM-Reference-Format}
\\bibliography{references}

\\end{document}`,
          },
          {
            path: 'references.bib',
            content: `@inproceedings{lamport1982,
  author={Lamport, Leslie and Shostak, Robert and Pease, Marshall},
  title={The Byzantine Generals Problem},
  booktitle={ACM Transactions on Programming Languages and Systems},
  year={1982},
  pages={382--401}
}`,
          },
        ],
      }),
      new ProjectTemplate({
        id: 'arxiv-preprint',
        title: 'arXiv Minimal Clean Preprint',
        category: 'article',
        description: 'Clean single-column preprint suitable for direct submission to arXiv.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,graphicx}
\\usepackage{hyperref}

\\title{\\textbf{An Empirical Study of Modern Scientific Workflows}}
\\author{Principal Investigator\\\\\\texttt{pi@research.institution.edu}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
We present a concise preprint exploring collaborative workflows for scientific manuscripts.
\\end{abstract}

\\section{Introduction}
Preprints provide rapid dissemination of scientific discoveries.

\\section{Results}
Our findings show a substantial reduction in cycle times.

\\end{document}`,
          },
        ],
      }),
      new ProjectTemplate({
        id: 'springer-lncs',
        title: 'Springer LNCS Conference Template',
        category: 'conference',
        description: 'Lecture Notes in Computer Science (LNCS) proceedings template.',
        author: 'Springer Nature',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass{llncs}
\\usepackage{graphicx}

\\begin{document}
\\title{Contribution to Springer LNCS}
\\author{Author One\\inst{1} \\and Author Two\\inst{2}}
\\institute{Institute One \\and Institute Two}
\\maketitle

\\begin{abstract}
The abstract should summarize the contents of the paper in short terms.
\\keywords{First Keyword \\and Second Keyword.}
\\end{abstract}

\\section{Introduction}
Welcome to the LNCS paper format.

\\end{document}`,
          },
        ],
      }),
      new ProjectTemplate({
        id: 'beamer-presentation',
        title: 'Academic Presentation Slides (Beamer)',
        category: 'presentation',
        description: 'Modern 16:9 aspect ratio slide deck for conferences and thesis defense.',
        author: 'TeX Users Group',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[aspectratio=169]{beamer}
\\usetheme{Madrid}
\\usecolortheme{default}

\\title{Conference Presentation Title}
\\subtitle{Short Subtitle}
\\author{Speaker Name}
\\institute{University / Laboratory}
\\date{\\today}

\\begin{document}

\\begin{frame}
\\titlepage
\\end{frame}

\\begin{frame}{Agenda}
\\tableofcontents
\\end{frame}

\\section{Overview}
\\begin{frame}{Problem Formulation}
\\begin{itemize}
  \\item High collaboration overhead in LaTeX authoring.
  \\item Need for real-time synchronization and conflict resolution.
\\end{itemize}
\\end{frame}

\\end{document}`,
          },
        ],
      }),
    ];

    for (const t of defaultTemplates) {
      this.templates.set(t.id, t);
    }
  }
}
