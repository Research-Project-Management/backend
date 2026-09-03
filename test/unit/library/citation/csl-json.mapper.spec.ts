import { CslJsonMapper } from '../../../../src/modules/library/citation/mappers/csl-json.mapper';

describe('CslJsonMapper (Unit)', () => {
  it('maps a journalArticle CatalogItem with structured contributors to CSL-JSON', () => {
    const item = {
      id: 'item-1',
      citationKey: 'preskill2021quantum',
      itemType: 'journalArticle',
      title: 'Quantum Computing in the NISQ Era and Beyond',
      publicationTitle: 'Quantum',
      volume: '5',
      pages: '79-88',
      year: 2021,
      doi: '10.22331/q-2021-02-05-422',
      url: 'https://quantum-journal.org/papers/q-2021-02-05-422/',
      contributors: [
        {
          orderIndex: 0,
          creatorType: 'author',
          firstName: 'John',
          lastName: 'Preskill',
        },
      ],
    };

    const csl = CslJsonMapper.toCsl(item);

    expect(csl.id).toBe('preskill2021quantum');
    expect(csl.type).toBe('article-journal');
    expect(csl.title).toBe('Quantum Computing in the NISQ Era and Beyond');
    expect(csl['container-title']).toBe('Quantum');
    expect(csl.volume).toBe('5');
    expect(csl.page).toBe('79-88');
    expect(csl.issued).toEqual({ 'date-parts': [[2021]] });
    expect(csl.DOI).toBe('10.22331/q-2021-02-05-422');
    expect(csl.author).toEqual([{ family: 'Preskill', given: 'John' }]);
  });

  it('correctly classifies authors, editors, and translators', () => {
    const item = {
      id: 'book-1',
      itemType: 'book',
      title: 'The Art of Computer Programming',
      publisher: 'Addison-Wesley',
      year: 1997,
      contributors: [
        {
          orderIndex: 0,
          creatorType: 'author',
          firstName: 'Donald',
          lastName: 'Knuth',
        },
        {
          orderIndex: 1,
          creatorType: 'editor',
          firstName: 'Jane',
          lastName: 'Editor',
        },
        {
          orderIndex: 2,
          creatorType: 'translator',
          firstName: 'Hans',
          lastName: 'Translator',
        },
      ],
    };

    const csl = CslJsonMapper.toCsl(item);

    expect(csl.type).toBe('book');
    expect(csl.publisher).toBe('Addison-Wesley');
    expect(csl.author).toEqual([{ family: 'Knuth', given: 'Donald' }]);
    expect(csl.editor).toEqual([{ family: 'Editor', given: 'Jane' }]);
    expect(csl.translator).toEqual([{ family: 'Translator', given: 'Hans' }]);
  });

  it('detects institutional authors in parseStringName', () => {
    const name = CslJsonMapper.parseStringName('World Health Organization');
    expect(name.literal).toBe('World Health Organization');

    const person = CslJsonMapper.parseStringName('Alan Turing');
    expect(person.family).toBe('Turing');
    expect(person.given).toBe('Alan');

    const commaPerson = CslJsonMapper.parseStringName('Dijkstra, Edsger W.');
    expect(commaPerson.family).toBe('Dijkstra');
    expect(commaPerson.given).toBe('Edsger W.');
  });

  it('maps preprint, dataset, and computerProgram types to accurate CSL equivalents', () => {
    const preprint = CslJsonMapper.toCsl({
      itemType: 'preprint',
      title: 'Deep Attention',
    });
    expect(preprint.type).toBe('article');
    expect(preprint.genre).toBe('Preprint');

    const dataset = CslJsonMapper.toCsl({
      itemType: 'dataset',
      title: 'CIFAR-10',
    });
    expect(dataset.type).toBe('dataset');

    const software = CslJsonMapper.toCsl({
      itemType: 'computerProgram',
      title: 'NumPy',
    });
    expect(software.type).toBe('software');
  });
});
