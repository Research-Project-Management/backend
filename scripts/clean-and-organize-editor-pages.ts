import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import Redis from 'ioredis';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@localhost:5433/flux-db?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function run() {
  console.log(
    '🧹 Cleaning up and reorganizing Editor Pages in FLUX project...',
  );

  // 1. Locate FLUX Project
  const fluxProject = await prisma.project.findFirst({
    where: { identifier: 'FLUX' },
  });

  if (!fluxProject) {
    throw new Error('❌ Project FLUX not found!');
  }
  console.log(
    `📁 Found FLUX project: [${fluxProject.identifier}] ${fluxProject.name} (${fluxProject.id})`,
  );

  // Ensure Project name & description reflect the Lab
  await prisma.project.update({
    where: { id: fluxProject.id },
    data: {
      name: 'Flux Neural Dynamics & AI Research Laboratory',
      description:
        'Phòng Thí Nghiệm Trọng Điểm Trí Tuệ Nhân Tạo & Tính Toán Khoa Học (Flux Lab). Chủ nhiệm Lab: GS. TS. Ngô Tấn Thành. Lĩnh vực nghiên cứu: Physics-Informed Neural Operators (PINO/FNO), High-Performance GPU Computing, và Mô hình hóa dòng chảy rối Navier-Stokes.',
    },
  });

  // 2. Clear old manuscript nodes and docs in FLUX project
  console.log(
    '🗑️ Deleting old cluttered/junk manuscript nodes and docs in FLUX...',
  );
  await prisma.manuscriptNode.deleteMany({
    where: { projectId: fluxProject.id },
  });
  await prisma.manuscriptDoc.deleteMany({
    where: { projectId: fluxProject.id },
  });
  console.log('   ✅ Removed old manuscript records.');

  // 3. Define Clean, High-Quality Content for Research Lab Documents

  // --- Main Paper Files ---
  const MAIN_TEX = `\\documentclass[journal,10pt,twocolumn]{IEEEtran}

% --- Essential Preamble & Formatting ---
\\input{preamble}

\\begin{document}

\\title{Physics-Informed Fourier Neural Operators for Multi-Scale Navier-Stokes Equations}

\\author{
  Prof.~Tan~Thanh~Ngo,
  Dr.~Evelyn~Vance,
  Dr.~Alex~Chen,
  Prof.~Marcus~Brody%
  \\thanks{Prof. Tan Thanh Ngo is with the Flux Laboratory for Neural Computing and Scientific AI (e-mail: ngotanthanh92.26@gmail.com, Lab Director & Corresponding Author).}%
  \\thanks{Dr. E. Vance and Dr. A. Chen are with the Department of Computational Mathematics, Flux Lab.}%
  \\thanks{Prof. M. Brody is with the Department of Applied Mathematics and Theoretical Physics.}%
}

\\markboth{IEEE Transactions on Pattern Analysis and Machine Intelligence,~Vol.~48, No.~2}{Ngo \\MakeLowercase{\\textit{et al.}}: Physics-Informed Neural Operators for Navier-Stokes}

\\maketitle

% --- Modular Section Inclusions ---
\\input{sections/01_abstract}
\\input{sections/02_introduction}
\\input{sections/03_methodology}
\\input{sections/04_experiments}
\\input{sections/05_conclusion}

% --- Tables ---
\\input{tables/benchmark_results}

% --- Bibliography ---
\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}
`;

  const PREAMBLE_TEX = `% ==============================================================================
% Preamble: Essential Math, Algorithms and Typography Packages
% ==============================================================================
\\usepackage{amsmath,amsfonts,amssymb,amsthm}
\\usepackage{mathtools}
\\usepackage{graphicx}
\\usepackage{cite}
\\usepackage{booktabs}
\\usepackage{microtype}
\\usepackage{hyperref}
\\usepackage{cleveref}
\\usepackage{subcaption}
\\usepackage{multirow}
\\usepackage{xcolor}

% Custom Colors
\\definecolor{fluxblue}{RGB}{37, 99, 235}
\\definecolor{fluxgreen}{RGB}{16, 185, 129}
\\definecolor{fluxamber}{RGB}{217, 119, 6}

\\hypersetup{
  colorlinks=true,
  linkcolor=fluxblue,
  citecolor=fluxgreen,
  urlcolor=fluxblue
}

% Math definitions
\\newcommand{\\R}{\\mathbb{R}}
\\newcommand{\\Sobolev}{\\mathcal{H}}
\\newcommand{\\Loss}{\\mathcal{L}}
\\newcommand{\\Norm}[1]{\\left\\lVert #1 \\right\\rVert}
`;

  const REFERENCES_BIB = `@article{li2021fourier,
  title={Fourier neural operator for parametric partial differential equations},
  author={Li, Zongyi and Kovachki, Nikola and Azizzadenesheli, Kamyar and Liu, Burigede and Bhattacharya, Kaushik and Stuart, Andrew and Anandkumar, Anima},
  journal={International Conference on Learning Representations (ICLR)},
  year={2021}
}

@article{raissi2019physics,
  title={Physics-informed neural networks: A deep learning framework for solving forward and inverse problems involving nonlinear partial differential equations},
  author={Raissi, Maziar and Perdikaris, Paris and Karniadakis, George E},
  journal={Journal of Computational Physics},
  volume={378},
  pages={686--707},
  year={2019},
  publisher={Elsevier}
}

@article{lu2021learning,
  title={Learning nonlinear operators via DeepONet based on the universal approximation theorem of operators},
  author={Lu, Lu and Jin, Pengzhan and Pang, Guofei and Zhang, Zhongqiang and Karniadakis, George Em},
  journal={Nature Machine Intelligence},
  volume={3},
  number={3},
  pages={218--229},
  year={2021}
}

@book{pope2000turbulent,
  title={Turbulent Flows},
  author={Pope, Stephen B},
  year={2000},
  publisher={Cambridge University Press}
}

@article{wang2022respecting,
  title={Respecting causality is all you need for training physics-informed neural networks},
  author={Wang, Sifan and Sankaran, Shyam and Perdikaris, Paris},
  journal={Computer Methods in Applied Mechanics and Engineering},
  volume={407},
  pages={115930},
  year={2023}
}
`;

  const SEC_ABSTRACT = `\\begin{abstract}
Predicting high-Reynolds-number turbulent fluid dynamics governed by the Navier-Stokes equations represents one of the grand computational challenges in science and engineering. While classical Direct Numerical Simulations (DNS) demand prohibitive spatio-temporal resolution, conventional deep neural networks suffer from severe generalization failure when deployed across unseen physical domains. In this paper, we propose a Physics-Informed Fourier Neural Operator (PINO) framework that regularizes frequency-space operator representations with an $H^1$ Sobolev gradient norm penalty. By explicitly penalizing high-frequency spectral oscillations and preserving the conservation of vorticity along boundary layers, our model achieves a $850\\times$ inference acceleration over pseudo-spectral solvers while maintaining a relative $L_2$ error below $0.72\\%$ on two-dimensional Kolmogorov turbulence ($Re=10,000$) and three-dimensional Taylor-Green vortex flows. Crucially, the learned operator demonstrates zero-shot super-resolution up to $1024\\times 1024$ mesh grids without retraining.
\\end{abstract}

\\begin{IEEEkeywords}
Fourier Neural Operators, Navier-Stokes Equations, Physics-Informed Deep Learning, Sobolev Regularization, Turbulent Flows.
\\end{IEEEkeywords}
`;

  const SEC_INTRO = `\\section{Introduction}
\\label{sec:introduction}
\\IEEEPARstart{T}{he} mathematical modeling of incompressible fluid flow via the Navier-Stokes equations forms the foundational bedrock of aerospace aerodynamics, climate prediction, and chemical process engineering \\cite{pope2000turbulent}. The governing equations for velocity field $\\mathbf{u}(\\mathbf{x}, t)$ and pressure $p(\\mathbf{x}, t)$ are expressed as:
\\begin{align}
  \\frac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u} \\cdot \\nabla) \\mathbf{u} &= -\\frac{1}{\\rho}\\nabla p + \\nu \\nabla^2 \\mathbf{u} + \\mathbf{f}, \\label{eq:navier_stokes} \\\\
  \\nabla \\cdot \\mathbf{u} &= 0, \\label{eq:incompressibility}
\\end{align}
where $\\nu$ denotes kinematic viscosity and $\\mathbf{f}$ represents external forcing. As the Reynolds number $Re = U L / \\nu$ increases, energy cascades through non-linear convective interactions from macroscopic integral scales down to the Kolmogorov dissipation scale $\\eta \\sim Re^{-3/4}$.

Resolving all active turbulent scales via Direct Numerical Simulation (DNS) incurs computational complexity scaling as $\\mathcal{O}(Re^3)$, rendering long-horizon parametric simulations computationally intractable. In recent years, neural operator architectures such as DeepONet \\cite{lu2021learning} and Fourier Neural Operators (FNO) \\cite{li2021fourier} have emerged as transformative paradigms by learning mappings between infinite-dimensional function spaces. However, unconstrained FNO models frequently violate fundamental physical invariants, producing unphysical energy accumulation at high frequencies.

In this work, we demonstrate that incorporating Sobolev loss regularization into Fourier spectral convolution layers simultaneously eliminates high-frequency noise and guarantees exact divergence-free velocity fields.
`;

  const SEC_METHODOLOGY = `\\section{Methodology & Mathematical Formulation}
\\label{sec:methodology}
Let $\\Omega \\subset \\R^d$ be a bounded domain with Lipschitz boundary $\\partial\\Omega$. We consider the parametric operator $\\mathcal{G}^\\dagger: \\mathcal{A} \\to \\mathcal{U}$ mapping initial vorticity conditions $\\omega_0 \\in \\mathcal{A}$ to time-evolved velocity states $\\mathbf{u}(\\cdot, T) \\in \\mathcal{U}$.

\\subsection{Fourier Spectral Layer}
The core building block of the neural operator parameterizes the kernel integral via discrete Fourier transform:
\\begin{equation}
  (\\mathcal{K}(v))(x) = \\mathcal{F}^{-1} \\left( R_\\phi \\cdot (\\mathcal{F} v) \\right)(x),
\\end{equation}
where $\\mathcal{F}$ denotes the Fast Fourier Transform (FFT), $\\mathcal{F}^{-1}$ is its inverse, and $R_\\phi \\in \\mathbb{C}^{k_{\\max} \\times k_{\\max} \\times d_v \\times d_v}$ is a complex-valued weight tensor truncated at maximum frequency mode $k_{\\max} = 32$.

\\subsection{Physics-Informed Sobolev Regularization}
To enforce spatial smoothness and prevent spectral leakage, we formulate the composite optimization objective:
\\begin{equation}
  \\Loss(\\theta) = \\Loss_{\\text{data}}(\\theta) + \\lambda_{\\text{pde}} \\Loss_{\\text{physics}}(\\theta) + \\lambda_H \\Norm{\\nabla (\\mathbf{u}_\\theta - \\mathbf{u}^\\dagger)}_{L^2(\\Omega)}^2,
\\end{equation}
where $\\lambda_H = 10^{-2}$ penalizes spatial derivative errors, thereby directly penalizing unphysical vorticity generation.
`;

  const SEC_EXPERIMENTS = `\\section{Experimental Results & Benchmarks}
\\label{sec:experiments}
We evaluate our Physics-Informed FNO framework on two canonical turbulent flow benchmarks:
\\begin{enumerate}
  \\item \\textbf{2D Kolmogorov Turbulence:} Forced periodic domain with $Re = 10,000$ and $N = 10,000$ high-fidelity DNS snapshots generated on a $512 \\times 512$ spatial grid.
  \\item \\textbf{3D Taylor-Green Vortex:} Canonical transition to turbulence benchmark tracking kinetic energy dissipation rate $\\varepsilon(t) = -\\frac{dE_k}{dt}$ against spectral element solver Nek5000.
\\end{enumerate}

Training was conducted on the Flux Lab HPC cluster utilizing $4\\times$ NVIDIA A100 SXM4 80GB GPUs with Distributed Data Parallel (DDP). The FlashAttention Fourier kernel reduced peak VRAM consumption from $72\\,\\text{GB}$ to $36\\,\\text{GB}$, permitting batch size $B=64$.
`;

  const SEC_CONCLUSION = `\\section{Conclusion}
\\label{sec:conclusion}
We have presented a physics-informed Fourier Neural Operator architecture equipped with $H^1$ Sobolev regularization for multi-scale Navier-Stokes simulations. By bridging spectral representation theory with rigorous conservation laws, our method provides a reliable, mesh-independent surrogate model capable of accelerating turbulent flow computations by nearly three orders of magnitude. Future work will investigate foundation operator models for complex industrial geometries and coupled multi-physics systems.
`;

  const TABLE_BENCHMARKS = `\\begin{table*}[t]
\\centering
\\caption{Performance comparison on 2D Kolmogorov turbulence ($Re=10,000$) on $512 \\times 512$ grid.}
\\label{tab:benchmarks}
\\begin{tabular}{lccccc}
\\toprule
\\textbf{Model Architecture} & \\textbf{Relative $L_2$ Error (\\%)} & \\textbf{Vorticity Dissipation} & \\textbf{Inference Time (ms)} & \\textbf{Speedup} & \\textbf{GPU Memory} \\\\
\\midrule
Spectral DNS (Nek5000) & Baseline & Reference & 1,420.0 & $1.0\\times$ & N/A (CPU Cluster) \\\\
Vanilla MLP & $34.80\\%$ & Diverged & 1.2 & $1,180\\times$ & $4.2\\,\\text{GB}$ \\\\
Standard PINN (Raissi et al.) & $8.45\\%$ & $14.2\\%$ Error & 45.0 & $31.5\\times$ & $12.8\\,\\text{GB}$ \\\\
DeepONet (Lu et al.) & $3.12\\%$ & $5.8\\%$ Error & 8.6 & $165\\times$ & $18.4\\,\\text{GB}$ \\\\
Standard FNO-2D & $1.85\\%$ & $3.4\\%$ Error & 2.1 & $676\\times$ & $72.0\\,\\text{GB}$ \\\\
\\textbf{Flux Lab PINO (Ours)} & \\textbf{0.72\\%} & \\textbf{0.4\\% Error} & \\textbf{1.67} & \\textbf{850\\times} & \\textbf{36.0\\,GB} \\\\
\\bottomrule
\\end{tabular}
\\end{table*}
`;

  // --- Document 2: NAFOSTED Grant Proposal ---
  const GRANT_PROPOSAL_TEX = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{geometry}
\\geometry{margin=2.5cm}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs}
\\usepackage{hyperref}

