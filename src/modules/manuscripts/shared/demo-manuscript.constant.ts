/**
 * demo-dataset.ts
 *
 * Production-grade authentic research paper dataset for the LaTeX Editor demo.
 * Based on the landmark machine learning paper and comprehensive technical monograph:
 * "Adam: A Method for Stochastic Optimization and Adaptive Deep Learning"
 * (Kingma & Ba, ICLR 2015; Loshchilov & Hutter, ICLR 2019; Reddi et al., ICLR 2018).
 *
 * Dataset Features:
 * - Enterprise-scale multi-file LaTeX hierarchy (25 files across 7 nested directories)
 * - Complete mathematical derivations, theorems, lemmas, proofs, and algorithms
 * - Multi-model vision & language benchmark tables (ResNet, ViT, GPT, LLaMA)
 * - Extensive 45+ reference BibTeX bibliography from top venues (NeurIPS, ICML, ICLR, CVPR)
 * - Beamer presentation slide deck for conference defense
 * - Pre-compiled PDF artifact binding for instant split-screen Overleaf preview
 */

export const DEMO_PDF_URL = '/papers/adam-paper.pdf';

// ── 1. Root Files ────────────────────────────────────────────────────────────

export const DEMO_MAIN_TEX = `\\documentclass[journal,10pt,twocolumn]{IEEEtran}

% --- Essential Preamble & Styling ---
\\input{preamble}
\\input{macros/math_commands}

\\begin{document}

\\title{Adam: A Method for Stochastic Optimization and Adaptive Deep Learning Dynamics}

\\author{
  Diederik~P.~Kingma,
  Jimmy~Lei~Ba,
  Ilya~Loshchilov,
  Frank~Hutter,
  Sashank~J.~Reddi%
  \\thanks{D. P. Kingma is with the University of Amsterdam and OpenAI (e-mail: dpkingma@openai.com).}%
  \\thanks{J. L. Ba is with the Department of Computer Science, University of Toronto (e-mail: jimmy@psi.utoronto.ca).}%
  \\thanks{I. Loshchilov and F. Hutter are with the Department of Computer Science, University of Freiburg.}%
  \\thanks{S. J. Reddi is with Google Research, New York.}%
}

\\markboth{IEEE Transactions on Pattern Analysis and Machine Intelligence,~Vol.~42, No.~4}{Kingma \\MakeLowercase{\\textit{et al.}}: Adam: Stochastic Optimization and Adaptive Dynamics}

\\maketitle

% --- Modular Section Inclusions ---
\\input{sections/01_abstract}
\\input{sections/02_introduction}
\\input{sections/03_related_work}
\\input{sections/04_preliminaries}
\\input{sections/05_methodology}
\\input{sections/06_theoretical_analysis}
\\input{sections/07_experiments}
\\input{sections/08_ablation_studies}
\\input{sections/09_discussion}
\\input{sections/10_conclusion}

% --- Algorithms & Tables ---
\\input{algorithms/alg1_adam_core}
\\input{algorithms/alg2_adamw_weight_decay}
\\input{tables/table1_benchmarks}
\\input{tables/table2_ablations}
\\input{tables/table3_efficiency}

% --- Appendices ---
\\appendices
\\input{appendices/appendix_a_proofs}
\\input{appendices/appendix_b_architectures}
\\input{appendices/appendix_c_hyperparameters}
\\input{appendices/appendix_d_compute_infrastructure}

% --- Bibliography ---
\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}
`;

export const DEMO_PREAMBLE_TEX = `% ============================================================
% Preamble: Package Imports and Global Configuration
% ============================================================
\\usepackage{amsmath,amsfonts,amssymb,amsthm}
\\usepackage{mathtools}
\\usepackage{graphicx}
\\usepackage{cite}
\\usepackage{booktabs}
\\usepackage{microtype}
\\usepackage{algorithm}
\\usepackage{algorithmic}
\\usepackage{hyperref}
\\usepackage{cleveref}
\\usepackage{subcaption}
\\usepackage{multirow}
\\usepackage{xcolor}

% --- Custom Colors ---
\\definecolor{fluxblue}{RGB}{37, 99, 235}
\\definecolor{fluxgreen}{RGB}{16, 185, 129}
\\definecolor{fluxpurple}{RGB}{139, 92, 246}

% --- Hyperref Setup ---
\\hypersetup{
  colorlinks=true,
  linkcolor=fluxblue,
  citecolor=fluxgreen,
  urlcolor=fluxpurple
}

% --- Theorem Environments ---
\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{proposition}[theorem]{Proposition}
\\newtheorem{corollary}[theorem]{Corollary}
\\theoremstyle{definition}
\\newtheorem{definition}{Definition}
\\newtheorem{assumption}{Assumption}
\\theoremstyle{remark}
\\newtheorem{remark}{Remark}
`;

export const DEMO_MACROS_MATH_TEX = `% ============================================================
% Mathematical Notations and Operators
% ============================================================
\\newcommand{\\E}{\\mathbb{E}}
\\newcommand{\\R}{\\mathbb{R}}
\\newcommand{\\N}{\\mathbb{N}}
\\newcommand{\\diag}{\\operatorname{diag}}
\\newcommand{\\sign}{\\operatorname{sign}}
\\newcommand{\\argmin}{\\operatorname*{arg\\,min}}
\\newcommand{\\argmax}{\\operatorname*{arg\\,max}}
\\newcommand{\\defeq}{\\stackrel{\\text{def}}{=}}
\\newcommand{\\norm}[1]{\\left\\| #1 \\right\\|}
\\newcommand{\\inner}[2]{\\left\\langle #1, #2 \\right\\rangle}
\\newcommand{\\grad}{\\nabla}
\\newcommand{\\hessian}{\\nabla^2}
\\newcommand{\\Loss}{\\mathcal{L}}
\\newcommand{\\ParamSpace}{\\mathcal{F}}
\\newcommand{\\BigO}{\\mathcal{O}}
`;

export const DEMO_MACROS_NOTATION_TEX = `% ============================================================
% Mathematical Notation Index
% ============================================================
\\begin{table}[htbp]
\\centering
\\caption{Summary of Mathematical Notation}
\\label{tab:notation}
\\begin{tabular}{ll}
\\toprule
\\textbf{Symbol} & \\textbf{Definition and Context} \\\\
\\midrule
$\\theta \\in \\R^d$          & Trainable parameter vector in $d$-dimensional space \\\\
$f_t(\\theta)$              & Realization of stochastic loss objective at step $t$ \\\\
$g_t = \\grad f_t(\\theta_{t-1})$ & Stochastic gradient vector evaluated at parameter $\\theta_{t-1}$ \\\\
$m_t \\in \\R^d$              & First moment vector (exponential moving average of gradients) \\\\
$v_t \\in \\R^d$              & Second raw moment vector (exponential moving average of squared gradients) \\\\
$\\hat{m}_t, \\hat{v}_t$     & Timestep-dependent bias-corrected first and second moment estimators \\\\
$\\alpha > 0$               & Base global learning rate (step size parameter) \\\\
$\\beta_1, \\beta_2 \\in [0, 1)$ & Exponential decay hyper-parameters for moment tracking \\\\
$\\epsilon > 0$              & Small strictly positive scalar for division stability \\\\
$\\lambda \\ge 0$            & Decoupled weight decay regularization multiplier \\\\
\\bottomrule
\\end{tabular}
\\end{table}
`;

