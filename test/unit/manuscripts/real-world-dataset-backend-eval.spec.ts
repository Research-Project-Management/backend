/**
 * test/unit/manuscripts/real-world-dataset-backend-eval.spec.ts
 *
 * Backend Evaluation Test Suite using Real-World Academic Datasets
 * (arXiv:1706.03762 Attention, arXiv:1810.04805 BERT, arXiv:2307.01189 TinT)
 */

import * as fs from 'fs';
import * as path from 'path';
import { RegexAstBibtexParser } from '@/modules/manuscripts/citations';
import { BibBackendDetector } from '@/modules/manuscripts/clsi/core/adapters/engines/bib-backend.detector';

const FIXTURES_DIR = path.resolve(__dirname, '../../../../frontend/tests/fixtures/real-world-datasets');
const ATTENTION_DIR = path.join(FIXTURES_DIR, 'attention');
const BERT_DIR = path.join(FIXTURES_DIR, 'bert');
const TINT_DIR = path.join(FIXTURES_DIR, 'tint');

describe('Backend Manuscripts - Real-World Dataset Evaluation', () => {
  describe('BibTeX AST Engine on Real-World Bibliography (TinT arXiv:2307.01189)', () => {
    const bibPath = path.join(TINT_DIR, 'bibliography.bib');

    it('successfully parses 32.8 KB academic bibliography into structured AST entries', () => {
      expect(fs.existsSync(bibPath)).toBe(true);
      const bibText = fs.readFileSync(bibPath, 'utf-8');

      const parser = new RegexAstBibtexParser();
      const entries = parser.parse(bibText);
      expect(entries).toBeDefined();
      expect(entries.length).toBeGreaterThanOrEqual(40);

      // Verify each entry has valid key and non-empty type
      for (const entry of entries) {
        expect(entry.key.value).toBeTruthy();
        expect(entry.entryType).toBeTruthy();
      }
    });

    it('correctly extracts author list and titles from real entries', () => {
      const bibText = fs.readFileSync(bibPath, 'utf-8');
      const parser = new RegexAstBibtexParser();
      const entries = parser.parse(bibText);

      const entriesWithAuthors = entries.filter((e) => e.authors && e.authors.authors.length > 0);
      expect(entriesWithAuthors.length).toBeGreaterThanOrEqual(entries.length * 0.85);

      const entriesWithTitle = entries.filter((e) => e.title && e.title.length > 0);
      expect(entriesWithTitle.length).toBeGreaterThanOrEqual(entries.length * 0.85);
    });
  });

  describe('CLSI Bibliography Engine Detection on Real Manuscripts', () => {
    it('detects traditional BibTeX engine for Attention Is All You Need (ms.tex)', async () => {
      const msPath = path.join(ATTENTION_DIR, 'ms.tex');
      expect(fs.existsSync(msPath)).toBe(true);
      const content = fs.readFileSync(msPath, 'utf-8');

      const backend = await BibBackendDetector.detect(content);
      expect(backend).toBe('bibtex');
    });

    it('detects traditional BibTeX engine for BERT (main.tex)', async () => {
      const bertPath = path.join(BERT_DIR, 'main.tex');
      expect(fs.existsSync(bertPath)).toBe(true);
      const content = fs.readFileSync(bertPath, 'utf-8');

      const backend = await BibBackendDetector.detect(content);
      expect(backend).toBe('bibtex');
    });

    it('detects Biber engine when biblatex is declared', async () => {
      const biblatexDoc = `
\\documentclass{article}
\\usepackage[backend=biber,style=numeric]{biblatex}
\\addbibresource{references.bib}
\\begin{document}
Test
\\end{document}
`;
      const backend = await BibBackendDetector.detect(biblatexDoc);
      expect(backend).toBe('biber');
    });
  });
});