\\title{\\textbf{THUYẾT MINH ĐỀ TÀI KHOA HỌC VÀ CÔNG NGHỆ QUỐC GIA}\\\\
\\large Nghiên cứu Làm chủ Công nghệ Nền tảng Neural Operators trong Mô phỏng Đa Vật lý và Động lực học Chất lưu Dòng rối}

\\author{
  \\textbf{Chủ nhiệm đề tài:} GS. TS. Ngô Tấn Thành\\\\
  \\textbf{Cơ quan chủ trì:} Flux Laboratory for Neural Computing and Scientific AI\\\\
  \\textbf{Đồng chủ nhiệm:} Dr. Evelyn Vance \\quad \\textbf{Nghiên cứu viên:} Dr. Alex Chen
}

\\date{Giai đoạn tài trợ: 2026 -- 2028 \\quad | \\quad Mã số: NAFOSTED-AI-2026-08}

\\begin{document}
\\maketitle

\\section*{1. Tóm tắt mục tiêu nghiên cứu (Executive Summary)}
Đề tài hướng tới việc giải quyết bài toán nút thắt cổ chai về chi phí tính toán trong cơ học chất lưu hiện đại (Computational Fluid Dynamics - CFD). Thông qua việc xây dựng họ kiến trúc mạng toán tử Fourier Neural Operators (FNO) và Physics-Informed Neural Operators (PINO), phòng thí nghiệm Flux Lab đặt mục tiêu:
\\begin{itemize}
  \\item Tăng tốc độ mô phỏng số dòng chảy rối Reynolds cao ($Re > 10,000$) lên tối thiểu 500 lần so với các phương pháp giải phần tử hữu hạn/thể tích hữu hạn cổ điển.
  \\item Bảo toàn các định luật vật lý cơ bản (định luật bảo toàn khối lượng, bảo toàn động lượng và độ xoáy) với sai số dưới $1.0\\%$.
  \\item Đạt tính năng siêu phân giải không phụ thuộc lưới (Zero-shot Mesh-Independence).
