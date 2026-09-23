import { Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  FindTemplatesFilter,
  SearchTemplatesFilter,
  FindTemplatesResult,
} from '../../ports/template-repository.port';
import { ManuscriptTemplateEntity } from '../../domain/entities/manuscript-template.entity';

@Injectable()
export class InMemoryTemplateAdapter implements ITemplateRepositoryPort {
  private readonly templates = new Map<string, ManuscriptTemplateEntity>();
  private readonly versionIndex = new Map<string, string>(); // versionId -> id

  constructor() {
    this.seedDefaults();
  }

  seedDefaults(): void {
    const defaults: Array<{
      id: string;
      versionId: string;
      name: string;
      category: string;
      description: string;
      compiler: string;
      imageName?: string;
      mainFile: string;
      author: string;
      tags: string[];
      isOfficial: boolean;
      downloadCount: number;
      files: Record<string, string>;
    }> = [
      {
        id: '10000000-0000-0000-0000-000000000001',
        versionId: 'tmpl-ieee-tran-v1',
        name: 'IEEE Transactions Article',
        category: 'journal',
        description: 'Standard IEEE Transactions template for journal publications and archival papers.',
        compiler: 'pdflatex',
        imageName: 'texlive/texlive:latest',
        mainFile: 'bare_jrnl.tex',
        author: 'IEEE',
        tags: ['ieee', 'journal', 'engineering', 'transactions'],
        isOfficial: true,
        downloadCount: 1420,
        files: {
          'bare_jrnl.tex': `\\documentclass[journal]{IEEEtran}
\\usepackage{amsmath,amsfonts}
\\usepackage{algorithmic}
\\usepackage{algorithm}
\\usepackage{array}
\\usepackage{textcomp}
\\usepackage{stfloats}
\\usepackage{url}
\\usepackage{verbatim}
\\usepackage{graphicx}
\\usepackage{cite}
\\hyphenation{op-tical net-works semi-conduc-tor IEEE-Xplore}

\\begin{document}
\\title{A Sample Article Using IEEEtran.cls for IEEE Transactions}
\\author{Flux Author, \\IEEEmembership{Senior Member,~IEEE}}

\\maketitle

\\begin{abstract}
This brief document is a template for writing IEEE Transactions articles with Flux Manuscript Editor.
\\end{abstract}

\\begin{IEEEkeywords}
IEEEtran, journal, LaTeX, template.
\\end{IEEEkeywords}

\\section{Introduction}
\\IEEEPARstart{T}{his} document demonstrates the standard layout for IEEE transactions papers.

\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}
`,
          'references.bib': `@article{example2026,
  author = {Doe, John and Smith, Jane},
  title = {Modern Collaborative Manuscript Engineering},
  journal = {IEEE Transactions on Software Engineering},
  year = {2026},
  volume = {52},
  number = {4},
  pages = {100--115}
}
`,
        },
      },
      {
        id: '10000000-0000-0000-0000-000000000002',
        versionId: 'tmpl-acm-sigconf-v1',
        name: 'ACM Conference Proceedings (SIGCONF)',
        category: 'conference',
        description: 'Official ACM Primary Article Template for computer science conferences (SIGCONF layout).',
        compiler: 'pdflatex',
        imageName: 'texlive/texlive:latest',
        mainFile: 'sample-sigconf.tex',
        author: 'Association for Computing Machinery',
        tags: ['acm', 'conference', 'cs', 'proceedings', 'sigconf'],
        isOfficial: true,
        downloadCount: 1150,
        files: {
          'sample-sigconf.tex': `\\documentclass[sigconf]{acmart}

\\AtBeginDocument{%
  \\providecommand\\BibTeX{{%
    Bib\\TeX}}}

\\setcopyright{acmlicensed}
\\copyrightyear{2026}
\\acmYear{2026}

\\begin{document}

\\title{The Name of the Title Is Hope: An ACM Conference Template}

\\author{Flux Contributor}
\\affiliation{%
  \\institution{Flux Institute}
  \\city{Hanoi}
  \\country{Vietnam}
}
\\email{author@flux.org}

\\begin{abstract}
An abstract template following the ACM sigconf formatting style guidelines.
\\end{abstract}

\\maketitle

\\section{Introduction}
ACM conferences require papers to adhere to the standardized acmart class.

\\bibliographystyle{ACM-Reference-Format}
\\bibliography{sample}

\\end{document}
`,
          'sample.bib': `@inproceedings{flux2026,
  author = {Flux Team},
  title = {Distributed Realtime Overleaf-Compatible Architecture},
  booktitle = {Proceedings of the ACM Conference on Computer Supported Cooperative Work},
  year = {2026},
  pages = {1--12}
}
`,
        },
      },
      {
        id: '10000000-0000-0000-0000-000000000003',
        versionId: 'tmpl-springer-lncs-v1',
        name: 'Springer LNCS Conference Template',
        category: 'conference',
        description: 'Springer Lecture Notes in Computer Science (LNCS) proceedings and proceedings books.',
        compiler: 'pdflatex',
        imageName: 'texlive/texlive:latest',
        mainFile: 'llncs.tex',
        author: 'Springer Nature',
        tags: ['springer', 'lncs', 'conference', 'book-series', 'ai'],
        isOfficial: true,
        downloadCount: 890,
        files: {
          'llncs.tex': `\\documentclass[runningheads]{llncs}
\\usepackage{graphicx}
\\usepackage{amsmath}

\\begin{document}

\\title{Contribution Title\\thanks{Supported by organization x.}}
\\titlerunning{Abbreviated paper title}
\\author{First Author\\inst{1} \\and Second Author\\inst{2}}
\\institute{Princeton University, Princeton NJ 08544, USA \\and Springer Heidelberg, Tiergartenstr. 17, 69121 Heidelberg, Germany}

\\maketitle

\\begin{abstract}
The abstract should summarize the contents of the paper in 150--250 words.
\\keywords{First keyword \\and Second keyword \\and Another keyword.}
\\end{abstract}

\\section{Introduction}
Springer LNCS papers provide high quality academic proceedings layout.

\\begin{thebibliography}{8}
\\bibitem{ref_article1}
Author, F.: Article title. Journal \\textbf{2}(5), 99--110 (2026)
\\end{thebibliography}

\\end{document}
`,
        },
      },
      {
        id: '10000000-0000-0000-0000-000000000004',
        versionId: 'tmpl-arxiv-minimal-v1',
        name: 'arXiv Minimal Preprint Template',
        category: 'journal',
        description: 'Clean, clean-cut preprint template perfectly tuned for fast compilation and instant arXiv submission.',
        compiler: 'pdflatex',
        imageName: 'texlive/texlive:latest',
        mainFile: 'main.tex',
        author: 'Flux Community',
        tags: ['arxiv', 'preprint', 'minimal', 'math', 'physics'],
        isOfficial: true,
        downloadCount: 2300,
        files: {
          'main.tex': `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{hyperref}

\\title{\\textbf{On the Structure of Efficient Realtime Collaboration}}
\\author{Flux Research Group}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
A minimal, lightweight preprint layout suitable for rapid mathematics and physics submissions.
\\end{abstract}

\\section{Introduction}
Welcome to your new manuscript project. Edit this file to begin authoring.

\\end{document}
`,
        },
      },
      {
        id: '10000000-0000-0000-0000-000000000005',
        versionId: 'tmpl-thesis-v1',
        name: 'Master & PhD Dissertation',
        category: 'thesis',
        description: 'Multi-chapter university thesis & dissertation template with front matter, bibliography, and chapters.',
        compiler: 'xelatex',
        imageName: 'texlive/texlive:latest',
        mainFile: 'thesis.tex',
        author: 'Academic Press',
        tags: ['thesis', 'dissertation', 'phd', 'master', 'university'],
        isOfficial: true,
        downloadCount: 760,
        files: {
          'thesis.tex': `\\documentclass[12pt,oneside]{book}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1.2in]{geometry}
\\usepackage{setspace}
\\doublespacing

\\title{My Doctoral Dissertation}
\\author{Candidate Name}
\\date{May 2026}

\\begin{document}
\\frontmatter
\\maketitle

\\chapter*{Abstract}
This dissertation investigates cutting-edge advances in computational collaborative editing.

\\tableofcontents

\\mainmatter
\\chapter{Introduction}
\\input{chapters/intro.tex}

\\chapter{Conclusion}
\\input{chapters/conclusion.tex}

\\end{document}
`,
          'chapters/intro.tex': `\\section{Background}
Background and problem motivation for this dissertation.
`,
          'chapters/conclusion.tex': `\\section{Future Outlook}
Summary of contributions and recommendations for further research.
`,
        },
      },
      {
        id: '10000000-0000-0000-0000-000000000006',
        versionId: 'tmpl-academic-cv-v1',
        name: 'Academic Curriculum Vitae (CV)',
        category: 'cv',
        description: 'Modern, elegant academic curriculum vitae template for researchers, postdocs, and professors.',
        compiler: 'xelatex',
        imageName: 'texlive/texlive:latest',
        mainFile: 'cv.tex',
        author: 'Flux Community',
        tags: ['cv', 'resume', 'academic', 'career'],
        isOfficial: true,
        downloadCount: 940,
        files: {
          'cv.tex': `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{hyperref}

\\begin{document}
\\begin{center}
  {\\LARGE \\textbf{Dr. Alex Mercer}}\\\\
  Department of Computer Science \\textbar{} researcher@flux.org
\\end{center}

\\section*{Education}
\\textbf{Ph.D. in Computer Science}, University of Excellence \\hfill 2022--2026\\\\
\\textbf{B.S. in Software Engineering}, State University \\hfill 2018--2022

\\section*{Publications}
\\begin{enumerate}
  \\item \\textbf{A. Mercer et al.}, \`\`High-Performance OT/CRDT Synthesis'', \\textit{ACM SIGCOMM}, 2025.
\\end{enumerate}

\\end{document}
`,
        },
      },
      {
        id: '10000000-0000-0000-0000-000000000007',
        versionId: 'tmpl-beamer-slides-v1',
        name: 'Beamer Presentation Slides',
        category: 'presentation',
        description: 'Professional academic slide presentation using the LaTeX Beamer theme.',
        compiler: 'pdflatex',
        imageName: 'texlive/texlive:latest',
        mainFile: 'presentation.tex',
        author: 'Flux Community',
        tags: ['slides', 'presentation', 'beamer', 'talk'],
        isOfficial: true,
        downloadCount: 680,
        files: {
          'presentation.tex': `\\documentclass{beamer}
\\usetheme{Madrid}
\\usecolortheme{default}

\\title[Flux Collaboration]{Collaborative Research Manuscripts}
\\subtitle{A Modern Cloud-Native Paradigm}
\\author{Flux Research Team}
\\institute{Flux Foundation}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Overview}
  \\tableofcontents
\\end{frame}

\\section{Motivation}
\\begin{frame}{Why Modern Manuscripts?}
  \\begin{itemize}
    \\item Seamless Overleaf ecosystem compatibility.
    \\item Realtime operational transformation.
    \\item Built-in academic starter templates.
  \\end{itemize}
\\end{frame}

\\end{document}
`,
        },
      },
    ];

    for (const d of defaults) {
      const entity = ManuscriptTemplateEntity.create(d);
      this.templates.set(entity.id, entity);
      this.versionIndex.set(entity.versionId, entity.id);
    }
  }