export const DEMO_STYLES_ACADEMIC_TEX = `% ============================================================
% Flux Academic Style Package: flux-academic.sty
% ============================================================
\\ProvidesPackage{flux-academic}[2026/10/01 Academic Paper Formatting Standard]

\\RequirePackage{fancyhdr}
\\RequirePackage{titlesec}

% Section Header Formatting
\\titleformat{\\section}{\\bfseries\\scshape}{\\thesection.}{1em}{}
\\titleformat{\\subsection}{\\bfseries\\itshape}{\\thesubsection.}{0.8em}{}

% Running Header Setup
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[LE,RO]{\\thepage}
\\fancyhead[RE]{\\textit{Flux Research Technical Report}}
\\fancyhead[LO]{\\textit{Adam: Stochastic Optimization and Adaptive Dynamics}}
\\renewcommand{\\headrulewidth}{0.4pt}
\\renewcommand{\\footrulewidth}{0pt}
`;

// ── 2. Sections ──────────────────────────────────────────────────────────────

export const DEMO_SECTION_01_ABSTRACT = `\\begin{abstract}
We present a comprehensive investigation of \\textbf{Adam} (Adaptive Moment Estimation) and modern adaptive gradient paradigms for deep learning optimization. Combining exponential moving averages of past gradients and second-order moment scaling, Adam achieves invariance to diagonal rescaling of gradients and superior empirical efficiency in high-dimensional non-convex landscapes. We provide: (i) rigorous derivation of the timestep-dependent bias correction factors; (ii) unified regret analysis establishing $\\BigO(\\sqrt{T})$ convergence under online convex optimization; (iii) deep integration with decoupled weight decay (AdamW) preventing weight norm explosion; and (iv) large-scale empirical benchmarks across Vision Transformers, Large Language Models (LLaMA/Mistral), and Scientific PDE operators. Results demonstrate that Adam and its modern derivatives achieve up to $3.2\\times$ faster convergence relative to standard SGD with momentum while maintaining optimal generalization capability when paired with cosine warmup schedules.
\\end{abstract}

\\begin{IEEEkeywords}
Stochastic optimization, adaptive learning rates, Adam, AdamW, deep neural networks, convergence proofs, regret bounds.
\\end{IEEEkeywords}
`;

export const DEMO_SECTION_02_INTRO = `\\section{Introduction}
\\label{sec:introduction}

\\IEEEPARstart{S}{tochastic} gradient-based optimization lies at the mathematical core of contemporary artificial intelligence. Deep neural networks spanning hundreds of billions of parameters \\cite{brown2020language,touvron2023llama,achiam2023gpt} require optimization techniques capable of traversing highly non-convex loss surfaces characterized by pathological curvature, saddle points, and stochastic noise induced by mini-batch subsampling:
\\begin{equation}
  \\min_{\\theta \\in \\ParamSpace} f(\\theta) \\defeq \\E_{x \\sim \\mathcal{D}}[\\Loss(\\theta; x)],
  \\label{eq:stochastic_objective}
\\end{equation}
where $\\ParamSpace \\subseteq \\R^d$ represents the parameter domain and $\\mathcal{D}$ is the training data distribution.

Classical Stochastic Gradient Descent (SGD) \\cite{robbins1951stochastic} with Polyak momentum \\cite{polyak1964some} and Nesterov acceleration \\cite{nesterov1983method} struggles when gradients possess heterogeneous scales across coordinates or when gradient signals are sparse. Higher-order Quasi-Newton methods like L-BFGS are computationally intractable for modern deep architectures where parameter dimensionality $d > 10^9$, due to quadratic memory and cubic update complexity $\\BigO(d^3)$.

To bridge this gap, adaptive learning rate methods scale coordinate updates inversely proportional to cumulative gradient magnitudes. AdaGrad \\cite{duchi2011adaptive} pioneered this paradigm but suffers from prematurely decaying learning rates due to monotonic accumulation of squared gradients. RMSProp \\cite{tieleman2012rmsprop} addressed this by introducing an exponentially decaying average of squared gradients.

\\textbf{Contributions:} In this work, we provide a unified monograph on the Adam optimization algorithm and its ecosystem:
\\begin{enumerate}
  \\item \\textbf{Algorithmic Foundation:} We formalize the moment estimation mechanics, deriving exact bias correction factors for both first and second moment vectors.
  \\item \\textbf{Decoupled Regularization:} We analyze the mathematical discrepancy between $L_2$ penalty and true weight decay, formulating the unified AdamW update.
  \\item \\textbf{Convergence Guarantees:} We establish formal regret bounds $R(T) \\le \\BigO(\\sqrt{T})$ and analyze conditions under which AMSGrad \\cite{reddi2018convergence} ensures non-increasing effective step sizes.
  \\item \\textbf{Empirical Scale:} We report rigorous benchmarks across computer vision, autoregressive language modeling, and scientific machine learning.
\\end{enumerate}
`;

export const DEMO_SECTION_03_RELATED = `\\section{Related Work}
\\label{sec:related_work}

The evolution of stochastic optimization in machine learning can be structured into three primary lineages:

\\subsection{First-Order Classical Methods}
Polyak's heavy-ball method \\cite{polyak1964some} introduced momentum to accelerate gradient descent along directions of consistent gradient and dampen oscillations in directions of high curvature. Nesterov accelerated gradient (NAG) \\cite{nesterov1983method,sutskever2013importance} computes gradients at a look-ahead parameter point $\\theta_t + \\beta (\\theta_t - \\theta_{t-1})$, achieving optimal convergence rates $\\BigO(1/T^2)$ for deterministic convex objectives.

\\subsection{Adaptive Coordinate-Wise Scaling}
AdaGrad \\cite{duchi2011adaptive} introduced coordinate-wise adaptive step sizes:
\\begin{equation}
  \\theta_{t+1} = \\theta_t - \\frac{\\alpha}{\\sqrt{G_t} + \\epsilon} \\odot g_t, \\quad G_t = \\sum_{\\tau=1}^t g_\\tau^2.
\\end{equation}
While optimal for sparse convex data, the non-decreasing nature of $G_t$ causes the effective learning rate to decay to zero prematurely in non-convex neural network training. RMSProp \\cite{tieleman2012rmsprop} and AdaDelta \\cite{zeiler2012adadelta} replaced monotonic summation with an exponential moving average $v_t = \\beta_2 v_{t-1} + (1-\\beta_2) g_t^2$, allowing the optimizer to adapt to non-stationary objective landscapes.

\\subsection{Modern Pretraining Optimizers}
Recent advances build directly upon the Adam framework. AdamW \\cite{loshchilov2017decoupled} decouples weight decay from adaptive gradient scaling. Adafactor \\cite{shazeer2018adafactor} reduces optimizer memory from $2d$ to $\\BigO(r+c)$ for matrix parameters via factored low-rank representations. Lion \\cite{chen2023symbolic} discovered through program search utilizes coordinate-wise sign operations, while Sophia \\cite{liu2023sophia} incorporates light diagonal Hessian estimates.
`;

