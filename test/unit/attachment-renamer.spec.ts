import {
  formatAttachmentFilename,
  extractAuthorTokens,
  sanitizeFilenameStem,
  DEFAULT_RENAME_PATTERN,
} from '@/modules/library/attachments/utils/renamer.util';

describe('Attachment Renamer Utility Spec (Zotero 7 Official Standard)', () => {
  it('should format filename with official Zotero 7 default template {{ firstCreator suffix=" - " }}{{ year suffix=" - " }}{{ title truncate="100" }}', () => {
    const item = {
      title: 'Attention Is All You Need',
      year: 2017,
      contributors: [
        { fullName: 'Ashish Vaswani', lastName: 'Vaswani', creatorType: 'author', orderIndex: 0 },
      ],
    };

    const result = formatAttachmentFilename(DEFAULT_RENAME_PATTERN, item, 'original.pdf');
    expect(result).toBe('Vaswani - 2017 - Attention Is All You Need.pdf');
  });

  it('should format filename with authors et al. pattern when specified', () => {
    const pattern = '{{ authors suffix=" - " }}{{ year suffix=" - " }}{{ title truncate="100" }}';
    const item = {
      title: 'Deep Residual Learning for Image Recognition',
      year: 2016,
      contributors: [
        { fullName: 'Kaiming He', lastName: 'He', creatorType: 'author', orderIndex: 0 },
        { fullName: 'Xiangyu Zhang', lastName: 'Zhang', creatorType: 'author', orderIndex: 1 },
      ],
    };

    const result = formatAttachmentFilename(pattern, item, 'paper.pdf');
    expect(result).toBe('He and Zhang - 2016 - Deep Residual Learning for Image Recognition.pdf');
  });

  it('should format filename with 3+ authors using "et al."', () => {
    const pattern = '{{ authors suffix=" - " }}{{ year suffix=" - " }}{{ title truncate="100" }}';
    const item = {
      title: 'Generative Adversarial Nets',
      year: 2014,
      contributors: [
        { fullName: 'Ian Goodfellow', lastName: 'Goodfellow', creatorType: 'author', orderIndex: 0 },
        { fullName: 'Jean Pouget-Abadie', lastName: 'Pouget-Abadie', creatorType: 'author', orderIndex: 1 },
        { fullName: 'Mehdi Mirza', lastName: 'Mirza', creatorType: 'author', orderIndex: 2 },
      ],
    };

    const result = formatAttachmentFilename(pattern, item, 'document.pdf');
    expect(result).toBe('Goodfellow et al. - 2014 - Generative Adversarial Nets.pdf');
  });

  it('should sanitize illegal characters and colon in title', () => {
    const item = {
      title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      year: 2019,
      contributors: [
        { fullName: 'Jacob Devlin', lastName: 'Devlin', creatorType: 'author', orderIndex: 0 },
      ],
    };

    const result = formatAttachmentFilename(DEFAULT_RENAME_PATTERN, item, 'file.pdf');
    expect(result).not.toContain(':');
    expect(result).toBe('Devlin - 2019 - BERT Pre-training of Deep Bidirectional Transformers for Language Understanding.pdf');
  });

  it('should handle custom patterns like {{year}}_{{firstCreator}}_{{title}}', () => {
    const item = {
      title: 'Mastering the Game of Go',
      year: 2016,
      contributors: [
        { fullName: 'David Silver', lastName: 'Silver', creatorType: 'author', orderIndex: 0 },
        { fullName: 'Aja Huang', lastName: 'Huang', creatorType: 'author', orderIndex: 1 },
      ],
    };

    const pattern = '{{year}}_{{firstCreator}}_{{title}}';
    const result = formatAttachmentFilename(pattern, item, 'doc.pdf');
    expect(result).toBe('2016_Silver_Mastering the Game of Go.pdf');
  });

  it('should handle missing year or missing author gracefully without dangling dashes due to suffix modifier', () => {
    const itemWithoutYear = {
      title: 'A Mathematical Theory of Communication',
      contributors: [
        { fullName: 'Claude Shannon', lastName: 'Shannon', creatorType: 'author', orderIndex: 0 },
      ],
    };

    const result = formatAttachmentFilename(DEFAULT_RENAME_PATTERN, itemWithoutYear, 'paper.pdf');
    expect(result).toBe('Shannon - A Mathematical Theory of Communication.pdf');
  });

  it('should preserve original non-pdf extensions', () => {
    const item = {
      title: 'Snapshot of Wikipedia Article',
      year: 2023,
      contributors: [],
    };

    const result = formatAttachmentFilename(DEFAULT_RENAME_PATTERN, item, 'snapshot.html');
    expect(result.endsWith('.html')).toBe(true);
  });
});