\\end{itemize}

\\section*{2. Dự toán ngân sách và Thiết bị (Budget & Hardware Allocation)}
Tổng kinh phí đề xuất: \\textbf{14.8 Tỷ VNĐ}, bao gồm:
\\begin{itemize}
  \\item \\textbf{Trang thiết bị tính toán:} Mua sắm cụm máy chủ 8x NVIDIA H100 SXM5 80GB kết nối mạng InfiniBand 400Gbps (9.2 Tỷ VNĐ).
  \\item \\textbf{Học bổng Nghiên cứu sinh:} Tài trợ 2 suất học bổng toàn phần Ph.D. trong 3 năm (1.8 Tỷ VNĐ).
  \\item \\textbf{Công bố quốc tế & Hội nghị:} Đăng bài trên các tạp chí nhóm Q1 (Journal of Fluid Mechanics, Nature Machine Intelligence) và tham dự NeurIPS / ICML (1.6 Tỷ VNĐ).
  \\item \\textbf{Chi phí vận hành & lưu trữ dữ liệu lớn:} (2.2 Tỷ VNĐ).
\\end{itemize}

\\section*{3. Kế hoạch công bố và Sản phẩm dự kiến}
\\begin{enumerate}
  \\item Tối thiểu 03 bài báo khoa học trên các tạp chí quốc tế uy tín thuộc danh mục ISI/Scopus (Q1).
  \\item 01 Bộ dữ liệu mở về dòng chảy rối Kolmogorov và Taylor-Green đạt chuẩn FAIR Data.
  \\item 01 Gói phần mềm mã nguồn mở \\texttt{Flux-PINO} tích hợp framework PyTorch và Slurm cluster.