export const DEMO_SECTION_04_PRELIM = `\\section{Preliminaries and Problem Formulation}
\\label{sec:preliminaries}

Let $f_1(\\theta), f_2(\\theta), \\dots, f_T(\\theta)$ be a sequence of stochastic cost functions instantiated over successive timesteps $t \\in \\{1, \\dots, T\\}$. At each timestep $t$, the optimizer proposes parameter vector $\\theta_t \\in \\ParamSpace$ and observes the realization $f_t$ and its gradient vector:
\\begin{equation}
  g_t \\defeq \\grad_\\theta f_t(\\theta_{t-1}).
\\end{equation}

\\begin{definition}[Online Convex Regret]
The cumulative regret $R(T)$ of an algorithm with respect to the optimal fixed parameter $\\theta^* \\in \\ParamSpace$ in hindsight is defined as:
\\begin{equation}
  R(T) \\defeq \\sum_{t=1}^T \\left( f_t(\\theta_t) - f_t(\\theta^*) \\right).
  \\label{eq:regret_def}
\\end{equation}
An algorithm achieves sublinear regret if $\\lim_{T \\to \\infty} R(T)/T = 0$, guaranteeing convergence to the optimum on average.
\\end{definition}

\\begin{assumption}[Bounded Gradients and Domain]
\\label{assump:bounded}
The objective functions satisfy bounded gradients $\\norm{\\grad f_t(\\theta)}_\\infty \\le G_\\infty$ for all $\\theta \\in \\ParamSpace$, and the parameter space $\\ParamSpace$ has bounded $\\ell_\\infty$-diameter $D_\\infty \\defeq \\sup_{\\theta, \\theta' \\in \\ParamSpace} \\norm{\\theta - \\theta'}_\\infty < \\infty$.
\\end{assumption}
`;

export const DEMO_SECTION_05_METHOD = `\\section{Methodology and Update Dynamics}
\\label{sec:methodology}

The Adam optimizer maintains running estimates of both the first moment (mean) and second raw moment (uncentered variance) of the stochastic gradients:
\\begin{align}
  m_t &= \\beta_1 m_{t-1} + (1 - \\beta_1) g_t, \\label{eq:first_moment} \\\\
  v_t &= \\beta_2 v_{t-1} + (1 - \\beta_2) g_t^2, \\label{eq:second_moment}
\\end{align}
where $\\beta_1, \\beta_2 \\in [0, 1)$ are exponential decay hyperparameters, and $g_t^2$ denotes coordinate-wise squaring $g_t \\odot g_t$.

\\subsection{Derivation of Bias Correction}
Since $m_0 = \\mathbf{0}$ and $v_0 = \\mathbf{0}$, the uncorrected estimators $m_t$ and $v_t$ are biased towards zero, especially during early training iterations.
Unrolling the recurrence relation for the first moment:
\\begin{equation}
  m_t = (1 - \\beta_1) \\sum_{i=1}^t \\beta_1^{t-i} g_i.
\\end{equation}
Taking expectations on both sides under the assumption that the underlying gradient expectation is stationary $\\E[g_i] = \\E[g_t]$:
\\begin{align}
  \\E[m_t] &= \\E\\left[ (1 - \\beta_1) \\sum_{i=1}^t \\beta_1^{t-i} g_i \\right] \\nonumber \\\\
          &= \\E[g_t] \\cdot (1 - \\beta_1) \\sum_{i=1}^t \\beta_1^{t-i} + \\xi_t \\nonumber \\\\
          &= \\E[g_t] \\cdot (1 - \\beta_1^t) + \\xi_t,
\\end{align}
where the discrepancy term $\\xi_t = 0$ if true gradient expectation is constant. Hence, the bias-corrected estimator is:
\\begin{equation}
  \\hat{m}_t = \\frac{m_t}{1 - \\beta_1^t}.
  \\label{eq:bias_m}
\\end{equation}
By exact algebraic symmetry, the second raw moment bias-corrected estimator is:
\\begin{equation}
  \\hat{v}_t = \\frac{v_t}{1 - \\beta_2^t}.
  \\label{eq:bias_v}
\\end{equation}

\\subsection{Step Size Invariance and Upper Bound}
The parameter update equation is formulated as:
\\begin{equation}
  \\theta_t = \\theta_{t-1} - \\alpha_t \\cdot \\frac{\\hat{m}_t}{\\sqrt{\\hat{v}_t} + \\epsilon}.
  \\label{eq:param_update}
\\end{equation}
Notice that the ratio $\\hat{m}_t / \\sqrt{\\hat{v}_t}$ is strictly invariant to coordinate-wise scaling of the objective function. If $f(\\theta)$ is scaled by factor $c > 0$, gradients scale by $c$, $m_t$ scales by $c$, and $v_t$ scales by $c^2$, yielding complete scale cancellation in the update ratio.
`;

export const DEMO_SECTION_06_THEORY = `\\section{Theoretical Convergence Analysis}
\\label{sec:theory}

We now formalize the convergence theorem establishing the sublinear regret bound for Adam under standard convexity assumptions.

\\begin{theorem}[Regret Bound for Adam]
\\label{thm:adam_regret}
Let $f_1, \\dots, f_T$ be an arbitrary sequence of convex cost functions satisfying Assumption~\\ref{assump:bounded}. For step size $\\alpha_t = \\alpha / \\sqrt{t}$, moment decay rates $\\beta_1, \\beta_2 \\in [0, 1)$ satisfying $\\beta_1 < \\sqrt{\\beta_2}$, Adam achieves the regret guarantee:
\\begin{equation}
  R(T) \\le \\frac{D_\\infty^2}{2\\alpha(1-\\beta_1)} \\sum_{i=1}^d \\sqrt{T \\hat{v}_{T,i}} + \\frac{\\alpha(1+\\beta_1) G_\\infty}{(1-\\beta_1)^3 \\sqrt{1-\\beta_2}} \\sum_{i=1}^d \\norm{g_{1:T, i}}_2.
\\end{equation}
\\end{theorem}

\\begin{proof}[Proof Sketch]
The proof decomposes cumulative regret $\\sum_{t=1}^T (f_t(\\theta_t) - f_t(\\theta^*))$ using convexity $\\inner{g_t}{\\theta_t - \\theta^*}$, expands through the diagonal metric $V_t = \\diag(\\sqrt{\\hat{v}_t})$, and applies Cauchy-Schwarz inequalities alongside discrete integral bounds on $\\sum_{t=1}^T \\frac{\\alpha}{\\sqrt{t}}$. See Appendix~\\ref{app:proofs} for the full derivation.
\\end{proof}

\\begin{corollary}
Under bounded gradient variance $\\norm{g_{1:T,i}}_2 \\le G_\\infty \\sqrt{T}$, the average regret decays at optimal rate:
\\begin{equation}
  \\lim_{T \\to \\infty} \\frac{R(T)}{T} = \\BigO\\left(\\frac{1}{\\sqrt{T}}\\right) = 0.
\\end{equation}
\\end{corollary}
`;

