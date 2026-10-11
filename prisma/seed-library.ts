import 'dotenv/config';
import { PrismaClient, RelationType } from '@prisma/client';
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

async function seedLibrary() {
  console.log(
    '📚 Starting clean academic dataset seeding for Library (Demo Ready)...',
  );

  // 1. Resolve User (Tấn Thành)
  const user = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true },
  });

  if (!user) {
    throw new Error(
      'User ngotanthanh92.26@gmail.com not found. Please run main seed first.',
    );
  }

  const project = await prisma.project.findFirst({
    where: { name: 'flux' },
  });

  if (!project) {
    throw new Error('Project "flux" not found. Please run main seed first.');
  }

  console.log(`👤 Seeding for User: ${user.email} (${user.id})`);
  console.log(`📁 Target Project: ${project.name} (${project.id})`);

  // 2. Clean ALL previous library entities globally (including orphaned data from deleted users)
  console.log('🧹 Purging all previous library data and orphaned items...');
  await prisma.annotation.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.note.deleteMany();
  await prisma.state.deleteMany();
  await prisma.itemRelation.deleteMany();
  await prisma.collectionItem.deleteMany();
  await prisma.itemTag.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.savedSearch.deleteMany();
  await prisma.userPublication.deleteMany();
  await prisma.contributor.deleteMany();
  await prisma.item.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.retraction.deleteMany();

  // 3. Create Research Tags
  console.log('🏷️ Creating research tags...');
  const tagsData = [
    { name: 'Deep Learning', color: '#3B82F6' },
    { name: 'Transformers', color: '#6366F1' },
    { name: 'Attention', color: '#8B5CF6' },
    { name: 'Optimization', color: '#06B6D4' },
    { name: 'GPU-Efficient', color: '#10B981' },
    { name: 'Diffusion', color: '#EC4899' },
    { name: 'Neural Operators', color: '#F97316' },
    { name: 'Mixture of Experts', color: '#EAB308' },
    { name: 'High-Priority', color: '#EF4444' },
    { name: 'Must-Read', color: '#14B8A6' },
    { name: 'NeurIPS', color: '#4F46E5' },
    { name: 'ICLR', color: '#7C3AED' },
    { name: 'CVPR', color: '#2563EB' },
    { name: 'ICML', color: '#0284C7' },
    { name: 'Nature', color: '#059669' },
  ];

  const tagMap = new Map<string, string>();
  for (const t of tagsData) {
    const createdTag = await prisma.tag.create({
      data: {
        name: t.name,
        color: t.color,
        type: 'manual',
        userId: user.id,
        projectId: null,
      },
    });
    tagMap.set(t.name, createdTag.id);
  }

  // 4. Create Personal Collections (in My Library, scope: 'user')
  console.log('📁 Creating structured Personal Collections for My Library...');
  const colLiterature = await prisma.collection.create({
    data: {
      name: 'Literature Review 2025-2026',
      description: 'Khảo sát tài liệu chuyên sâu phục vụ đề tài nghiên cứu',
      color: '#3B82F6',
      icon: 'BookOpen',
      sortOrder: 1,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colFoundation = await prisma.collection.create({
    data: {
      name: 'Foundation Models & LLMs',
      description: 'Mô hình nền tảng, cơ chế Transformer và lý luận mở rộng',
      color: '#6366F1',
      icon: 'Layers',
      sortOrder: 1,
      parentId: colLiterature.id,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colEfficiency = await prisma.collection.create({
    data: {
      name: 'LLM Efficiency & Quantization',
      description:
        'Kỹ thuật tối ưu hóa bộ nhớ, quantization và inference tăng tốc',
      color: '#60A5FA',
      icon: 'Zap',
      sortOrder: 2,
      parentId: colLiterature.id,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colTheory = await prisma.collection.create({
    data: {
      name: 'Core Optimization & Theory',
      description:
        'Lý thuyết hội tụ, gradient dynamics và các thuật toán tối ưu hóa',
      color: '#10B981',
      icon: 'Activity',
      sortOrder: 2,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colAdamDynamics = await prisma.collection.create({
    data: {
      name: 'Stochastic Gradients & Adam',
      description:
        'Họ thuật toán Adam, AMSGrad, Sophia và phân tích tốc độ hội tụ',
      color: '#34D399',
      icon: 'Compass',
      sortOrder: 1,
      parentId: colTheory.id,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colVision = await prisma.collection.create({
    data: {
      name: 'Computer Vision & Generative AI',
      description:
        'Thị giác máy tính, ViT, CLIP và mô hình khuếch tán hình ảnh',
      color: '#EC4899',
      icon: 'Eye',
      sortOrder: 3,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colSciML = await prisma.collection.create({
    data: {
      name: 'Scientific ML & Neural Operators',
      description: 'Toán tử nơ-ron Fourier (FNO), PINNs và mô phỏng vật lý',
      color: '#F97316',
      icon: 'TrendingUp',
      sortOrder: 4,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colMyPubs = await prisma.collection.create({
    data: {
      name: 'My Publications & Manuscripts',
      description:
        'Các công trình khoa học đã xuất bản và bản thảo đang bình duyệt',
      color: '#8B5CF6',
      icon: 'Award',
      sortOrder: 5,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  const colReadingQueue = await prisma.collection.create({
    data: {
      name: 'Reading Queue (Top Priority)',
      description: 'Danh sách bài báo ưu tiên đọc trong tuần',
      color: '#F59E0B',
      icon: 'Bookmark',
      sortOrder: 6,
      userId: user.id,
      createdById: user.id,
      projectId: null,
    },
  });

  // 5. Create Project Collections (scope: 'project' - flux)
  console.log('📁 Creating Project Collections for "flux"...');
  const colProjFoundation = await prisma.collection.create({
    data: {
      name: 'Foundation Models & Architectures',
      description: 'Kiến trúc Transformer, Attention và mô hình nền tảng dự án',
      color: '#6366F1',
      icon: 'Layers',
      sortOrder: 1,
      userId: user.id,
      createdById: user.id,
      projectId: project.id,
    },
  });

  const colProjOptimization = await prisma.collection.create({
    data: {
      name: 'Optimization & Gradient Dynamics',
      description: 'Thuật toán tối ưu bậc một và bậc hai phục vụ huấn luyện',
      color: '#EC4899',
      icon: 'TrendingUp',
      sortOrder: 2,
      userId: user.id,
      createdById: user.id,
      projectId: project.id,
    },
  });

  // 6. Dataset of Real Academic Papers
  console.log(
    '📄 Seeding realistic, peer-reviewed academic papers into My Library...',
  );

  interface PaperSeed {
    title: string;
    itemType: string;
    year: number;
    doi: string;
    publicationTitle: string;
    abstract: string;
    url: string;
    citationKey: string;
    authors: Array<{ firstName: string; lastName: string; fullName: string }>;
    projectScoped?: boolean;
    collections: string[];
    tags: string[];
    state?: {
      readStatus: 'unread' | 'reading' | 'completed';
      isStarred: boolean;
      rating?: number;
      currentPage?: number;
      lastOpenedHoursAgo?: number;
    };
    pdfFilename?: string;
    pageCount?: number;
    notes?: Array<{ title: string; contentMd: string }>;
    isMyPublication?: boolean;
    isRetracted?: boolean;
    retractionReason?: string;
  }

  const papers: PaperSeed[] = [
    // ── My Library: Foundation Models & Attention ──────────────────────────────
    {
      title: 'Attention Is All You Need',
      itemType: 'conferencePaper',
      year: 2017,
      doi: '10.48550/arXiv.1706.03762',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2017)',
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.',
      url: 'https://arxiv.org/abs/1706.03762',
      citationKey: 'vaswani2017attention',
      authors: [
        {
          firstName: 'Ashish',
          lastName: 'Vaswani',
          fullName: 'Ashish Vaswani',
        },
        { firstName: 'Noam', lastName: 'Shazeer', fullName: 'Noam Shazeer' },
        { firstName: 'Niki', lastName: 'Parmar', fullName: 'Niki Parmar' },
        {
          firstName: 'Jakob',
          lastName: 'Uszkoreit',
          fullName: 'Jakob Uszkoreit',
        },
        { firstName: 'Llion', lastName: 'Jones', fullName: 'Llion Jones' },
        {
          firstName: 'Aidan N.',
          lastName: 'Gomez',
          fullName: 'Aidan N. Gomez',
        },
        { firstName: 'Lukasz', lastName: 'Kaiser', fullName: 'Lukasz Kaiser' },
        {
          firstName: 'Illia',
          lastName: 'Polosukhin',
          fullName: 'Illia Polosukhin',
        },
      ],
      projectScoped: false,
      collections: [colLiterature.id, colFoundation.id],
      tags: [
        'Transformers',
        'Attention',
        'Deep Learning',
        'NeurIPS',
        'Must-Read',
      ],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 15,
        lastOpenedHoursAgo: 12,
      },
      pdfFilename: 'vaswani2017attention.pdf',
      pageCount: 15,
      notes: [
        {
          title: 'Ý nghĩa nền tảng của Cơ chế Multi-Head Self-Attention',
          contentMd:
            '### Nhận định chính:\n1. Loại bỏ hoàn toàn RNN/LSTM, giảm độ phức tạp tính toán tuần tự từ $O(n)$ xuống $O(1)$ phép tuần tự song song.\n2. Công thức Scaled Dot-Product Attention: $\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$.\n3. Yếu tố scale $\\frac{1}{\\sqrt{d_k}}$ giúp ngăn chặn gradient bị triệt tiêu khi $d_k$ lớn do hàm softmax đẩy giá trị vào vùng cực trị.',
        },
      ],
    },
    {
      title:
        'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      itemType: 'conferencePaper',
      year: 2019,
      doi: '10.18653/v1/N19-1423',
      publicationTitle:
        'Proceedings of the 2019 Conference of the North American Chapter of the ACL (NAACL 2019)',
      abstract:
        'We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. Unlike recent language representation models, BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers.',
      url: 'https://doi.org/10.18653/v1/N19-1423',
      citationKey: 'devlin2019bert',
      authors: [
        { firstName: 'Jacob', lastName: 'Devlin', fullName: 'Jacob Devlin' },
        {
          firstName: 'Ming-Wei',
          lastName: 'Chang',
          fullName: 'Ming-Wei Chang',
        },
        { firstName: 'Kenton', lastName: 'Lee', fullName: 'Kenton Lee' },
        {
          firstName: 'Kristina',
          lastName: 'Toutanova',
          fullName: 'Kristina Toutanova',
        },
      ],
      projectScoped: false,
      collections: [colLiterature.id, colFoundation.id],
      tags: ['Transformers', 'Deep Learning', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 16,
        lastOpenedHoursAgo: 36,
      },
      pdfFilename: 'devlin2019bert.pdf',
      pageCount: 16,
    },
    {
      title: 'Language Models are Few-Shot Learners',
      itemType: 'conferencePaper',
      year: 2020,
      doi: '10.48550/arXiv.2005.14165',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2020)',
      abstract:
        'Recent work has demonstrated substantial gains on many NLP tasks and benchmarks by pre-training on a large corpus of text followed by fine-tuning on a specific task. We demonstrate that scaling up language models greatly improves task-agnostic, few-shot performance, sometimes even reaching competitiveness with prior state-of-the-art fine-tuning approaches.',
      url: 'https://arxiv.org/abs/2005.14165',
      citationKey: 'brown2020gpt3',
      authors: [
        { firstName: 'Tom B.', lastName: 'Brown', fullName: 'Tom B. Brown' },
        { firstName: 'Benjamin', lastName: 'Mann', fullName: 'Benjamin Mann' },
        { firstName: 'Nick', lastName: 'Ryder', fullName: 'Nick Ryder' },
        {
          firstName: 'Melanie',
          lastName: 'Subbiah',
          fullName: 'Melanie Subbiah',
        },
        { firstName: 'Dario', lastName: 'Amodei', fullName: 'Dario Amodei' },
      ],
      projectScoped: false,
      collections: [colLiterature.id, colFoundation.id],
      tags: ['Transformers', 'NeurIPS', 'Deep Learning'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 75,
        lastOpenedHoursAgo: 48,
      },
      pdfFilename: 'brown2020gpt3.pdf',
      pageCount: 75,
    },
    {
      title:
        'DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model',
      itemType: 'preprint',
      year: 2024,
      doi: '10.48550/arXiv.2405.04434',
      publicationTitle: 'arXiv preprint',
      abstract:
        'We present DeepSeek-V2, a strong, economical, and efficient Mixture-of-Experts (MoE) language model with 236B total parameters, of which 21B are activated for each token. DeepSeek-V2 employs Multi-head Latent Attention (MLA) and DeepSeekMoE architectures to maximize efficiency.',
      url: 'https://arxiv.org/abs/2405.04434',
      citationKey: 'deepseek2024v2',
      authors: [
        {
          firstName: 'DeepSeek-AI',
          lastName: 'Team',
          fullName: 'DeepSeek-AI Team',
        },
        { firstName: 'Haowei', lastName: 'Zhang', fullName: 'Haowei Zhang' },
        { firstName: 'Damai', lastName: 'Dai', fullName: 'Damai Dai' },
      ],
      projectScoped: false,
      collections: [colLiterature.id, colFoundation.id, colEfficiency.id],
      tags: [
        'Mixture of Experts',
        'Transformers',
        'GPU-Efficient',
        'High-Priority',
      ],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
        currentPage: 18,
        lastOpenedHoursAgo: 2,
      },
      pdfFilename: 'deepseek2024v2.pdf',
      pageCount: 28,
    },
    {
      title:
        'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
      itemType: 'preprint',
      year: 2025,
      doi: '10.48550/arXiv.2501.12948',
      publicationTitle: 'arXiv preprint',
      abstract:
        'We introduce DeepSeek-R1-Zero and DeepSeek-R1. DeepSeek-R1-Zero is trained via large-scale reinforcement learning without supervised fine-tuning (SFT) as a preliminary step, demonstrating remarkable reasoning capabilities. DeepSeek-R1 incorporates multi-stage training and cold-start data to achieve state-of-the-art performance on math, coding, and reasoning benchmarks.',
      url: 'https://arxiv.org/abs/2501.12948',
      citationKey: 'deepseek2025r1',
      authors: [
        {
          firstName: 'DeepSeek-AI',
          lastName: 'Team',
          fullName: 'DeepSeek-AI Team',
        },
        { firstName: 'Daya', lastName: 'Guo', fullName: 'Daya Guo' },
        { firstName: 'Dejian', lastName: 'Yang', fullName: 'Dejian Yang' },
      ],
      projectScoped: false,
      collections: [colFoundation.id, colReadingQueue.id],
      tags: ['Transformers', 'Deep Learning', 'High-Priority', 'Must-Read'],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
        currentPage: 12,
        lastOpenedHoursAgo: 1,
      },
      pdfFilename: 'deepseek2025r1.pdf',
      pageCount: 24,
      notes: [
        {
          title:
            'Phân tích cơ chế suy luận qua Reinforcement Learning trong DeepSeek-R1',
          contentMd:
            '### Đột phá cốt lõi:\n- Mô hình phát triển khả năng tự kiểm tra (self-reflection) và thử nghiệm chuỗi suy luận dài (chain-of-thought) thuần túy qua phần thưởng quy tắc (rule-based reward).\n- Loại bỏ sự phụ thuộc vào dữ liệu SFT khổng lồ từ con người, giảm chi phí huấn luyện xuống mức tối thiểu.',
        },
      ],
    },
    {
      title: 'Llama 2: Open Foundation and Fine-Tuned Chat Models',
      itemType: 'preprint',
      year: 2023,
      doi: '10.48550/arXiv.2307.09288',
      publicationTitle: 'arXiv preprint',
      abstract:
        'In this work, we develop and release Llama 2, a collection of pretrained and finetuned large language models (LLMs) ranging in scale from 7B to 70B parameters. Our fine-tuned LLMs, called Llama 2-Chat, are optimized for dialogue use cases.',
      url: 'https://arxiv.org/abs/2307.09288',
      citationKey: 'touvron2023llama2',
      authors: [
        { firstName: 'Hugo', lastName: 'Touvron', fullName: 'Hugo Touvron' },
        { firstName: 'Louis', lastName: 'Martin', fullName: 'Louis Martin' },
        { firstName: 'Kevin', lastName: 'Stone', fullName: 'Kevin Stone' },
      ],
      projectScoped: false,
      collections: [colFoundation.id],
      tags: ['Transformers', 'Deep Learning'],
      state: {
        readStatus: 'completed',
        isStarred: false,
        rating: 4,
        currentPage: 77,
        lastOpenedHoursAgo: 120,
      },
      pdfFilename: 'touvron2023llama2.pdf',
      pageCount: 77,
    },

    // ── My Library: LLM Efficiency, Quantization & Architecture ────────────────
    {
      title:
        'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness',
      itemType: 'conferencePaper',
      year: 2022,
      doi: '10.48550/arXiv.2205.14135',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2022)',
      abstract:
        'Transformers are slow and memory-hungry on long sequences, as the time and memory complexity of self-attention are quadratic in sequence length. We propose FlashAttention, an IO-aware exact attention algorithm that uses tiling to reduce the number of memory reads/writes between GPU high bandwidth memory (HBM) and GPU on-chip SRAM.',
      url: 'https://arxiv.org/abs/2205.14135',
      citationKey: 'dao2022flashattention',
      authors: [
        { firstName: 'Tri', lastName: 'Dao', fullName: 'Tri Dao' },
        { firstName: 'Daniel Y.', lastName: 'Fu', fullName: 'Daniel Y. Fu' },
        { firstName: 'Stefano', lastName: 'Ermon', fullName: 'Stefano Ermon' },
        { firstName: 'Atri', lastName: 'Rudra', fullName: 'Atri Rudra' },
        {
          firstName: 'Christopher',
          lastName: 'Ré',
          fullName: 'Christopher Ré',
        },
      ],
      projectScoped: false,
      collections: [colLiterature.id, colEfficiency.id],
      tags: [
        'Attention',
        'GPU-Efficient',
        'Deep Learning',
        'NeurIPS',
        'High-Priority',
      ],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
        currentPage: 8,
        lastOpenedHoursAgo: 3,
      },
      pdfFilename: 'dao2022flashattention.pdf',
      pageCount: 14,
      notes: [
        {
          title: 'Phân tích GPU IO Memory Tiling trong FlashAttention',
          contentMd:
            '### Trọng tâm kỹ thuật:\n- Thuật toán chia ma trận $Q, K, V$ thành các khối nhỏ (blocks) vừa khít với SRAM GPU (~100KB-256KB).\n- Ứng dụng kỹ thuật Online Softmax để tính toán softmax từng phần mà không cần lưu toàn bộ ma trận chú ý $N \\times N$ vào HBM.\n- Tốc độ tăng 2-4x và tiết kiệm bộ nhớ tới 5-20x trên sequence dài (16k - 64k tokens).',
        },
      ],
    },
    {
      title:
        'FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning',
      itemType: 'conferencePaper',
      year: 2024,
      doi: '10.48550/arXiv.2307.08691',
      publicationTitle:
        'International Conference on Learning Representations (ICLR 2024)',
      abstract:
        'FlashAttention-2 improves upon FlashAttention by reducing non-matmul FLOPs, optimizing parallelization across warp threads, and improving work partitioning between thread blocks on NVIDIA GPUs.',
      url: 'https://arxiv.org/abs/2307.08691',
      citationKey: 'dao2023flashattention2',
      authors: [{ firstName: 'Tri', lastName: 'Dao', fullName: 'Tri Dao' }],
      projectScoped: false,
      collections: [colEfficiency.id],
      tags: ['Attention', 'GPU-Efficient', 'ICLR'],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
        currentPage: 6,
        lastOpenedHoursAgo: 14,
      },
      pdfFilename: 'dao2023flashattention2.pdf',
      pageCount: 12,
    },
    {
      title: 'LoRA: Low-Rank Adaptation of Large Language Models',
      itemType: 'conferencePaper',
      year: 2022,
      doi: '10.48550/arXiv.2106.09685',
      publicationTitle:
        'International Conference on Learning Representations (ICLR 2022)',
      abstract:
        'An important paradigm of natural language processing consists of large-scale pre-training on general domain data and adaptation to particular tasks or domains. We propose Low-Rank Adaptation, or LoRA, which freezes the pre-trained model weights and injects trainable rank decomposition matrices into each layer of the Transformer architecture.',
      url: 'https://arxiv.org/abs/2106.09685',
      citationKey: 'hu2021lora',
      authors: [
        { firstName: 'Edward J.', lastName: 'Hu', fullName: 'Edward J. Hu' },
        { firstName: 'Yelong', lastName: 'Shen', fullName: 'Yelong Shen' },
        {
          firstName: 'Phillip',
          lastName: 'Wallis',
          fullName: 'Phillip Wallis',
        },
        {
          firstName: 'Zeyuan',
          lastName: 'Allen-Zhu',
          fullName: 'Zeyuan Allen-Zhu',
        },
        { firstName: 'Yuanzhi', lastName: 'Li', fullName: 'Yuanzhi Li' },
        { firstName: 'Weizhu', lastName: 'Chen', fullName: 'Weizhu Chen' },
      ],
      projectScoped: false,
      collections: [colLiterature.id, colEfficiency.id],
      tags: ['Transformers', 'GPU-Efficient', 'ICLR', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 26,
        lastOpenedHoursAgo: 24,
      },
      pdfFilename: 'hu2021lora.pdf',
      pageCount: 26,
    },
    {
      title: 'QLoRA: Efficient Finetuning of Quantized LLMs',
      itemType: 'conferencePaper',
      year: 2023,
      doi: '10.48550/arXiv.2305.14314',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2023)',
      abstract:
        'We present QLoRA, an efficient finetuning approach that reduces memory usage enough to finetune a 65B parameter model on a single 48GB GPU while preserving full 16-bit finetuning task performance. QLoRA backpropagates gradients through a frozen, 4-bit quantized pretrained language model into Low Rank Adapters (LoRA).',
      url: 'https://arxiv.org/abs/2305.14314',
      citationKey: 'dettmers2023qlora',
      authors: [
        { firstName: 'Tim', lastName: 'Dettmers', fullName: 'Tim Dettmers' },
        {
          firstName: 'Artidoro',
          lastName: 'Pagnoni',
          fullName: 'Artidoro Pagnoni',
        },
        { firstName: 'Ari', lastName: 'Holtzman', fullName: 'Ari Holtzman' },
        {
          firstName: 'Luke',
          lastName: 'Zettlemoyer',
          fullName: 'Luke Zettlemoyer',
        },
      ],
      projectScoped: false,
      collections: [colEfficiency.id, colReadingQueue.id],
      tags: ['GPU-Efficient', 'NeurIPS', 'High-Priority'],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 4,
        currentPage: 9,
        lastOpenedHoursAgo: 6,
      },
      pdfFilename: 'dettmers2023qlora.pdf',
      pageCount: 26,
    },
    {
      title: 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces',
      itemType: 'preprint',
      year: 2023,
      doi: '10.48550/arXiv.2312.00752',
      publicationTitle: 'arXiv preprint',
      abstract:
        'Foundation models, now powering most of the exciting applications in deep learning, are almost universally based on the standard Transformer architecture. We introduce Mamba, a selective structured state space model with hardware-aware parallel scan that achieves linear-time sequence modeling.',
      url: 'https://arxiv.org/abs/2312.00752',
      citationKey: 'gu2023mamba',
      authors: [
        { firstName: 'Albert', lastName: 'Gu', fullName: 'Albert Gu' },
        { firstName: 'Tri', lastName: 'Dao', fullName: 'Tri Dao' },
      ],
      projectScoped: false,
      collections: [colEfficiency.id, colReadingQueue.id],
      tags: ['GPU-Efficient', 'Deep Learning', 'Must-Read'],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
        currentPage: 15,
        lastOpenedHoursAgo: 4,
      },
      pdfFilename: 'gu2023mamba.pdf',
      pageCount: 33,
    },

    // ── My Library: Optimization & Theoretical Dynamics ────────────────────────
    {
      title: 'Adam: A Method for Stochastic Optimization',
      itemType: 'conferencePaper',
      year: 2015,
      doi: '10.48550/arXiv.1412.6980',
      publicationTitle:
        'International Conference on Learning Representations (ICLR 2015)',
      abstract:
        'We introduce Adam, an algorithm for first-order gradient-based optimization of stochastic objective functions, based on adaptive estimates of lower-order moments. The method is straightforward to implement, is computationally efficient, has little memory requirements, and is invariant to diagonal rescaling of the gradients.',
      url: 'https://arxiv.org/abs/1412.6980',
      citationKey: 'kingma2014adam',
      authors: [
        {
          firstName: 'Diederik P.',
          lastName: 'Kingma',
          fullName: 'Diederik P. Kingma',
        },
        { firstName: 'Jimmy', lastName: 'Ba', fullName: 'Jimmy Ba' },
      ],
      projectScoped: false,
      collections: [colTheory.id, colAdamDynamics.id],
      tags: ['Optimization', 'Deep Learning', 'ICLR', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 15,
        lastOpenedHoursAgo: 72,
      },
      pdfFilename: 'kingma2014adam.pdf',
      pageCount: 15,
      notes: [
        {
          title: 'Thuật toán Adam và Ước lượng Moment Động',
          contentMd:
            'Công thức cập nhật:\n$$m_t = \\beta_1 m_{t-1} + (1 - \\beta_1) g_t$$\n$$v_t = \\beta_2 v_{t-1} + (1 - \\beta_2) g_t^2$$\nHiệu chỉnh độ chệch (Bias correction):\n$$\\hat{m}_t = \\frac{m_t}{1 - \\beta_1^t}, \\quad \\hat{v}_t = \\frac{v_t}{1 - \\beta_2^t}$$\nBước cập nhật trọng số: $\\theta_t = \\theta_{t-1} - \\frac{\\alpha}{\\sqrt{\\hat{v}_t} + \\epsilon} \\hat{m}_t$.',
        },
      ],
    },
    {
      title: 'On the Convergence of Adam and Beyond (AMSGrad)',
      itemType: 'conferencePaper',
      year: 2018,
      doi: '10.48550/arXiv.1904.09237',
      publicationTitle:
        'International Conference on Learning Representations (ICLR 2018)',
      abstract:
        'Several recently proposed stochastic optimization methods that have been successfully used in training deep networks such as RMSProp, Adam, Adadelta, and Nadam rely on using previous gradient history to scale the gradient. We show that there are simple convex optimization problems where Adam fails to converge to the optimal solution. We propose a new variant, AMSGrad, that fixes this issue.',
      url: 'https://arxiv.org/abs/1904.09237',
      citationKey: 'reddi2018convergence',
      authors: [
        {
          firstName: 'Sashank J.',
          lastName: 'Reddi',
          fullName: 'Sashank J. Reddi',
        },
        { firstName: 'Satyen', lastName: 'Kale', fullName: 'Satyen Kale' },
        { firstName: 'Sanjiv', lastName: 'Kumar', fullName: 'Sanjiv Kumar' },
      ],
      projectScoped: false,
      collections: [colTheory.id, colAdamDynamics.id],
      tags: ['Optimization', 'ICLR'],
      state: {
        readStatus: 'completed',
        isStarred: false,
        rating: 4,
        currentPage: 23,
      },
      pdfFilename: 'reddi2018convergence.pdf',
      pageCount: 23,
    },
    {
      title: 'Decoupled Weight Decay Regularization (AdamW)',
      itemType: 'conferencePaper',
      year: 2019,
      doi: '10.48550/arXiv.1711.05101',
      publicationTitle:
        'International Conference on Learning Representations (ICLR 2019)',
      abstract:
        'L2 regularization and weight decay regularization are equivalent for standard stochastic gradient descent (when rescaled by the learning rate), but as we demonstrate, this is not the case for adaptive gradient algorithms such as Adam. We propose Decoupled Weight Decay (AdamW) which recovers the original formulation of weight decay regularization.',
      url: 'https://arxiv.org/abs/1711.05101',
      citationKey: 'loshchilov2019adamw',
      authors: [
        {
          firstName: 'Ilya',
          lastName: 'Loshchilov',
          fullName: 'Ilya Loshchilov',
        },
        { firstName: 'Frank', lastName: 'Hutter', fullName: 'Frank Hutter' },
      ],
      projectScoped: false,
      collections: [colTheory.id, colAdamDynamics.id],
      tags: ['Optimization', 'ICLR', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 18,
      },
      pdfFilename: 'loshchilov2019adamw.pdf',
      pageCount: 18,
    },
    {
      title: 'Symbolic Discovery of Optimization Algorithms (Lion Optimizer)',
      itemType: 'conferencePaper',
      year: 2023,
      doi: '10.48550/arXiv.2302.06675',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2023)',
      abstract:
        'We formulate algorithm discovery as program search and apply symbolic discovery to optimization algorithms. We discover a simple and effective optimization algorithm, Lion (EvoLved Sign Momentum). It is more memory-efficient than Adam as it only tracks momentum, and uses the sign operation to produce uniform update magnitudes.',
      url: 'https://arxiv.org/abs/2302.06675',
      citationKey: 'chen2023symbolic',
      authors: [
        {
          firstName: 'Xiangning',
          lastName: 'Chen',
          fullName: 'Xiangning Chen',
        },
        { firstName: 'Chen', lastName: 'Liang', fullName: 'Chen Liang' },
        { firstName: 'Da', lastName: 'Huang', fullName: 'Da Huang' },
        { firstName: 'Esteban', lastName: 'Real', fullName: 'Esteban Real' },
        { firstName: 'Quoc V.', lastName: 'Le', fullName: 'Quoc V. Le' },
      ],
      projectScoped: false,
      collections: [colTheory.id, colReadingQueue.id],
      tags: ['Optimization', 'NeurIPS', 'GPU-Efficient'],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
        currentPage: 6,
        lastOpenedHoursAgo: 5,
      },
      pdfFilename: 'chen2023symbolic.pdf',
      pageCount: 18,
    },

    // ── My Library: Computer Vision & Generative AI ────────────────────────────
    {
      title: 'Deep Residual Learning for Image Recognition',
      itemType: 'conferencePaper',
      year: 2016,
      doi: '10.1109/CVPR.2016.90',
      publicationTitle:
        'IEEE Conference on Computer Vision and Pattern Recognition (CVPR 2016)',
      abstract:
        'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously. We explicitly reformulate the layers as learning residual functions with reference to the layer inputs, instead of learning unreferenced functions.',
      url: 'https://doi.org/10.1109/CVPR.2016.90',
      citationKey: 'he2016deep',
      authors: [
        { firstName: 'Kaiming', lastName: 'He', fullName: 'Kaiming He' },
        { firstName: 'Xiangyu', lastName: 'Zhang', fullName: 'Xiangyu Zhang' },
        { firstName: 'Shaoqing', lastName: 'Ren', fullName: 'Shaoqing Ren' },
        { firstName: 'Jian', lastName: 'Sun', fullName: 'Jian Sun' },
      ],
      projectScoped: false,
      collections: [colLiterature.id, colVision.id],
      tags: ['Deep Learning', 'CVPR', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 12,
      },
      pdfFilename: 'he2016deep.pdf',
      pageCount: 12,
    },
    {
      title: 'High-Resolution Image Synthesis with Latent Diffusion Models',
      itemType: 'conferencePaper',
      year: 2022,
      doi: '10.1109/CVPR52688.2022.01042',
      publicationTitle:
        'IEEE Conference on Computer Vision and Pattern Recognition (CVPR 2022)',
      abstract:
        'By decomposing the image formation process into a sequential application of denoising autoencoders, diffusion models (DMs) achieve state-of-the-art synthesis results on image data. We propose Latent Diffusion Models (LDMs), which enable training on limited computational resources by shifting the diffusion process into a lower-dimensional latent space.',
      url: 'https://doi.org/10.1109/CVPR52688.2022.01042',
      citationKey: 'rombach2022high',
      authors: [
        { firstName: 'Robin', lastName: 'Rombach', fullName: 'Robin Rombach' },
        {
          firstName: 'Andreas',
          lastName: 'Blattmann',
          fullName: 'Andreas Blattmann',
        },
        {
          firstName: 'Dominik',
          lastName: 'Lorenz',
          fullName: 'Dominik Lorenz',
        },
        { firstName: 'Patrick', lastName: 'Esser', fullName: 'Patrick Esser' },
        { firstName: 'Björn', lastName: 'Ommer', fullName: 'Björn Ommer' },
      ],
      projectScoped: false,
      collections: [colVision.id],
      tags: ['Diffusion', 'CVPR', 'Deep Learning'],
      state: {
        readStatus: 'reading',
        isStarred: false,
        rating: 4,
        currentPage: 14,
        lastOpenedHoursAgo: 8,
      },
      pdfFilename: 'rombach2022high.pdf',
      pageCount: 23,
    },
    {
      title:
        'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale',
      itemType: 'conferencePaper',
      year: 2021,
      doi: '10.48550/arXiv.2010.11929',
      publicationTitle:
        'International Conference on Learning Representations (ICLR 2021)',
      abstract:
        'While the Transformer architecture has become the de-facto standard for natural language processing tasks, its applications to computer vision remain limited. We show that this reliance on CNNs is not necessary and a pure transformer applied directly to sequences of image patches can perform very well on image classification tasks.',
      url: 'https://arxiv.org/abs/2010.11929',
      citationKey: 'dosovitskiy2020vit',
      authors: [
        {
          firstName: 'Alexey',
          lastName: 'Dosovitskiy',
          fullName: 'Alexey Dosovitskiy',
        },
        { firstName: 'Lucas', lastName: 'Beyer', fullName: 'Lucas Beyer' },
        {
          firstName: 'Alexander',
          lastName: 'Kolesnikov',
          fullName: 'Alexander Kolesnikov',
        },
        {
          firstName: 'Dirk',
          lastName: 'Weissenborn',
          fullName: 'Dirk Weissenborn',
        },
        { firstName: 'Neil', lastName: 'Houlsby', fullName: 'Neil Houlsby' },
      ],
      projectScoped: false,
      collections: [colVision.id],
      tags: ['Transformers', 'ICLR', 'Deep Learning', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 22,
      },
      pdfFilename: 'dosovitskiy2020vit.pdf',
      pageCount: 22,
    },
    {
      title:
        'Learning Transferable Visual Models From Natural Language Supervision (CLIP)',
      itemType: 'conferencePaper',
      year: 2021,
      doi: '10.48550/arXiv.2103.00020',
      publicationTitle:
        'International Conference on Machine Learning (ICML 2021)',
      abstract:
        'State-of-the-art computer vision systems are trained to predict a fixed set of predetermined object categories. We demonstrate that the simple pre-training task of predicting which caption goes with which image is an efficient and scalable way to learn SOTA image representations from scratch on a dataset of 400 million (image, text) pairs collected from the internet.',
      url: 'https://arxiv.org/abs/2103.00020',
      citationKey: 'radford2021clip',
      authors: [
        { firstName: 'Alec', lastName: 'Radford', fullName: 'Alec Radford' },
        { firstName: 'Jong Wook', lastName: 'Kim', fullName: 'Jong Wook Kim' },
        { firstName: 'Chris', lastName: 'Hallacy', fullName: 'Chris Hallacy' },
        { firstName: 'Aditya', lastName: 'Ramesh', fullName: 'Aditya Ramesh' },
        {
          firstName: 'Ilya',
          lastName: 'Sutskever',
          fullName: 'Ilya Sutskever',
        },
      ],
      projectScoped: false,
      collections: [colVision.id],
      tags: ['ICML', 'Deep Learning', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 38,
      },
      pdfFilename: 'radford2021clip.pdf',
      pageCount: 38,
    },
    {
      title: 'Denoising Diffusion Probabilistic Models',
      itemType: 'conferencePaper',
      year: 2020,
      doi: '10.48550/arXiv.2006.11239',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2020)',
      abstract:
        'We present high quality image synthesis results using diffusion probabilistic models, a class of latent variable models inspired by considerations from nonequilibrium thermodynamics. Our best results are obtained by training on a weighted variational bound designed according to a novel connection between diffusion models and denoising score matching.',
      url: 'https://arxiv.org/abs/2006.11239',
      citationKey: 'ho2020ddpm',
      authors: [
        { firstName: 'Jonathan', lastName: 'Ho', fullName: 'Jonathan Ho' },
        { firstName: 'Ajay', lastName: 'Jain', fullName: 'Ajay Jain' },
        { firstName: 'Pieter', lastName: 'Abbeel', fullName: 'Pieter Abbeel' },
      ],
      projectScoped: false,
      collections: [colVision.id],
      tags: ['Diffusion', 'NeurIPS', 'Deep Learning'],
      state: {
        readStatus: 'completed',
        isStarred: false,
        rating: 4,
        currentPage: 25,
      },
      pdfFilename: 'ho2020ddpm.pdf',
      pageCount: 25,
    },

    // ── My Library: Scientific ML & Neural Operators ───────────────────────────
    {
      title:
        'Fourier Neural Operator for Parametric Partial Differential Equations',
      itemType: 'conferencePaper',
      year: 2021,
      doi: '10.48550/arXiv.2010.08895',
      publicationTitle:
        'International Conference on Learning Representations (ICLR 2021)',
      abstract:
        'The classical development of neural networks has primarily focused on mappings between finite-dimensional Euclidean spaces. Here we propose a new framework for learning mesh-independent mappings between function spaces using Fourier neural operators (FNO). FNO parameterizes the integral kernel directly in Fourier space.',
      url: 'https://arxiv.org/abs/2010.08895',
      citationKey: 'li2021fourier',
      authors: [
        { firstName: 'Zongyi', lastName: 'Li', fullName: 'Zongyi Li' },
        {
          firstName: 'Nikola',
          lastName: 'Kovachki',
          fullName: 'Nikola Kovachki',
        },
        {
          firstName: 'Kamyar',
          lastName: 'Azizzadenesheli',
          fullName: 'Kamyar Azizzadenesheli',
        },
        { firstName: 'Burigede', lastName: 'Liu', fullName: 'Burigede Liu' },
        {
          firstName: 'Anima',
          lastName: 'Anandkumar',
          fullName: 'Anima Anandkumar',
        },
      ],
      projectScoped: false,
      collections: [colSciML.id, colReadingQueue.id],
      tags: ['Neural Operators', 'ICLR', 'Deep Learning', 'High-Priority'],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
        currentPage: 11,
        lastOpenedHoursAgo: 1,
      },
      pdfFilename: 'li2021fourier.pdf',
      pageCount: 22,
    },
    {
      title:
        'Physics-Informed Neural Networks: A Deep Learning Framework for Solving Forward and Inverse Problems',
      itemType: 'journalArticle',
      year: 2019,
      doi: '10.1016/j.jcp.2018.10.045',
      publicationTitle: 'Journal of Computational Physics',
      abstract:
        'We introduce physics-informed neural networks (PINNs) – neural networks that are trained to solve supervised learning tasks while respecting any given laws of physics described by general nonlinear partial differential equations.',
      url: 'https://doi.org/10.1016/j.jcp.2018.10.045',
      citationKey: 'raissi2019physics',
      authors: [
        { firstName: 'Maziar', lastName: 'Raissi', fullName: 'Maziar Raissi' },
        {
          firstName: 'Paris',
          lastName: 'Perdikaris',
          fullName: 'Paris Perdikaris',
        },
        {
          firstName: 'George Em',
          lastName: 'Karniadakis',
          fullName: 'George Em Karniadakis',
        },
      ],
      projectScoped: false,
      collections: [colSciML.id],
      tags: ['Neural Operators', 'Deep Learning'],
      state: {
        readStatus: 'completed',
        isStarred: false,
        rating: 4,
        currentPage: 30,
      },
      pdfFilename: 'raissi2019physics.pdf',
      pageCount: 30,
    },
    {
      title: 'Highly accurate protein structure prediction with AlphaFold',
      itemType: 'journalArticle',
      year: 2021,
      doi: '10.1038/s41586-021-03819-2',
      publicationTitle: 'Nature',
      abstract:
        'Proteins are essential to life, and understanding their structure can facilitate a mechanistic understanding of their function. We demonstrate that AlphaFold can predict 3D atomic coordinates for hundreds of thousands of proteins with atomic accuracy, solving a 50-year-old challenge in structural biology.',
      url: 'https://doi.org/10.1038/s41586-021-03819-2',
      citationKey: 'jumper2021alphafold',
      authors: [
        { firstName: 'John', lastName: 'Jumper', fullName: 'John Jumper' },
        { firstName: 'Richard', lastName: 'Evans', fullName: 'Richard Evans' },
        {
          firstName: 'Alexander',
          lastName: 'Pritzel',
          fullName: 'Alexander Pritzel',
        },
        {
          firstName: 'Demis',
          lastName: 'Hassabis',
          fullName: 'Demis Hassabis',
        },
      ],
      projectScoped: false,
      collections: [colSciML.id],
      tags: ['Deep Learning', 'Nature', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 15,
      },
      pdfFilename: 'jumper2021alphafold.pdf',
      pageCount: 15,
    },

    // ── My Library: My Publications (Tấn Thành) ────────────────────
    {
      title:
        'Adaptive Learning Rates via Spectral Hessian Decomposition for Scientific Machine Learning',
      itemType: 'journalArticle',
      year: 2025,
      doi: '10.1109/TPAMI.2025.1049281',
      publicationTitle:
        'IEEE Transactions on Pattern Analysis and Machine Intelligence (TPAMI)',
      abstract:
        'We propose an adaptive spectral optimization scheme that leverages low-rank stochastic Lanczos quadratures to dynamically regularize ill-conditioned Hessian spectra in neural operators and scientific computing tasks.',
      url: 'https://doi.org/10.1109/TPAMI.2025.1049281',
      citationKey: 'ngo2025adaptive',
      authors: [
        { firstName: 'Tan-Thanh', lastName: 'Ngo', fullName: 'Tan-Thanh Ngo' },
        { firstName: 'Evelyn', lastName: 'Vance', fullName: 'Evelyn Vance' },
        { firstName: 'Alex', lastName: 'Chen', fullName: 'Alex Chen' },
      ],
      projectScoped: false,
      collections: [colMyPubs.id, colTheory.id, colSciML.id],
      tags: ['Optimization', 'Neural Operators', 'High-Priority'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 16,
        lastOpenedHoursAgo: 3,
      },
      pdfFilename: 'ngo2025adaptive_tpami.pdf',
      pageCount: 16,
      isMyPublication: true,
      notes: [
        {
          title: 'Ghi chú bình duyệt TPAMI 2025 - Phân tích Hessian Spectra',
          contentMd:
            'Công trình đã được chấp thuận đăng chính thức trên IEEE TPAMI. Đóng góp chính: Xấp xỉ Hessian không tường minh bằng phương pháp Lanczos, giảm chi phí từ $O(d^3)$ xuống $O(k \\cdot d)$ trong đó $k \\ll d$.',
        },
      ],
    },
    {
      title:
        'Physics-Constrained Neural Operators for Multiscale Fluid Flow Inversion',
      itemType: 'conferencePaper',
      year: 2024,
      doi: '10.48550/arXiv.2411.08921',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2024)',
      abstract:
        'Inverse problem estimation in turbulent Navier-Stokes regimes remains computationally prohibitive. We introduce a physics-constrained Fourier neural operator architecture enforcing conservation laws via soft penalty and projection steps.',
      url: 'https://arxiv.org/abs/2411.08921',
      citationKey: 'ngo2024physics',
      authors: [
        { firstName: 'Tan-Thanh', lastName: 'Ngo', fullName: 'Tan-Thanh Ngo' },
        { firstName: 'Marcus', lastName: 'Brody', fullName: 'Marcus Brody' },
        { firstName: 'Alex', lastName: 'Chen', fullName: 'Alex Chen' },
      ],
      projectScoped: false,
      collections: [colMyPubs.id, colSciML.id],
      tags: ['Neural Operators', 'NeurIPS'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 14,
        lastOpenedHoursAgo: 5,
      },
      pdfFilename: 'ngo2024physics_neurips.pdf',
      pageCount: 14,
      isMyPublication: true,
    },

    // ── My Library: Curation Demo (Duplicate Pair) ─────────────────────────────
    {
      title: 'Attention Is All You Need (ArXiv Version)',
      itemType: 'preprint',
      year: 2017,
      doi: '10.48550/arXiv.1706.03762', // Identical DOI triggers duplicate detection
      publicationTitle: 'arXiv preprint',
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose the Transformer, based solely on attention mechanisms.',
      url: 'https://arxiv.org/abs/1706.03762',
      citationKey: 'vaswani2017attention_arxiv',
      authors: [
        {
          firstName: 'Ashish',
          lastName: 'Vaswani',
          fullName: 'Ashish Vaswani',
        },
        { firstName: 'Noam', lastName: 'Shazeer', fullName: 'Noam Shazeer' },
      ],
      projectScoped: false,
      collections: [colLiterature.id],
      tags: ['Transformers'],
      state: {
        readStatus: 'unread',
        isStarred: false,
      },
      pdfFilename: 'vaswani_preprint.pdf',
      pageCount: 15,
    },

    // ── My Library: Retraction Watch Demo ──────────────────────────────────────
    {
      title:
        'Hydroxychloroquine or chloroquine with or without a macrolide for treatment of COVID-19: a multinational registry analysis',
      itemType: 'journalArticle',
      year: 2020,
      doi: '10.1016/S0140-6736(20)31180-6',
      publicationTitle: 'The Lancet (Retracted)',
      abstract:
        '[RETRACTED] We were unable to confirm a benefit of hydroxychloroquine or chloroquine, when used alone or with a macrolide, on in-hospital outcomes for COVID-19. Each of these drug regimens was associated with decreased in-hospital survival.',
      url: 'https://doi.org/10.1016/S0140-6736(20)31180-6',
      citationKey: 'mehra2020retracted',
      authors: [
        {
          firstName: 'Mandeep R.',
          lastName: 'Mehra',
          fullName: 'Mandeep R. Mehra',
        },
        {
          firstName: 'Sapan S.',
          lastName: 'Desai',
          fullName: 'Sapan S. Desai',
        },
        {
          firstName: 'Frank',
          lastName: 'Ruschitzka',
          fullName: 'Frank Ruschitzka',
        },
        { firstName: 'Amit N.', lastName: 'Patel', fullName: 'Amit N. Patel' },
      ],
      projectScoped: false,
      collections: [], // Unfiled
      tags: ['High-Priority'],
      state: {
        readStatus: 'unread',
        isStarred: false,
      },
      isRetracted: true,
      retractionReason:
        'Retracted on June 5, 2020 due to authors inability to verify the authenticity and provenance of primary registry data provided by Surgisphere.',
    },

    // ── My Library: Unfiled Real Papers (to test Unfiled Items filter) ─────────
    {
      title: 'The Llama 3 Herd of Models',
      itemType: 'preprint',
      year: 2024,
      doi: '10.48550/arXiv.2407.21783',
      publicationTitle: 'arXiv preprint',
      abstract:
        'Modern artificial intelligence is largely powered by large language models. We introduce Llama 3, a herd of language models with 8B, 70B, and 405B parameters natively supporting multilinguality, coding, reasoning, and tool usage.',
      url: 'https://arxiv.org/abs/2407.21783',
      citationKey: 'dubey2024llama3',
      authors: [
        {
          firstName: 'Abhimanyu',
          lastName: 'Dubey',
          fullName: 'Abhimanyu Dubey',
        },
        {
          firstName: 'Abhinav',
          lastName: 'Jauhri',
          fullName: 'Abhinav Jauhri',
        },
      ],
      projectScoped: false,
      collections: [], // Intentionally empty to test Unfiled Items!
      tags: ['Transformers', 'Must-Read'],
      state: {
        readStatus: 'unread',
        isStarred: true,
      },
      pdfFilename: 'dubey2024llama3.pdf',
      pageCount: 92,
    },
    {
      title: 'Deep Learning',
      itemType: 'journalArticle',
      year: 2015,
      doi: '10.1038/nature14539',
      publicationTitle: 'Nature',
      abstract:
        'Deep learning allows computational models that are composed of multiple processing layers to learn representations of data with multiple levels of abstraction. These methods have dramatically improved the state-of-the-art in visual object recognition, object detection and many other domains.',
      url: 'https://doi.org/10.1038/nature14539',
      citationKey: 'lecun2015deep',
      authors: [
        { firstName: 'Yann', lastName: 'LeCun', fullName: 'Yann LeCun' },
        { firstName: 'Yoshua', lastName: 'Bengio', fullName: 'Yoshua Bengio' },
        {
          firstName: 'Geoffrey',
          lastName: 'Hinton',
          fullName: 'Geoffrey Hinton',
        },
      ],
      projectScoped: false,
      collections: [], // Unfiled
      tags: ['Deep Learning', 'Nature', 'Must-Read'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 9,
      },
      pdfFilename: 'lecun2015deep.pdf',
      pageCount: 9,
    },
    {
      title:
        'Mastering the Game of Go with Deep Neural Networks and Tree Search',
      itemType: 'journalArticle',
      year: 2016,
      doi: '10.1038/nature16961',
      publicationTitle: 'Nature',
      abstract:
        'The game of Go has long been viewed as the most challenging of classic games for artificial intelligence owing to its enormous search space and the difficulty of evaluating board positions and moves. We introduce AlphaGo, which combines Monte-Carlo tree search with deep neural networks.',
      url: 'https://doi.org/10.1038/nature16961',
      citationKey: 'silver2016alphago',
      authors: [
        { firstName: 'David', lastName: 'Silver', fullName: 'David Silver' },
        { firstName: 'Aja', lastName: 'Huang', fullName: 'Aja Huang' },
        {
          firstName: 'Demis',
          lastName: 'Hassabis',
          fullName: 'Demis Hassabis',
        },
      ],
      projectScoped: false,
      collections: [], // Unfiled
      tags: ['Deep Learning', 'Nature'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
        currentPage: 11,
      },
      pdfFilename: 'silver2016alphago.pdf',
      pageCount: 11,
    },

    // ── Project Library (Flux Collaborative Scope) ─────────────────────────────
    {
      title:
        'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness (Project Reference)',
      itemType: 'conferencePaper',
      year: 2022,
      doi: '10.48550/arXiv.2205.14135',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2022)',
      abstract:
        'Project reference copy of FlashAttention for long-context memory caching and token throughput benchmarks.',
      url: 'https://arxiv.org/abs/2205.14135',
      citationKey: 'proj_dao2022flashattention',
      authors: [
        { firstName: 'Tri', lastName: 'Dao', fullName: 'Tri Dao' },
        {
          firstName: 'Christopher',
          lastName: 'Ré',
          fullName: 'Christopher Ré',
        },
      ],
      projectScoped: true,
      collections: [colProjFoundation.id],
      tags: ['Attention', 'GPU-Efficient'],
      state: {
        readStatus: 'reading',
        isStarred: true,
        rating: 5,
      },
      pdfFilename: 'dao2022flashattention.pdf',
      pageCount: 14,
    },
    {
      title:
        'Symbolic Discovery of Optimization Algorithms (Lion Optimizer) (Project Reference)',
      itemType: 'conferencePaper',
      year: 2023,
      doi: '10.48550/arXiv.2302.06675',
      publicationTitle:
        'Advances in Neural Information Processing Systems (NeurIPS 2023)',
      abstract:
        'Project reference copy of Lion optimizer for training stability experiments in collaborative pipeline.',
      url: 'https://arxiv.org/abs/2302.06675',
      citationKey: 'proj_chen2023symbolic',
      authors: [
        {
          firstName: 'Xiangning',
          lastName: 'Chen',
          fullName: 'Xiangning Chen',
        },
        { firstName: 'Quoc V.', lastName: 'Le', fullName: 'Quoc V. Le' },
      ],
      projectScoped: true,
      collections: [colProjOptimization.id],
      tags: ['Optimization', 'NeurIPS'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
      },
      pdfFilename: 'chen2023symbolic.pdf',
      pageCount: 18,
    },
    {
      title:
        'Adaptive Learning Rates via Spectral Hessian Decomposition (Project Copy)',
      itemType: 'journalArticle',
      year: 2025,
      doi: '10.1109/TPAMI.2025.1049281',
      publicationTitle:
        'IEEE Transactions on Pattern Analysis and Machine Intelligence (TPAMI)',
      abstract: 'Team master copy for experimental verification.',
      url: 'https://doi.org/10.1109/TPAMI.2025.1049281',
      citationKey: 'proj_ngo2025adaptive',
      authors: [
        { firstName: 'Tan-Thanh', lastName: 'Ngo', fullName: 'Tan-Thanh Ngo' },
      ],
      projectScoped: true,
      collections: [colProjOptimization.id],
      tags: ['Optimization', 'Neural Operators'],
      state: {
        readStatus: 'completed',
        isStarred: true,
        rating: 5,
      },
      isMyPublication: true,
      pdfFilename: 'ngo2025adaptive_tpami.pdf',
      pageCount: 16,
    },
  ];

  const createdItemMap = new Map<string, string>(); // citationKey -> itemId

  for (const p of papers) {
    const firstAuthor = p.authors[0]?.fullName || '';
    const targetProjectId = p.projectScoped ? project.id : null;

    const item = await prisma.item.create({
      data: {
        title: p.title,
        itemType: p.itemType,
        year: p.year,
        doi: p.doi,
        publicationTitle: p.publicationTitle,
        abstract: p.abstract,
        url: p.url,
        citationKey: p.citationKey,
        firstAuthor,
        hasFile: Boolean(p.pdfFilename),
        attachmentCount: p.pdfFilename ? 1 : 0,
        noteCount: p.notes?.length || 0,
        userId: user.id,
        projectId: targetProjectId,
        metadata: {
          doi: p.doi,
          url: p.url,
          year: p.year,
          publisher: p.publicationTitle,
          pages: p.pageCount ? `1-${p.pageCount}` : undefined,
          bibtexKey: p.citationKey,
          isMyPublication: Boolean(p.isMyPublication),
          isRetracted: Boolean(p.isRetracted),
        },
      },
    });

    createdItemMap.set(p.citationKey, item.id);

    // Create Contributors
    for (let i = 0; i < p.authors.length; i++) {
      const a = p.authors[i];
      await prisma.contributor.create({
        data: {
          itemId: item.id,
          creatorType: 'author',
          firstName: a.firstName,
          lastName: a.lastName,
          fullName: a.fullName,
          orderIndex: i,
        },
      });
    }

    // Link to Collections
    for (const colId of p.collections) {
      await prisma.collectionItem.create({
        data: {
          collectionId: colId,
          itemId: item.id,
          sortOrder: 0,
        },
      });
    }

    // Link to Tags
    for (const tagName of p.tags) {
      const tagId = tagMap.get(tagName);
      if (tagId) {
        await prisma.itemTag.create({
          data: {
            tagId,
            itemId: item.id,
            type: 'manual',
          },
        });
      }
    }

    // Create UserItemState (Starred, Reading, Completed, LastOpened)
    if (p.state) {
      const lastOpenedAt = p.state.lastOpenedHoursAgo
        ? new Date(Date.now() - p.state.lastOpenedHoursAgo * 3600 * 1000)
        : null;
      const lastReadAt =
        p.state.readStatus === 'completed'
          ? new Date(
              Date.now() - (p.state.lastOpenedHoursAgo || 24) * 3600 * 1000,
            )
          : lastOpenedAt;

      await prisma.state.create({
        data: {
          userId: user.id,
          itemId: item.id,
          readStatus: p.state.readStatus,
          isStarred: p.state.isStarred,
          rating: p.state.rating || null,
          currentPage:
            p.state.currentPage ||
            (p.state.readStatus === 'completed' ? p.pageCount : 1),
          lastOpenedAt,
          lastReadAt,
        },
      });
    }

    // Create Primary PDF Attachment
    if (p.pdfFilename) {
      const attachment = await prisma.attachment.create({
        data: {
          itemId: item.id,
          filename: p.pdfFilename,
          mimeType: 'application/pdf',
          size: BigInt((p.pageCount || 10) * 128 * 1024),
          pageCount: p.pageCount || 12,
          linkMode: 'imported_file',
          attachmentType: 'primary_pdf',
          extractionStatus: 'READY',
          url: p.url,
          metadata: {
            title: p.title,
            pageCount: p.pageCount || 12,
            hasTextLayer: true,
            hasOutline: true,
          },
        },
      });

      // For FlashAttention, create rich PDF highlights & annotations
      if (p.citationKey === 'dao2022flashattention') {
        await prisma.annotation.create({
          data: {
            attachmentId: attachment.id,
            type: 'highlight',
            pageIndex: 1,
            color: '#FEF08A', // Yellow highlight
            quoteText:
              'FlashAttention is an IO-aware exact attention algorithm that uses tiling to reduce memory reads/writes',
            comment: 'FlashAttention compute-to-read ratio optimization',
            rectCoords: [{ x: 72, y: 150, width: 450, height: 18 }],
            authorId: user.id,
          },
        });
        await prisma.annotation.create({
          data: {
            attachmentId: attachment.id,
            type: 'note',
            pageIndex: 3,
            color: '#BBF7D0', // Green note
            comment:
              'Áp dụng kỹ thuật này vào việc tăng context window của mô hình Flux',
            rectCoords: [{ x: 100, y: 300, width: 24, height: 24 }],
            authorId: user.id,
          },
        });
      }
    }

    // Create Notes
    if (p.notes) {
      for (const n of p.notes) {
        await prisma.note.create({
          data: {
            itemId: item.id,
            title: n.title,
            contentMd: n.contentMd,
            userId: user.id,
            createdById: user.id,
            projectId: targetProjectId,
            tags: p.tags,
          },
        });
      }
    }

    // Link to UserPublications (My Publications)
    if (p.isMyPublication) {
      await prisma.userPublication.create({
        data: {
          userId: user.id,
          itemId: item.id,
          isPublic: true,
          openAccessLicense: 'CC-BY-4.0',
        },
      });
    }

    // Add to Retraction table if retracted
    if (p.isRetracted) {
      await prisma.retraction.create({
        data: {
          doi: p.doi,
          title: p.title,
          isRetracted: true,
          nature: 'retraction',
          journal: p.publicationTitle,
          reason: p.retractionReason || 'Data integrity failure',
          source: 'The Lancet',
          noticeUrl: 'https://doi.org/10.1016/S0140-6736(20)31324-6',
        },
      });
    }
  }

  // 7. Seed Item Relations (Citation Network & Lineage)
  console.log('🔗 Creating scholarly citation links & item relations...');
  const relations: Array<{
    sourceKey: string;
    targetKey: string;
    relationType: RelationType;
    description: string;
  }> = [
    {
      sourceKey: 'dao2023flashattention2',
      targetKey: 'dao2022flashattention',
      relationType: 'extends',
      description:
        'FlashAttention-2 builds directly upon the tiling scheme of FlashAttention-1 with better work partitioning.',
    },
    {
      sourceKey: 'dettmers2023qlora',
      targetKey: 'hu2021lora',
      relationType: 'extends',
      description:
        'QLoRA extends LoRA by injecting low-rank adapters into 4-bit NormalFloat (NF4) quantized weights.',
    },
    {
      sourceKey: 'reddi2018convergence',
      targetKey: 'kingma2014adam',
      relationType: 'rebuts',
      description:
        'AMSGrad proves a counterexample to Adam convergence and provides a non-increasing learning rate step.',
    },
    {
      sourceKey: 'loshchilov2019adamw',
      targetKey: 'kingma2014adam',
      relationType: 'extends',
      description:
        'AdamW decouples weight decay from gradient updates to restore true L2 regularization behavior.',
    },
    {
      sourceKey: 'chen2023symbolic',
      targetKey: 'kingma2014adam',
      relationType: 'related',
      description:
        'Lion discovered via program synthesis matches or outperforms AdamW with 50% lower optimizer state memory.',
    },
    {
      sourceKey: 'deepseek2025r1',
      targetKey: 'deepseek2024v2',
      relationType: 'extends',
      description:
        'DeepSeek-R1 leverages DeepSeek-V2 MoE architecture as foundation for reinforcement learning reasoning.',
    },
    {
      sourceKey: 'dosovitskiy2020vit',
      targetKey: 'vaswani2017attention',
      relationType: 'extends',
      description:
        'ViT adopts the pure Transformer encoder architecture for direct patch-based image recognition.',
    },
    {
      sourceKey: 'ngo2025adaptive',
      targetKey: 'li2021fourier',
      relationType: 'uses_dataset',
      description:
        'Uses Kolmogorov turbulent flow benchmark from Li et al. (2021) for spectral Hessian convergence testing.',
    },
    {
      sourceKey: 'ngo2024physics',
      targetKey: 'raissi2019physics',
      relationType: 'extends',
      description:
        'Extends PINN formulation to operator learning in infinite-dimensional function spaces.',
    },
  ];

  for (const rel of relations) {
    const sourceId = createdItemMap.get(rel.sourceKey);
    const targetId = createdItemMap.get(rel.targetKey);
    if (sourceId && targetId) {
      await prisma.itemRelation.create({
        data: {
          sourceItemId: sourceId,
          targetItemId: targetId,
          relationType: rel.relationType,
          description: rel.description,
        },
      });
    }
  }

  // 8. Saved Searches: Purposely OMITTED per user instruction (can skip saved search cleanup)
  console.log('🔍 Saved searches skipped (cleaned per user request).');

  // 9. Invalidate Redis Caches
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const keys = await redis.keys('*library*');
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`🧹 Flushed ${keys.length} library cache keys in Redis.`);
    }
    await redis.quit();
  } catch {
    // Redis optional
  }

  console.log('🎉 Academic Library Seeding Completed Successfully!');
  console.log(`📊 Summary of Seeded Data for ${user.email}:`);
  console.log(
    `   - Total Real Papers: ${papers.length} peer-reviewed & preprint papers`,
  );
  console.log(
    `   - My Library Papers: ${papers.filter((p) => !p.projectScoped).length} papers in Personal Library`,
  );
  console.log(
    `   - Project Library Papers: ${papers.filter((p) => p.projectScoped).length} papers in Flux Project`,
  );
  console.log(
    `   - Personal Collections: 8 structured categories (with sub-collections)`,
  );
  console.log(`   - Research Tags: ${tagsData.length} technical tags`);
  console.log(`   - Starred Papers: 18 key papers`);
  console.log(
    `   - Reading Notes: Detailed mathematical & implementation Markdown notes`,
  );
  console.log(
    `   - PDF Attachments & Annotations: Real highlights and sticky notes`,
  );
  console.log(`   - Scholarly Relations: Citation & extension graph links`);
  console.log(
    `   - Duplicate Cluster: 1 duplicate pair for Curation/Merge testing`,
  );
  console.log(`   - Retraction Watch: 1 retracted paper with warning notice`);
  console.log(`   - My Publications: 2 peer-reviewed articles by Tấn Thành`);
}

export { seedLibrary };

seedLibrary()
  .catch((e) => {
    console.error('❌ Error during library seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
