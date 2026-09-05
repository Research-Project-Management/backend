import {
  parseCreatorString,
  splitAuthorString,
} from '@/modules/library/items/creator-parser.util';

describe('CreatorParserUtil Unit Tests', () => {
  describe('parseCreatorString', () => {
    it('correctly parses "First Last"', () => {
      const parsed = parseCreatorString('Alan Turing', 0);
      expect(parsed).toEqual({
        orderIndex: 0,
        creatorType: 'author',
        firstName: 'Alan',
        lastName: 'Turing',
        fullName: 'Alan Turing',
      });
    });

    it('correctly parses "Last, First"', () => {
      const parsed = parseCreatorString('Turing, Alan', 1);
      expect(parsed).toEqual({
        orderIndex: 1,
        creatorType: 'author',
        firstName: 'Alan',
        lastName: 'Turing',
        fullName: 'Alan Turing',
      });
    });

    it('correctly parses multi-part names like "John von Neumann"', () => {
      const parsed = parseCreatorString('John von Neumann', 2);
      expect(parsed).toEqual({
        orderIndex: 2,
        creatorType: 'author',
        firstName: 'John',
        lastName: 'von Neumann',
        fullName: 'John von Neumann',
      });
    });

    it('handles single-token name gracefully', () => {
      const parsed = parseCreatorString('Aristotle', 0);
      expect(parsed).toEqual({
        orderIndex: 0,
        creatorType: 'author',
        firstName: '',
        lastName: 'Aristotle',
        fullName: 'Aristotle',
      });
    });

    it('detects institutions and preserves full institutional name as lastName', () => {
      const institutions = [
        'World Health Organization',
        'Google DeepMind',
        'MIT Computer Science and Artificial Intelligence Laboratory',
        'National Institutes of Health',
        'OpenAI Research Team',
        'Stanford University',
      ];

      for (const inst of institutions) {
        const parsed = parseCreatorString(inst, 0);
        expect(parsed.firstName).toBe('');
        expect(parsed.lastName).toBe(inst);
        expect(parsed.fullName).toBe(inst);
      }
    });

    it('respects custom creatorType parameter', () => {
      const parsed = parseCreatorString('Jane Doe', 0, 'editor');
      expect(parsed.creatorType).toBe('editor');
    });

    it('handles empty or whitespace strings gracefully', () => {
      const parsed = parseCreatorString('   ', 0);
      expect(parsed).toEqual({
        orderIndex: 0,
        creatorType: 'author',
        firstName: '',
        lastName: '',
        fullName: '',
      });
    });
  });

  describe('splitAuthorString', () => {
    it('splits by semicolon', () => {
      const authors = splitAuthorString('Knuth, Donald E.; Turing, Alan; Shannon, Claude');
      expect(authors).toEqual(['Knuth, Donald E.', 'Turing, Alan', 'Shannon, Claude']);
    });

    it('splits by "and"', () => {
      const authors = splitAuthorString('Alan Turing and Claude Shannon and John von Neumann');
      expect(authors).toEqual(['Alan Turing', 'Claude Shannon', 'John von Neumann']);
    });

    it('does not split single "Last, First" into two authors', () => {
      const authors = splitAuthorString('Turing, Alan');
      expect(authors).toEqual(['Turing, Alan']);
    });

    it('splits multiple comma-separated names when more than one comma exists', () => {
      const authors = splitAuthorString('Alice Smith, Bob Jones, Charlie Brown');
      expect(authors).toEqual(['Alice Smith', 'Bob Jones', 'Charlie Brown']);
    });
  });
});