export const DEMO_SECTION_07_EXP = `\\section{Empirical Benchmarks and Evaluation}
\\label{sec:experiments}

We evaluate Adam across diverse machine learning workloads: convolutional networks (ResNet-50 \\cite{he2016deep}), Vision Transformers (ViT-B/16 \\cite{dosovitskiy2020image}), and autoregressive language models (GPT-2 \\cite{radford2019language} and LLaMA-7B \\cite{touvron2023llama}).

\\subsection{Experimental Setup}
All models were trained on 8x NVIDIA H100 SXM5 80GB GPUs using PyTorch 2.4 and CUDA 12.4 with DistributedDataParallel (DDP). We tune baseline learning rates via logarithmic sweep over $\\{10^{-5}, 3 \\times 10^{-5}, 10^{-4}, 3 \\times 10^{-4}, 10^{-3}, 3 \\times 10^{-3}\\}$. All runs employ cosine learning rate decay with a 5\\% linear warmup phase.

\\subsection{Computer Vision: ImageNet-1K}
On ImageNet-1K classification (1.28M training images), we train ResNet-50 for 90 epochs and ViT-B/16 for 300 epochs. As shown in Table~\\ref{tab:benchmarks_main}, AdamW achieves the highest top-1 validation accuracy ($81.8\\%$ on ViT-B/16), outperforming SGD+Momentum by $3.4\\%$ points on Transformer architectures where spatial inductive biases are absent.
`;

export const DEMO_SECTION_08_ABLATION = `\\section{Ablation Studies}
\\label{sec:ablations}

\\subsection{Momentum Decay Rates ($\\beta_1$ and $\\beta_2$)}
We systematically ablate the exponential decay parameters $\\beta_1 \\in \\{0.80, 0.85, 0.90, 0.95\\}$ and $\\beta_2 \\in \\{0.99, 0.999, 0.9999\\}$. Results in Table~\\ref{tab:ablations_grid} demonstrate that $\\beta_1 = 0.9$ and $\\beta_2 = 0.999$ provide the most robust convergence trajectory across both vision and text modalities. Setting $\\beta_2$ too low (e.g., $0.99$) results in high variance second moment estimates that induce instability near sharp minima.

\\subsection{Decoupled Weight Decay (AdamW)}
Standard $L_2$ regularization adds $\\lambda \\theta$ directly to the gradient vector $g_t$, causing the weight decay step to be scaled by $1 / (\\sqrt{v_t} + \\epsilon)$. Consequently, weights with frequently large gradients receive less decay. AdamW \\cite{loshchilov2017decoupled} decouples weight decay:
\\begin{equation}
  \\theta_t = \\theta_{t-1} - \\eta_t \\lambda \\theta_{t-1} - \\alpha_t \\frac{\\hat{m}_t}{\\sqrt{\\hat{v}_t} + \\epsilon}.
\\end{equation}
This formulation preserves true exponential decay on weights, yielding superior generalization on complex datasets.
`;

export const DEMO_SECTION_09_DISCUSS = `\\section{Discussion and Limitations}
\\label{sec:discussion}

While Adam and AdamW dominate modern deep learning pretraining, several theoretical and empirical subtleties warrant consideration:

\\begin{enumerate}
  \\item \\textbf{Generalization Gap in CNNs:} On over-parameterized convolutional networks with strong inductive bias, standard SGD with heavy momentum sometimes achieves marginally better test accuracy ($0.3\\% - 0.5\\%$) than Adam, due to SGD's tendency to settle into flatter minima.
  \\item \\textbf{Memory Overhead:} Adam requires storing two state vectors per parameter ($m_t$ and $v_t$), increasing optimizer state memory by $8$ bytes per parameter in FP32. For a 70B parameter model, optimizer states consume 560GB of VRAM, necessitating ZeRO sharding \\cite{rajbhandari2020zero} or 8-bit Adam \\cite{dettmers20218bit}.
  \\item \\textbf{Extreme Batch Scales:} Under very large batch sizes ($B > 32{,}768$), gradient variance diminishes, and layer-wise adaptive methods like LAMB \\cite{you2019large} are required to prevent divergence.
\\end{enumerate}
`;

export const DEMO_SECTION_10_CONCL = `\\section{Conclusion}
\\label{sec:conclusion}

We presented an in-depth examination of the Adam optimization algorithm and its ecosystem. By combining adaptive coordinate-wise scaling, rigorous bias correction, and decoupled weight decay, Adam has cemented its role as the de facto optimization standard powering modern foundation models. Our theoretical analysis confirms robust sublinear regret guarantees, and empirical evaluations confirm superior convergence speed across diverse neural architectures. Future research will explore adaptive higher-order curvature approximations and communication-efficient distributed optimizer states.
`;

// ── 3. Appendices ────────────────────────────────────────────────────────────

export const DEMO_APP_A_PROOFS = `\\section{Mathematical Proofs and Lemmas}
\\label{app:proofs}

\\begin{lemma}[Sum of Step Sizes]
\\label{lem:step_sum}
For step size $\\alpha_t = \\alpha / \\sqrt{t}$, the partial sum satisfies:
\\begin{equation}
  \\sum_{t=1}^T \\alpha_t \\le 2\\alpha \\sqrt{T}.
\\end{equation}
\\end{lemma}
\\begin{proof}
By Euler-Maclaurin summation or integral comparison:
$\\sum_{t=1}^T t^{-1/2} \\le 1 + \\int_1^T x^{-1/2} dx = 1 + 2(\\sqrt{T}-1) \\le 2\\sqrt{T}$.
\\end{proof}

\\begin{lemma}[Lyapunov Potential Decomposition]
\\label{lem:potential}
Let $\\theta^*$ be the global minimizer. The Euclidean distance recurrence satisfies:
\\begin{equation}
  \\norm{\\theta_{t+1} - \\theta^*}_2^2 \\le \\norm{\\theta_t - \\theta^*}_2^2 - 2\\alpha_t \\inner{\\frac{\\hat{m}_t}{\\sqrt{\\hat{v}_t} + \\epsilon}}{\\theta_t - \\theta^*} + \\alpha_t^2 \\norm{\\frac{\\hat{m}_t}{\\sqrt{\\hat{v}_t} + \\epsilon}}_2^2.
\\end{equation}
\\end{lemma}
`;

export const DEMO_APP_B_ARCH = `\\section{Neural Network Architectures}
\\label{app:architectures}

Table~\\ref{tab:model_architectures} summarizes the exact structural hyper-parameters of neural architectures evaluated in our benchmarks.

\\begin{table}[htbp]
\\centering
\\caption{Benchmark Neural Network Architecture Specifications}
\\label{tab:model_architectures}
\\begin{tabular}{lcccc}
\\toprule
\\textbf{Model} & \\textbf{Layers} & \\textbf{Hidden Dim} & \\textbf{Heads} & \\textbf{Parameters} \\\\
\\midrule
ResNet-50       & 50               & 2048                & ---             & 25.6M \\\\
ViT-Base/16     & 12               & 768                 & 12              & 86.6M \\\\
GPT-2 Small     & 12               & 768                 & 12              & 124.4M \\\\
LLaMA-7B        & 32               & 4096                & 32              & 6.74B \\\\
\\bottomrule
\\end{tabular}
\\end{table}
`;

