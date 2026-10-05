import { Pool } from 'pg';
import Redis from 'ioredis';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public',
});

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// Reference base date: Oct 4, 2026
const T0 = new Date('2026-10-04T09:00:00.000Z');
const dayMs = 24 * 60 * 60 * 1000;

const d = (daysDelta, hour = 9) => {
  const target = new Date(T0.getTime() + daysDelta * dayMs);
  target.setUTCHours(hour, 0, 0, 0);
  return target.toISOString();
};

const itemsUpdates = [
  // ── BACKLOG (FLUX-1 to FLUX-8): Future Research Milestones (Mid Oct - Late Nov 2026) ──
  {
    seq: 1,
    startDate: d(16),
    dueDate: d(32, 17),
    timeSpent: 0,
    content: `## Objective
Investigate decoupled weight decay ($\lambda$) dynamics with cosine learning rate annealing schedules on 70B parameter dense autoregressive language models (LLaMA-70B architecture).

## Technical Scope & Methodology
- Evaluate the theoretical gap between $L_2$ regularization and weight decay when gradient variance is high across deep Transformer layers.
- Formulate hyperparameter search grid for $\lambda \in [0.01, 0.1]$ and peak learning rate $\eta_{\max} \in [1.5 \times 10^{-4}, 3.0 \times 10^{-4}]$.
- Measure token perplexity on the RedPajama validation corpus over the first 50 billion tokens.

## Acceptance Criteria
- Full matrix of loss trajectories across 4 weight decay multipliers.
- Validation checkpoint evaluation showing gradient norm stability without sudden spike anomalies.`,
  },
  {
    seq: 2,
    startDate: d(18),
    dueDate: d(35, 17),
    timeSpent: 0,
    content: `## Objective
Benchmark Adafactor vs Adam on 1D Burgers and 2D Navier-Stokes PDE solvers to quantify memory footprint reduction vs shock formation resolution.

## Technical Scope & Methodology
- Exploit sub-linear memory cost of row-wise and column-wise second moment factorizations ($O(R + C)$ instead of $O(R \times C)$).
- Test on 1D Viscous Burgers equation ($\nu = 0.01$) and 2D incompressible Kolmogorov flow.
- Record relative $L_2$ error norm $\|u - u^*\|_2 / \|u^*\|_2$ over 10,000 PDE solver time steps.

## Acceptance Criteria
- Memory reduction $\ge 40\%$ verified on VRAM profiler.
- Energy spectrum parity within $1.5\%$ margin relative to full-rank Adam baseline.`,
  },
  {
    seq: 3,
    startDate: d(20),
    dueDate: d(37, 17),
    timeSpent: 0,
    content: `## Objective
Profile PyTorch Automatic Mixed Precision (AMP) with FP16 vs BF16 floating-point formats on NVIDIA H100 SXM5 GPUs to prevent underflow in second moment calculations.

## Technical Scope & Methodology
- Analyze exponent bit range (8 bits in BF16 vs 5 bits in FP16) under second-order moment calculation $v_t = \beta_2 v_{t-1} + (1 - \beta_2) g_t^2$.
- Benchmark gradient scaling factor dynamics and zero-loss underflow frequencies across 100,000 steps.
- Compare wall-clock iteration latency with Tensor Core FP8/FP16 execution units.

## Acceptance Criteria
- Zero NaN/Inf loss occurrences over a continuous 24-hour training run.
- Throughput report detailing TFLOPS utilization across precision modes.`,
  },
  {
    seq: 4,
    startDate: d(21),
    dueDate: d(39, 17),
    timeSpent: 0,
    content: `## Objective
Survey recent second-order curvature approximations (Sophia vs K-FAC) for transformer pretraining at sub-quadratic computational complexity.

## Technical Scope & Methodology
- Comparative mathematical breakdown of diagonal Hessian estimates via Hutchinson-style stochastic trace estimation.
- Estimate overhead of auxiliary matrix-vector products relative to backward pass latency ($< 5\%$ target).
- Document convergence rates on autoregressive language modeling tasks.

## Acceptance Criteria
- Comprehensive comparison table in LaTeX summarizing per-iteration FLOPs, memory overhead, and wall-clock speedup.
- Literature review section ready for inclusion in paper Appendix C.`,
  },
  {
    seq: 5,
    startDate: d(23),
    dueDate: d(42, 17),
    timeSpent: 0,
    content: `## Objective
Implement block-wise 8-bit dynamic quantization for optimizer first and second moments following Dettmers et al.

## Technical Scope & Methodology
- Chunk state vectors into blocks of 2048 elements; compute localized absolute maximum for dynamic scaling.
- Quantize fp32 states into signed 8-bit representations, achieving a $75\%$ reduction in optimizer state VRAM.
- Measure numerical fidelity against standard fp32 master weights.

## Acceptance Criteria
- PyTorch custom C++/CUDA kernel passing all unit tests.
- Peak VRAM footprint reduced by at least $12\\text{ GB}$ per GPU on a 70B parameter model.`,
  },
  {
    seq: 6,
    startDate: d(24),
    dueDate: d(45, 17),
    timeSpent: 0,
    content: `## Objective
Analyze early training instability and self-attention entropy collapse during learning rate warmup phases in deep Transformers.

## Technical Scope & Methodology
- Track attention weight distribution entropy $-\sum p \log p$ across all attention heads during the first 2,000 warmup iterations.
- Contrast linear warmup with cosine, inverse square root, and WSD (Warmup-Stable-Decay) schedules.
- Identify the critical threshold where gradient variance causes layer norm saturation.

## Acceptance Criteria
- Automated diagnostic script logging per-layer entropy trajectories to Weights & Biases.
- Formal analytical note proposing optimal warmup step count $T_{\\text{warmup}} = f(L, d_{\\text{model}})$.`,
  },
  {
    seq: 7,
    startDate: d(28),
    dueDate: d(49, 17),
    timeSpent: 0,
    content: `## Objective
Evaluate the Muon optimizer's momentum orthogonalization algorithm using Newton-Schulz matrix iterations on linear weight matrices.

## Technical Scope & Methodology
- Implement matrix-valued momentum orthogonalization $O_t = \\text{NewtonSchulz}(M_t)$ for 2D weight tensors.
- Measure spectral norm evolution and condition numbers across transformer MLP and attention projection layers.
- Compare learning efficiency against standard AdamW on Wikitext-103.

## Acceptance Criteria
- Benchmarked loss curves demonstrating faster initial convergence.
- Memory and compute overhead analysis for Newton-Schulz polynomial iterations.`,
  },
  {
    seq: 8,
    startDate: d(32),
    dueDate: d(52, 17),
    timeSpent: 0,
    content: `## Objective
Draft technical narrative and compute allocation request for the NSF Supercomputing Resource Allocation grant.

## Technical Scope & Methodology
- Detail scientific merit of scalable adaptive optimization for scientific AI foundation models.
- Specify requested compute: 250,000 H100 GPU-hours on Frontera/Delta supercomputing clusters.
- Formulate milestone chart, storage requirements, and data management plan.

## Acceptance Criteria
- Complete 15-page NSF proposal PDF formatted per PAPPG guidelines.
- Budget justification and compute allocation calculations vetted by institutional review.`,
  },

  // ── TO DO (FLUX-9 to FLUX-18): Upcoming Sprint Execution (Oct 5 - Oct 17, 2026) ──
  {
    seq: 9,
    startDate: d(1),
    dueDate: d(7, 17),
    timeSpent: 0,
    content: `## Objective
Derive the analytical formulation and proof for the second moment vector bias-correction term in Theorem 1.

## Technical Scope & Methodology
- Derive expectation of $v_t$: show that $E[v_t] = E[g_t^2] (1 - \\beta_2^t)$ under stationary gradient distribution.
- Establish that correcting initial estimates by dividing by $1 - \\beta_2^t$ yields an asymptotically unbiased estimator.
- Provide explicit bounds on the bias decay rate as $t \\to \\infty$.

## Acceptance Criteria
- Complete proof written in LaTeX math environment within \`proofs/theorem1_bias.tex\`.
- Verified step-by-step by theoretical review without loose inequality bounds.`,
  },
  {
    seq: 10,
    startDate: d(1),
    dueDate: d(4, 17),
    timeSpent: 0,
    content: `## Objective
Synchronize 32 literature references from the Flux Library Zotero collections into \`references.bib\`.

## Technical Scope & Methodology
- Export metadata fields (author, title, journal, year, volume, pages, doi, url) from database schema v42.
- Clean and normalize citation keys into \`authorYearKeyword\` format (e.g., \`kingma2014adam\`, \`loshchilov2017decoupled\`).
- Validate character escaping for special characters, ampersands, and LaTeX accents.

## Acceptance Criteria
- \`references.bib\` compiled with 0 bibtex syntax errors.
- All 32 papers in Flux library linked with valid DOI links.`,
  },
  {
    seq: 11,
    startDate: d(2),
    dueDate: d(9, 17),
    timeSpent: 0,
    content: `## Objective
Configure multi-node Slurm job submission scripts for distributed Data-Parallel (DDP) training across 8 nodes (64x H100 SXM5 GPUs).

## Technical Scope & Methodology
- Write \`sbatch_distributed_h100.sh\` with \`#SBATCH --nodes=8\`, \`--ntasks-per-node=8\`, \`--gres=gpu:8\`.
- Configure NCCL communication flags: \`NCCL_DEBUG=INFO\`, \`NCCL_IB_DISABLE=0\`, \`NCCL_SOCKET_IFNAME=eth0\`.
- Implement automated node-failure checkpointing and restart via Slurm exit traps.

## Acceptance Criteria
- Successful dry-run launch on the test partition.
- NCCL all-reduce bandwidth achieving $> 400\\text{ GB/s}$ inter-node InfiniBand throughput.`,
  },
  {
    seq: 12,
    startDate: d(3),
    dueDate: d(10, 17),
    timeSpent: 0,
    content: `## Objective
Integrate FlashAttention-2 custom kernel into the benchmark suite to accelerate attention matrix computations during optimizer profiling.

## Technical Scope & Methodology
- Replace standard PyTorch scaled dot-product attention with \`flash_attn_func\`.
- Verify causal masking and cross-attention head dimension support ($d_k = 64, 128$).
- Benchmark backward pass gradient latency before and after integration.

## Acceptance Criteria
- $2.2\\times$ speedup on attention backward pass for sequence length 4096.
- Exact numerical parity ($\Delta < 10^{-6}$) with standard attention reference.`,
  },
  {
    seq: 13,
    startDate: d(4),
    dueDate: d(12, 17),
    timeSpent: 0,
    content: `## Objective
Draft Section 3 (Related Work) comparative analysis categorizing modern first-order and second-order optimization techniques.

## Technical Scope & Methodology
- Structure narrative into 3 subsections:
  1. Classical Stochastic Methods (SGD, Polyak Momentum, Nesterov Accelerated Gradient).
  2. Coordinate-wise Adaptive Gradients (AdaGrad, RMSProp, Adam, AdamW, AMSGrad).
  3. Second-Order and Structural Approximations (Adafactor, Lion, Sophia, Muon).
- Highlight key trade-offs between per-iteration compute overhead and memory footprint.

## Acceptance Criteria
- 4 full manuscript pages drafted in \`sections/03_related_work.tex\`.
- At least 25 citations referenced with contextual synthesis.`,
  },
  {
    seq: 14,
    startDate: d(1),
    dueDate: d(3, 17),
    timeSpent: 0,
    content: `## Objective
Add mathematical macro definitions to \`macros/math_commands.tex\` for clean, uniform mathematical notation across all manuscript files.

## Technical Scope & Methodology
- Define bold tensor notation \`\\bm{w}\`, expectation \`\\E\`, inner product \`\\iprod{\\cdot}{\\cdot}\`.
- Add shorthands for moment vectors \`\\hat{\\bm{m}}_t\`, \`\\hat{\\bm{v}}_t\`, and adaptive learning rate \`\\alpha_t\`.
- Validate zero collision with standard AMS-LaTeX and IEEE packages.

## Acceptance Criteria
- \`math_commands.tex\` integrated into \`main.tex\` preamble.
- Manuscript builds cleanly without undefined macro warnings.`,
  },
  {
    seq: 15,
    startDate: d(5),
    dueDate: d(13, 17),
    timeSpent: 0,
    content: `## Objective
Profile CUDA memory bandwidth saturation during the optimizer step using NVIDIA Nsight Compute.

## Technical Scope & Methodology
- Capture kernel profile for fused elementwise kernel: first moment, second moment, bias correction, weight decay, and parameter update.
- Measure DRAM read/write throughput relative to theoretical HBM3 peak ($3.35\\text{ TB/s}$).
- Identify register spill and shared memory bank conflict bottlenecks.

## Acceptance Criteria
- Nsight Compute report (\`.ncu-rep\`) demonstrating $> 85\\%$ memory bandwidth utilization.
- Concrete recommendations for kernel register tiling and loop unrolling.`,
  },
  {
    seq: 16,
    startDate: d(6),
    dueDate: d(11, 17),
    timeSpent: 0,
    content: `## Objective
Format Table 3 (Memory Footprint and Optimizer State Overhead) using booktabs rules for camera-ready compliance.

## Technical Scope & Methodology
- Convert plain LaTeX table to \`booktabs\` format with \`\\toprule\`, \`\\midrule\`, \`\\bottomrule\`.
- Add numerical alignment via \`siunitx\` package for memory consumption (MB/GB) and throughput (TFLOPS).
- Include footnotes documenting fp32 master weights vs quantized 8-bit states.

## Acceptance Criteria
- Visually polished table conforming to IEEE / NeurIPS formatting guidelines.
- Table compiles cleanly without overfull hbox warnings.`,
  },
  {
    seq: 17,
    startDate: d(4),
    dueDate: d(12, 17),
    timeSpent: 0,
    content: `## Objective
Verify the AMSGrad maximum second moment update routine ($\hat{v}_t = \max(\hat{v}_{t-1}, v_t)$) across 100,000 optimization steps.

## Technical Scope & Methodology
- Implement coordinate-wise running maximum routine to guarantee non-increasing step sizes.
- Test on 2D non-convex synthetic counterexamples where standard Adam fails to converge (Reddi et al. setting).
- Verify numerical monotonicity: ensure $\hat{v}_{t,i} \ge \hat{v}_{t-1,i}$ holds universally for all $i$.

## Acceptance Criteria
- Verified monotonicity log across all 100,000 steps without precision regression.
- Empirical convergence plot reproducing AMSGrad performance superiority on counterexample.`,
  },
  {
    seq: 18,
    startDate: d(2),
    dueDate: d(8, 17),
    timeSpent: 0,
    content: `## Objective
Prepare a 10-slide Beamer presentation deck for the upcoming international laboratory research symposium.

## Technical Scope & Methodology
- Structure slides: Problem Statement, Theoretical Breakthrough (Theorem 1), Vector Dynamics, Empirical Benchmarks (ImageNet, LLaMA), and Conclusion.
- Embed high-resolution vector TikZ diagrams and loss trajectory plots.
- Apply Flux institutional color palette (Primer Blue, Copilot Purple, Paper Canvas).

## Acceptance Criteria
- Complete Beamer \`.tex\` project and compiled 16:9 PDF deck.
- Speaker notes and timing guide for a 15-minute presentation.`,
  },

  // ── IN PROGRESS (FLUX-19 to FLUX-34): Active Sprint Development (Sept 28 - Oct 10, 2026) ──
  {
    seq: 19,
    startDate: d(-6),
    dueDate: d(4, 17),
    timeSpent: 34.0,
    content: `## Objective
Implement the core Adam optimizer algorithm in PyTorch autograd and verify empirical convergence on benchmark datasets.

## Technical Scope & Methodology
- Implement vectorized first moment ($m_t = \beta_1 m_{t-1} + (1 - \beta_1) g_t$) and second moment ($v_t = \beta_2 v_{t-1} + (1 - \beta_2) g_t^2$) updates.
- Apply bias correction factors $\hat{m}_t = m_t / (1 - \beta_1^t)$ and $\hat{v}_t = v_t / (1 - \beta_2^t)$.
- Validate parameter update rule $\theta_t = \theta_{t-1} - \frac{\alpha}{\sqrt{\hat{v}_t} + \epsilon} \hat{m}_t$.

## Acceptance Criteria
- PyTorch custom optimizer class passing all unit tests against reference torch.optim.Adam.
- Zero loss spike and identical numerical trajectory within $10^{-7}$ tolerance.`,
  },
  {
    seq: 20,
    startDate: d(-6),
    dueDate: d(-3, 17),
    timeSpent: 12.0,
    completed: true,
    content: `## Objective
Formulate vectorized moving average updates for first and second moments supporting fused backward pass.

## Technical Scope & Methodology
- Mathematical formulation of exponential decay updates with numerical safeguards against division by zero.
- Implementation in C++/CUDA extension for in-place tensor memory operations.
- Verification of mathematical equivalence under IEEE 754 floating point arithmetic.

## Acceptance Criteria
- Kernel passes all tensor unit tests with $100\%$ precision matching.`,
  },
  {
    seq: 21,
    startDate: d(-4),
    dueDate: d(0, 17),
    timeSpent: 16.0,
    completed: true,
    content: `## Objective
Implement vectorized Adam update kernel in PyTorch autograd engine.

## Technical Scope & Methodology
- Fused CUDA kernel combining moment estimation, bias correction, weight decay, and gradient application in a single pass.
- Eliminates 3 redundant round-trips to GPU DRAM per optimizer step.
- Benchmarked on 8x H100 SXM5 showing $2.4\\times$ kernel execution speedup.

## Acceptance Criteria
- Kernel packaged and integrated into core repository.
- Unit test suite passed with zero regressions.`,
  },
  {
    seq: 22,
    startDate: d(-2),
    dueDate: d(3, 17),
    timeSpent: 6.0,
    completed: false,
    content: `## Objective
Validate loss backpropagation stability on MNIST and CIFAR-10 ConvNet architectures across 40,000 iterations.

## Technical Scope & Methodology
- Run 40,000 iterations of ResNet-18 on CIFAR-10 and LeNet-5 on MNIST.
- Log gradient norm $\|g_t\|_2$ and learning rate step scaling to identify numerical anomalies.
- Confirm final top-1 test error reaches state-of-the-art benchmark levels ($> 95.2\%$ on CIFAR-10).

## Acceptance Criteria
- 40,000 continuous steps completed with zero loss anomalies.
- Test accuracy curves uploaded to experiment artifact repository.`,
  },
  {
    seq: 23,
    startDate: d(-5),
    dueDate: d(5, 17),
    timeSpent: 19.5,
    content: `## Objective
Draft Section 2 (Algorithm & Dynamics) in \`main.tex\` detailing the mathematical formulation and pseudocode of the algorithm.

## Technical Scope & Methodology
- Formulate Algorithm 1 block with inputs, parameter defaults ($\alpha=0.001, \beta_1=0.9, \beta_2=0.999, \epsilon=10^{-8}$), and step-by-step update rules.
- Explain adaptive step size dynamics and coordinate-wise gradient scaling rationale.
- Reference vector figures illustrating step size bounds.

## Acceptance Criteria
- Complete Section 2 drafted in \`sections/02_algorithm.tex\`.
- Validated by lead author and ready for peer review.`,
  },
  {
    seq: 24,
    startDate: d(-5),
    dueDate: d(-1, 17),
    timeSpent: 8.5,
    completed: true,
    content: `## Objective
Write algorithm pseudocode in LaTeX algorithm/algorithmic environment.

## Technical Scope & Methodology
- Draft \`alg1_adam_core.tex\` with input requirements, initialization of moment vectors, and while-loop iteration steps.
- Clear mathematical typography matching IEEE Transactions standards.

## Acceptance Criteria
- Algorithmic block renders cleanly with clear line numbering and comment annotations.`,
  },
  {
    seq: 25,
    startDate: d(-2),
    dueDate: d(4, 17),
    timeSpent: 5.0,
    completed: false,
    content: `## Objective
Produce publication-ready TikZ vector diagram for step size adaptation dynamics.

## Technical Scope & Methodology
- Design TikZ figure illustrating how coordinate-wise gradient magnitudes rescale effective step sizes in anisotropic loss landscapes.
- Incorporate vector arrows and contour curves representing non-convex ravines.
- Render in standalone PDF format before inclusion in \`main.tex\`.

## Acceptance Criteria
- TikZ source compiles without errors into vector PDF.
- Text labels in figure match document typography exactly.`,
  },
  {
    seq: 26,
    startDate: d(-3),
    dueDate: d(6, 17),
    timeSpent: 14.0,
    content: `## Objective
Execute ablation study on hyperparameter sensitivity ($\beta_1 \in [0.8, 0.95]$, $\beta_2 \in [0.98, 0.9999]$).

## Technical Scope & Methodology
- Train 12 ConvNet models across parameter permutations on ImageNet-100 over 500 epochs.
- Quantify empirical trade-off between first moment smoothing and second moment variance.
- Evaluate impact of $\epsilon$ stabilization constant on ill-conditioned objectives.

## Acceptance Criteria
- Comprehensive heatmaps generated and exported to \`figures/ablation_heatmap.pdf\`.
- Clear optimal parameter guidelines summarized in manuscript Section 4.`,
  },
  {
    seq: 27,
    startDate: d(-3),
    dueDate: d(3, 17),
    timeSpent: 22.0,
    content: `## Objective
Scale ImageNet ViT-B/16 training to 300 epochs across 64 H100 GPUs with RandAugment and Mixup data augmentation.

## Technical Scope & Methodology
- Distribute training using PyTorch FSDP (Fully Sharded Data Parallel).
- Measure scaling efficiency: throughput (images/sec) vs linear ideal.
- Target top-1 validation accuracy $\ge 81.8\%$.

## Acceptance Criteria
- 300 epochs completed on 64 GPUs.
- Checkpoints saved with training log verifying $94.6\%$ scaling efficiency.`,
  },
  {
    seq: 28,
    startDate: d(-2),
    dueDate: d(5, 17),
    timeSpent: 11.5,
    content: `## Objective
Write Appendix A (Full Mathematical Proofs) detailing algebraic transitions for Lemma 1, Lemma 2, and Theorem 1.

## Technical Scope & Methodology
- Expand every intermediate algebraic step omitted from main body Section 6 for brevity.
- Detail bounding of the sum of adaptive step size coefficients using telescoping series.
- Ensure all notation strictly aligns with \`macros/math_commands.tex\`.

## Acceptance Criteria
- 8 full pages of rigorous proofs compiled in \`sections/appendix_a_proofs.tex\`.
- Signed off by theoretical reviewer.`,
  },
  {
    seq: 29,
    startDate: d(-5),
    dueDate: d(1, 17),
    timeSpent: 15.0,
    content: `## Objective
Validate regret bound proofs in the online convex programming setting for Section 6.

## Technical Scope & Methodology
- Verify that the cumulative regret $R(T) = \sum_{t=1}^T (f_t(\theta_t) - f_t(\theta^*))$ is upper-bounded by $O(\sqrt{T})$.
- Prove that decaying step size $\alpha_t = \alpha / \sqrt{t}$ preserves asymptotic convergence to the global optimum.
- Check inequality bounds under bounded gradient assumption $\|g_t\|_\infty \le G_\infty$.

## Acceptance Criteria
- Mathematical proof audited without unstated assumptions or circular logic.
- Theorem statement aligned with final notation in manuscript.`,
  },
  {
    seq: 30,
    startDate: d(-2),
    dueDate: d(4, 17),
    timeSpent: 6.5,
    content: `## Objective
Conduct thorough peer review of Section 6 (Convergence Analysis & Regret Bounds).

## Technical Scope & Methodology
- Check mathematical rigor of Lemmas 1, 2, and 3.
- Verify whether claims regarding general non-convex convergence are appropriately bounded.
- Provide detailed referee comments and line-by-line proof corrections.

## Acceptance Criteria
- Reviewer feedback report submitted with categorized major/minor remarks.
- Mathematical adjustments incorporated into manuscript draft.`,
  },
  {
    seq: 31,
    startDate: d(-1),
    dueDate: d(3, 17),
    timeSpent: 4.5,
    content: `## Objective
Audit decoupled weight decay implementation against the mathematical specification of Loshchilov & Hutter (ICLR 2019).

## Technical Scope & Methodology
- Confirm that weight decay multiplier $\eta_t \lambda \theta_t$ directly scales with current learning rate $\eta_t$.
- Ensure no accidental mixing occurs between gradient $L_2$ regularization and adaptive variance normalization.
- Compare optimizer state step execution against official reference implementation.

## Acceptance Criteria
- Code audit confirmation document verifying $100\%$ algorithmic fidelity.`,
  },
  {
    seq: 32,
    startDate: d(-1),
    dueDate: d(2, 17),
    timeSpent: 3.0,
    content: `## Objective
Cross-check BibTeX citation keys across all 10 section files to eliminate undefined citation warnings.

## Technical Scope & Methodology
- Run automated LaTeX linter checking every \`\\cite{...}\` call against \`references.bib\`.
- Fix typo errors in citation keys and eliminate duplicate references.
- Ensure consistent author name capitalization and journal abbreviations.

## Acceptance Criteria
- 0 undefined citation warnings during LaTeX compilation pass.
- Biber / BibTeX log runs with 0 errors.`,
  },
  {
    seq: 33,
    startDate: d(-2),
    dueDate: d(5, 17),
    timeSpent: 4.0,
    content: `## Objective
Review Appendix B (Model Architecture Specifications and Experimental Hyperparameters).

## Technical Scope & Methodology
- Confirm hidden dimensions, head counts, layer counts, and parameter counts match official publications.
- Document exact software versions: PyTorch 2.4.0, CUDA 12.4, cuDNN 9.1.
- Document hardware environment: NVIDIA H100 SXM5 80GB, Intel Xeon Platinum 8480C.

## Acceptance Criteria
- Complete architectural table verified and formatted in \`sections/appendix_b_architectures.tex\`.`,
  },
  {
    seq: 34,
    startDate: d(-1),
    dueDate: d(4, 17),
    timeSpent: 2.5,
    content: `## Objective
Execute camera-ready compliance check for IEEE Transactions on Pattern Analysis and Machine Intelligence format.

## Technical Scope & Methodology
- Check page margins, column gutter spacing, font embedding (Type 1 fonts required), and twocolumn layout.
- Verify vector figure resolution ($> 600\\text{ DPI}$) and color accessibility for print and digital.
- Ensure manuscript strictly fits within the 14-page limit including references.

## Acceptance Criteria
- Automated PDF compliance validator report passing all IEEE PDF eXpress checks.`,
  },

  // ── COMPLETED (FLUX-35 to FLUX-41): Completed Foundation Work (Sept 10 - Oct 02, 2026) ──
  {
    seq: 35,
    startDate: d(-12),
    dueDate: d(-2, 17),
    timeSpent: 28.0,
    completed: true,
    content: `## Objective
Synthesize empirical results across Logistic Regression and Multi-Layer Perceptrons (MLPs).

## Technical Scope & Methodology
- Generated training and test loss curves across MNIST, IMDB sentiment analysis, and CIFAR-10 datasets.
- Plotted convergence speedup of Adam relative to SGD, SGD with Nesterov momentum, and AdaGrad.
- Synthesized statistical confidence intervals over 10 random seeds.

## Acceptance Criteria
- Complete empirical results section with high-resolution vector figures in \`figures/empirical_loss_curves.pdf\`.
- All benchmark tables signed off by lead researcher.`,
  },
  {
    seq: 36,
    startDate: d(-14),
    dueDate: d(-5, 17),
    timeSpent: 21.0,
    completed: true,
    content: `## Objective
Verify analytical upper bound on step size ratio in Theorem 1.

## Technical Scope & Methodology
- Analytically proved that the effective step size is upper bounded by $\\gamma_t \\le \\alpha \\frac{\\sqrt{1 - \\beta_2^t}}{1 - \\beta_1^t}$.
- Established that the maximum effective step size is achieved in early iterations and remains finite.
- Formalized asymptotic bound as $t \\to \\infty$, ensuring bounded step sizes throughout training.

## Acceptance Criteria
- Formal proof accepted and integrated into Section 6 of the manuscript.`,
  },
  {
    seq: 37,
    startDate: d(-18),
    dueDate: d(-10, 17),
    timeSpent: 26.0,
    completed: true,
    content: `## Objective
Set up Overleaf / CLSI compiler integration and PDF generation engine for collaborative paper drafting.

## Technical Scope & Methodology
- Automated LaTeX compilation pipeline on main branch commits using pdftex and bibtex artifact export.
- Integrated Dockerized CLSI compilation container with SyncTeX forward/inverse search support.
- Configured real-time compilation error diagnostics parser.

## Acceptance Criteria
- Fast sub-second recompilation on incremental edits.
- Fully functional PDF preview with bidirectional SyncTeX click-to-source mapping.`,
  },
  {
    seq: 38,
    startDate: d(-16),
    dueDate: d(-7, 17),
    timeSpent: 32.5,
    completed: true,
    content: `## Objective
Construct 8x H100 cluster benchmark harness in PyTorch.

## Technical Scope & Methodology
- Configured automated throughput benchmarking script with synthetic and real data loaders.
- Implemented NCCL barrier synchronization and distributed performance metrics logger.
- Validated GPU thermal throttling mitigation and power capping profiles.

## Acceptance Criteria
- Reusable benchmark harness script \`benchmark_cluster_h100.py\` committed to codebase.
- Baseline benchmark results logged for all standard model sizes (1B to 70B).`,
  },
  {
    seq: 39,
    startDate: d(-24),
    dueDate: d(-16, 17),
    timeSpent: 18.5,
    completed: true,
    content: `## Objective
Draft Section 1 (Introduction & Motivation) in \`main.tex\`.

## Technical Scope & Methodology
- Authored comprehensive introduction detailing challenges in non-convex stochastic optimization.
- Motivated need for coordinate-wise adaptive learning rates invariant to diagonal gradient rescaling.
- Outlined primary paper contributions and manuscript organization.

## Acceptance Criteria
- Complete introductory narrative drafted in \`sections/01_introduction.tex\`.
- Peer-reviewed by co-authors and integrated into working draft.`,
  },
  {
    seq: 40,
    startDate: d(-22),
    dueDate: d(-15, 17),
    timeSpent: 14.0,
    completed: true,
    content: `## Objective
Set up Zotero schema v42 synchronization pipeline for reference library ingestion.

## Technical Scope & Methodology
- Configured base field mappings for 72 citation fields across book, article, and preprint types.
- Implemented automated schema validator and Zotero Web API connector.
- Verified bidirectional sync with Flux reference library.

## Acceptance Criteria
- Successful import of 32 core optimization papers into Flux library.
- Zero field corruption or missing authors in citation records.`,
  },
  {
    seq: 41,
    startDate: d(-19),
    dueDate: d(-12, 17),
    timeSpent: 11.0,
    completed: true,
    content: `## Objective
Compile \`references.bib\` with 45 peer-reviewed landmark ML papers.

## Technical Scope & Methodology
- Assembled landmark citations from Kingma, Vaswani, He, Loshchilov, Reddi, and Devlin.
- Standardized citation keys, capitalized title words per BibTeX standards, and validated DOIs.
- Integrated reference bib file into LaTeX build tree.

## Acceptance Criteria
- \`references.bib\` checked into repository.
- Fully compiling bibliography section in main paper PDF.`,
  },

  // ── CANCELLED (FLUX-42): Deprecated Historical Direction ──
  {
    seq: 42,
    startDate: d(-22),
    dueDate: d(-18, 17),
    timeSpent: 6.0,
    completed: false,
    content: `## Objective
Evaluate vanilla SGD without momentum baseline on non-convex objectives.

## Technical Scope & Methodology
- Benchmarked vanilla SGD against deep neural network loss surfaces with pathological curvature.
- Observed complete stalling in saddle points and high-curvature ravines.

## Reason for Cancellation
Vanilla SGD completely stalls in saddle points and ravines on complex deep neural network landscapes. Deprecated and cancelled in favor of AdaGrad and Adam baselines.`,
  },
];

