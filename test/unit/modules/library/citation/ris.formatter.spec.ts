import { RisFormatter } from '@/modules/library/citation/formatters/ris.formatter';

describe('RisFormatter', () => {
  let formatter: RisFormatter;

  beforeEach(() => {
    formatter = new RisFormatter();
  });

  it('should parse standard RIS text into structured ReferenceData', () => {
    const risText = `
TY  - JOUR
TI  - Attention Is All You Need
AU  - Vaswani, Ashish
AU  - Shazeer, Noam
PY  - 2017
DO  - 10.48550/arXiv.1706.03762
JO  - Advances in Neural Information Processing Systems
VL  - 30
SP  - 5998
EP  - 6008
AB  - The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...
KW  - Deep Learning
KW  - Transformers
ER  - 
`;

    const entries = formatter.parse(risText);

    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Attention Is All You Need');
    expect(entries[0].authors).toEqual(['Vaswani, Ashish', 'Shazeer, Noam']);
    expect(entries[0].year).toBe(2017);
    expect(entries[0].doi).toBe('10.48550/arXiv.1706.03762');
    expect(entries[0].journal).toBe(
      'Advances in Neural Information Processing Systems',
    );
    expect(entries[0].volume).toBe('30');
    expect(entries[0].pages).toBe('5998-6008');
    expect(entries[0].keywords).toEqual(['Deep Learning', 'Transformers']);
    expect(entries[0].itemType).toBe('journalArticle');
  });

  it('should format paper into standard RIS entry string', () => {
    const paper = {
      title: 'Deep Residual Learning for Image Recognition',
      authors: ['He, Kaiming', 'Zhang, Xiangyu'],
      year: 2016,
      doi: '10.1109/CVPR.2016.90',
      journal: 'IEEE Conference on Computer Vision and Pattern Recognition',
      itemType: 'conferencePaper',
    };

    const risOutput = formatter.formatEntry(paper);

    expect(risOutput).toContain('TY  - CONF');
    expect(risOutput).toContain(
      'TI  - Deep Residual Learning for Image Recognition',
    );
    expect(risOutput).toContain('AU  - He, Kaiming');
    expect(risOutput).toContain('PY  - 2016');
    expect(risOutput).toContain('DO  - 10.1109/CVPR.2016.90');
    expect(risOutput).toContain('ER  - ');
  });
});