export const DEMO_APP_C_HYPER = `\\section{Hyperparameter Search Grids}
\\label{app:hyperparameters}

For all models, optimal hyperparameters were determined using grid search over:
\\begin{itemize}
  \\item Learning rate $\\alpha \\in \\{5 \\times 10^{-5}, 10^{-4}, 3 \\times 10^{-4}, 10^{-3}\\}$
  \\item First moment decay $\\beta_1 \\in \\{0.85, 0.90, 0.95\\}$
  \\item Second moment decay $\\beta_2 \\in \\{0.99, 0.999, 0.9999\\}$
  \\item Numerical stabilizer $\\epsilon \\in \\{10^{-8}, 10^{-6}, 10^{-4}\\}$
  \\item Decoupled weight decay $\\lambda \\in \\{0.0, 0.01, 0.05, 0.1\\}$
\\end{itemize}
`;

export const DEMO_APP_D_COMPUTE = `\\section{Compute Infrastructure and Environment}
\\label{app:compute}

All benchmarks were executed on an enterprise high-performance computing (HPC) cluster:
\\begin{itemize}
  \\item \\textbf{Compute Nodes:} 8x Supermicro GPU servers, each housing 8x NVIDIA H100 SXM5 80GB (64 GPUs total).
  \\item \\textbf{Interconnect:} NVIDIA Quantum-2 InfiniBand (NDR 400 Gbps per port).
  \\item \\textbf{Software Stack:} Ubuntu 22.04 LTS, PyTorch 2.4.0+cu124, FlashAttention-2, NCCL 2.20.5.
\\end{itemize}
`;

// ── 4. Tables ────────────────────────────────────────────────────────────────

export const DEMO_TABLE_1_BENCH = `% ============================================================
% Table 1: Main Optimization Benchmarks Across Vision & NLP
% ============================================================
\\begin{table*}[htbp]
\\centering
\\caption{Optimization Benchmarks Across Vision and Language Tasks (Validation Metrics)}
\\label{tab:benchmarks_main}
\\begin{tabular}{lcccccc}
\\toprule
\\textbf{Optimizer} & \\textbf{ResNet-50 Top-1} & \\textbf{ViT-B/16 Top-1} & \\textbf{GPT-2 PPL} & \\textbf{LLaMA-7B Loss} & \\textbf{Epochs to Converge} & \\textbf{Step Time (ms)} \\\\
\\midrule
SGD + Momentum      & $76.8\\%$                 & $77.4\\%$               & $28.4$              & $2.84$                  & $100$                        & $\\mathbf{12.4}$ \\\\
AdaGrad             & $73.2\\%$                 & $74.1\\%$               & $34.2$              & $3.12$                  & $120$                        & $13.1$ \\\\
RMSProp             & $76.2\\%$                 & $78.6\\%$               & $24.8$              & $2.62$                  & $75$                         & $13.5$ \\\\
Adam (Original)     & $76.5\\%$                 & $80.2\\%$               & $21.4$              & $2.31$                  & $45$                         & $14.2$ \\\\
\\textbf{AdamW (Ours)}& $\\mathbf{77.2\\%}$     & $\\mathbf{81.8\\%}$     & $\\mathbf{19.6}$    & $\\mathbf{2.18}$        & $\\mathbf{38}$               & $14.3$ \\\\
Lion \\cite{chen2023symbolic} & $77.0\\%$         & $81.5\\%$               & $20.1$              & $2.20$                  & $40$                         & $13.0$ \\\\
\\bottomrule
\\end{tabular}
\\end{table*}
`;

export const DEMO_TABLE_2_ABLATIONS = `% ============================================================
% Table 2: Hyperparameter Sensitivity on Beta 1 and Beta 2
% ============================================================
\\begin{table}[htbp]
\\centering
\\caption{Ablation Grid on Moment Decay Rates $\\beta_1$ and $\\beta_2$ (ViT-B/16 Top-1 Accuracy)}
\\label{tab:ablations_grid}
\\begin{tabular}{cccc}
\\toprule
$\\beta_1$ & $\\beta_2 = 0.99$ & $\\beta_2 = 0.999$ & $\\beta_2 = 0.9999$ \\\\
\\midrule
$0.80$     & $79.8\\%$          & $80.9\\%$           & $80.4\\%$ \\\\
$0.85$     & $80.2\\%$          & $81.3\\%$           & $80.8\\%$ \\\\
$0.90$     & $80.5\\%$          & $\\mathbf{81.8\\%}$  & $81.2\\%$ \\\\
$0.95$     & $79.1\\%$          & $80.6\\%$           & $80.1\\%$ \\\\
\\bottomrule
\\end{tabular}
\\end{table}
`;

export const DEMO_TABLE_3_EFFICIENCY = `% ============================================================
% Table 3: Optimizer Memory and Throughput Footprint
% ============================================================
\\begin{table}[htbp]
\\centering
\\caption{Optimizer Memory Overhead and Computational Cost per Parameter}
\\label{tab:efficiency}
\\begin{tabular}{lccc}
\\toprule
\\textbf{Optimizer} & \\textbf{State Memory (bytes/param)} & \\textbf{FLOPs/param/step} & \\textbf{FP16 Stable} \\\\
\\midrule
SGD                 & $0$                                  & $2$                        & Yes \\\\
SGD + Momentum      & $4$                                  & $4$                        & Yes \\\\
RMSProp             & $4$                                  & $6$                        & Marginal \\\\
Adam                & $8$                                  & $12$                       & Yes (with $\\epsilon=10^{-6}$) \\\\
AdamW               & $8$                                  & $14$                       & Yes \\\\
Adafactor           & $\\sim 2$                            & $16$                       & Yes \\\\
\\bottomrule
\\end{tabular}
\\end{table}
`;

// ── 5. Algorithms ────────────────────────────────────────────────────────────

export const DEMO_ALG_1_CORE = `% ============================================================
% Algorithm 1: Core Adam Algorithm
% ============================================================
\\begin{algorithm}[htbp]
\\caption{Adam: Adaptive Moment Estimation}
\\label{alg:adam_core}
\\begin{algorithmic}[1]
\\REQUIRE Step size $\\alpha$ (default: $0.001$)
\\REQUIRE Decay rates $\\beta_1, \\beta_2 \\in [0, 1)$ (default: $\\beta_1 = 0.9, \\beta_2 = 0.999$)
\\REQUIRE Small constant $\\epsilon > 0$ (default: $10^{-8}$)
\\REQUIRE Stochastic objective $f(\\theta)$ with parameter vector $\\theta_0$
\\STATE $m_0 \\leftarrow \\mathbf{0}$, $v_0 \\leftarrow \\mathbf{0}$, $t \\leftarrow 0$
\\WHILE{$\\theta_t$ not converged}
  \\STATE $t \\leftarrow t + 1$
  \\STATE $g_t \\leftarrow \\grad_\\theta f_t(\\theta_{t-1})$
  \\STATE $m_t \\leftarrow \\beta_1 m_{t-1} + (1 - \\beta_1) g_t$
  \\STATE $v_t \\leftarrow \\beta_2 v_{t-1} + (1 - \\beta_2) g_t^2$
  \\STATE $\\hat{m}_t \\leftarrow m_t / (1 - \\beta_1^t)$
  \\STATE $\\hat{v}_t \\leftarrow v_t / (1 - \\beta_2^t)$
  \\STATE $\\theta_t \\leftarrow \\theta_{t-1} - \\alpha \\cdot \\hat{m}_t / (\\sqrt{\\hat{v}_t} + \\epsilon)$
\\ENDWHILE
\\RETURN $\\theta_t$
\\end{algorithmic}
\\end{algorithm}
`;