\\end{enumerate}

\\end{document}
`;

  // --- Document 3: Lab Operating Handbook & SOP ---
  const LAB_HANDBOOK_TEX = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{geometry}
\\geometry{margin=2.5cm}
\\usepackage{hyperref}
\\usepackage{xcolor}

\\title{\\textbf{FLUX LABORATORY OPERATING HANDBOOK (SOP)}\\\\
\\large Quy chế Vận hành Phòng Thí nghiệm & Quản trị Cụm Siêu Máy Tính GPU}
\\author{Ban Giám Đốc Lab: GS. TS. Ngô Tấn Thành (PI) \\& Dr. Evelyn Vance (Co-PI)}
\\date{Ban hành: Mùa Thu 2026 \\quad | \\quad Phiên bản: 4.2}

\\begin{document}
\\maketitle

\\section{Quy định Điều phối Cụm Siêu Máy Tính (HPC / GPU Cluster)}
Phòng thí nghiệm hiện vận hành 4 node máy chủ NVIDIA A100 SXM4 80GB và 2 node trạm kiểm thử. Mọi thành viên lab bắt buộc tuân thủ:
\\begin{enumerate}
  \\item \\textbf{Cơ chế lập lịch Slurm:} Tuyệt đối không chạy tiến trình nền (background process / nohup) trực tiếp trên node đăng nhập (login node). Mọi tác vụ huấn luyện phải thông qua lệnh \\texttt{sbatch} hoặc \\texttt{srun}.
  \\item \\textbf{Phân bổ hàng đợi (Partitions):}
  \\begin{itemize}
    \\item \\texttt{gpu-research}: Dành riêng cho các đợt chạy huấn luyện mô hình lớn (giới hạn tối đa 72 giờ/job).
    \\item \\texttt{gpu-interactive}: Dành cho debug, kiểm thử mã nguồn và notebook (giới hạn tối đa 2 giờ/job).
  \\end{itemize}
  \\item \\textbf{Giải phóng bộ nhớ VRAM:} Khi job hoàn thành hoặc bị hủy, người dùng có trách nhiệm kiểm tra tiến trình zombie qua \\texttt{nvidia-smi} để tránh chiếm dụng bộ nhớ của đồng nghiệp.
\\end{enumerate}

\\section{Quy chuẩn Quản trị Mã nguồn & Soạn thảo LaTeX}
\\begin{itemize}
  \\item \\textbf{Git Workflow:} Mọi nhánh tính năng (feature branch) phải được tạo từ \\texttt{main} và tạo Pull Request có tối thiểu 01 code review từ thành viên chính thức trước khi merge.
  \\item \\textbf{Soạn thảo tài liệu:} Sử dụng trình soạn thảo tích hợp Flux Editor. Mọi file \\texttt{.tex} phải chia nhỏ theo từng section trong thư mục \\texttt{sections/}, không viết toàn bộ bài báo vào file \\texttt{main.tex}.
  \\item \\textbf{Trích dẫn BibTeX:} Khóa trích dẫn (citation key) phải chuẩn hóa theo định dạng \\texttt{[author][year][first-word-title]} (ví dụ: \\texttt{li2021fourier}).
\\end{itemize}

\\section{Sinh hoạt Khoa học & Lịch Giao Ban}
Họp giao ban toàn thể Lab diễn ra định kỳ vào \\textbf{09:30 AM Thứ Năm hàng tuần} tại Phòng Hội thảo 402 hoặc trực tuyến qua Zoom. Mỗi tuần, 01 nghiên cứu sinh sẽ chủ trì buổi \\textit{Journal Club} phân tích 01 bài báo xuất sắc mới xuất bản.
\\end{document}
`;

  // --- Document 4: Technical Report ---
  const TECHNICAL_REPORT_TEX = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{geometry}
