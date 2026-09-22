import { cleanAbstractText } from '../../src/modules/library/shared-kernel/utils/bibliographic.utils';

describe('cleanAbstractText - Comprehensive Academic Abstract Normalization', () => {
  describe('1. LaTeX and Mathematical Formula Preservation', () => {
    it('should preserve inline LaTeX math formulas with curly braces completely intact', () => {
      const raw =
        'We propose an algorithm running in $O(n \\log n)$ time with $\\mathbb{R}^d$ bounds, where $\\frac{a}{b} = c$.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'We propose an algorithm running in $O(n \\log n)$ time with $\\mathbb{R}^d$ bounds, where $\\frac{a}{b} = c$.',
      );
    });

    it('should strip non-math LaTeX braces while keeping math formulas intact', () => {
      const raw =
        '{Deep Learning} models achieve state-of-the-art results for {Convolutional Networks} when $f(x) = \\sigma(W^T x + b)$.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'Deep Learning models achieve state-of-the-art results for Convolutional Networks when $f(x) = \\sigma(W^T x + b)$.',
      );
    });

    it('should preserve display math block delimiters ($$...$$)', () => {
      const raw = `
        The energy formulation is governed by the following equation:

        $$E = mc^2 + \\int_0^1 f(x) dx$$

        This proves the fundamental theorem of physics.
      `;
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toContain('$$E = mc^2 + \\int_0^1 f(x) dx$$');
      expect(cleaned).toContain('The energy formulation is governed');
    });

    it('should preserve LaTeX environment equations (\\begin{equation}...\\end{equation})', () => {
      const raw =
        'The loss function is defined as:\n\\begin{equation}\n\\mathcal{L}(\\theta) = -\\sum_{i=1}^N \\log p(y_i|x_i)\n\\end{equation}\nwhich converges monotonically.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toContain(
        '\\begin{equation}\n\\mathcal{L}(\\theta) = -\\sum_{i=1}^N \\log p(y_i|x_i)\n\\end{equation}',
      );
    });

    it('should pre-extract and preserve JATS XML <tex-math> formulas from Crossref / PubMed', () => {
      const raw =
        '<jats:p>We investigate the group <jats:inline-formula><jats:tex-math>\\mathcal{G}_n</jats:tex-math></jats:inline-formula> under rotation.</jats:p>';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'We investigate the group $\\mathcal{G}_n$ under rotation.',
      );
    });

    it('should unwrap CDATA inside JATS XML tex-math tags', () => {
      const raw =
        'The Hamiltonian is <disp-formula><tex-math><![CDATA[H = \\sum_i \\hbar \\omega_i a_i^\\dagger a_i]]></tex-math></disp-formula> for quantum oscillators.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toContain(
        '$$H = \\sum_i \\hbar \\omega_i a_i^\\dagger a_i$$',
      );
    });
  });

  describe('2. Native Unicode Subscripts and Superscripts', () => {
    it('should convert chemical formula <sub> tags to semantic Unicode characters', () => {
      const raw =
        'The reaction between H<sub>2</sub>O and CO<sub>2</sub> produces H<sub>2</sub>CO<sub>3</sub> in solution.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'The reaction between H₂O and CO₂ produces H₂CO₃ in solution.',
      );
    });

    it('should convert numerical and mathematical <sup> tags to semantic Unicode characters', () => {
      const raw =
        'The concentration was 10<sup>-5</sup> mol/L with confidence R<sup>2</sup> = 0.99 for Ca<sup>2+</sup> ions.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'The concentration was 10⁻⁵ mol/L with confidence R² = 0.99 for Ca²⁺ ions.',
      );
    });

    it('should convert JATS prefixed <jats:sub> and <jats:sup> tags', () => {
      const raw =
        'Measurement of NO<jats:sub>x</jats:sub> emissions revealed a decrease of 10<jats:sup>3</jats:sup> kg/year.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'Measurement of NOₓ emissions revealed a decrease of 10³ kg/year.',
      );
    });
  });

  describe('3. Structured Headings Normalization (PubMed & JATS XML)', () => {
    it('should convert PubMed <AbstractText Label="..."> tags to Markdown bold headings', () => {
      const raw = `
        <AbstractText Label="BACKGROUND" NlmCategory="BACKGROUND">Hypertension affects millions worldwide.</AbstractText>
        <AbstractText Label="METHODS" NlmCategory="METHODS">We conducted a randomized trial of 500 patients.</AbstractText>
        <AbstractText Label="RESULTS" NlmCategory="RESULTS">Systolic blood pressure decreased significantly.</AbstractText>
        <AbstractText Label="CONCLUSIONS" NlmCategory="CONCLUSIONS">Treatment was effective and well tolerated.</AbstractText>
      `;
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        '**BACKGROUND:** Hypertension affects millions worldwide.\n\n' +
          '**METHODS:** We conducted a randomized trial of 500 patients.\n\n' +
          '**RESULTS:** Systolic blood pressure decreased significantly.\n\n' +
          '**CONCLUSIONS:** Treatment was effective and well tolerated.',
      );
    });

    it('should convert JATS section titles into Markdown bold headings without duplicate colons', () => {
      const raw = `
        <jats:sec>
          <jats:title>Background:</jats:title>
          <jats:p>The emergence of transformers changed NLP.</jats:p>
        </jats:sec>
        <jats:sec>
          <jats:title>Findings</jats:title>
          <jats:p>Self-attention scales with sequence length quadratically.</jats:p>
        </jats:sec>
      `;
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toContain('**Background:** The emergence of transformers');
      expect(cleaned).toContain('**Findings:** Self-attention scales');
    });

    it('should strip redundant "Abstract" or "Summary" prefix titles', () => {
      const raw1 =
        'ABSTRACT: This paper presents an empirical analysis of neural network distillation.';
      expect(cleanAbstractText(raw1)).toBe(
        'This paper presents an empirical analysis of neural network distillation.',
      );

      const raw2 =
        'Graphical Abstract. In this study we demonstrate quantum supremacy.';
      expect(cleanAbstractText(raw2)).toBe(
        'In this study we demonstrate quantum supremacy.',
      );
    });
  });

  describe('4. Noise, Copyright, and Artifact Stripping', () => {
    it('should remove Elsevier and Academic Press copyright notices', () => {
      const raw =
        'Our findings confirm the hypothesis. © 2023 Elsevier B.V. All rights reserved.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe('Our findings confirm the hypothesis.');
    });

    it('should remove Springer Nature and BioMed Central copyright notices', () => {
      const raw =
        'Therapeutic benefits were observed in 95% of cases. Copyright © 2024 The Author(s), Springer Nature Switzerland AG.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'Therapeutic benefits were observed in 95% of cases.',
      );
    });

    it('should remove IEEE and ACM copyright banners', () => {
      const raw =
        'The proposed architecture achieves 40% latency reduction. 0018-9219 (c) 2022 IEEE. Personal use is permitted.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'The proposed architecture achieves 40% latency reduction.',
      );
    });

    it('should remove repeated year extraction artifacts', () => {
      const raw =
        'We benchmark several historical datasets (2014)(2015)(2016)(2017)(2018). The accuracy improved over time.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'We benchmark several historical datasets. The accuracy improved over time.',
      );
    });

    it('should remove trailing author correspondence footnotes', () => {
      const raw =
        'Results suggest strong generalization capabilities. * Corresponding author: j.doe@mit.edu. Equal contribution.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'Results suggest strong generalization capabilities.',
      );
    });
  });

  describe('5. Whitespace and Paragraph Normalization', () => {
    it('should unwrap hard line breaks within paragraphs while preserving double newline paragraph boundaries', () => {
      const raw =
        'This is the first sentence\nof the first paragraph which continues\nhere.\n\nThis is the second paragraph\nwith more details.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'This is the first sentence of the first paragraph which continues here.\n\nThis is the second paragraph with more details.',
      );
    });

    it('should rejoin hyphenated words broken across line wraps', () => {
      const raw =
        'We introduce a self-atten-\ntion mechanism for stochas-\ntic gradient descent.';
      const cleaned = cleanAbstractText(raw);
      expect(cleaned).toBe(
        'We introduce a self-attention mechanism for stochastic gradient descent.',
      );
    });

    it('should return undefined for banned placeholder or too short strings', () => {
      expect(cleanAbstractText(null)).toBeUndefined();
      expect(cleanAbstractText('')).toBeUndefined();
      expect(cleanAbstractText('n/a')).toBeUndefined();
      expect(cleanAbstractText('Too short.')).toBeUndefined(); // length 10 < 15
    });
  });
});