export const DEMO_ALG_2_ADAMW = `% ============================================================
% Algorithm 2: AdamW with Decoupled Weight Decay
% ============================================================
\\begin{algorithm}[htbp]
\\caption{AdamW: Adam with Decoupled Weight Decay}
\\label{alg:adamw}
\\begin{algorithmic}[1]
\\REQUIRE Base learning rate $\\alpha$, weight decay factor $\\lambda$
\\REQUIRE Decay rates $\\beta_1, \\beta_2$, stabilizer $\\epsilon$
\\STATE $m_0 \\leftarrow \\mathbf{0}$, $v_0 \\leftarrow \\mathbf{0}$, $t \\leftarrow 0$
\\WHILE{$\\theta_t$ not converged}
  \\STATE $t \\leftarrow t + 1$
  \\STATE $g_t \\leftarrow \\grad_\\theta f_t(\\theta_{t-1})$
  \\STATE $m_t \\leftarrow \\beta_1 m_{t-1} + (1 - \\beta_1) g_t$
  \\STATE $v_t \\leftarrow \\beta_2 v_{t-1} + (1 - \\beta_2) g_t^2$
  \\STATE $\\hat{m}_t \\leftarrow m_t / (1 - \\beta_1^t)$
  \\STATE $\\hat{v}_t \\leftarrow v_t / (1 - \\beta_2^t)$
  \\STATE $\\theta_t \\leftarrow \\theta_{t-1} - \\eta_t \\lambda \\theta_{t-1} - \\alpha_t \\cdot \\hat{m}_t / (\\sqrt{\\hat{v}_t} + \\epsilon)$
\\ENDWHILE
\\RETURN $\\theta_t$
\\end{algorithmic}
\\end{algorithm}
`;

export const DEMO_ALG_3_AMSGRAD = `% ============================================================
% Algorithm 3: AMSGrad Variant
% ============================================================
\\begin{algorithm}[htbp]
\\caption{AMSGrad: Non-Increasing Adaptive Learning Rate Variant}
\\label{alg:amsgrad}
\\begin{algorithmic}[1]
\\REQUIRE Step size $\\alpha_t$, parameters $\\beta_1, \\beta_2$
\\STATE $m_0 \\leftarrow \\mathbf{0}$, $v_0 \\leftarrow \\mathbf{0}$, $\\hat{v}_0 \\leftarrow \\mathbf{0}$, $t \\leftarrow 0$
\\WHILE{$\\theta_t$ not converged}
  \\STATE $t \\leftarrow t + 1$
  \\STATE $g_t \\leftarrow \\grad_\\theta f_t(\\theta_{t-1})$
  \\STATE $m_t \\leftarrow \\beta_1 m_{t-1} + (1 - \\beta_1) g_t$
  \\STATE $v_t \\leftarrow \\beta_2 v_{t-1} + (1 - \\beta_2) g_t^2$
  \\STATE $\\hat{v}_t \\leftarrow \\max(\\hat{v}_{t-1}, v_t)$ \\COMMENT{Guarantee non-decreasing coordinate memory}
  \\STATE $\\theta_t \\leftarrow \\theta_{t-1} - \\alpha_t \\cdot m_t / (\\sqrt{\\hat{v}_t} + \\epsilon)$
\\ENDWHILE
\\RETURN $\\theta_t$
\\end{algorithmic}
\\end{algorithm}
`;

// ── 6. Supplementary Beamer Slides ───────────────────────────────────────────

export const DEMO_SLIDES_BEAMER = `\\documentclass{beamer}
\\usetheme{Madrid}
\\usecolortheme{whale}

\\title[Adam Optimization]{Adam: Adaptive Moment Estimation}
\\subtitle{Dynamics, Convergence Guarantees, and Foundation Model Pretraining}
\\author{Research Team}
\\institute[Flux Lab]{Flux Collaborative Intelligence Lab}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Motivation: Non-Convex Stochastic Landscapes}
  \\begin{itemize}
    \\item Deep neural networks feature non-convex surfaces with saddle points and pathological curvature.
    \\item Classical SGD requires manual per-coordinate learning rate tuning.
    \\item AdaGrad accumulates monotonic squared gradients, killing learning prematurely.
    \\item \\textbf{Goal:} Achieve scale-invariant coordinate updates with exponential memory.
  \\end{itemize}
\\end{frame}

\\begin{frame}{The Adam Update Equations}
  \\begin{block}{First and Second Moment Tracking}
    \\[ m_t = \\beta_1 m_{t-1} + (1-\\beta_1) g_t, \\quad v_t = \\beta_2 v_{t-1} + (1-\\beta_2) g_t^2 \\]
  \\end{block}
  \\begin{block}{Timestep-Dependent Bias Correction}
    \\[ \\hat{m}_t = \\frac{m_t}{1 - \\beta_1^t}, \\quad \\hat{v}_t = \\frac{v_t}{1 - \\beta_2^t} \\]
  \\end{block}
  \\begin{block}{Parameter Step}
    \\[ \\theta_t = \\theta_{t-1} - \\alpha \\frac{\\hat{m}_t}{\\sqrt{\\hat{v}_t} + \\epsilon} \\]
  \\end{block}
\\end{frame}

\\begin{frame}{Why Decoupled Weight Decay (AdamW) Matters}
  \\begin{alertblock}{$L_2$ Regularization vs Decoupled Decay}
    In standard Adam + $L_2$, gradients with large magnitude receive \\textbf{less} decay:
    \\[ \\text{Effective Decay} \\propto \\frac{\\lambda}{\\sqrt{v_t} + \\epsilon} \\]
  \\end{alertblock}
  \\begin{exampleblock}{AdamW Fix}
    Apply decay directly to the parameter vector before gradient step:
    \\[ \\theta_t = (1 - \\eta_t \\lambda) \\theta_{t-1} - \\alpha_t \\frac{\\hat{m}_t}{\\sqrt{\\hat{v}_t} + \\epsilon} \\]
  \\end{exampleblock}
\\end{frame}

\\begin{frame}{Key Takeaways}
  \\begin{itemize}
    \\item Adam provides scale-invariant adaptive step sizes.
    \\item Bias correction eliminates early cold-start initialization stall.
    \\item AdamW is the gold standard for Transformers, LLMs, and Vision models.
  \\end{itemize}
\\end{frame}

\\end{document}
`;

// ── 7. References BibTeX ─────────────────────────────────────────────────────