\\geometry{margin=2.5cm}
\\usepackage{amsmath,amssymb}
\\usepackage{booktabs}
\\usepackage{graphicx}

\\title{\\textbf{BÁO CÁO THỬ NGHIỆM KỸ THUẬT: ZERO-SHOT MESH SUPER-RESOLUTION}\\\\
\\large Đánh giá Khả năng Khái quát hóa của Fourier Neural Operator trên Lưới Siêu Mịn ($1024 \\times 1024$)}
\\author{Thực hiện: Alex Chen \\quad | \\quad Cố vấn: GS. TS. Ngô Tấn Thành}
\\date{Flux Lab Technical Report TR-2026-03}

\\begin{document}
\\maketitle

\\section*{1. Đặt vấn đề và Mục tiêu thử nghiệm}
Một trong những ưu điểm vượt trội của toán tử Fourier Neural Operator so với các mạng nơ-ron tích chập (CNN) thông thường là tính độc lập với độ phân giải lưới tính toán (mesh-independence). Trong thử nghiệm này, chúng tôi đánh giá mô hình được huấn luyện trên lưới độ phân giải thấp $256 \\times 256$, sau đó đưa trực tiếp vào suy luận (zero-shot evaluation) trên lưới $1024 \\times 1024$ mà không cần huấn luyện lại bất kỳ trọng số nào.

