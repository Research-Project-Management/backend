/**
 * 100-Dataset Gold Benchmark Corpus Fixture
 *
 * Spans 10 distinct groups (10 datasets each = 100 records) to evaluate:
 *   G1 (01-10): Standard Academic PDFs (AI/ML, NeurIPS, ICLR, CVPR)
 *   G2 (11-20): Working Papers, Theses & Scanned PDFs (Citation Trap, scan title fallback)
 *   G3 (21-30): Multi-Identifier Real Papers (DOI, arXiv, PMID, PMCID, ISBN, ISSN)
 *   G4 (31-40): URL Ingestion & Web Captures (Publisher DOM, Open Access PDF, WAF Turnstile)
 *   G5 (41-50): Multi-Format Bibliographic Imports (BibTeX, RIS, CSL-JSON, XML)
 *   G6 (51-60): Concurrency, Exact Merge & P2002 Race Scenarios
 *   G7 (61-70): Background PDF Extraction, Provenance & User Lock Enforcement
 *   G8 (71-80): Data Modeling, Smart Collections & Keyset Index Queries
 *   G9 (81-90): Reader Annotations, Notes, Denormalized Counters & Delta Sync
 *   G10 (91-100): Cross-Stack Frontend/Backend Parity & Lossless Export Round-Trip
 */

export interface BenchmarkRecord {
  id: string;
  group: number;
  groupName: string;
  itemType:
    | 'journalArticle'
    | 'conferencePaper'
    | 'preprint'
    | 'book'
    | 'thesis'
    | 'report'
    | 'webpage'
    | 'dataset';
  title: string;
  authors: string[];
  year: number;
  venue: string;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  rawInputTags: string[];
  expectedCleanTags: string[];
  rawNote: string;
  expectedNoteSnippet: string;
  isScanned?: boolean;
  citationTrapDoi?: string;
  wafKind?: string;
  lockedFields?: string[];
  collectionId?: string;
}