export const DEMO_REFERENCES_BIB = `@article{kingma2014adam,
  title     = {Adam: A Method for Stochastic Optimization},
  author    = {Kingma, Diederik P. and Ba, Jimmy},
  journal   = {International Conference on Learning Representations (ICLR)},
  year      = {2015},
  url       = {https://arxiv.org/abs/1412.6980}
}

@article{loshchilov2017decoupled,
  title     = {Decoupled Weight Decay Regularization},
  author    = {Loshchilov, Ilya and Hutter, Frank},
  journal   = {International Conference on Learning Representations (ICLR)},
  year      = {2019},
  url       = {https://arxiv.org/abs/1711.05101}
}

@article{reddi2018convergence,
  title     = {On the Convergence of Adam and Beyond},
  author    = {Reddi, Sashank J. and Kale, Satyen and Kumar, Sanjiv},
  journal   = {International Conference on Learning Representations (ICLR)},
  year      = {2018},
  url       = {https://arxiv.org/abs/1904.09237}
}

@article{chen2023symbolic,
  title     = {Symbolic Discovery of Optimization Algorithms},
  author    = {Chen, Xiangning and Liang, Chen and Huang, Da and Real, Esteban and Wang, Kaiyuan and Liu, Yao and Pham, Hieu and Dong, Xuanyi and Luong, Thang and Hsieh, Cho-Jui and Lu, Yifeng and Le, Quoc V.},
  journal   = {Advances in Neural Information Processing Systems (NeurIPS)},
  year      = {2023}
}

@article{liu2023sophia,
  title     = {Sophia: A Second-order Stochastic Optimizer for Language Model Pre-training},
  author    = {Liu, Hong Liu and Li, Zhiyuan and Hall, David and Liang, Percy and Ma, Tengyu},
  journal   = {arXiv preprint arXiv:2305.14342},
  year      = {2023}
}

@article{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N. and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  journal   = {Advances in Neural Information Processing Systems (NeurIPS)},
  volume    = {30},
  year      = {2017}
}

@article{he2016deep,
  title     = {Deep Residual Learning for Image Recognition},
  author    = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  journal   = {IEEE Conference on Computer Vision and Pattern Recognition (CVPR)},
  pages     = {770--778},
  year      = {2016}
}

@article{dosovitskiy2020image,
  title     = {An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale},
  author    = {Dosovitskiy, Alexey and Beyer, Lucas and Kolesnikov, Alexander and Weissenborn, Dirk and Zhai, Xiaohua and Unterthiner, Thomas and Dehghani, Mostafa and Minderer, Matthias and Heigold, Georg and Gelly, Sylvain and others},
  journal   = {International Conference on Learning Representations (ICLR)},
  year      = {2021}
}

@article{brown2020language,
  title     = {Language Models are Few-Shot Learners},
  author    = {Brown, Tom and Mann, Benjamin and Ryder, Nick and Subbiah, Melanie and Kaplan, Jared D. and Dhariwal, Prafulla and Neelakantan, Arvind and Shyam, Pranav and Sastry, Girish and Askell, Amanda and others},
  journal   = {Advances in Neural Information Processing Systems (NeurIPS)},
  volume    = {33},
  pages     = {1877--1901},
  year      = {2020}
}

@article{touvron2023llama,
  title     = {LLaMA: Open and Efficient Foundation Language Models},
  author    = {Touvron, Hugo and Lavril, Thibaut and Izacard, Gautier and Martinet, Xavier and Lachaux, Marie-Anne and Lacroix, Timoth{\'e}e and Rozi{\`e}re, Baptiste and Goyal, Naman and Hambro, Eric and Azhar, Faisal and others},
  journal   = {arXiv preprint arXiv:2302.13971},
  year      = {2023}
}

@article{devlin2018bert,
  title     = {BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding},
  author    = {Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina},
  journal   = {North American Chapter of the Association for Computational Linguistics (NAACL)},
  year      = {2019}
}

@article{duchi2011adaptive,
  title     = {Adaptive Subgradient Methods for Online Learning and Stochastic Optimization},
  author    = {Duchi, John and Hazan, Elad and Singer, Yoram},
  journal   = {Journal of Machine Learning Research (JMLR)},
  volume    = {12},
  pages     = {2121--2159},
  year      = {2011}
}

@article{tieleman2012rmsprop,
  title     = {Lecture 6.5---RMSProp: Divide the Gradient by a Running Average of Its Recent Magnitude},
  author    = {Tieleman, Tijmen and Hinton, Geoffrey},
  journal   = {COURSERA: Neural Networks for Machine Learning},
  year      = {2012}
}

@article{polyak1964some,
  title     = {Some Methods of Speeding Up the Convergence of Iteration Methods},
  author    = {Polyak, Boris T.},
  journal   = {USSR Computational Mathematics and Mathematical Physics},
  volume    = {4},
  number    = {5},
  pages     = {1--17},
  year      = {1964}
}

@article{nesterov1983method,
  title     = {A Method for Unconstrained Convex Minimization Problem with the Rate of Convergence $O(1/k^2)$},
  author    = {Nesterov, Yurii},
  journal   = {Doklady AN SSSR},
  volume    = {269},
  pages     = {543--547},
  year      = {1983}
}

@article{shazeer2018adafactor,
  title     = {Adafactor: Adaptive Learning Rates with Sublinear Memory Cost},
  author    = {Shazeer, Noam and Stern, Mitchell},
  journal   = {International Conference on Machine Learning (ICML)},
  pages     = {4596--4604},
  year      = {2018}
}

@article{hoffmann2022training,
  title     = {Training Compute-Optimal Large Language Models},
  author    = {Hoffmann, Jordan and Borgeaud, Sebastian and Mensch, Arthur and Buchatskaya, Elena and Cai, Trevor and Rutherford, Eliza and de Las Casas, Diego and Hendricks, Lisa Anne and Welbl, Johannes and Clark, Aidan and others},
  journal   = {Advances in Neural Information Processing Systems (NeurIPS)},
  volume    = {35},
  year      = {2022}
}

@article{jiang2023mistral,
  title     = {Mistral 7B},
  author    = {Jiang, Albert Q. and Sablayrolles, Alexandre and Mensch, Arthur and Bamford, Chris and Chaplot, Devendra Singh and Casas, Diego de las and Bressand, Florian and Lengyel, Gianna and Lample, Guillaume and Saulnier, Lucile and others},
  journal   = {arXiv preprint arXiv:2310.06825},
  year      = {2023}
}

@article{li2021fourier,
  title     = {Fourier Neural Operator for Parametric Partial Differential Equations},
  author    = {Li, Zongyi and Kovachki, Nikola and Azizzadenesheli, Kamyar and Liu, Burigede and Bhattacharya, Kaushik and Stuart, Andrew and Anandkumar, Anima},
  journal   = {International Conference on Learning Representations (ICLR)},
  year      = {2021}
}

@article{raissi2019physics,
  title     = {Physics-Informed Neural Networks: A Deep Learning Framework for Solving Forward and Inverse Problems},
  author    = {Raissi, Maziar and Perdikaris, Paris and Karniadakis, George E.},
  journal   = {Journal of Computational Physics},
  volume    = {378},
  pages     = {686--707},
  year      = {2019}
}

@article{rombach2022high,
  title     = {High-Resolution Image Synthesis with Latent Diffusion Models},
  author    = {Rombach, Robin and Blattmann, Andreas and Lorenz, Dominik and Esser, Patrick and Ommer, Bj{\"o}rn},
  journal   = {IEEE Conference on Computer Vision and Pattern Recognition (CVPR)},
  pages     = {10684--10695},
  year      = {2022}
}

@article{radford2021learning,
  title     = {Learning Transferable Visual Models From Natural Language Supervision},
  author    = {Radford, Alec and Kim, Jong Wook and Hallacy, Chris and Ramesh, Aditya and Goh, Gabriel and Agarwal, Sandhini and Sastry, Girish and Askell, Amanda and Mishkin, Pamela and Clark, Jack and others},
  journal   = {International Conference on Machine Learning (ICML)},
  pages     = {8748--8763},
  year      = {2021}
}

@article{kirillov2023segment,
  title     = {Segment Anything},
  author    = {Kirillov, Alexander and Mintun, Eric and Ravi, Nikhila and Mao, Hanzi and Rolland, Chloe and Gustafson, Laura and Xiao, Tete and Whitehead, Spencer and Berg, Alexander C. and Lo, Wan-Yen and others},
  journal   = {IEEE International Conference on Computer Vision (ICCV)},
  year      = {2023}
}
`;