\\section*{2. Kết quả đo kiểm thực nghiệm}
Đối soát với solver phần tử phổ Nek5000:
\\begin{itemize}
  \\item \\textbf{Sai số tương đối $L_2$ trên lưới $256 \\times 256$:} $0.68\\%$.
  \\item \\textbf{Sai số tương đối $L_2$ zero-shot trên lưới $512 \\times 512$:} $0.72\\%$.
  \\item \\textbf{Sai số tương đối $L_2$ zero-shot trên lưới $1024 \\times 1024$:} $0.89\\%$.
  \\item \\textbf{Thời gian suy luận:} $6.4\\,\\text{ms}$ cho 1 bước thời gian trên 01 card GPU NVIDIA A100.
\\end{itemize}

\\section*{3. Kết luận}
Toán tử FNO duy trì độ chính xác tuyệt vời khi chuyển dịch độ phân giải lên gấp 16 lần số lượng mắt lưới. Đường cong tiêu tán năng lượng động học khớp với lý thuyết Kolmogorov $-5/3$ đến bậc wavenumber $k=64$.
\\end{document}
`;

  // --- Document 5: Journal Club Notes ---
  const JOURNAL_CLUB_TEX = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{geometry}
\\geometry{margin=2.5cm}
\\usepackage{hyperref}

\\title{\\textbf{FLUX LAB JOURNAL CLUB & SEMINAR PROCEEDINGS}\\\\
\\large Tổng Hợp Báo Cáo Sinh Hoạt Học Thuật & Đánh Giá Tiền Ấn Phẩm}
\\author{Thư ký học thuật: Sarah Jenkins, M.Sc. \\quad | \\quad Chủ trì: GS. TS. Ngô Tấn Thành}
\\date{Kỳ Mùa Thu 2026}

\\begin{document}
\\maketitle

\\section*{Kỳ 1: Phân tích kiến trúc U-FNO và Geometry-Aware Neural Operators}
\\textbf{Người trình bày:} Dr. Alex Chen \\\\
\\textbf{Thời gian:} Thứ Năm, 18/09/2026\\\\
\\textbf{Tài liệu thảo luận:} Li et al., \\textit{"Geometry-Informed Neural Operator for Complex Domain PDEs"}, NeurIPS 2025.

\\subsection*{Nội dung trọng tâm:}
Mô hình FNO cổ điển gặp khó khăn với các miền biên cong phức tạp (như cánh máy bay hoặc động cơ tuabin) do giả định chu kỳ của phép biến đổi Fourier. U-FNO kết hợp các kết nối tắt (skip connections) của U-Net với các lớp phổ Fourier giúp cải thiện độ phân giải cục bộ tại các lớp biên ranh giới.

\\subsection*{Định hướng áp dụng cho Flux Lab:}
Nhóm nghiên cứu của Lab sẽ tích hợp cơ chế ánh xạ tọa độ biến dạng (coordinate transformation mapping) vào PINO để mở rộng thử nghiệm trên các biên phi chu kỳ từ tháng 11/2026.

\\vspace{1cm}
\\section*{Kỳ 2: Tối ưu hóa hàm mất mát bảo toàn động lượng và tính nhân quả}
\\textbf{Người trình bày:} GS. TS. Ngô Tấn Thành \\\\
\\textbf{Thời gian:} Thứ Năm, 25/09/2026\\\\
\\textbf{Thảo luận chuyên sâu:} Phương pháp Causality-preserving PINNs (Wang et al., CMAME 2023). Tích hợp hàm trọng số thích nghi thời gian để ngăn ngừa hiện tượng hội tụ cục bộ tại các thời điểm ban đầu.
\\end{document}
`;

  // 4. Batch Create the Cleaned Documents & Nodes in foreign-key safe order
  console.log('📝 Creating clean, structured Documents and Nodes...');

  // Helper to create doc and node
  const createDocWithNode = async (params: {
    name: string;
    path: string;
    content: string;
    isRootDoc: boolean;
    sortOrder: number;
    type?: 'DOC' | 'FOLDER';
  }) => {
    const { name, path, content, isRootDoc, sortOrder, type = 'DOC' } = params;

    let docId: string | null = null;
    let sizeBytes = 0;

    if (type === 'DOC') {
      const lines = content.split('\n');
      sizeBytes = Buffer.byteLength(content, 'utf8');
      const doc = await prisma.manuscriptDoc.create({
        data: {
          projectId: fluxProject.id,
          path,
          lines,
          sizeBytes,
          rev: 1,
          version: 1,
        },
      });
      docId = doc.id;
    }

    const node = await prisma.manuscriptNode.create({
      data: {
        projectId: fluxProject.id,
        name,
        path,
        type,
        docId,
        isRootDoc,
        sizeBytes,
        sortOrder,
      },
    });

    return { docId, nodeId: node.id };
  };

  // --- Document 1 (Root Page 1): Main Research Paper ---
  console.log(
    '   📄 [1/5] Root Page: 01. Research Paper: Physics-Informed Neural Operators for Navier-Stokes...',
  );
  await createDocWithNode({
    name: '01. Research Paper: Physics-Informed Neural Operators for Navier-Stokes',
    path: '/main.tex',
    content: MAIN_TEX,
    isRootDoc: true,
    sortOrder: 1,
  });

  // Supporting files for Main Paper
  await createDocWithNode({
    name: 'preamble.tex',
    path: '/preamble.tex',
    content: PREAMBLE_TEX,
    isRootDoc: false,
    sortOrder: 2,
  });

  await createDocWithNode({
    name: 'references.bib',
    path: '/references.bib',
    content: REFERENCES_BIB,
    isRootDoc: false,
    sortOrder: 3,
  });

  // Section folder & files
  await createDocWithNode({
    name: 'sections',
    path: '/sections',
    content: '',
    isRootDoc: false,
    sortOrder: 10,
    type: 'FOLDER',
  });

  await createDocWithNode({
    name: 'sections/01_abstract.tex',
    path: '/sections/01_abstract.tex',
    content: SEC_ABSTRACT,
    isRootDoc: false,
    sortOrder: 11,
  });

  await createDocWithNode({
    name: 'sections/02_introduction.tex',
    path: '/sections/02_introduction.tex',
    content: SEC_INTRO,
    isRootDoc: false,
    sortOrder: 12,
  });

  await createDocWithNode({
    name: 'sections/03_methodology.tex',
    path: '/sections/03_methodology.tex',
    content: SEC_METHODOLOGY,
    isRootDoc: false,
    sortOrder: 13,
  });

  await createDocWithNode({
    name: 'sections/04_experiments.tex',
    path: '/sections/04_experiments.tex',
    content: SEC_EXPERIMENTS,
    isRootDoc: false,
    sortOrder: 14,
  });

  await createDocWithNode({
    name: 'sections/05_conclusion.tex',
    path: '/sections/05_conclusion.tex',
    content: SEC_CONCLUSION,
    isRootDoc: false,
    sortOrder: 15,
  });

  // Table folder & file
  await createDocWithNode({
    name: 'tables',
    path: '/tables',
    content: '',
    isRootDoc: false,
    sortOrder: 20,
    type: 'FOLDER',
  });

  await createDocWithNode({
    name: 'tables/benchmark_results.tex',
    path: '/tables/benchmark_results.tex',
    content: TABLE_BENCHMARKS,
    isRootDoc: false,
    sortOrder: 21,
  });

  // Documents folder
  await createDocWithNode({
    name: 'documents',
    path: '/documents',
    content: '',
    isRootDoc: false,
    sortOrder: 30,
    type: 'FOLDER',
  });

  // --- Document 2 (Root Page 2): Grant Proposal ---
  console.log(
    '   📄 [2/5] Root Page: 02. [Grant Proposal] NAFOSTED & NSF Grand Challenge...',
  );
  await createDocWithNode({
    name: '02. [Grant Proposal] NAFOSTED & NSF Grand Challenge (2026-2028)',
    path: '/documents/01_grant_proposal.tex',
    content: GRANT_PROPOSAL_TEX,
    isRootDoc: true,
    sortOrder: 31,
  });

  // --- Document 3 (Root Page 3): Technical Report ---
  console.log(
    '   📄 [3/5] Root Page: 03. [Technical Report] Zero-Shot Mesh Super-Resolution...',
  );
  await createDocWithNode({
    name: '03. [Technical Report] Zero-Shot Mesh Super-Resolution on Nek5000',
    path: '/documents/02_technical_report.tex',
    content: TECHNICAL_REPORT_TEX,
    isRootDoc: true,
    sortOrder: 32,
  });

  // --- Document 4 (Root Page 4): Lab Handbook SOP ---
  console.log(
    '   📄 [4/5] Root Page: 04. [SOP] Flux Lab Operating Handbook & GPU Cluster Protocol...',
  );
  await createDocWithNode({
    name: '04. [SOP] Flux Lab Operating Handbook & GPU Cluster Protocol',
    path: '/documents/03_lab_handbook.tex',
    content: LAB_HANDBOOK_TEX,
    isRootDoc: true,
    sortOrder: 33,
  });

  // --- Document 5 (Root Page 5): Journal Club Notes ---
  console.log(
    '   📄 [5/5] Root Page: 05. [Journal Club] Biên bản Thảo luận Khoa học Hàng tuần...',
  );
  await createDocWithNode({
    name: '05. [Journal Club] Biên bản Thảo luận Khoa học Hàng tuần',
    path: '/documents/04_journal_club_notes.tex',
    content: JOURNAL_CLUB_TEX,
    isRootDoc: true,
    sortOrder: 34,
  });

  // 5. Invalidate Redis Caches
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const keys = await redis.keys('*');
    const targetKeys = keys.filter(
      (k) =>
        k.includes('doc') ||
        k.includes('page') ||
        k.includes('manuscript') ||
        k.includes('project') ||
        k.includes('flux:wi'),
    );
    if (targetKeys.length > 0) {
      await redis.del(...targetKeys);
      console.log(`🧹 Flushed ${targetKeys.length} Redis cache keys.`);
    }
    await redis.quit();
  } catch (err) {
    console.warn('⚠️ Warning Redis flush:', err);
  }

  console.log(
    '\n🎉 ALL DONE! Editor & Pages data reorganized into 5 pristine, academic research documents.',
  );
}

run()
  .catch((e) => {
    console.error('❌ Error organizing pages:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
