/**
 * citations/core/adapters/library/pluggable-library-sync.adapter.ts
 * Adapter implementing ILibrarySyncPort.
 * Provides future-ready bridge for Zotero / Flux Library integration.
 */

import { ILibrarySyncPort, LibraryCollectionSummary } from '../../ports/library-sync.port';

export class PluggableLibrarySyncAdapter implements ILibrarySyncPort {
  private readonly defaultCollections: LibraryCollectionSummary[] = [
    {
      id: 'coll-default',
      name: 'My Library (Zotero Parity)',
      itemCount: 2,
    },
    {
      id: 'coll-ai-papers',
      name: 'Artificial Intelligence & Deep Learning',
      itemCount: 1,
    },
  ];

  private readonly mockBibtexData = new Map<string, string>([
    [
      'coll-default',
      `@article{vaswani2017attention,
  title = {Attention is all you need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  journal = {Advances in neural information processing systems},
  volume = {30},
  year = {2017}
}

@book{goodfellow2016deep,
  title = {Deep Learning},
  author = {Goodfellow, Ian and Bengio, Yoshua and Courville, Aaron},
  publisher = {MIT Press},
  year = {2016}
}`,
    ],
    [
      'coll-ai-papers',
      `@inproceedings{he2016deep,
  title = {Deep residual learning for image recognition},
  author = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  booktitle = {Proceedings of the IEEE conference on computer vision and pattern recognition},
  pages = {770--778},
  year = {2016}
}`,
    ],
  ]);

  public async listCollections(_userId: string): Promise<LibraryCollectionSummary[]> {
    return [...this.defaultCollections];
  }

  public async fetchCollectionBibtex(
    _userId: string,
    collectionId: string
  ): Promise<string> {
    const data = this.mockBibtexData.get(collectionId);
    if (!data) {
      throw new Error(`Collection ${collectionId} not found`);
    }
    return data;
  }
}
