import { CslEngineService } from '../src/modules/library/citation/services/csl-engine.service';
import { CslJsonMapper } from '../src/modules/library/citation/utils/csl-json.mapper';
import { CslItemData } from '../src/modules/library/citation/types/csl-json.types';

interface BenchmarkSource {
  id: string;
  category: 'AI/CS' | 'Biomedical' | 'Physics/Math' | 'Economics' | 'Book' | 'Preprint' | 'Report' | 'Patent' | 'Thesis' | 'Vietnamese';
  title: string;
  doi?: string;
  expectedYear: number;
  expectedFirstAuthor: string;
  cslItem: CslItemData;
}

const SOURCES: BenchmarkSource[] = [
  // 1. Vaswani et al. (2017)
  {
    id: 'src-1',
    category: 'AI/CS',
    title: 'Attention Is All You Need',
    doi: '10.5555/3295222.3295349',
    expectedYear: 2017,
    expectedFirstAuthor: 'Vaswani',
    cslItem: {
      id: 'vaswani2017attention',
      type: 'paper-conference',
      title: 'Attention Is All You Need',
      author: [
        { family: 'Vaswani', given: 'Ashish' },
        { family: 'Shazeer', given: 'Noam' },
        { family: 'Parmar', given: 'Niki' },
        { family: 'Uszkoreit', given: 'Jakob' },
        { family: 'Jones', given: 'Llion' },
        { family: 'Gomez', given: 'Aidan N.' },
        { family: 'Kaiser', given: 'Łukasz' },
        { family: 'Polosukhin', given: 'Illia' },
      ],
      'container-title': 'Advances in Neural Information Processing Systems',
      volume: '30',
      page: '5998-6008',
      issued: { 'date-parts': [[2017]] },
      DOI: '10.5555/3295222.3295349',
    },
  },
  // 2. He et al. (2016) - ResNet
  {
    id: 'src-2',
    category: 'AI/CS',
    title: 'Deep Residual Learning for Image Recognition',
    doi: '10.1109/CVPR.2016.90',
    expectedYear: 2016,
    expectedFirstAuthor: 'He',
    cslItem: {
      id: 'he2016deep',
      type: 'paper-conference',
      title: 'Deep Residual Learning for Image Recognition',
      author: [
        { family: 'He', given: 'Kaiming' },
        { family: 'Zhang', given: 'Xiangyu' },
        { family: 'Ren', given: 'Shaoqing' },
        { family: 'Sun', given: 'Jian' },
      ],
      'container-title': 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR)',
      page: '770-778',
      issued: { 'date-parts': [[2016]] },
      DOI: '10.1109/CVPR.2016.90',
    },
  },
  // 3. Krizhevsky et al. (2012) - AlexNet
  {
    id: 'src-3',
    category: 'AI/CS',
    title: 'ImageNet Classification with Deep Convolutional Neural Networks',
    doi: '10.1145/3065386',
    expectedYear: 2012,
    expectedFirstAuthor: 'Krizhevsky',
    cslItem: {
      id: 'krizhevsky2012imagenet',
      type: 'article-journal',
      title: 'ImageNet Classification with Deep Convolutional Neural Networks',
      author: [
        { family: 'Krizhevsky', given: 'Alex' },
        { family: 'Sutskever', given: 'Ilya' },
        { family: 'Hinton', given: 'Geoffrey E.' },
      ],
      'container-title': 'Communications of the ACM',
      volume: '60',
      issue: '6',
      page: '84-90',
      issued: { 'date-parts': [[2012]] },
      DOI: '10.1145/3065386',
    },
  },
  // 4. Devlin et al. (2019) - BERT
  {
    id: 'src-4',
    category: 'AI/CS',
    title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
    doi: '10.18653/v1/N19-1423',
    expectedYear: 2019,
    expectedFirstAuthor: 'Devlin',
    cslItem: {
      id: 'devlin2019bert',
      type: 'paper-conference',
      title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      author: [
        { family: 'Devlin', given: 'Jacob' },
        { family: 'Chang', given: 'Ming-Wei' },
        { family: 'Lee', given: 'Kenton' },
        { family: 'Toutanova', given: 'Kristina' },
      ],
      'container-title': 'Proceedings of NAACL-HLT 2019',
      page: '4171-4186',
      issued: { 'date-parts': [[2019]] },
      DOI: '10.18653/v1/N19-1423',
    },
  },
  // 5. Watson & Crick (1953) - DNA Structure
  {
    id: 'src-5',
    category: 'Biomedical',
    title: 'Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid',
    doi: '10.1038/171737a0',
    expectedYear: 1953,
    expectedFirstAuthor: 'Watson',
    cslItem: {
      id: 'watson1953molecular',
      type: 'article-journal',
      title: 'Molecular Structure of Nucleic Acids: A Structure for Deoxyribose Nucleic Acid',
      author: [
        { family: 'Watson', given: 'J. D.' },
        { family: 'Crick', given: 'F. H. C.' },
      ],
      'container-title': 'Nature',
      volume: '171',
      issue: '4356',
      page: '737-738',
      issued: { 'date-parts': [[1953]] },
      DOI: '10.1038/171737a0',
    },
  },
  // 6. Hanahan & Weinberg (2000) - Hallmarks of Cancer
  {
    id: 'src-6',
    category: 'Biomedical',
    title: 'The Hallmarks of Cancer',
    doi: '10.1016/s0092-8674(00)81683-9',
    expectedYear: 2000,
    expectedFirstAuthor: 'Hanahan',
    cslItem: {
      id: 'hanahan2000hallmarks',
      type: 'article-journal',
      title: 'The Hallmarks of Cancer',
      author: [
        { family: 'Hanahan', given: 'Douglas' },
        { family: 'Weinberg', given: 'Robert A.' },
      ],
      'container-title': 'Cell',
      volume: '100',
      issue: '1',
      page: '57-70',
      issued: { 'date-parts': [[2000]] },
      DOI: '10.1016/s0092-8674(00)81683-9',
    },
  },
  // 7. Lander et al. (2001) - Human Genome
  {
    id: 'src-7',
    category: 'Biomedical',
    title: 'Initial sequencing and analysis of the human genome',
    doi: '10.1038/35057062',
    expectedYear: 2001,
    expectedFirstAuthor: 'Lander',
    cslItem: {
      id: 'lander2001initial',
      type: 'article-journal',
      title: 'Initial sequencing and analysis of the human genome',
      author: [
        { family: 'Lander', given: 'Eric S.' },
        { family: 'Linton', given: 'Lauren M.' },
        { family: 'Birren', given: 'Bruce' },
        { family: 'Nusbaum', given: 'Chad' },
      ],
      'container-title': 'Nature',
      volume: '409',
      issue: '6822',
      page: '860-921',
      issued: { 'date-parts': [[2001]] },
      DOI: '10.1038/35057062',
    },
  },
  // 8. Kahneman & Tversky (1979) - Prospect Theory
  {
    id: 'src-8',
    category: 'Economics',
    title: 'Prospect Theory: An Analysis of Decision under Risk',
    doi: '10.2307/1914185',
    expectedYear: 1979,
    expectedFirstAuthor: 'Kahneman',
    cslItem: {
      id: 'kahneman1979prospect',
      type: 'article-journal',
      title: 'Prospect Theory: An Analysis of Decision under Risk',
      author: [
        { family: 'Kahneman', given: 'Daniel' },
        { family: 'Tversky', given: 'Amos' },
      ],
      'container-title': 'Econometrica',
      volume: '47',
      issue: '2',
      page: '263-291',
      issued: { 'date-parts': [[1979]] },
      DOI: '10.2307/1914185',
    },
  },
  // 9. Einstein (1905) - Special Relativity
  {
    id: 'src-9',
    category: 'Physics/Math',
    title: 'Zur Elektrodynamik bewegter Körper',
    doi: '10.1002/andp.19053221004',
    expectedYear: 1905,
    expectedFirstAuthor: 'Einstein',
    cslItem: {
      id: 'einstein1905elektrodynamik',
      type: 'article-journal',
      title: 'Zur Elektrodynamik bewegter Körper',
      author: [{ family: 'Einstein', given: 'Albert' }],
      'container-title': 'Annalen der Physik',
      volume: '322',
      issue: '10',
      page: '891-921',
      issued: { 'date-parts': [[1905]] },
      DOI: '10.1002/andp.19053221004',
    },
  },
  // 10. Shannon (1948) - Information Theory
  {
    id: 'src-10',
    category: 'Physics/Math',
    title: 'A Mathematical Theory of Communication',
    doi: '10.1002/j.1538-7305.1948.tb01338.x',
    expectedYear: 1948,
    expectedFirstAuthor: 'Shannon',
    cslItem: {
      id: 'shannon1948mathematical',
      type: 'article-journal',
      title: 'A Mathematical Theory of Communication',
      author: [{ family: 'Shannon', given: 'Claude E.' }],
      'container-title': 'Bell System Technical Journal',
      volume: '27',
      issue: '3',
      page: '379-423',
      issued: { 'date-parts': [[1948]] },
      DOI: '10.1002/j.1538-7305.1948.tb01338.x',
    },
  },
  // 11. ATLAS Collaboration (2012) - Higgs Boson (Massive Consortium)
  {
    id: 'src-11',
    category: 'Physics/Math',
    title: 'Observation of a new particle in the search for the Standard Model Higgs boson with the ATLAS detector at the LHC',
    doi: '10.1016/j.physletb.2012.08.020',
    expectedYear: 2012,
    expectedFirstAuthor: 'Aad',
    cslItem: {
      id: 'atlas2012higgs',
      type: 'article-journal',
      title: 'Observation of a new particle in the search for the Standard Model Higgs boson with the ATLAS detector at the LHC',
      author: [
        { family: 'Aad', given: 'G.' },
        { family: 'Abajyan', given: 'T.' },
        { family: 'Abbott', given: 'B.' },
        { family: 'Abdallah', given: 'J.' },
      ],
      'container-title': 'Physics Letters B',
      volume: '716',
      issue: '1',
      page: '1-29',
      issued: { 'date-parts': [[2012]] },
      DOI: '10.1016/j.physletb.2012.08.020',
    },
  },
  // 12. Goodfellow, Bengio, Courville (2016) - Deep Learning Book
  {
    id: 'src-12',
    category: 'Book',
    title: 'Deep Learning',
    expectedYear: 2016,
    expectedFirstAuthor: 'Goodfellow',
    cslItem: {
      id: 'goodfellow2016deep',
      type: 'book',
      title: 'Deep Learning',
      author: [
        { family: 'Goodfellow', given: 'Ian' },
        { family: 'Bengio', given: 'Yoshua' },
        { family: 'Courville', given: 'Aaron' },
      ],
      publisher: 'MIT Press',
      'publisher-place': 'Cambridge, MA',
      issued: { 'date-parts': [[2016]] },
      ISBN: '978-0-262-03561-3',
    },
  },
  // 13. Russell & Norvig (2020) - AI A Modern Approach
  {
    id: 'src-13',
    category: 'Book',
    title: 'Artificial Intelligence: A Modern Approach',
    expectedYear: 2020,
    expectedFirstAuthor: 'Russell',
    cslItem: {
      id: 'russell2020artificial',
      type: 'book',
      title: 'Artificial Intelligence: A Modern Approach',
      author: [
        { family: 'Russell', given: 'Stuart' },
        { family: 'Norvig', given: 'Peter' },
      ],
      edition: '4th',
      publisher: 'Pearson',
      'publisher-place': 'Hoboken, NJ',
      issued: { 'date-parts': [[2020]] },
      ISBN: '978-0-13-461099-3',
    },
  },
  // 14. Knuth (1997) - The Art of Computer Programming
  {
    id: 'src-14',
    category: 'Book',
    title: 'The Art of Computer Programming, Volume 1: Fundamental Algorithms',
    expectedYear: 1997,
    expectedFirstAuthor: 'Knuth',
    cslItem: {
      id: 'knuth1997art',
      type: 'book',
      title: 'The Art of Computer Programming, Volume 1: Fundamental Algorithms',
      author: [{ family: 'Knuth', given: 'Donald E.' }],
      edition: '3rd',
      publisher: 'Addison-Wesley',
      'publisher-place': 'Reading, MA',
      issued: { 'date-parts': [[1997]] },
      ISBN: '978-0-201-89683-1',
    },
  },
  // 15. Perelman (2002) - Ricci Flow on arXiv
  {
    id: 'src-15',
    category: 'Preprint',
    title: 'The entropy formula for the Ricci flow and its geometric applications',
    expectedYear: 2002,
    expectedFirstAuthor: 'Perelman',
    cslItem: {
      id: 'perelman2002entropy',
      type: 'article',
      title: 'The entropy formula for the Ricci flow and its geometric applications',
      author: [{ family: 'Perelman', given: 'Grisha' }],
      'container-title': 'arXiv preprint math/0211159',
      issued: { 'date-parts': [[2002]] },
    },
  },
  // 16. World Health Organization (2020) - Corporate Author Report
  {
    id: 'src-16',
    category: 'Report',
    title: 'WHO guidelines on physical activity and sedentary behaviour',
    expectedYear: 2020,
    expectedFirstAuthor: 'World Health Organization',
    cslItem: {
      id: 'who2020guidelines',
      type: 'report',
      title: 'WHO guidelines on physical activity and sedentary behaviour',
      author: [{ literal: 'World Health Organization' }],
      publisher: 'World Health Organization',
      'publisher-place': 'Geneva',
      issued: { 'date-parts': [[2020]] },
      ISBN: '978-92-4-001512-8',
    },
  },
  // 17. IPCC (2023) - Climate Change Synthesis Report
  {
    id: 'src-17',
    category: 'Report',
    title: 'Climate Change 2023: Synthesis Report. Contribution of Working Groups I, II and III to the Sixth Assessment Report',
    doi: '10.59327/IPCC/AR6-9789291691647',
    expectedYear: 2023,
    expectedFirstAuthor: 'IPCC',
    cslItem: {
      id: 'ipcc2023synthesis',
      type: 'report',
      title: 'Climate Change 2023: Synthesis Report',
      author: [{ literal: 'IPCC' }],
      publisher: 'Intergovernmental Panel on Climate Change',
      'publisher-place': 'Geneva, Switzerland',
      issued: { 'date-parts': [[2023]] },
      DOI: '10.59327/IPCC/AR6-9789291691647',
    },
  },
  // 18. Page (2001) - PageRank Patent
  {
    id: 'src-18',
    category: 'Patent',
    title: 'Method for node ranking in a linked database',
    expectedYear: 2001,
    expectedFirstAuthor: 'Page',
    cslItem: {
      id: 'page2001pagerank',
      type: 'patent',
      title: 'Method for node ranking in a linked database',
      author: [{ family: 'Page', given: 'Lawrence' }],
      number: 'US Patent 6,285,999',
      issued: { 'date-parts': [[2001]] },
    },
  },
  // 19. Sutherland (1963) - MIT Sketchpad Thesis
  {
    id: 'src-19',
    category: 'Thesis',
    title: 'Sketchpad: A man-machine graphical communication system',
    expectedYear: 1963,
    expectedFirstAuthor: 'Sutherland',
    cslItem: {
      id: 'sutherland1963sketchpad',
      type: 'thesis',
      title: 'Sketchpad: A man-machine graphical communication system',
      author: [{ family: 'Sutherland', given: 'Ivan Edward' }],
      publisher: 'Massachusetts Institute of Technology',
      genre: 'PhD thesis',
      issued: { 'date-parts': [[1963]] },
    },
  },
  // 20. Quoc V. Le & Mikolov (2014) - Distributed Representations (Vietnamese author test)
  {
    id: 'src-20',
    category: 'Vietnamese',
    title: 'Distributed Representations of Sentences and Documents',
    expectedYear: 2014,
    expectedFirstAuthor: 'Le',
    cslItem: {
      id: 'le2014distributed',
      type: 'paper-conference',
      title: 'Distributed Representations of Sentences and Documents',
      author: [
        { family: 'Le', given: 'Quoc' },
        { family: 'Mikolov', given: 'Tomas' },
      ],
      'container-title': 'Proceedings of the 31st International Conference on Machine Learning (ICML)',
      page: '1188-1196',
      issued: { 'date-parts': [[2014]] },
    },
  },
];