  async findById(id: string): Promise<ManuscriptTemplateEntity | null> {
    const direct = this.templates.get(id);
    if (direct) return direct;

    // Check version index if passed versionId as fallback
    const resolvedId = this.versionIndex.get(id);
    if (resolvedId) {
      return this.templates.get(resolvedId) || null;
    }
    return null;
  }

  async findByVersionId(versionId: string): Promise<ManuscriptTemplateEntity | null> {
    const id = this.versionIndex.get(versionId);
    if (!id) return null;
    return this.templates.get(id) || null;
  }

  async findAll(filter?: FindTemplatesFilter): Promise<FindTemplatesResult> {
    let list = Array.from(this.templates.values());

    if (filter?.category && filter.category !== 'all') {
      const cat = filter.category.toLowerCase().trim();
      list = list.filter((t) => t.category.toLowerCase() === cat);
    }

    if (filter?.isOfficial !== undefined) {
      list = list.filter((t) => t.isOfficial === filter.isOfficial);
    }

    if (filter?.tag) {
      const tagLower = filter.tag.toLowerCase().trim();
      list = list.filter((t) => t.tags.some((tg) => tg.toLowerCase() === tagLower));
    }

    // Sort by official first, then downloadCount descending
    list.sort((a, b) => {
      if (a.isOfficial && !b.isOfficial) return -1;
      if (!a.isOfficial && b.isOfficial) return 1;
      return b.downloadCount - a.downloadCount;
    });

    const total = list.length;
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    const paginated = list.slice(offset, offset + limit);

    return { templates: paginated, total };
  }

