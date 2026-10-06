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

  public async getTemplateById(
    templateId: string,
  ): Promise<ProjectTemplate | null> {
    return this.templates.get(templateId) || null;
  }

  private seedDefaultTemplates(): void {
    const defaultTemplates: ProjectTemplate[] = [
      new ProjectTemplate({
        id: 'ieee-transactions',
        title: 'IEEE Transactions Journal Template',
        category: 'journal',
        description:
          'Standard two-column template for IEEE journals and transactions with IEEEtran class.',
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
        description:
          'Official ACM master article template for proceedings and conferences (acmart).',
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
        category: 'journal',
        description:
          'Clean single-column preprint suitable for direct submission to arXiv.',
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
        description:
          'Lecture Notes in Computer Science (LNCS) proceedings template.',
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
        description:
          'Modern 16:9 aspect ratio slide deck for conferences and thesis defense.',
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
      new ProjectTemplate({
        id: 'academic-book',
        title: 'Academic Book / Monograph',
        category: 'book',
        description:
          'Comprehensive multi-chapter book template with front matter, index, and bibliography.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[11pt,a4paper,openany]{book}
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
          },
          {
            path: 'references.bib',
            content: `@book{tanenbaum2007,
  title={Distributed Systems: Principles and Paradigms},
  author={Tanenbaum, Andrew S and Van Steen, Maarten},
  year={2007},
  publisher={Prentice-Hall}
}`,
          },
        ],
      }),
      new ProjectTemplate({
        id: 'formal-letter',
        title: 'Formal Academic & Institutional Letter',
        category: 'letter',
        description:
          'Professional letter template for recommendation, institutional correspondence, and inquiries.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[11pt]{letter}
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
        ],
      }),
      new ProjectTemplate({
        id: 'course-assignment',
        title: 'Coursework & Problem Set Assignment',
        category: 'assignment',
        description:
          'Structured assignment and homework template with formatted problem statements and solutions.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[11pt,a4paper]{article}
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
        ],
      }),
      new ProjectTemplate({
        id: 'scientific-poster',
        title: 'Scientific Conference Poster',
        category: 'poster',
        description:
          'Single-page landscape poster layout for conferences and research symposiums.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[20pt,landscape]{article}
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
        ],
      }),
      new ProjectTemplate({
        id: 'academic-cv',
        title: 'Academic Curriculum Vitae',
        category: 'cv',
        description:
          'Elegant, clean two-page curriculum vitae for faculty positions and postdocs.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{titlesec}

\\titleformat{\\section}{\\large\\bfseries\\uppercase}{}{0em}{}[\\titlerule]
\\titlespacing{\\section}{0pt}{1.5ex}{1ex}
\\pagestyle{empty}

\\begin{document}

\\begin{center}
  {\\LARGE\\textbf{Dr. Alex Mercer}} \\\\[0.3em]
  Postdoctoral Research Fellow in Distributed Systems \\\\[0.2em]
  Email: \\texttt{alex.mercer@institution.edu} \\quad | \\quad Web: \\url{https://flux.org}
\\end{center}

\\section{Education}
\\textbf{Ph.D. in Computer Science} \\hfill 2021--2025 \\\\
University of Science \\hfill Advisor: Prof. Alan Turing \\\\
Dissertation: \\textit{High-Throughput Distributed State Machine Replication}

\\vspace{0.5em}
\\textbf{B.S. in Computer Engineering (Summa Cum Laude)} \\hfill 2017--2021 \\\\
National Institute of Technology

\\section{Research Interests}
Distributed Consensus, Real-time Collaborative Systems, Scientific Typesetting Engines.

\\section{Selected Publications}
\\begin{itemize}
  \\item \\textbf{A. Mercer}, et al. "Sub-millisecond State Convergence in Multi-Master Document Networks." \\textit{ACM SIGCOMM}, 2024.
  \\item \\textbf{A. Mercer} and C. Shannon. "Information-Theoretic Limits of Distributed Synchronization." \\textit{IEEE Transactions on Information Theory}, 2023.
\\end{itemize}

\\section{Honors \\& Awards}
\\begin{itemize}
  \\item Best Paper Award, USENIX OSDI 2024.
  \\item National Science Foundation Graduate Research Fellowship, 2021.
\\end{itemize}

\\end{document}`,
          },
        ],
      }),
      new ProjectTemplate({
        id: 'masters-thesis',
        title: 'Master / PhD Thesis & Dissertation',
        category: 'thesis',
        description:
          'Comprehensive graduate thesis template with signature page, abstract, and chapter structure.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[12pt,a4paper,oneside]{report}
\\usepackage[margin=1.2in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{setspace}
\\doublespacing

\\title{\\textbf{Scalable Architecture for Real-Time Collaborative LaTeX Authoring}}
\\author{Graduate Candidate Name}
\\date{\\today}

\\begin{document}

\\pagenumbering{roman}
\\maketitle

\\chapter*{Abstract}
This thesis investigates the algorithmic foundation and systems architecture of modern collaborative document preparation engines...

\\chapter*{Acknowledgements}
I am deeply indebted to my thesis supervisor and research group for their unwavering support and guidance throughout this project.

\\tableofcontents
\\listoffigures
\\listoftables

\\clearpage
\\pagenumbering{arabic}

\\chapter{Introduction}
\\section{Background}
Scientific publishing relies extensively on LaTeX for mathematical rigor and precise typographical control.

\\section{Problem Statement}
Offline editing workflows introduce substantial merging friction and latency...

\\chapter{System Architecture}
\\section{Distributed Docstore Model}
Overview of the operational transformation and CRDT algorithms deployed in the docstore.

\\chapter{Evaluation}
\\section{Performance Benchmarks}
Detailed latency, memory consumption, and network efficiency benchmarks under varying network partitions.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`,
          },
          {
            path: 'references.bib',
            content: `@article{lamport1978time,
  title={Time, clocks, and the ordering of events in a distributed system},
  author={Lamport, Leslie},
  journal={Communications of the ACM},
  volume={21},
  number={7},
  pages={558--565},
  year={1978}
}`,
          },
        ],
      }),
      new ProjectTemplate({
        id: 'technical-report',
        title: 'Technical & Engineering Report',
        category: 'report',
        description:
          'Clean technical report with executive summary, metadata banner, and structured appendices.',
        author: 'Flux Academic Team',
        defaultRootDoc: 'main.tex',
        files: [
          {
            path: 'main.tex',
            content: `\\documentclass[11pt,a4paper]{article}
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
        ],
      }),
    ];

    for (const t of defaultTemplates) {
      this.templates.set(t.id, t);
    }
  }
}