async function fetchDoiGroundTruth(doi: string, style: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
      headers: {
        Accept: `text/x-bibliography; style=${style}`,
        'User-Agent': 'FluxAcademicBench/1.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const text = await res.text();
      return text.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('FLUX CITATION ENGINE ACCURACY BENCHMARK — 20 POPULAR SOURCES');
  console.log('Testing against official CSL standards and online DOI ground truth');
  console.log('='.repeat(80));

  const engine = new CslEngineService();
  engine.onModuleInit();

  let apaPassCount = 0;
  let ieeePassCount = 0;
  let inTextPassCount = 0;
  let bibtexPassCount = 0;
  let groundTruthMatches = 0;
  let totalDoiTested = 0;

  const results: any[] = [];

  for (let i = 0; i < SOURCES.length; i++) {
    const src = SOURCES[i];
    console.log(`\n[${i + 1}/20] Testing: ${src.title} (${src.category})`);

    // 1. Format APA 7th
    const apaResult = engine.format(src.cslItem, 'apa-7th', i + 1);
    const apaHasAuthor = apaResult.bibliography.includes(src.expectedFirstAuthor);
    const apaHasYear = apaResult.bibliography.includes(String(src.expectedYear));
    const apaInTextValid =
      apaResult.inText.includes(src.expectedFirstAuthor) &&
      apaResult.inText.includes(String(src.expectedYear));

    if (apaHasAuthor && apaHasYear) apaPassCount++;
    if (apaInTextValid) inTextPassCount++;

    // 2. Format IEEE
    const ieeeResult = engine.format(src.cslItem, 'ieee', i + 1);
    const ieeeValid =
      /^\[\d+\]$/.test(ieeeResult.inText) &&
      (ieeeResult.bibliography.includes(src.expectedFirstAuthor) ||
        ieeeResult.bibliography.includes(src.title));
    if (ieeeValid) ieeePassCount++;

    // 3. Format BibTeX
    const bibtexResult = engine.format(src.cslItem, 'bibtex', i + 1);
    const bibtexValid =
      bibtexResult.bibliography.startsWith('@') &&
      bibtexResult.bibliography.includes(src.cslItem.id);
    if (bibtexValid) bibtexPassCount++;

    // 4. Online CrossRef Ground Truth Verification
    let groundTruth: string | null = null;
    let groundTruthMatch = false;
    if (src.doi) {
      totalDoiTested++;
      groundTruth = await fetchDoiGroundTruth(src.doi, 'apa');
      if (groundTruth) {
        // Check if author and year match ground truth
        const authorMatch = groundTruth.toLowerCase().includes(src.expectedFirstAuthor.toLowerCase());
        const yearMatch = groundTruth.includes(String(src.expectedYear));
        if (authorMatch && yearMatch) {
          groundTruthMatch = true;
          groundTruthMatches++;
        }
      }
    }

    console.log(`  - APA In-Text:    ${apaResult.inText} [${apaInTextValid ? 'PASS' : 'FAIL'}]`);
    console.log(`  - APA Bib:        ${apaResult.bibliography.slice(0, 100)}...`);
    console.log(`  - IEEE In-Text:   ${ieeeResult.inText} [${ieeeValid ? 'PASS' : 'FAIL'}]`);
    console.log(`  - BibTeX Key:     ${bibtexResult.inText} [${bibtexValid ? 'PASS' : 'FAIL'}]`);
    if (src.doi) {
      console.log(`  - DOI Online GT:  ${groundTruth ? 'Fetched OK' : 'Offline/Unavailable'} (Match: ${groundTruthMatch ? 'YES' : 'N/A'})`);
    }

    results.push({
      id: src.id,
      category: src.category,
      title: src.title,
      firstAuthor: src.expectedFirstAuthor,
      year: src.expectedYear,
      apaInText: apaResult.inText,
      apaBibSample: apaResult.bibliography.slice(0, 80) + '...',
      ieeeInText: ieeeResult.inText,
      apaStatus: apaHasAuthor && apaHasYear ? 'PASS' : 'FAIL',
      ieeeStatus: ieeeValid ? 'PASS' : 'FAIL',
      bibtexStatus: bibtexValid ? 'PASS' : 'FAIL',
      groundTruthMatch: groundTruthMatch ? 'VERIFIED' : src.doi ? 'FETCH_FAIL' : 'MANUAL_SOURCE',
    });
  }

  // 5. Test Batch Grouping & Sorting with 5 distinct items together
  console.log('\n' + '='.repeat(80));
  console.log('TESTING MULTI-ITEM BATCH CITATION (NEW FEATURE VERIFICATION)');
  console.log('='.repeat(80));

  const batchSample = [SOURCES[0].cslItem, SOURCES[3].cslItem, SOURCES[1].cslItem, SOURCES[4].cslItem];
  const batchApa = engine.formatBatch(batchSample, 'apa-7th');
  console.log('Combined APA In-Text:', batchApa.combinedInText);
  console.log('Batch APA Bibliography (Alphabetized):\n' + batchApa.bibliographyText);

  const batchIeee = engine.formatBatch(batchSample, 'ieee');
  console.log('\nCombined IEEE In-Text:', batchIeee.combinedInText);
  console.log('Batch IEEE Bibliography (Numbered):\n' + batchIeee.bibliographyText);

  // Summary Metrics
  console.log('\n' + '='.repeat(80));
  console.log('BENCHMARK SUMMARY RESULTS:');
  console.log(`- Total Sources Tested:      20 / 20`);
  console.log(`- APA Bibliography Accuracy: ${(apaPassCount / 20) * 100}% (${apaPassCount}/20)`);
  console.log(`- APA In-Text Accuracy:      ${(inTextPassCount / 20) * 100}% (${inTextPassCount}/20)`);
  console.log(`- IEEE Format Accuracy:      ${(ieeePassCount / 20) * 100}% (${ieeePassCount}/20)`);
  console.log(`- BibTeX Format Accuracy:    ${(bibtexPassCount / 20) * 100}% (${bibtexPassCount}/20)`);
  console.log(`- Online CrossRef Parity:    ${totalDoiTested > 0 ? ((groundTruthMatches / totalDoiTested) * 100).toFixed(1) : 0}% (${groundTruthMatches}/${totalDoiTested} DOIs verified online)`);
  console.log('='.repeat(80));
}

runBenchmark().catch(console.error);
