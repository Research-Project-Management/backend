import { BibtexParser } from '@/modules/library/reference/parsers/bibtex.parser';

describe('BibtexParser', () => {
  let parser: BibtexParser;

  beforeEach(() => {
    parser = new BibtexParser();
  });

  it('should parse single @article entry with bracketed fields', () => {
    const bib = `
      @article{vaswani2017attention,
        title = {Attention Is All You Need},
        author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
        journal = {Advances in Neural Information Processing Systems},
        year = {2017},
        volume = {30},
        pages = {5998--6008},
        doi = {10.5555/3295222.3295349}
      }
    `;

    const entries = parser.parse(bib);
    expect(entries).toHaveLength(1);
    expect(entries[0].citationKey).toBe('vaswani2017attention');
    expect(entries[0].itemType).toBe('journalArticle');
    expect(entries[0].title).toBe('Attention Is All You Need');
    expect(entries[0].authors).toEqual([
      'Vaswani, Ashish',
      'Shazeer, Noam',
      'Parmar, Niki',
    ]);
    expect(entries[0].year).toBe(2017);
    expect(entries[0].journal).toBe(
      'Advances in Neural Information Processing Systems',
    );
    expect(entries[0].volume).toBe('30');
    expect(entries[0].pages).toBe('5998-6008');
    expect(entries[0].doi).toBe('10.5555/3295222.3295349');
  });

  it('should parse multiple entries with quoted and unquoted values', () => {
    const bib = `
      @inproceedings{he2016deep,
        title = "Deep Residual Learning for Image Recognition",
        author = "Kaiming He and Xiangyu Zhang and Shaoqing Ren and Jian Sun",
        booktitle = "CVPR",
        year = 2016
      }

      @book{goodfellow2016deep,
        title = {Deep Learning},
        author = {Ian Goodfellow and Yoshua Bengio and Aaron Courville},
        publisher = {MIT Press},
        year = {2016}
      }
    `;

    const entries = parser.parse(bib);
    expect(entries).toHaveLength(2);

    expect(entries[0].title).toBe(
      'Deep Residual Learning for Image Recognition',
    );
    expect(entries[0].itemType).toBe('conferencePaper');
    expect(entries[0].year).toBe(2016);
    expect(entries[0].authors).toHaveLength(4);

    expect(entries[1].title).toBe('Deep Learning');
    expect(entries[1].itemType).toBe('book');
    expect(entries[1].publisher).toBe('MIT Press');
  });

  it('should handle empty or malformed strings gracefully', () => {
    expect(parser.parse('')).toEqual([]);
    expect(parser.parse('random non-bibtex text')).toEqual([]);
  });
});