export function generate100BenchmarkDatasets(): BenchmarkRecord[] {
  const records: BenchmarkRecord[] = [];

  // ───────────────────────────────────────────────────────────────────────────
  // G1 (DS-001 .. DS-010): AI/ML & Computer Science PDFs
  // ───────────────────────────────────────────────────────────────────────────
  const g1Defs = [
    { title: 'Attention Is All You Need', authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'], year: 2017, venue: 'NeurIPS', doi: '10.5555/3295222.3295349', arxivId: '1706.03762', itemType: 'conferencePaper' as const },
    { title: 'Deep Residual Learning for Image Recognition', authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren'], year: 2016, venue: 'CVPR', doi: '10.1109/CVPR.2016.90', arxivId: '1512.03385', itemType: 'conferencePaper' as const },
    { title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: ['Jacob Devlin', 'Ming-Wei Chang', 'Kenton Lee'], year: 2019, venue: 'NAACL', doi: '10.18653/v1/N19-1423', arxivId: '1810.04805', itemType: 'conferencePaper' as const },
    { title: 'GPT-4 Technical Report', authors: ['OpenAI', 'Josh Achiam', 'Steven Adler'], year: 2023, venue: 'arXiv', arxivId: '2303.08774', doi: '10.48550/arXiv.2303.08774', itemType: 'preprint' as const },
    { title: 'FlashAttention: Fast and Memory-Efficient Exact Attention', authors: ['Tri Dao', 'Daniel Y. Fu', 'Christopher Ré'], year: 2022, venue: 'NeurIPS', doi: '10.48550/arXiv.2205.14135', arxivId: '2205.14135', itemType: 'conferencePaper' as const },
    { title: 'Adam: A Method for Stochastic Optimization', authors: ['Diederik P. Kingma', 'Jimmy Ba'], year: 2014, venue: 'ICLR', arxivId: '1412.6980', doi: '10.48550/arXiv.1412.6980', itemType: 'conferencePaper' as const },
    { title: 'Generative Adversarial Nets', authors: ['Ian J. Goodfellow', 'Jean Pouget-Abadie', 'Mehdi Mirza'], year: 2014, venue: 'NeurIPS', doi: '10.5555/2969033.2969166', arxivId: '1406.2661', itemType: 'conferencePaper' as const },
    { title: 'Mastering the Game of Go with Deep Neural Networks', authors: ['David Silver', 'Aja Huang', 'Demis Hassabis'], year: 2016, venue: 'Nature', doi: '10.1038/nature16961', itemType: 'journalArticle' as const },
    { title: 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale', authors: ['Alexey Dosovitskiy', 'Lucas Beyer', 'Alexander Kolesnikov'], year: 2021, venue: 'ICLR', doi: '10.48550/arXiv.2010.11929', arxivId: '2010.11929', itemType: 'conferencePaper' as const },
    { title: 'LoRA: Low-Rank Adaptation of Large Language Models', authors: ['Edward J. Hu', 'Yelong Shen', 'Phillip Wallis'], year: 2021, venue: 'ICLR', arxivId: '2106.09685', doi: '10.48550/arXiv.2106.09685', itemType: 'conferencePaper' as const },
  ];
  g1Defs.forEach((d, i) => {
    const num = i + 1;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 1,
      groupName: 'AI/ML & Computer Science PDFs',
      ...d,
      rawInputTags: [`AI; ${d.venue}; Machine Learning`, 'cs.LG', 'Must-Read', 'n/a', '2023'],
      expectedCleanTags: ['AI', d.venue, 'Machine Learning', 'Computer Science - Machine Learning', 'Must-Read'],
      rawNote: `<h2>Summary for ${d.title}</h2><p>Pioneering contribution in <strong>${d.venue}</strong>.</p>`,
      expectedNoteSnippet: `## Summary for ${d.title}`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G2 (DS-011 .. DS-020): Working Papers, Theses & Scanned PDFs (Citation Trap)
  // ───────────────────────────────────────────────────────────────────────────
  const g2Defs = [
    { title: 'Empirical Study on Macroeconomic Shocks in Southeast Asia', authors: ['Minh T. Nguyen', 'Duc H. Tran'], year: 2024, venue: 'Economics Working Papers', itemType: 'report' as const, citationTrapDoi: '10.5555/3295222.3295349' },
    { title: 'Scalable Byzantine Fault Tolerant State Machine Replication', authors: ['Arthur Pendelton'], year: 2023, venue: 'University of Cambridge Ph.D. Thesis', itemType: 'thesis' as const },
    { title: 'NIST Guidelines on Post-Quantum Cryptographic Standards', authors: ['Dustin Moody', 'Ray Perlner'], year: 2022, venue: 'NIST Special Publication', itemType: 'report' as const, isScanned: true },
    { title: 'Microstructure of Emerging Bond Markets', authors: ['Elena Rostova', 'Klaus Weber'], year: 2024, venue: 'Finance Working Paper Series', itemType: 'report' as const, citationTrapDoi: '10.1109/CVPR.2016.90' },
    { title: 'Topological Quantum Error Correction in Surface Codes', authors: ['Liam O’Connor'], year: 2023, venue: 'MIT Doctoral Dissertation', itemType: 'thesis' as const },
    { title: 'Can Quantum-Mechanical Description of Physical Reality be Considered Complete?', authors: ['Albert Einstein', 'Boris Podolsky', 'Nathan Rosen'], year: 1935, venue: 'Physical Review', doi: '10.1103/PhysRev.47.777', itemType: 'journalArticle' as const, isScanned: true },
    { title: 'Epoch-Based Garbage Collection for High-Throughput In-Memory Stores', authors: ['Tanya Vance', 'Vikram Patel'], year: 2024, venue: 'Technical Whitepaper', itemType: 'report' as const },
    { title: 'Comparative Analysis of CRISPR-Cas9 Target Cleavage Kinetics', authors: ['Hannah Abbott', 'Claire Vance'], year: 2024, venue: 'Biology Pre-Print Archive', itemType: 'preprint' as const, citationTrapDoi: '10.1038/s41586-021-03819-2' },
    { title: 'Epistemic Logic and Distributed Knowledge in Rational Agents', authors: ['Sarah Jenkins'], year: 2022, venue: 'Oxford University Thesis', itemType: 'thesis' as const },
    { title: 'OECD Principles for Trustworthy Governance of Artificial Intelligence', authors: ['OECD Secretariat'], year: 2023, venue: 'OECD Policy Report', itemType: 'report' as const },
  ];
  g2Defs.forEach((d, i) => {
    const num = i + 11;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 2,
      groupName: 'Working Papers, Theses & Scanned PDFs',
      ...d,
      rawInputTags: ['Working Paper, Research Draft', 'Thesis', 'downloaded from web', '2024'],
      expectedCleanTags: ['Working Paper', 'Research Draft', 'Thesis'],
      rawNote: `<p>Detailed reading notes for <em>${d.title}</em>.</p>`,
      expectedNoteSnippet: `*${d.title}*`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G3 (DS-021 .. DS-030): Multi-Identifier Real Papers (DOI, PMID, ISBN, ISSN)
  // ───────────────────────────────────────────────────────────────────────────
  const g3Defs = [
    { title: 'Highly accurate protein structure prediction with AlphaFold', authors: ['John Jumper', 'Richard Evans', 'Demis Hassabis'], year: 2021, venue: 'Nature', doi: '10.1038/s41586-021-03819-2', pmid: '34265844', pmcid: 'PMC8594248', issn: '0028-0836', itemType: 'journalArticle' as const },
    { title: 'Safety and Efficacy of the BNT162b2 mRNA Covid-19 Vaccine', authors: ['Fernando P. Polack', 'Stephen J. Thomas', 'Kathrin U. Jansen'], year: 2020, venue: 'NEJM', doi: '10.1056/NEJMoa2034577', pmid: '33301246', pmcid: 'PMC7745181', issn: '0028-4793', itemType: 'journalArticle' as const },
    { title: 'A Programmable Dual-RNA-Guided DNA Endonuclease in Adaptive Bacterial Immunity', authors: ['Martin Jinek', 'Krzysztof Chylinski', 'Jennifer A. Doudna', 'Emmanuelle Charpentier'], year: 2012, venue: 'Science', doi: '10.1126/science.1225829', pmid: '22745249', pmcid: 'PMC6286148', issn: '0036-8075', itemType: 'journalArticle' as const },
    { title: 'Initial sequencing and analysis of the human genome', authors: ['Eric S. Lander', 'Lauren M. Linton', 'Bruce W. Birren'], year: 2001, venue: 'Nature', doi: '10.1038/35057062', pmid: '11237011', issn: '0028-0836', itemType: 'journalArticle' as const },
    { title: 'Deep Learning', authors: ['Ian Goodfellow', 'Yoshua Bengio', 'Aaron Courville'], year: 2016, venue: 'MIT Press', isbn: '9780262035613', itemType: 'book' as const },
    { title: 'Designing Data-Intensive Applications', authors: ['Martin Kleppmann'], year: 2017, venue: "O'Reilly Media", isbn: '9781449373320', itemType: 'book' as const },
    { title: 'Introduction to Algorithms (Third Edition)', authors: ['Thomas H. Cormen', 'Charles E. Leiserson', 'Ronald L. Rivest', 'Clifford Stein'], year: 2009, venue: 'MIT Press', isbn: '9780262033848', itemType: 'book' as const },
    { title: 'Observation of Gravitational Waves from a Binary Black Hole Merger', authors: ['B. P. Abbott', 'R. Abbott', 'LIGO Scientific Collaboration'], year: 2016, venue: 'Physical Review Letters', doi: '10.1103/PhysRevLett.116.061102', pmid: '26918975', issn: '0031-9007', itemType: 'journalArticle' as const },
    { title: 'Observation of a new boson at a mass of 125 GeV with the CMS experiment at the LHC', authors: ['CMS Collaboration', 'Serguei Chatrchyan'], year: 2012, venue: 'Physics Letters B', doi: '10.1016/j.physletb.2012.08.021', arxivId: '1207.7235', issn: '0370-2693', itemType: 'journalArticle' as const },
    { title: 'Cancer Genome Landscapes', authors: ['Bert Vogelstein', 'Nickolas Papadopoulos', 'Kenneth W. Kinzler'], year: 2013, venue: 'Science', doi: '10.1126/science.1235122', pmid: '23539594', pmcid: 'PMC3749880', issn: '0036-8075', itemType: 'journalArticle' as const },
  ];
  g3Defs.forEach((d, i) => {
    const num = i + 21;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 3,
      groupName: 'Multi-Identifier Real Papers',
      ...d,
      rawInputTags: ['Biomedical; Genetics; Landmark', 'Reference Text', 'pp. 100-110'],
      expectedCleanTags: ['Biomedical', 'Genetics', 'Landmark', 'Reference Text'],
      rawNote: `<p>Key biological and physical takeaways from <strong>${d.title}</strong>.</p>`,
      expectedNoteSnippet: `Key biological and physical takeaways`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G4 (DS-031 .. DS-040): URL Ingestion & Web Captures
  // ───────────────────────────────────────────────────────────────────────────
  const g4Defs = [
    { title: 'Room-Temperature Superconductivity: Claim Retracted by Journal', authors: ['Quirin Schiermeier'], year: 2023, venue: 'Nature News', url: 'https://www.nature.com/articles/d41586-023-03398-4', itemType: 'webpage' as const },
    { title: 'Neuromorphic Computing Moves from Lab to Edge Silicon', authors: ['Sally Ward-Foxton'], year: 2024, venue: 'IEEE Spectrum', url: 'https://spectrum.ieee.org/neuromorphic-computing-edge', itemType: 'webpage' as const },
    { title: 'The Limits of Quantum Superiority in Optimization Problems', authors: ['Scott Aaronson'], year: 2023, venue: 'Communications of the ACM Blog', url: 'https://cacm.acm.org/blogs/blog-cacm/quantum-limits', itemType: 'webpage' as const },
    { title: 'Protected Publisher Article: Quantum Annealing Frontiers', authors: ['Anonymous'], year: 2024, venue: 'Protected Research Journal', url: 'https://protected-journal.example.com/quantum-annealing', wafKind: 'WAF_CLOUDFLARE_TURNSTILE', itemType: 'journalArticle' as const },
    { title: 'Protected Publisher Article: High-Entropy Alloys', authors: ['Anonymous'], year: 2024, venue: 'Materials Science Paywall', url: 'https://paywall.materials-today.example.com/hea-review', wafKind: 'WAF_CLOUDFLARE_TURNSTILE', itemType: 'journalArticle' as const },
    { title: 'Direct Observation of Single-Molecule Enzymatic Dynamics', authors: ['Laura Palmer', 'Dale Cooper'], year: 2024, venue: 'bioRxiv', url: 'https://www.biorxiv.org/content/10.1101/2024.01.15.575678v1', doi: '10.1101/2024.01.15.575678', itemType: 'preprint' as const },
    { title: 'Phase III Randomized Trial of Inhaled Nanobodies for Influenza', authors: ['Audrey Horne', 'Gordon Cole'], year: 2024, venue: 'medRxiv', url: 'https://www.medrxiv.org/content/10.1101/2024.02.01.24302100v1', doi: '10.1101/2024.02.01.24302100', itemType: 'preprint' as const },
    { title: 'Dissecting Modern LLM Serving Architecture: vLLM and PagedAttention', authors: ['Chip Huyen'], year: 2023, venue: 'Technical Engineering Blog', url: 'https://huyenchip.com/2023/llm-serving', itemType: 'webpage' as const },
    { title: 'Transformer (Deep Learning Architecture)', authors: ['Wikipedia Contributors'], year: 2024, venue: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)', itemType: 'webpage' as const },
    { title: 'Nuclear Fusion Milestone: Net Energy Gain Reconfirmed at NIF', authors: ['Kenneth Chang'], year: 2023, venue: 'The New York Times', url: 'https://www.nytimes.com/2023/12/20/science/fusion-ignition-nif.html', itemType: 'webpage' as const },
  ];
  g4Defs.forEach((d, i) => {
    const num = i + 31;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 4,
      groupName: 'URL Ingestion & Web Captures',
      ...d,
      rawInputTags: ['Web Article; Technology; Tech News', 'Open-Access', 'url: ' + d.url],
      expectedCleanTags: ['Web Article', 'Technology', 'Tech News', 'Open-Access'],
      rawNote: `<p>Web capture snapshot note for <a href="${d.url}">${d.title}</a>.</p>`,
      expectedNoteSnippet: `Web capture snapshot note`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G5 (DS-041 .. DS-050): Multi-Format Bibliographic Imports
  // ───────────────────────────────────────────────────────────────────────────
  const g5Defs = [
    { title: 'Algorithmic Complexity in String Processing: O(n log n) Bounds', authors: ['Günter Müller', 'François Côté'], year: 2020, venue: 'Theoretical Computer Science', doi: '10.1016/j.tcs.2020.01.001', itemType: 'journalArticle' as const },
    { title: 'Comprehensive Evaluation of Graph Neural Networks for Molecule Generation', authors: ['Stefan Kramer', 'Luc De Raedt'], year: 2021, venue: 'Journal of Chemical Information and Modeling', doi: '10.1021/acs.jcim.1c00001', itemType: 'journalArticle' as const },
    { title: 'Federated Learning with Differential Privacy Guarantees', authors: ['Brendan McMahan', 'Ewan Moore', 'Daniel Ramage'], year: 2017, venue: 'AISTATS', doi: '10.5555/3122749.3122756', itemType: 'conferencePaper' as const },
    { title: 'Zero-Shot Learning with Semantic Embeddings and Cross-Modal Attention', authors: ['Yongqin Xian', 'Bernt Schiele', 'Zeynep Akata'], year: 2018, venue: 'CVPR', doi: '10.1109/CVPR.2018.00586', itemType: 'conferencePaper' as const },
    { title: 'The Algorithm Design Manual (Third Edition)', authors: ['Steven S. Skiena'], year: 2020, venue: 'Springer', isbn: '9783030542559', itemType: 'book' as const },
    { title: 'ImageNet Large Scale Visual Recognition Challenge Dataset Record', authors: ['Olga Russakovsky', 'Jia Deng', 'Hao Su'], year: 2015, venue: 'IJCV', doi: '10.1007/s11263-015-0816-y', itemType: 'dataset' as const },
    { title: 'Technical Specification for Distributed Hash Table Protocol', authors: ['Petar Maymounkov', 'David Mazières'], year: 2002, venue: 'NYU Technical Report', itemType: 'report' as const },
    { title: 'High-Dimensional Convex Optimization and Interior-Point Methods', authors: ['Yurii Nesterov'], year: 2004, venue: 'Kluwer Academic Publishers', isbn: '9781402075537', itemType: 'book' as const },
    { title: 'Attention Is Not All You Need: Pure Attention Degenerates Rank', authors: ['Yihe Dong', 'Jean-Baptiste Cordonnier', 'Andreas Loukas'], year: 2021, venue: 'ICML', arxivId: '2103.03404', doi: '10.48550/arXiv.2103.03404', itemType: 'conferencePaper' as const },
    { title: 'Phương Pháp Phân Tích Dữ Liệu Nghiên Cứu Y Học Theo Chuẩn TCVN', authors: ['Văn A Nguyễn', 'Thị B Trần', 'Quang C Lê'], year: 2022, venue: 'Tạp Chí Y Học Thực Hành', itemType: 'journalArticle' as const },
  ];
  g5Defs.forEach((d, i) => {
    const num = i + 41;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 5,
      groupName: 'Multi-Format Bibliographic Imports',
      ...d,
      rawInputTags: ['Algorithms; Theory; Data Structures', 'TCVN', 'n/a', 'http://example.com'],
      expectedCleanTags: ['Algorithms', 'Theory', 'Data Structures', 'TCVN'],
      rawNote: `<p>Bibliographic import note: <strong>${d.title}</strong>.</p>`,
      expectedNoteSnippet: `Bibliographic import note`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G6 (DS-051 .. DS-060): Concurrency, Exact Merge & P2002 Race Scenarios
  // ───────────────────────────────────────────────────────────────────────────
  const g6Defs = [
    { title: 'Attention Is All You Need (Re-Upload Duplicate)', authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017, venue: 'NeurIPS', doi: '10.5555/3295222.3295349', arxivId: '1706.03762', itemType: 'conferencePaper' as const },
    { title: 'GPT-4 Technical Report (Re-Upload Duplicate)', authors: ['OpenAI', 'Josh Achiam'], year: 2023, venue: 'arXiv', arxivId: '2303.08774', doi: '10.48550/arXiv.2303.08774', itemType: 'preprint' as const },
    { title: 'Highly accurate protein structure prediction with AlphaFold (PMID Match)', authors: ['John Jumper', 'Richard Evans'], year: 2021, venue: 'Nature', pmid: '34265844', doi: '10.1038/s41586-021-03819-2', itemType: 'journalArticle' as const },
    { title: 'Deep Learning (ISBN Re-Import Match)', authors: ['Ian Goodfellow', 'Yoshua Bengio'], year: 2016, venue: 'MIT Press', isbn: '9780262035613', itemType: 'book' as const },
    { title: 'P2002 Race Simulation: Concurrent Commit Collision on DOI', authors: ['Alice Walker', 'Bob Vance'], year: 2024, venue: 'Journal of Concurrency', doi: '10.1000/p2002-collision-doi', itemType: 'journalArticle' as const },
    { title: 'P2002 Race Simulation: Concurrent Commit Collision on arXiv', authors: ['Charlie Day', 'Frank Reynolds'], year: 2024, venue: 'arXiv', arxivId: '2401.99999', itemType: 'preprint' as const },
    { title: 'Deep Residual Learning for Vision (Probable Match 88% Title Similarity)', authors: ['Kaiming He', 'Xiangyu Zhang'], year: 2017, venue: 'CVPR Workshop', itemType: 'conferencePaper' as const },
    { title: 'BERT: Bidirectional Encoder Representations (Probable Match Alternative Venue)', authors: ['Jacob Devlin', 'Kenton Lee'], year: 2019, venue: 'ACL Anthology', itemType: 'conferencePaper' as const },
    { title: 'Multi-Collection Ingestion Test Record with Redundant Collection IDs', authors: ['Grace Hopper'], year: 2024, venue: 'Systems Review', doi: '10.1000/multi-col-test', itemType: 'journalArticle' as const },
    { title: 'Existing Item with Pre-Existing Notes (Double Materialize Protection)', authors: ['Alan Turing'], year: 2024, venue: 'Computing Journal', doi: '10.1000/note-dedup-test', itemType: 'journalArticle' as const },
  ];
  g6Defs.forEach((d, i) => {
    const num = i + 51;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 6,
      groupName: 'Concurrency, Exact Merge & P2002 Race Scenarios',
      ...d,
      rawInputTags: ['Deduplication; Concurrency; Race Test', 'Collection-A', 'Collection-A', ''],
      expectedCleanTags: ['Deduplication', 'Concurrency', 'Race Test', 'Collection-A'],
      rawNote: `<p>Concurrency note: <em>${d.title}</em>.</p>`,
      expectedNoteSnippet: `Concurrency note:`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G7 (DS-061 .. DS-070): Background PDF Extraction & User Lock Enforcement
  // ───────────────────────────────────────────────────────────────────────────
  const g7Defs = [
    { title: 'User Hand-Crafted Title: Do Not Overwrite Me', authors: ['Hand Editor'], year: 2022, venue: 'Manual Entry', lockedFields: ['title'], itemType: 'journalArticle' as const },
    { title: 'Canonical DOI Verified Entry', authors: ['Author One'], year: 2023, venue: 'DOI Registry', doi: '10.1000/locked-doi-target', lockedFields: ['doi'], itemType: 'journalArticle' as const },
    { title: 'Curated Contributors Record', authors: ['Primary Author', 'Key Contributor'], year: 2021, venue: 'Peer Review', lockedFields: ['creators', 'authors'], itemType: 'journalArticle' as const },
    { title: 'Custom Citation Key Record', authors: ['Custom CitKey Specialist'], year: 2024, venue: 'BibTeX Archive', lockedFields: ['citationKey'], itemType: 'conferencePaper' as const },
    { title: 'PDF Extraction Discovering Missing ArXiv ID', authors: ['ArXiv Seeker'], year: 2023, venue: 'arXiv Physics', arxivId: '2305.12345', itemType: 'preprint' as const },
    { title: 'PDF Extraction Discovering Missing PMID', authors: ['Medical Researcher'], year: 2023, venue: 'PubMed Central', pmid: '38123456', itemType: 'journalArticle' as const },
    { title: 'PDF Extraction Discovering Missing ISBN', authors: ['Monograph Publisher'], year: 2020, venue: 'Academic Press', isbn: '9781234567897', itemType: 'book' as const },
    { title: 'PDF Extraction Discovering Missing ISSN', authors: ['Periodical Specialist'], year: 2021, venue: 'Quarterly Review', issn: '1234-5679', itemType: 'journalArticle' as const },
    { title: 'Fully Verified Item with Authoritative Provenance', authors: ['Verified Scientist'], year: 2024, venue: 'High-Impact Journal', doi: '10.1038/verified-paper', itemType: 'journalArticle' as const },
    { title: 'Draft Paper with Placeholder Title scan_002.pdf', authors: ['Lab Technician'], year: 2024, venue: 'Internal Report', isScanned: true, itemType: 'report' as const },
  ];
  g7Defs.forEach((d, i) => {
    const num = i + 61;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 7,
      groupName: 'Background PDF Extraction & User Lock Enforcement',
      ...d,
      rawInputTags: ['Extraction Sync; Data Provenance; Lock Test', 'PDF-Parser'],
      expectedCleanTags: ['Extraction Sync', 'Data Provenance', 'Lock Test', 'PDF-Parser'],
      rawNote: `<p>Provenance audit note for <strong>${d.title}</strong>.</p>`,
      expectedNoteSnippet: `Provenance audit note`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G8 (DS-071 .. DS-080): Data Modeling, Smart Collections & Keyset Queries
  // ───────────────────────────────────────────────────────────────────────────
  const g8Defs = [
    { title: 'Nature Communications Paper with Top-Level DOI', authors: ['Sarah Connor'], year: 2022, venue: 'Nature Communications', doi: '10.1038/s41467-022-00001-x', itemType: 'journalArticle' as const },
    { title: 'High-Energy Physics Preprint with Top-Level arXiv', authors: ['John Connor'], year: 2023, venue: 'arXiv High Energy Physics', arxivId: '2308.01234', itemType: 'preprint' as const },
    { title: 'Clinical Trial Record with Top-Level PMID and PMCID', authors: ['Kyle Reese'], year: 2021, venue: 'Lancet', pmid: '35001122', pmcid: 'PMC9001122', itemType: 'journalArticle' as const },
    { title: 'Computer Architecture Monograph with Top-Level ISBN', authors: ['Miles Dyson'], year: 2020, venue: 'Morgan Kaufmann', isbn: '9780128119051', itemType: 'book' as const },
    { title: 'Hierarchical Collection Root Item', authors: ['Tree Root'], year: 2024, venue: 'Hierarchy Journal', collectionId: 'col-root-01', itemType: 'journalArticle' as const },
    { title: 'Hierarchical Collection Mid-Level Item', authors: ['Tree Node'], year: 2024, venue: 'Hierarchy Journal', collectionId: 'col-mid-02', itemType: 'journalArticle' as const },
    { title: 'Hierarchical Collection Leaf-Level Item', authors: ['Tree Leaf'], year: 2024, venue: 'Hierarchy Journal', collectionId: 'col-leaf-03', itemType: 'journalArticle' as const },
    { title: 'Soft-Deleted Collection Member Item', authors: ['Ghost Author'], year: 2023, venue: 'Deleted Venue', collectionId: 'col-deleted-99', itemType: 'journalArticle' as const },
    { title: 'Exact Title Keyset Filter Record A', authors: ['Search Specialist A'], year: 2024, venue: 'Search Conf', doi: '10.2000/search-a', itemType: 'conferencePaper' as const },
    { title: 'Exact Title Keyset Filter Record B', authors: ['Search Specialist B'], year: 2024, venue: 'Search Conf', doi: '10.2000/search-b', itemType: 'conferencePaper' as const },
  ];
  g8Defs.forEach((d, i) => {
    const num = i + 71;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 8,
      groupName: 'Data Modeling, Smart Collections & Keyset Queries',
      ...d,
      rawInputTags: ['Data Modeling; Schema Integrity; Smart Collections', 'SQL-Filter'],
      expectedCleanTags: ['Data Modeling', 'Schema Integrity', 'Smart Collections', 'SQL-Filter'],
      rawNote: `<p>Smart collection evaluation for <strong>${d.title}</strong>.</p>`,
      expectedNoteSnippet: `Smart collection evaluation`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G9 (DS-081 .. DS-090): Reader Annotations, Notes, Counters & Delta Sync
  // ───────────────────────────────────────────────────────────────────────────
  const g9Defs = [
    { title: 'Document with 3 PDF Attachments and 2 Notes', authors: ['Reader User 1'], year: 2024, venue: 'Reader Test Hub', itemType: 'journalArticle' as const },
    { title: 'Document with Zero Attachments and 5 Notes', authors: ['Reader User 2'], year: 2024, venue: 'Reader Test Hub', itemType: 'book' as const },
    { title: 'Document with 1 Stored Attachment and Counter Recount Trigger', authors: ['Reader User 3'], year: 2024, venue: 'Reader Test Hub', itemType: 'conferencePaper' as const },
    { title: 'Annotated Medical Paper with Yellow Highlight', authors: ['Medical Reader'], year: 2024, venue: 'Clinical Journal', pmid: '38900111', itemType: 'journalArticle' as const },
    { title: 'Annotated Computer Science Paper with Area Box Selection', authors: ['CS Reader'], year: 2024, venue: 'Vision Journal', arxivId: '2402.12345', itemType: 'conferencePaper' as const },
    { title: 'Paper with Free-Floating Reader Note and Anchored TipTap AST', authors: ['Note Taker'], year: 2024, venue: 'Note Review', itemType: 'report' as const },
    { title: 'Transaction Commit with Guaranteed Post-Commit Cache Eviction', authors: ['Cache Auditor'], year: 2024, venue: 'Database Transactions', itemType: 'journalArticle' as const },
    { title: 'Transaction Commit Fallback when onAfterCommit Hook is Absent', authors: ['Mock Tester'], year: 2024, venue: 'Testing Systems', itemType: 'journalArticle' as const },
    { title: 'Delta Sync Changelog Entry Emission with Entity Snapshot', authors: ['Sync Engineer'], year: 2024, venue: 'Distributed Sync', itemType: 'journalArticle' as const },
    { title: 'Transactional Outbox Publication with Canonical Event Types', authors: ['Outbox Specialist'], year: 2024, venue: 'Event-Driven Arch', itemType: 'journalArticle' as const },
  ];
  g9Defs.forEach((d, i) => {
    const num = i + 81;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 9,
      groupName: 'Reader Annotations, Notes, Counters & Delta Sync',
      ...d,
      rawInputTags: ['Reader; Annotations; Delta Sync; Counters', 'Highlight-Yellow'],
      expectedCleanTags: ['Reader', 'Annotations', 'Delta Sync', 'Counters', 'Highlight-Yellow'],
      rawNote: `<blockquote>Important highlighted quote from page 5</blockquote><p>User margin note.</p>`,
      expectedNoteSnippet: `Important highlighted quote from page 5`,
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // G10 (DS-091 .. DS-100): Cross-Stack Parity & Lossless Export Round-Trip
  // ───────────────────────────────────────────────────────────────────────────
  const g10Defs = [
    { title: 'Nghiên Cứu Ứng Dụng Học Máy Trong Chẩn Đoán Hình Ảnh Y Khoa', authors: ['Văn A Nguyễn', 'Thị B Trần'], year: 2023, venue: 'Tạp Chí Khoa Học & Công Nghệ', doi: '10.1000/tcvn-ai-vn', itemType: 'journalArticle' as const },
    { title: 'Syntactic Parsing with Short Korean and Mongolian Names', authors: ['Seung-Hoon Na', 'Robert Nil', 'Minh T. Nguyen'], year: 2024, venue: 'Computational Linguistics', doi: '10.1162/coli_a_00500', itemType: 'journalArticle' as const },
    { title: 'Transformer Efficiency with Footnote Stripped Contributor Names', authors: ['Ashish Vaswani1,*', 'Noam Shazeer2,†', 'Niki Parmar1'], year: 2017, venue: 'NeurIPS Proceedings', doi: '10.5555/footnote-strip-test', itemType: 'conferencePaper' as const },
    { title: 'Trash and Favorite System View Item Matching Case', authors: ['View Tester'], year: 2024, venue: 'System View Studies', itemType: 'journalArticle' as const },
    { title: 'Optimistic Reading Overlay State Preservation under Re-fetch', authors: ['State Guard'], year: 2024, venue: 'Frontend State Arch', itemType: 'journalArticle' as const },
    { title: 'CSL-JSON Lossless Export and Re-Import Fidelity Assessment', authors: ['Citation Standards Committee'], year: 2024, venue: 'CSL Technical Reports', doi: '10.1000/csl-json-roundtrip', itemType: 'report' as const },
    { title: 'BibTeX Keyword and Annote Preservation across LaTeX Compilation', authors: ['Leslie Lamport', 'Donald E. Knuth'], year: 1984, venue: 'TeX Archives', itemType: 'book' as const },
    { title: 'RIS Keyword and Tag Specification Compliance Record', authors: ['Research Information Systems Inc.'], year: 2021, venue: 'RIS Standards', itemType: 'report' as const },
    { title: 'RFC 4180 CSV Batch Export and Keyset Keystroke Accuracy', authors: ['Data Export Consortium'], year: 2023, venue: 'Open Data Standards', itemType: 'dataset' as const },
    { title: 'TCVN 6700-1 Vietnamese Academic Citation Standard Verification', authors: ['Viện Hàn Lâm Khoa Học Xã Hội'], year: 2024, venue: 'Nhà Xuất Bản Khoa Học Xã Hội', isbn: '9786049567890', itemType: 'book' as const },
  ];
  g10Defs.forEach((d, i) => {
    const num = i + 91;
    const id = `DS-${String(num).padStart(3, '0')}`;
    records.push({
      id,
      group: 10,
      groupName: 'Cross-Stack Parity & Lossless Export Round-Trip',
      ...d,
      rawInputTags: ['Export Fidelity; CSL-JSON; BibTeX; RIS; TCVN', 'TCVN 6700-1'],
      expectedCleanTags: ['Export Fidelity', 'CSL-JSON', 'BibTeX', 'RIS', 'TCVN', 'TCVN 6700-1'],
      rawNote: `<p>Export round-trip note for <strong>${d.title}</strong>.</p>`,
      expectedNoteSnippet: `Export round-trip note`,
    });
  });

  return records;
}