async function main() {
  console.log('🔄 Enriching 42 work-items with realistic enterprise data...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Update each work item with realistic dates, timeSpent, and structured content
    for (const item of itemsUpdates) {
      const res = await client.query(
        `UPDATE work_items 
         SET start_date = $1, 
             due_date = $2, 
             time_spent = $3, 
             content = $4,
             completed = COALESCE($5, completed)
         WHERE sequence_number = $6
         RETURNING id, identifier, title, start_date, due_date, time_spent, completed`,
        [
          item.startDate,
          item.dueDate,
          item.timeSpent,
          item.content,
          item.completed !== undefined ? item.completed : null,
          item.seq,
        ]
      );
      if (res.rowCount > 0) {
        console.log(`  ✓ Updated ${res.rows[0].identifier}: [${res.rows[0].start_date?.toISOString().slice(0, 10)} -> ${res.rows[0].due_date?.toISOString().slice(0, 10)}] (${res.rows[0].time_spent}h spent)`);
      }
    }

    // 2. Fetch all IDs to map sequence to uuid
    const allItemsRes = await client.query('SELECT id, sequence_number FROM work_items');
    const seqToId = new Map(allItemsRes.rows.map((r) => [r.sequence_number, r.id]));

    // 3. Clear existing relations and seed realistic logical dependencies
    await client.query('DELETE FROM work_item_relations');
    console.log('🔗 Seeding logical work item relations...');

    const relations = [
      { sourceSeq: 20, targetSeq: 21, type: 'blocks' },
      { sourceSeq: 21, targetSeq: 22, type: 'blocks' },
      { sourceSeq: 24, targetSeq: 23, type: 'blocks' },
      { sourceSeq: 9, targetSeq: 36, type: 'relates_to' },
      { sourceSeq: 10, targetSeq: 41, type: 'relates_to' },
      { sourceSeq: 11, targetSeq: 27, type: 'relates_to' },
      { sourceSeq: 17, targetSeq: 31, type: 'relates_to' },
      { sourceSeq: 29, targetSeq: 30, type: 'relates_to' },
      { sourceSeq: 36, targetSeq: 28, type: 'relates_to' },
      { sourceSeq: 12, targetSeq: 26, type: 'relates_to' },
      { sourceSeq: 37, targetSeq: 34, type: 'relates_to' },
      { sourceSeq: 14, targetSeq: 23, type: 'relates_to' },
    ];

    for (const rel of relations) {
      const sourceId = seqToId.get(rel.sourceSeq);
      const targetId = seqToId.get(rel.targetSeq);
      if (sourceId && targetId) {
        await client.query(
          `INSERT INTO work_item_relations (id, source_id, target_id, type, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, NOW())
           ON CONFLICT DO NOTHING`,
          [sourceId, targetId, rel.type]
        );
        console.log(`  ✓ Relation: FLUX-${rel.sourceSeq} [${rel.type}] -> FLUX-${rel.targetSeq}`);
      }
    }

    await client.query('COMMIT');
    console.log('✅ PostgreSQL work-items successfully updated!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error updating work-items:', err);
    throw err;
  } finally {
    client.release();
  }

  // 4. Invalidate Redis Cache
  try {
    const keys = await redis.keys('flux:*');
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`🧹 Flushed ${keys.length} Redis cache keys.`);
    }
  } catch (err) {
    console.warn('⚠️ Could not flush Redis cache:', err.message);
  } finally {
    redis.disconnect();
  }

  console.log('🎉 All work-item data successfully standardized and cleaned!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
