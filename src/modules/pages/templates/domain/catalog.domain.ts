/**
 * templates/domain/catalog.domain.ts
 * GoF Flyweight Pool: Immutable pre-built `TemplateManifest` prototypes for the
 * 13 curated academic templates (covering Overleaf categories).
 * Zero legacy alias arrays — identified strictly by canonical `id` or `slug`.
 */

import { TemplateFileVo } from './file.domain';
import { TemplateManifest } from './manifest.domain';
import { TemplateCategory, TemplateCompiler } from './policy';

interface CatalogSeed {
  readonly id: string;
  readonly slug: string;
  readonly versionId: string;
  readonly name: string;
  readonly category: TemplateCategory;
  readonly description: string;
  readonly compiler: TemplateCompiler;
  readonly mainFile: string;
  readonly author: string;
  readonly license: string;
  readonly sourceUrl?: string;
  readonly tags: readonly string[];
  readonly downloadCount: number;
  readonly files: Readonly<Record<string, string>>;
}

const SEEDS: readonly CatalogSeed[] = [
  {
    id: '10000000-0000-0000-0000-000000000001',
    slug: 'ieee-transactions',
    versionId: 'tmpl-ieee-tran-v1',
    name: 'IEEE Transactions Article',
    category: 'journal',
    description:
      'Standard IEEE Transactions template for journal publications and archival papers.',
    compiler: 'pdflatex',
    mainFile: 'bare_jrnl.tex',
    author: 'IEEE',
    license: 'LPPL-1.3c',
    sourceUrl: 'https://template-selector.ieee.org/',
    tags: ['ieee', 'journal', 'engineering', 'transactions'],
    downloadCount: 1420,
    files: {
      'bare_jrnl.tex': `\\documentclass[journal]{IEEEtran}
\\usepackage{amsmath,amsfonts}
\\usepackage{algorithmic}
\\usepackage{algorithm}
\\usepackage{array}
\\usepackage{graphicx}
\\usepackage{cite}

\\begin{document}
\\title{A Sample Article Using IEEEtran.cls for IEEE Transactions}
\\author{Flux Author, \\IEEEmembership{Senior Member,~IEEE}}
\\maketitle

\\begin{abstract}
This document provides the standard layout for IEEE Transactions articles.
\\end{abstract}

\\begin{IEEEkeywords}
IEEEtran, journal, LaTeX, template.
\\end{IEEEkeywords}

\\section{Introduction}
\\IEEEPARstart{T}{his} document demonstrates the standard layout for IEEE transactions papers \\cite{example2026}.

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
    id: '10000000-0000-0000-0000-000000000013',
    slug: 'ieee-conference',
    versionId: 'tmpl-ieee-conf-v1',
    name: 'IEEE Conference Paper (2-Column)',
    category: 'conference',
    description:
      'Standard IEEE 2-column format for conference proceedings, symposiums, and workshops.',
    compiler: 'pdflatex',
    mainFile: 'main.tex',
    author: 'IEEE',
    license: 'LPPL-1.3c',
    sourceUrl: 'https://www.ieee.org/conferences/publishing/templates.html',
    tags: ['ieee', 'conference', '2-column', 'ieeetran'],
    downloadCount: 1680,
    files: {
      'main.tex': `\\documentclass[conference]{IEEEtran}
\\usepackage{cite}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{xcolor}

\\begin{document}
\\title{Conference Paper Title}
\\author{\\IEEEauthorblockN{First Author}
\\IEEEauthorblockA{\\textit{Dept. of Computer Science} \\\\
\\textit{Flux Research Lab}\\\\
author@flux.org}}
\\maketitle

\\begin{abstract}
Guidelines for preparing IEEE 2-column conference papers using LaTeX.
\\end{abstract}

\\section{Introduction}
Prior investigations have explored collaborative authoring \\cite{vaswani2017attention}.

\\bibliographystyle{IEEEtran}
\\bibliography{references}
\\end{document}
`,
      'references.bib': `@inproceedings{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob},
  booktitle = {Advances in Neural Information Processing Systems},
  volume = {30},
  year = {2017}
}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000002',
    slug: 'acm-sigconf',
    versionId: 'tmpl-acm-sigconf-v1',
    name: 'ACM Conference Proceedings (SIGCONF)',
    category: 'conference',
    description:
      'Official ACM Primary Article Template for computer science conferences (SIGCONF layout).',
    compiler: 'pdflatex',
    mainFile: 'sample-sigconf.tex',
    author: 'Association for Computing Machinery',
    license: 'LPPL-1.3c',
    sourceUrl: 'https://www.acm.org/publications/proceedings-template',
    tags: ['acm', 'conference', 'cs', 'proceedings', 'sigconf'],
    downloadCount: 1150,
    files: {
      'sample-sigconf.tex': `\\documentclass[sigconf]{acmart}
\\setcopyright{acmlicensed}
\\copyrightyear{2026}
\\acmYear{2026}

\\begin{document}
\\title{An ACM SIGCONF Proceedings Template}
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
ACM conferences adhere to the standardized acmart class \\cite{flux2026}.

\\bibliographystyle{ACM-Reference-Format}
\\bibliography{sample}
\\end{document}
`,
      'sample.bib': `@inproceedings{flux2026,
  author = {Flux Team},
  title = {Distributed Realtime Overleaf-Compatible Architecture},
  booktitle = {Proceedings of the ACM CSCW},
  year = {2026},
  pages = {1--12}
}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000003',
    slug: 'springer-lncs',
    versionId: 'tmpl-springer-lncs-v1',
    name: 'Springer LNCS Conference Proceedings',
    category: 'conference',
    description:
      'Springer Lecture Notes in Computer Science (LNCS) conference proceedings layout.',
    compiler: 'pdflatex',
    mainFile: 'llncs.tex',
    author: 'Springer Nature',
    license: 'CC-BY-4.0',
    sourceUrl:
      'https://www.springer.com/gp/computer-science/lncs/conference-proceedings-guidelines',
    tags: ['springer', 'lncs', 'conference', 'ai'],
    downloadCount: 890,
    files: {
      'llncs.tex': `\\documentclass[runningheads]{llncs}
\\usepackage{graphicx}
\\usepackage{amsmath}

\\begin{document}
\\title{Contribution Title}
\\titlerunning{Abbreviated paper title}
\\author{First Author\\inst{1} \\and Second Author\\inst{2}}
\\institute{Institute One \\and Institute Two}
\\maketitle

\\begin{abstract}
The abstract should summarize the contents of the paper in 150--250 words.
\\keywords{First keyword \\and Second keyword.}
\\end{abstract}

\\section{Introduction}
Springer LNCS papers provide clean academic proceedings formatting.
\\end{document}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000004',
    slug: 'arxiv-preprint',
    versionId: 'tmpl-arxiv-minimal-v1',
    name: 'arXiv Minimal Clean Preprint',
    category: 'journal',
    description:
      'Clean single-column preprint template tuned for fast compilation and arXiv submission.',
    compiler: 'pdflatex',
    mainFile: 'main.tex',
    author: 'Flux Community',
    license: 'CC0-1.0',
    sourceUrl: 'https://info.arxiv.org/help/submit_tex.html',
    tags: ['arxiv', 'preprint', 'minimal', 'math', 'physics'],
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
A lightweight preprint layout suitable for rapid mathematics and physics submissions.
\\end{abstract}

\\section{Introduction}
Edit this file to begin authoring your manuscript.
\\end{document}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000005',
    slug: 'masters-thesis',
    versionId: 'tmpl-thesis-v1',
    name: 'Master & PhD Dissertation',
    category: 'thesis',
    description:
      'Multi-chapter university thesis & dissertation template with front matter and modular chapters.',
    compiler: 'xelatex',
    mainFile: 'thesis.tex',
    author: 'Academic Press',
    license: 'CC-BY-4.0',
    tags: ['thesis', 'dissertation', 'phd', 'master', 'university'],
    downloadCount: 760,
    files: {
      'thesis.tex': `\\documentclass[12pt,oneside]{book}
\\usepackage[margin=1.2in]{geometry}
\\usepackage{setspace}
\\doublespacing

\\title{My Doctoral Dissertation}
\\author{Candidate Name}
\\date{\\today}

\\begin{document}
\\frontmatter
\\maketitle

\\chapter*{Abstract}
This dissertation investigates advances in collaborative scientific publishing.
\\tableofcontents

\\mainmatter
\\chapter{Introduction}
\\input{chapters/intro.tex}

\\chapter{Conclusion}
\\input{chapters/conclusion.tex}
\\end{document}
`,
      'chapters/intro.tex': `\\section{Background}\nBackground and motivation for this dissertation.\n`,
      'chapters/conclusion.tex': `\\section{Future Outlook}\nSummary of contributions and future research.\n`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000006',
    slug: 'academic-cv',
    versionId: 'tmpl-academic-cv-v1',
    name: 'Academic Curriculum Vitae (CV)',
    category: 'cv',
    description:
      'Modern academic curriculum vitae template for researchers, postdocs, and faculty.',
    compiler: 'xelatex',
    mainFile: 'cv.tex',
    author: 'Flux Community',
    license: 'MIT',
    tags: ['cv', 'resume', 'academic', 'career'],
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
\\textbf{Ph.D. in Computer Science}, University of Excellence \\hfill 2022--2026

\\section*{Publications}
\\begin{enumerate}
  \\item \\textbf{A. Mercer et al.}, \`\`High-Performance CRDT Synthesis'', \\textit{ACM SIGCOMM}, 2025.
\\end{enumerate}
\\end{document}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000007',
    slug: 'beamer-presentation',
    versionId: 'tmpl-beamer-slides-v1',
    name: 'Beamer Presentation Slides',
    category: 'presentation',
    description:
      'Professional academic slide deck built on the LaTeX Beamer Madrid theme.',
    compiler: 'pdflatex',
    mainFile: 'presentation.tex',
    author: 'Flux Community',
    license: 'LPPL-1.3c',
    tags: ['slides', 'presentation', 'beamer', 'talk'],
    downloadCount: 680,
    files: {
      'presentation.tex': `\\documentclass{beamer}
\\usetheme{Madrid}

\\title[Flux Collaboration]{Collaborative Research Manuscripts}
\\author{Flux Research Team}
\\institute{Flux Foundation}
\\date{\\today}

\\begin{document}
\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Overview}
  \\begin{itemize}
    \\item Native Overleaf ecosystem compatibility.
    \\item Real-time CRDT synchronization.
  \\end{itemize}
\\end{frame}
\\end{document}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000008',
    slug: 'academic-book',
    versionId: 'tmpl-academic-book-v1',
    name: 'Academic Book / Monograph',
    category: 'book',
    description:
      'Comprehensive multi-chapter book template with front matter and bibliography.',
    compiler: 'pdflatex',
    mainFile: 'main.tex',
    author: 'Flux Academic Team',
    license: 'LPPL-1.3c',
    tags: ['book', 'monograph', 'academic', 'chapters'],
    downloadCount: 540,
    files: {
      'main.tex': `\\documentclass[11pt,a4paper,openany]{book}
\\usepackage[margin=1.2in]{geometry}
\\usepackage{amsmath,amsfonts,amssymb}
\\usepackage{hyperref}

\\title{\\textbf{Principles of Distributed Collaborative Systems}}
\\author{Author Name}
\\date{\\today}

\\begin{document}
\\frontmatter
\\maketitle
\\tableofcontents

\\mainmatter
\\chapter{Foundations}
\\section{Introduction}
Modern collaborative authoring relies on conflict-free data models \\cite{tanenbaum2007}.

\\backmatter
\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}
`,
      'references.bib': `@book{tanenbaum2007,
  title = {Distributed Systems: Principles and Paradigms},
  author = {Tanenbaum, Andrew S and Van Steen, Maarten},
  year = {2007},
  publisher = {Prentice-Hall}
}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000009',
    slug: 'formal-letter',
    versionId: 'tmpl-formal-letter-v1',
    name: 'Formal Academic & Recommendation Letter',
    category: 'letter',
    description:
      'Professional letter template for academic recommendations and institutional correspondence.',
    compiler: 'pdflatex',
    mainFile: 'main.tex',
    author: 'Flux Academic Team',
    license: 'CC0-1.0',
    tags: ['letter', 'formal', 'recommendation', 'correspondence'],
    downloadCount: 490,
    files: {
      'main.tex': `\\documentclass[11pt]{letter}
\\usepackage[margin=1in]{geometry}

\\signature{Prof. Jane Doe\\\\Department Chair}
\\address{Department of Computer Science\\\\123 University Avenue}

\\begin{document}
\\begin{letter}{Admissions Committee\\\\Graduate School of Engineering}
\\opening{Dear Members of the Committee,}
I am writing to enthusiastically recommend the applicant for your graduate program.
\\closing{Sincerely yours,}
\\end{letter}
\\end{document}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000010',
    slug: 'course-assignment',
    versionId: 'tmpl-course-assignment-v1',
    name: 'Coursework & Problem Set Assignment',
    category: 'assignment',
    description:
      'Structured homework and problem set template with theorem blocks and equations.',
    compiler: 'pdflatex',
    mainFile: 'main.tex',
    author: 'Flux Academic Team',
    license: 'MIT',
    tags: ['assignment', 'homework', 'coursework', 'problem-set'],
    downloadCount: 820,
    files: {
      'main.tex': `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}

\\theoremstyle{definition}
\\newtheorem{problem}{Problem}

\\begin{document}
\\begin{center}
  {\\Large\\textbf{Problem Set 1: Graph Algorithms}} \\\\[0.4em]
  {\\small Due: \\today}
\\end{center}

\\begin{problem}
Prove that Dijkstra's algorithm computes shortest paths on non-negative graphs.
\\end{problem}

\\noindent\\textbf{Solution:} We proceed by induction on $|S|$.
\\end{document}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000011',
    slug: 'scientific-poster',
    versionId: 'tmpl-scientific-poster-v1',
    name: 'Scientific Conference Poster',
    category: 'poster',
    description:
      'Single-page landscape A1 poster layout for academic conferences and symposiums.',
    compiler: 'pdflatex',
    mainFile: 'main.tex',
    author: 'Flux Academic Team',
    license: 'CC-BY-4.0',
    tags: ['poster', 'conference', 'symposium', 'landscape'],
    downloadCount: 610,
    files: {
      'main.tex': `\\documentclass[20pt,landscape]{article}
\\usepackage[a1paper,margin=1.5cm]{geometry}
\\usepackage{multicol}
\\usepackage{xcolor}

\\pagestyle{empty}
\\begin{document}
\\begin{center}
  {\\Huge\\textbf{Real-Time Collaborative Scientific Authoring}} \\\\[0.4em]
  {\\Large Author Name$^1$, Co-Author Name$^2$}
\\end{center}

\\begin{multicols}{3}
\\section*{1. Abstract}
Cloud-native LaTeX authoring with conflict-free concurrent editing.
\\section*{2. Method}
Commutative state replication with sub-50ms latency.
\\section*{3. Results}
Linear scalability across 100 concurrent authors.
\\end{multicols}
\\end{document}
`,
    },
  },
  {
    id: '10000000-0000-0000-0000-000000000012',
    slug: 'technical-report',
    versionId: 'tmpl-technical-report-v1',
    name: 'Technical & Engineering Report',
    category: 'report',
    description:
      'Clean technical report with executive summary, methodology, and benchmark findings.',
    compiler: 'pdflatex',
    mainFile: 'main.tex',
    author: 'Flux Academic Team',
    license: 'CC-BY-4.0',
    tags: ['report', 'technical', 'engineering', 'whitepaper'],
    downloadCount: 710,
    files: {
      'main.tex': `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,hyperref}

\\title{\\textbf{Technical Report: Scalability of Compilation Sandboxes}}
\\author{Flux Systems Team}
\\date{\\today}

\\begin{document}
\\maketitle
\\begin{abstract}
Architecture and throughput benchmarks of sandboxed LaTeX compilation workers.
\\end{abstract}

\\section{Executive Summary}
Testing validates linear scalability with strict tenant isolation.
\\end{document}
`,
    },
  },
];

const FIXED_EPOCH = new Date('2026-01-01T00:00:00.000Z');

export const OFFICIAL_TEMPLATES: readonly TemplateManifest[] = SEEDS.map(
  (seed) =>
    TemplateManifest.create({
      id: seed.id,
      slug: seed.slug,
      versionId: seed.versionId,
      name: seed.name,
      category: seed.category,
      visibility: 'official',
      description: seed.description,
      compiler: seed.compiler,
      texLiveVersion: '2024',
      mainFile: seed.mainFile,
      author: seed.author,
      license: seed.license,
      sourceUrl: seed.sourceUrl ?? null,
      tags: seed.tags,
      downloadCount: seed.downloadCount,
      files: Object.entries(seed.files).map(([p, text]) =>
        TemplateFileVo.fromText(p, text),
      ),
      createdAt: FIXED_EPOCH,
      updatedAt: FIXED_EPOCH,
    }),
);
