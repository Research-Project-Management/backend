/**
 * templates/domain/official-template.catalog.ts
 * Single source of truth for embedded official LaTeX academic templates,
 * shared across TemplatesModule and ExportImportModule.
 */

export interface OfficialTemplateDefinition {
  /** Primary UUID for database / TemplatesModule */
  id: string;
  /** Semantic slug ID used by ExportImportModule */
  slug: string;
  /** Version identifier used for Overleaf parity */
  versionId: string;
  /** Additional lookup aliases (slugs, versionIds, legacy keys) */
  aliases: string[];
  name: string;
  title: string;
  category:
    | 'journal'
    | 'conference'
    | 'thesis'
    | 'cv'
    | 'presentation'
    | 'book'
    | 'letter'
    | 'assignment'
    | 'poster'
    | 'report'
    | 'other';
  description: string;
  compiler: 'pdflatex' | 'xelatex' | 'lualatex';
  imageName: string;
  mainFile: string;
  author: string;
  tags: string[];
  isOfficial: boolean;
  downloadCount: number;
  files: Record<string, string>;
}

export const OFFICIAL_TEMPLATE_CATALOG: readonly OfficialTemplateDefinition[] =
  [
    {
      id: '10000000-0000-0000-0000-000000000001',
      slug: 'ieee-transactions',
      versionId: 'tmpl-ieee-tran-v1',
      aliases: ['ieee', 'ieee-tran', 'bare_jrnl'],
      name: 'IEEE Transactions Article',
      title: 'IEEE Transactions Journal Template',
      category: 'journal',
      description:
        'Standard IEEE Transactions template for journal publications and archival papers.',
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
      slug: 'acm-sigconf',
      versionId: 'tmpl-acm-sigconf-v1',
      aliases: ['acm', 'sigconf', 'sample-sigconf'],
      name: 'ACM Conference Proceedings (SIGCONF)',
      title: 'ACM Conference Proceedings (SIGCONF)',
      category: 'conference',
      description:
        'Official ACM Primary Article Template for computer science conferences (SIGCONF layout).',
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
      slug: 'springer-lncs',
      versionId: 'tmpl-springer-lncs-v1',
      aliases: ['springer', 'lncs', 'llncs'],
      name: 'Springer LNCS Conference Template',
      title: 'Springer LNCS Conference Template',
      category: 'conference',
      description:
        'Springer Lecture Notes in Computer Science (LNCS) proceedings and proceedings books.',
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
      slug: 'arxiv-preprint',
      versionId: 'tmpl-arxiv-minimal-v1',
      aliases: ['arxiv', 'arxiv-minimal', 'preprint'],
      name: 'arXiv Minimal Preprint Template',
      title: 'arXiv Minimal Clean Preprint',
      category: 'journal',
      description:
        'Clean, clean-cut preprint template perfectly tuned for fast compilation and instant arXiv submission.',
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
      slug: 'masters-thesis',
      versionId: 'tmpl-thesis-v1',
      aliases: ['thesis', 'phd-thesis', 'dissertation'],
      name: 'Master & PhD Dissertation',
      title: 'Master / PhD Thesis & Dissertation',
      category: 'thesis',
      description:
        'Multi-chapter university thesis & dissertation template with front matter, bibliography, and chapters.',
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
      slug: 'academic-cv',
      versionId: 'tmpl-academic-cv-v1',
      aliases: ['cv', 'resume'],
      name: 'Academic Curriculum Vitae (CV)',
      title: 'Academic Curriculum Vitae',
      category: 'cv',
      description:
        'Modern, elegant academic curriculum vitae template for researchers, postdocs, and professors.',
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
      slug: 'beamer-presentation',
      versionId: 'tmpl-beamer-slides-v1',
      aliases: ['beamer', 'beamer-slides', 'presentation', 'slides'],
      name: 'Beamer Presentation Slides',
      title: 'Academic Presentation Slides (Beamer)',
      category: 'presentation',
      description:
        'Professional academic slide presentation using the LaTeX Beamer theme.',
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
    {
      id: '10000000-0000-0000-0000-000000000008',
      slug: 'academic-book',
      versionId: 'tmpl-academic-book-v1',
      aliases: ['book', 'monograph'],
      name: 'Academic Book / Monograph',
      title: 'Academic Book / Monograph',
      category: 'book',
      description:
        'Comprehensive multi-chapter book template with front matter, index, and bibliography.',
      compiler: 'pdflatex',
      imageName: 'texlive/texlive:latest',
      mainFile: 'main.tex',
      author: 'Flux Academic Team',
      tags: ['book', 'monograph', 'academic', 'chapters'],
      isOfficial: true,
      downloadCount: 540,
      files: {
        'main.tex': `\\documentclass[11pt,a4paper,openany]{book}
\\usepackage[margin=1.2in]{geometry}
\\usepackage{amsmath,amsfonts,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{\\textbf{Principles of Distributed Collaborative Systems}}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\frontmatter
\\maketitle
\\tableofcontents

\\chapter{Preface}
This monograph covers modern distributed systems and collaborative algorithms.

\\mainmatter
\\chapter{Foundations}
\\section{Introduction}
Modern collaborative authoring relies on conflict-free data models and real-time synchronization.

\\section{Formal Model}
Consider an event-driven architecture with optimistic replication:
\\begin{equation}
  S_{t+1} = \\delta(S_t, e)
\\end{equation}

\\chapter{Architecture Design}
\\section{Subsystems Overview}
Detailed architectural breakdown of the system components.

\\backmatter
\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`,
        'references.bib': `@book{tanenbaum2007,
  title={Distributed Systems: Principles and Paradigms},
  author={Tanenbaum, Andrew S and Van Steen, Maarten},
  year={2007},
  publisher={Prentice-Hall}
}`,
      },
    },
    {
      id: '10000000-0000-0000-0000-000000000009',
      slug: 'formal-letter',
      versionId: 'tmpl-formal-letter-v1',
      aliases: ['letter', 'recommendation-letter'],
      name: 'Formal Academic & Institutional Letter',
      title: 'Formal Academic & Institutional Letter',
      category: 'letter',
      description:
        'Professional letter template for recommendation, institutional correspondence, and inquiries.',
      compiler: 'pdflatex',
      imageName: 'texlive/texlive:latest',
      mainFile: 'main.tex',
      author: 'Flux Academic Team',
      tags: ['letter', 'formal', 'recommendation', 'correspondence'],
      isOfficial: true,
      downloadCount: 490,
      files: {
        'main.tex': `\\documentclass[11pt]{letter}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\signature{Prof. Jane Doe\\\\Department Chair\\\\Faculty of Computer Science}
\\address{Department of Computer Science\\\\University of Science\\\\123 University Avenue}

\\begin{document}

\\begin{letter}{Admissions Committee\\\\Graduate School of Engineering\\\\456 Academic Boulevard}

\\opening{Dear Members of the Committee,}

I am writing this letter of recommendation with great enthusiasm on behalf of the applicant. During their tenure in our laboratory, they demonstrated exceptional intellectual rigor, algorithmic creativity, and collaborative leadership.

They made key contributions to our research on distributed systems and scientific authoring environments. Their ability to synthesize complex mathematical formulations into elegant code distinguishes them among their peers.

I recommend them without reservation for admission to your graduate program. Should you require further details, please feel free to reach out to me directly.

\\closing{Sincerely yours,}

\\end{letter}
\\end{document}`,
      },
    },
    {
      id: '10000000-0000-0000-0000-000000000010',
      slug: 'course-assignment',
      versionId: 'tmpl-course-assignment-v1',
      aliases: ['assignment', 'homework', 'problem-set'],
      name: 'Coursework & Problem Set Assignment',
      title: 'Coursework & Problem Set Assignment',
      category: 'assignment',
      description:
        'Structured assignment and homework template with formatted problem statements and solutions.',
      compiler: 'pdflatex',
      imageName: 'texlive/texlive:latest',
      mainFile: 'main.tex',
      author: 'Flux Academic Team',
      tags: ['assignment', 'homework', 'coursework', 'problem-set'],
      isOfficial: true,
      downloadCount: 820,
      files: {
        'main.tex': `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{fancyhdr}

\\pagestyle{fancy}
\\lhead{CS 401: Advanced Algorithms}
\\chead{Problem Set 1}
\\rhead{Student: Jane Doe (ID: 123456)}

\\theoremstyle{definition}
\\newtheorem{problem}{Problem}

\\begin{document}

\\begin{center}
  {\\Large\\textbf{Problem Set 1: Graph Algorithms \\& Dynamic Programming}} \\\\[0.5em]
  {\\small Due: \\today}
\\end{center}

\\begin{problem}
Prove that Dijkstra's algorithm correctly computes single-source shortest paths on graphs with non-negative edge weights.
\\end{problem}

\\noindent\\textbf{Solution:}
We proceed by mathematical induction on the number of finalized vertices in set $S$.
Base case: For $|S| = 1$, the source vertex $s$ satisfies $d[s] = 0$, which is trivially optimal.
Inductive step: Let $u$ be the next vertex chosen with minimum tentative distance $d[u]$...

\\begin{problem}
Formulate a dynamic programming recurrence for the longest common subsequence problem with time complexity $O(mn)$.
\\end{problem}

\\noindent\\textbf{Solution:}
Let $L[i,j]$ denote the length of the longest common subsequence of $X[1..i]$ and $Y[1..j]$.
\\begin{equation}
  L[i, j] = \\begin{cases}
    0 & \\text{if } i = 0 \\text{ or } j = 0 \\\\
    L[i-1, j-1] + 1 & \\text{if } X[i] = Y[j] \\\\
    \\max(L[i-1, j], L[i, j-1]) & \\text{if } X[i] \\neq Y[j]
  \\end{cases}
\\end{equation}

\\end{document}`,
      },
    },
    {
      id: '10000000-0000-0000-0000-000000000011',
      slug: 'scientific-poster',
      versionId: 'tmpl-scientific-poster-v1',
      aliases: ['poster', 'conference-poster'],
      name: 'Scientific Conference Poster',
      title: 'Scientific Conference Poster',
      category: 'poster',
      description:
        'Single-page landscape poster layout for conferences and research symposiums.',
      compiler: 'pdflatex',
      imageName: 'texlive/texlive:latest',
      mainFile: 'main.tex',
      author: 'Flux Academic Team',
      tags: ['poster', 'conference', 'symposium', 'landscape'],
      isOfficial: true,
      downloadCount: 610,
      files: {
        'main.tex': `\\documentclass[20pt,landscape]{article}
\\usepackage[a1paper,margin=1.5cm]{geometry}
\\usepackage{multicol}
\\usepackage{xcolor}
\\usepackage{amsmath,amssymb}
\\usepackage{tcolorbox}

\\pagestyle{empty}

\\begin{document}

\\begin{center}
  {\\Huge\\textbf{\\textcolor{blue!70!black}{Real-Time Collaborative Scientific Authoring with Flux}}} \\\\[0.4em]
  {\\Large Author Name$^1$, Co-Author Name$^2$} \\\\[0.2em]
  {\\normalsize $^1$Department of Computer Science, $^2$Institute for Advanced Studies}
\\end{center}

\\vspace{1cm}
\\begin{multicols}{3}

\\begin{tcolorbox}[title=1. Abstract \\& Motivation,colback=white,colframe=blue!60!black]
Scientific manuscript preparation demands high precision and collaborative efficiency. We present an end-to-end cloud platform supporting native LaTeX compilation and conflict-free concurrent editing.
\\end{tcolorbox}

\\begin{tcolorbox}[title=2. Mathematical Formulation,colback=white,colframe=blue!60!black]
We model state transitions via CRDT commutativity:
\\begin{equation}
  A \\ast B = B \\ast A
\\end{equation}
Guaranteed convergence without central locking overhead.
\\end{tcolorbox}

\\begin{tcolorbox}[title=3. Experimental Results,colback=white,colframe=blue!60!black]
Evaluation across 100 concurrent authors demonstrates sub-50ms synchronization latency.
\\end{tcolorbox}

\\begin{tcolorbox}[title=4. Conclusion \\& Future Work,colback=white,colframe=blue!60!black]
Flux provides Overleaf parity while advancing distributed document consistency.
\\end{tcolorbox}

\\end{multicols}

\\end{document}`,
      },
    },
    {
      id: '10000000-0000-0000-0000-000000000012',
      slug: 'technical-report',
      versionId: 'tmpl-technical-report-v1',
      aliases: ['report', 'engineering-report', 'tech-report'],
      name: 'Technical & Engineering Report',
      title: 'Technical & Engineering Report',
      category: 'report',
      description:
        'Clean technical report with executive summary, metadata banner, and structured appendices.',
      compiler: 'pdflatex',
      imageName: 'texlive/texlive:latest',
      mainFile: 'main.tex',
      author: 'Flux Academic Team',
      tags: ['report', 'technical', 'engineering', 'whitepaper'],
      isOfficial: true,
      downloadCount: 710,
      files: {
        'main.tex': `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,graphicx,hyperref}
\\usepackage{fancyhdr}

\\pagestyle{fancy}
\\lhead{Engineering Technical Report TR-2026-01}
\\rhead{Flux Engineering Team}

\\title{\\textbf{Performance Analysis and Scalability of the Ingestion Pipeline}}
\\author{Flux Research \\& Systems Team}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
This technical report documents the architecture, throughput benchmarks, and resource isolation profiles of the LaTeX compilation and Pandoc transpilation services under high concurrency.
\\end{abstract}

\\section{Executive Summary}
Testing validates linear scalability up to 1,000 active projects with sub-500ms compilation times.

\\section{Methodology \\& Test Setup}
All tests were conducted on standard multi-core container nodes with strict cgroup limits.

\\section{Key Findings}
Worker node sandboxing provides robust tenant isolation without throughput degradation.

\\end{document}`,
      },
    },
  ];