  async search(filter: SearchTemplatesFilter): Promise<FindTemplatesResult> {
    const q = filter.query.toLowerCase().trim();
    let list = Array.from(this.templates.values());

    if (filter.category && filter.category !== 'all') {
      const cat = filter.category.toLowerCase().trim();
      list = list.filter((t) => t.category.toLowerCase() === cat);
    }

    if (q) {
      list = list.filter((t) => {
        const matchName = t.name.toLowerCase().includes(q);
        const matchDesc = t.description?.toLowerCase().includes(q) ?? false;
        const matchAuthor = t.author.toLowerCase().includes(q);
        const matchTag = t.tags.some((tag) => tag.toLowerCase().includes(q));
        return matchName || matchDesc || matchAuthor || matchTag;
      });
    }

    list.sort((a, b) => b.downloadCount - a.downloadCount);

    const total = list.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    const paginated = list.slice(offset, offset + limit);

    return { templates: paginated, total };
  }

  async save(template: ManuscriptTemplateEntity): Promise<ManuscriptTemplateEntity> {
    this.templates.set(template.id, template);
    this.versionIndex.set(template.versionId, template.id);
    return template;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) return false;
    this.versionIndex.delete(existing.versionId);
    return this.templates.delete(existing.id);
  }

  async incrementDownloadCount(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (existing) {
      existing.incrementDownloadCount();
      await this.save(existing);
    }
  }
}
