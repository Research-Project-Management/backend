import {
  decodeHtmlEntities,
  stripXmlAndHtmlTags,
  cleanBibliographicText,
  cleanBannedString,
} from '@/modules/library/items/text-cleaner.util';

describe('TextCleanerUtil Unit Tests', () => {
  describe('decodeHtmlEntities', () => {
    it('decodes standard HTML entities', () => {
      expect(decodeHtmlEntities('Rock &amp; Roll')).toBe('Rock & Roll');
      expect(decodeHtmlEntities('&lt;div&gt;Hello&lt;/div&gt;')).toBe('<div>Hello</div>');
      expect(decodeHtmlEntities('&quot;Quoted&quot; and &#39;Single&#39;')).toBe('"Quoted" and \'Single\'');
      expect(decodeHtmlEntities('Non&nbsp;breaking')).toBe('Non breaking');
      expect(decodeHtmlEntities('Pages 1&ndash;10 &mdash; volume 2')).toBe('Pages 1–10 — volume 2');
    });

    it('decodes decimal character entities', () => {
      expect(decodeHtmlEntities('&#8220;Smart Quotes&#8221;')).toBe('“Smart Quotes”');
      expect(decodeHtmlEntities('Letter &#65;')).toBe('Letter A');
    });

    it('decodes hexadecimal character entities', () => {
      expect(decodeHtmlEntities('Hex &#x26; Ampersand')).toBe('Hex & Ampersand');
      expect(decodeHtmlEntities('Hex &#x2014; Dash')).toBe('Hex — Dash');
    });

    it('handles empty or undefined inputs gracefully', () => {
      expect(decodeHtmlEntities('')).toBe('');
      expect(decodeHtmlEntities(undefined as any)).toBe('');
      expect(decodeHtmlEntities(null as any)).toBe('');
    });
  });

  describe('stripXmlAndHtmlTags', () => {
    it('strips basic HTML tags', () => {
      expect(stripXmlAndHtmlTags('<p>Paragraph with <b>bold</b> and <i>italic</i>.</p>'))
        .toBe('Paragraph with bold and italic.');
    });

    it('strips JATS XML tags common in CrossRef and PubMed without word fusion', () => {
      expect(
        stripXmlAndHtmlTags(
          '<jats:title>Introduction</jats:title><jats:p>This study investigates <jats:italic>E. coli</jats:italic>.</jats:p>',
        ),
      ).toBe('Introduction This study investigates E. coli.');
    });
  });

  describe('cleanBibliographicText', () => {
    it('decodes entities, strips tags, and collapses multiple whitespaces into clean text', () => {
      const dirty = `
        <jats:p>
          Research on &amp; Development in <i>Deep Learning</i> &ndash; 2024.
        </jats:p>
      `;
      const cleaned = cleanBibliographicText(dirty);
      expect(cleaned).toBe('Research on & Development in Deep Learning – 2024.');
    });

    it('returns undefined for empty, whitespace, or nullish text', () => {
      expect(cleanBibliographicText('')).toBeUndefined();
      expect(cleanBibliographicText('    ')).toBeUndefined();
      expect(cleanBibliographicText(undefined)).toBeUndefined();
      expect(cleanBibliographicText(null)).toBeUndefined();
    });
  });

  describe('cleanBannedString', () => {
    it('filters out banned placeholders and empty strings', () => {
      const banned = ['undefined', 'null', 'n/a', 'na', 'none', 'unknown', '', '   '];
      for (const b of banned) {
        expect(cleanBannedString(b)).toBeUndefined();
      }
    });

    it('preserves legitimate text', () => {
      expect(cleanBannedString('Nature Neuroscience')).toBe('Nature Neuroscience');
      expect(cleanBannedString('10.1038/s41593-020-00742-w')).toBe('10.1038/s41593-020-00742-w');
    });
  });
});