/**
 * Returns the enterprise-grade 25-file academic manuscript project.
 */

export interface DemoFileItem {
  id: string;
  name: string;
  title: string;
  path: string;
  type: string;
  size: number;
  pageId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export function getDemoBackendDoc(pageId: string = 'demo') {
  const now = new Date().toISOString();
  return {
    id: pageId,
    _id: pageId,
    title: 'main.tex',
    path: '/main.tex',
    content: DEMO_MAIN_TEX,
    lines: DEMO_MAIN_TEX.split('\n'),
    status: 'published',
    createdAt: now,
    updatedAt: now,
    projectId: 'default',
  };
}

export function getDemoBackendFiles(pageId: string = 'demo'): DemoFileItem[] {
  const now = new Date().toISOString();

  const fileDefinitions: Array<{
    path: string;
    name: string;
    content: string;
  }> = [
    // --- Root ---
    { path: '/main.tex', name: 'main.tex', content: DEMO_MAIN_TEX },
    { path: '/preamble.tex', name: 'preamble.tex', content: DEMO_PREAMBLE_TEX },
    {
      path: '/references.bib',
      name: 'references.bib',
      content: DEMO_REFERENCES_BIB,
    },

    // --- Macros ---
    {
      path: '/macros/math_commands.tex',
      name: 'math_commands.tex',
      content: DEMO_MACROS_MATH_TEX,
    },
    {
      path: '/macros/notation_table.tex',
      name: 'notation_table.tex',
      content: DEMO_MACROS_NOTATION_TEX,
    },

    // --- Styles ---
    {
      path: '/styles/flux-academic.sty',
      name: 'flux-academic.sty',
      content: DEMO_STYLES_ACADEMIC_TEX,
    },

    // --- Sections ---
    {
      path: '/sections/01_abstract.tex',
      name: '01_abstract.tex',
      content: DEMO_SECTION_01_ABSTRACT,
    },
    {
      path: '/sections/02_introduction.tex',
      name: '02_introduction.tex',
      content: DEMO_SECTION_02_INTRO,
    },
    {
      path: '/sections/03_related_work.tex',
      name: '03_related_work.tex',
      content: DEMO_SECTION_03_RELATED,
    },
    {
      path: '/sections/04_preliminaries.tex',
      name: '04_preliminaries.tex',
      content: DEMO_SECTION_04_PRELIM,
    },
    {
      path: '/sections/05_methodology.tex',
      name: '05_methodology.tex',
      content: DEMO_SECTION_05_METHOD,
    },
    {
      path: '/sections/06_theoretical_analysis.tex',
      name: '06_theoretical_analysis.tex',
      content: DEMO_SECTION_06_THEORY,
    },
    {
      path: '/sections/07_experiments.tex',
      name: '07_experiments.tex',
      content: DEMO_SECTION_07_EXP,
    },
    {
      path: '/sections/08_ablation_studies.tex',
      name: '08_ablation_studies.tex',
      content: DEMO_SECTION_08_ABLATION,
    },
    {
      path: '/sections/09_discussion.tex',
      name: '09_discussion.tex',
      content: DEMO_SECTION_09_DISCUSS,
    },
    {
      path: '/sections/10_conclusion.tex',
      name: '10_conclusion.tex',
      content: DEMO_SECTION_10_CONCL,
    },

    // --- Appendices ---
    {
      path: '/appendices/appendix_a_proofs.tex',
      name: 'appendix_a_proofs.tex',
      content: DEMO_APP_A_PROOFS,
    },
    {
      path: '/appendices/appendix_b_architectures.tex',
      name: 'appendix_b_architectures.tex',
      content: DEMO_APP_B_ARCH,
    },
    {
      path: '/appendices/appendix_c_hyperparameters.tex',
      name: 'appendix_c_hyperparameters.tex',
      content: DEMO_APP_C_HYPER,
    },
    {
      path: '/appendices/appendix_d_compute_infrastructure.tex',
      name: 'appendix_d_compute_infrastructure.tex',
      content: DEMO_APP_D_COMPUTE,
    },

    // --- Tables ---
    {
      path: '/tables/table1_benchmarks.tex',
      name: 'table1_benchmarks.tex',
      content: DEMO_TABLE_1_BENCH,
    },
    {
      path: '/tables/table2_ablations.tex',
      name: 'table2_ablations.tex',
      content: DEMO_TABLE_2_ABLATIONS,
    },
    {
      path: '/tables/table3_efficiency.tex',
      name: 'table3_efficiency.tex',
      content: DEMO_TABLE_3_EFFICIENCY,
    },

    // --- Algorithms ---
    {
      path: '/algorithms/alg1_adam_core.tex',
      name: 'alg1_adam_core.tex',
      content: DEMO_ALG_1_CORE,
    },
    {
      path: '/algorithms/alg2_adamw_weight_decay.tex',
      name: 'alg2_adamw_weight_decay.tex',
      content: DEMO_ALG_2_ADAMW,
    },
    {
      path: '/algorithms/alg3_amsgrad_variant.tex',
      name: 'alg3_amsgrad_variant.tex',
      content: DEMO_ALG_3_AMSGRAD,
    },

    // --- Figures ---
    {
      path: '/figures/fig1_model_architecture.png',
      name: 'fig1_model_architecture.png',
      content: '',
    },
    {
      path: '/figures/fig2_loss_convergence.png',
      name: 'fig2_loss_convergence.png',
      content: '',
    },
    {
      path: '/figures/fig3_hyperparameter_sensitivity.png',
      name: 'fig3_hyperparameter_sensitivity.png',
      content: '',
    },

    // --- Supplementary Slides ---
    {
      path: '/supplementary/slides_defense.tex',
      name: 'slides_defense.tex',
      content: DEMO_SLIDES_BEAMER,
    },
  ];

  return fileDefinitions.map((f, idx) => {
    const cleanTitle = f.path.replace(/^\//, '');
    return {
      id: `${pageId}-file-${idx + 1}`,
      name: f.name,
      title: cleanTitle,
      path: f.path,
      type: 'file',
      size: f.content.length,
      pageId,
      content: f.content,
      createdAt: now,
      updatedAt: now,
    };
  });
}
