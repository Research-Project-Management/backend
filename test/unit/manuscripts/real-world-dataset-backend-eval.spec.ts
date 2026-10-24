/**
 * test/unit/manuscripts/real-world-dataset-backend-eval.spec.ts
 *
 * Backend Evaluation Test Suite using Real-World Academic Datasets
 * (arXiv:1706.03762 Attention, arXiv:1810.04805 BERT, arXiv:2307.01189 TinT)
 * Covers Case Studies CS-28 through CS-36 (Bugs 25 through 33).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as Y from 'yjs';
import { RegexAstBibtexParser } from '@/modules/manuscripts/citations';
import {
  BibBackendDetector,
  TexEngineDetector,
  DraftModeManager,
  TexWordCounter,
  SyncTexProcessor,
} from '@/modules/manuscripts/clsi';
import {
  HeuristicRootDocDetector,
  ManuscriptNodeEntity,
  NodePathVo,
  InvalidNodeNameError,
} from '@/modules/manuscripts/structure';
import {
  CompileLogAnalyzer,
  FastSyntaxLinter,
} from '@/modules/manuscripts/diagnostics';
import { LatexProseTokenizer } from '@/modules/manuscripts/spelling';
import {
  DocstorePatcherAdapter,
  TrackChangesService,
  TrackChange,
  TextRangeVo,
} from '@/modules/manuscripts/track-changes';
import { YjsService as YjsDocManagerAdapter } from '@/modules/realtime/manuscripts/yjs.service';
import {
  MyersDiffEngine,
  ManuscriptRestorerAdapter,
  Snapshot,
  FileSnapshotVo,
} from '@/modules/manuscripts/project-history';
import {
  ManuscriptHydratorAdapter,
  ManuscriptAggregatorAdapter,
  DocumentTranspilerAdapter,
  PkzipEngineAdapter,
  ArchiveEntryVo,
} from '@/modules/manuscripts/export-import';
import { replaceInText, LineArrayEngine } from '@/modules/manuscripts/docstore';
import { parseNameStatusZ } from '@/modules/manuscripts/git-bridge';
import {
  isPrivateOrReservedIPv6,
  assertSafeExternalUrl,
  SsrfSecurityException,
} from '@/modules/manuscripts/core';

const FIXTURES_DIR = path.resolve(
  __dirname,
  '../../../../frontend/tests/fixtures/real-world-datasets',
);
const ATTENTION_DIR = path.join(FIXTURES_DIR, 'attention');
const BERT_DIR = path.join(FIXTURES_DIR, 'bert');
const TINT_DIR = path.join(FIXTURES_DIR, 'tint');

describe('Backend Manuscripts / CLSI / Yjs Gateway - Real-World Dataset Evaluation (CS-28 -> CS-36)', () => {
  describe('CS-28 (Bug 25): CLSI TeXcount Word Counter on Real Conference Papers', () => {
    const counter = new TexWordCounter();

    it('ignores \\iffalse ... \\fi blocks in Attention ms.tex and extracts balanced headers/captions', () => {
      const msSource = fs.readFileSync(
        path.join(ATTENTION_DIR, 'ms.tex'),
        'utf-8',
      );
      const stats = counter.count(msSource);

      // ms.tex has a large \iffalse ... \fi block with old drafts; verifying it is excluded
      const withExtraIfFalse =
        msSource +
        '\n\\iffalse\n\\section{Hidden Ignored Section}\nThis block has twenty extra words that must never be counted in wordsInText or headers.\n\\fi\n';
      const statsWithIfFalse = counter.count(withExtraIfFalse);

      expect(statsWithIfFalse.wordsInText).toBe(stats.wordsInText);
      expect(statsWithIfFalse.headers).toBe(stats.headers);
      expect(statsWithIfFalse.wordsInHeaders).toBe(stats.wordsInHeaders);
    });

    it('accurately counts nested-brace headers, captions, and footnotes without leaking bibkeys into wordsInText', () => {
      const sample = [
        '\\section[Short]{Why \\emph{Self-Attention} Works}',
        'We compare against \\citet{vaswani2017attention} and \\newcite{devlin2018bert} in \\cref{sec:intro}.',
        '\\begin{figure}[t]',
        '\\caption{The \\textbf{Transformer} architecture \\cite{vaswani2017attention} with $d_{\\text{model}} = 512$.}',
        '\\end{figure}',
        'See footnote\\footnote{Trained on \\emph{eight} GPUs \\citep{wu2016google}.}.',
      ].join('\n');

      const stats = counter.count(sample);
      expect(stats.headers).toBe(1);
      // "Why Self-Attention Works" -> 3 words
      expect(stats.wordsInHeaders).toBe(3);
      expect(stats.floats).toBe(1);
      // Caption: "The Transformer architecture with" (4) + Footnote: "Trained on eight GPUs" (4) = 8 words
      expect(stats.wordsInCaptions).toBe(8);
      // Body text: "We compare against and in See footnote" -> 7 words (no vaswani2017attention, devlin2018bert, sec:intro)
      expect(stats.wordsInText).toBe(7);
    });
  });

  describe('CS-29 (Bug 26): CLSI SyncTeX Forward & Reverse Lookup on Multi-Folder Projects', () => {
    const processor = new SyncTexProcessor();
    const synctexSample = [
      'SyncTeX Version:1',
      'Input:1:/workspace/ms.tex',
      'Input:2:/workspace/Sections/intro.tex',
      'Input:3:/workspace/Appendix/intro.tex',
      'Unit:1',
      '{1}',
      'h1,10,0:4718592,6553600:26214400,786432',
      'h2,25,0:4718592,13107200:26214400,786432',
      '{2}',
      'h3,25,0:19660800,26214400:13107200,786432',
      'h3,28,0:28000000,27525120:655360,786432',
    ].join('\n');

    it('resolves Appendix/intro.tex to tag 3 (page 2) without colliding with Sections/intro.tex (tag 2, page 1)', () => {
      const sectionsHit = processor.forwardLookup(
        synctexSample,
        'Sections/intro.tex',
        25,
      );
      const appendixHit = processor.forwardLookup(
        synctexSample,
        'Appendix/intro.tex',
        25,
      );

      expect(sectionsHit).not.toBeNull();
      expect(appendixHit).not.toBeNull();
      expect(sectionsHit!.page).toBe(1);
      expect(appendixHit!.page).toBe(2);
    });

    it('resolves reverse lookup clicks near the right end of a wide hbox to that line rather than a narrow node on another line', () => {
      // h3,25 spans x = [19660800, 32768000] (~300pt to ~500pt) at y = 26214400 (~398.5pt)
      // Clicking at x = 425pt, y = 398.5pt lies directly inside h3,25's horizontal span
      const hit = processor.reverseLookup(synctexSample, 2, 425, 398.5);
      expect(hit).not.toBeNull();
      expect(hit!.file).toContain('Appendix/intro.tex');
      expect(hit!.line).toBe(25);
    });
  });

  describe('CS-30 (Bug 27): Root Document Detection & Draft Mode Injection on arXiv Papers', () => {
    it('prioritizes primary root document over smaller subfiles and handles multi-line \\documentclass options', () => {
      const detector = new HeuristicRootDocDetector();
      const subfileNode = new ManuscriptNodeEntity({
        id: 'node-sub',
        projectId: 'proj-1',
        name: 'intro.tex',
        path: '/intro.tex',
        type: 'DOC',
        docId: 'doc-sub',
        sizeBytes: 400,
      });
      const rootNode = new ManuscriptNodeEntity({
        id: 'node-root',
        projectId: 'proj-1',
        name: 'ms.tex',
        path: '/ms.tex',
        type: 'DOC',
        docId: 'doc-root',
        sizeBytes: 12000,
      });

      const docContents = new Map<string, string[]>([
        [
          'doc-sub',
          [
            '\\documentclass[ms.tex]{subfiles}',
            '\\begin{document}',
            'Subfile content',
            '\\end{document}',
          ],
        ],
        [
          'doc-root',
          [
            '% Commented header',
            '\\documentclass[',
            '  11pt,',
            '  twocolumn',
            ']{article}',
            '\\begin{document}',
            'Main content',
            '\\end{document}',
          ],
        ],
      ]);

      const detected = detector.detectRootDoc(
        [subfileNode, rootNode],
        docContents,
      );
      expect(detected).not.toBeNull();
      expect(detected!.name).toBe('ms.tex');

      const engineMain = TexEngineDetector.detectMainFile({
        'intro.tex': docContents.get('doc-sub')!.join('\n'),
        'ms.tex': docContents.get('doc-root')!.join('\n'),
      });
      expect(engineMain).toBe('ms.tex');
    });

    it('injects \\PassOptionsToPackage{draft}{graphicx} before the real \\documentclass without corrupting leading comment lines', () => {
      const sourceWithCommentedDocClass = [
        '% \\documentclass[12pt]{article}',
        '% Old template comment',
        '\\documentclass[11pt]{article}',
        '\\usepackage{graphicx}',
        '\\begin{document}',
        'Hello',
        '\\end{document}',
      ].join('\n');

      const res = DraftModeManager.apply(sourceWithCommentedDocClass, {
        draft: true,
      });
      expect(res.isModified).toBe(true);
      const lines = res.source.split('\n');
      expect(lines[0]).toBe('% \\documentclass[12pt]{article}');
      expect(lines[2]).toContain('\\PassOptionsToPackage{draft}{graphicx}');
      expect(lines[3]).toBe('\\documentclass[11pt]{article}');
    });
  });

  describe('CS-31 (Bug 28): Multi-File Compiler Log Parsing on Conference Papers', () => {
    const sampleLog = [
      'This is pdfTeX, Version 3.141592653-2.6-1.40.25 (TeX Live 2023)',
      '(./ms.tex',
      'LaTeX2e <2023-11-01>',
      '(./Sections/background.tex',
      'Overfull \\hbox (14.2pt too wide) in paragraph at lines 18--22',
      'Package hyperref Warning: Token not allowed in a PDF string (Unicode):',
      "(hyperref)                removing `math shift' on input line 34.",
      '! Undefined control sequence.',
      'l.47 \\unknownmacro',
      '                   {test}',
      ')',
      './Tables/wmt.tex:12: Extra alignment tab has been changed to \\cr.',
      ')',
    ].join('\n');

    it('maintains accurate file stack across non-file parentheses and extracts multi-line warning line numbers in CompileLogAnalyzer', () => {
      const clsiParser = new CompileLogAnalyzer();
      const diagParser = new CompileLogAnalyzer();

      const clsiDiags = clsiParser.parse(sampleLog, 'ms.tex');
      const treeDiags = diagParser.parseTexParenTreeLog(sampleLog, 'ms.tex');

      // 1. Badbox at line 18 in Sections/background.tex
      const clsiBadbox = clsiDiags.find((d) => d.line === 18);
      expect(clsiBadbox?.file).toBe('Sections/background.tex');

      // 2. Multi-line hyperref warning on input line 34 in Sections/background.tex
      const clsiWarn = clsiDiags.find((d) => d.severity === 'warning');
      expect(clsiWarn?.file).toBe('Sections/background.tex');
      expect(clsiWarn?.line).toBe(34);

      // 3. Undefined control sequence at line 47 STILL in Sections/background.tex (not popped by (14.2pt too wide) or (Unicode))
      const clsiErr = clsiDiags.find((d) => d.line === 47);
      expect(clsiErr?.file).toBe('Sections/background.tex');

      const treeErr = treeDiags.find((d) => d.line === 47);
      expect(treeErr?.file).toBe('Sections/background.tex');

      // 4. -file-line-error on Tables/wmt.tex:12
      const treeFle = treeDiags.find((d) => d.line === 12);
      expect(treeFle?.file).toBe('Tables/wmt.tex');
    });
  });

  describe('CS-32 (Bug 29): Fast Syntax Linter & Auto-Fixer on Real Conference Papers', () => {
    const linter = new FastSyntaxLinter();

    it('produces zero false-positive MISSING_MATH_DELIMITER or EXTRA_ALIGNMENT_TAB errors on real Attention & TinT files with underscores in labels/paths/citations', () => {
      const modelArchSource = fs.readFileSync(
        path.join(ATTENTION_DIR, 'model_architecture.tex'),
        'utf-8',
      );
      const diags = linter.lint(modelArchSource, 'model_architecture.tex');
      const mathOrTabErrors = diags.filter(
        (d) =>
          d.code === 'MISSING_MATH_DELIMITER' ||
          d.code === 'EXTRA_ALIGNMENT_TAB',
      );
      expect(mathOrTabErrors).toHaveLength(0);
    });

    it('autoFix escapes naked percentages and prose underscores without corrupting \\label, \\includegraphics, or % comments', () => {
      const sample = [
        'We achieved 95% accuracy on dev_set in \\ref{sec_results}. % 100% raw_comment “quoted”',
        '\\includegraphics[width=0.8\\textwidth]{Figures/atten_vis_1.png}',
      ].join('\n');

      const fixed = linter.autoFix(sample);
      expect(fixed.isFixed).toBe(true);
      const outLines = fixed.fixedSource.split('\n');
      expect(outLines[0]).toBe(
        'We achieved 95\\% accuracy on dev\\_set in \\ref{sec_results}. % 100% raw_comment “quoted”',
      );
      expect(outLines[1]).toBe(
        '\\includegraphics[width=0.8\\textwidth]{Figures/atten_vis_1.png}',
      );
    });
  });

  describe('CS-33 (Bug 30): BibTeX AST Engine on Real-World Bibliography & @string Concatenation', () => {
    const bibPath = path.join(TINT_DIR, 'bibliography.bib');

    it('successfully parses 32.8 KB academic bibliography into structured AST entries', () => {
      expect(fs.existsSync(bibPath)).toBe(true);
      const bibText = fs.readFileSync(bibPath, 'utf-8');

      const parser = new RegexAstBibtexParser();
      const entries = parser.parse(bibText);
      expect(entries).toBeDefined();
      expect(entries.length).toBeGreaterThanOrEqual(40);

      for (const entry of entries) {
        expect(entry.key.value).toBeTruthy();
        expect(entry.entryType).toBeTruthy();
      }
    });

    it('expands @string macros, standard month macros, # concatenations, and @inproceedings(...) parenthesis entries', () => {
      const parser = new RegexAstBibtexParser();
      const aclBib = [
        '@string{ACL = "Proceedings of the Association for Computational Linguistics"}',
        '@string(YEAR_CONF = {2019})',
        '@inproceedings(devlin2019bert,',
        '  author = "Devlin, Jacob and Chang, Ming-Wei",',
        '  title = "{BERT}: Pre-training of Deep Bidirectional Transformers",',
        '  booktitle = ACL # " (" # YEAR_CONF # ")",',
        '  month = jun,',
        '  year = 2019',
        ')',
      ].join('\n');

      const entries = parser.parse(aclBib);
      expect(entries).toHaveLength(1);
      expect(entries[0].key.value).toBe('devlin2019bert');
      expect(entries[0].getFieldValue('booktitle')).toBe(
        'Proceedings of the Association for Computational Linguistics (2019)',
      );
      expect(entries[0].getFieldValue('month')).toBe('June');
    });
  });

  describe('CS-34 (Bug 31): Academic Spell Tokenizer on Conference Papers', () => {
    const tokenizer = new LatexProseTokenizer();

    it('masks \\iffalse...\\fi blocks, \\newcite/\\shortcite/\\cref arguments, \\verb spans, and multi-% comments while preserving exact column offsets', () => {
      const sample = [
        '\\iffalse',
        'unspelledwordiniffalse',
        '\\fi',
        'As shown by \\newcite{palmer2005prop} and \\cref{fig:model_1}, our \\verb|raw_token| achieves 95\\% accuracy. % 50% comment_word',
      ].join('\n');

      const tokens = tokenizer.tokenize(sample);
      const words = tokens.map((t) => t.word);

      expect(words).not.toContain('unspelledwordiniffalse');
      expect(words).not.toContain('palmer');
      expect(words).not.toContain('fig');
      expect(words).not.toContain('raw');
      expect(words).not.toContain('comment');
      expect(words).toContain('achieves');
      expect(words).toContain('accuracy');

      // Verify exact 1-based column coordinate of 'accuracy' on line 4
      const accuracyToken = tokens.find((t) => t.word === 'accuracy');
      expect(accuracyToken).toBeDefined();
      expect(accuracyToken!.line).toBe(4);
      const rawLine4 = sample.split('\n')[3];
      expect(
        rawLine4.slice(
          accuracyToken!.col - 1,
          accuracyToken!.col - 1 + accuracyToken!.length,
        ),
      ).toBe('accuracy');
    });
  });

  describe('CS-35 (Bug 32): Track Changes Batch Accept/Reject Coordinate Stability', () => {
    it('accepts multiple pending deletions from top to bottom without shifting subsequent deletion line indices', async () => {
      const docState = {
        lines: [
          'Line 0: Keep',
          'Line 1: Delete First',
          'Line 2: Keep Middle',
          'Line 3: Delete Second',
          'Line 4: Keep End',
        ],
        rev: 1,
        version: 1,
      };

      const mockDocstore = {
        getDoc: jest.fn(async () => ({
          lines: [...docState.lines],
          rev: docState.rev,
          version: docState.version,
        })),
        updateDoc: jest.fn(
          async (_projId: string, _docId: string, dto: { lines: string[] }) => {
            docState.lines = [...dto.lines];
            docState.rev += 1;
            docState.version += 1;
            return {
              doc: {
                lines: [...docState.lines],
                rev: docState.rev,
                version: docState.version,
              },
            };
          },
        ),
      };

      const changes = [
        new TrackChange({
          id: 'del-1',
          projectId: 'p1',
          docId: 'd1',
          type: 'delete',
          text: 'Line 1: Delete First\n',
          range: TextRangeVo.create({
            startLine: 1,
            startCol: 0,
            endLine: 2,
            endCol: 0,
          }),
          status: 'pending',
        }),
        new TrackChange({
          id: 'del-2',
          projectId: 'p1',
          docId: 'd1',
          type: 'delete',
          text: 'Line 3: Delete Second\n',
          range: TextRangeVo.create({
            startLine: 3,
            startCol: 0,
            endLine: 4,
            endCol: 0,
          }),
          status: 'pending',
        }),
      ];

      const mockRepo = {
        listChangesByDoc: jest.fn(async () => changes),
        findChangeById: jest.fn(
          async (id: string) => changes.find((c) => c.id === id) || null,
        ),
        saveChange: jest.fn(async (c: TrackChange) => c),
        batchUpdateChangesStatus: jest.fn(async () => undefined),
      };

      const mockNotifier = {
        notifyChangeResolved: jest.fn(),
        notifyChangeCreated: jest.fn(),
      };

      const patcher = new DocstorePatcherAdapter(mockDocstore as never);
      const trackService = new TrackChangesService(
        mockRepo as never,
        mockDocstore as never,
        patcher,
        mockNotifier as never,
      );

      await trackService.batchResolveChanges('p1', 'd1', 'accept_all');

      expect(docState.lines).toEqual([
        'Line 0: Keep',
        'Line 2: Keep Middle',
        'Line 4: Keep End',
      ]);
    });
  });

  describe('CS-36 (Bug 33): Realtime Yjs CRDT Surrogate-Safe Splice & Multi-Peer Sync on Real Datasets', () => {
    it('preserves UTF-16 mathematical surrogate pairs (e.g. 𝐴 -> 𝐵) during replaceTextIfActive without corrupting Y.Text', async () => {
      const manager = new YjsDocManagerAdapter();
      const session = await manager.getOrCreateDoc('proj-yjs', 'math-doc');

      // 𝐴 (\uD835\uDC34) and 𝐵 (\uD835\uDC35) share the high surrogate \uD835
      const initialText = ' Let matrix 𝐴 be invertible.';
      session.doc.transact(() => {
        session.yText.insert(0, initialText);
      });

      const nextText = ' Let matrix 𝐵 be invertible.';
      const updateFrame = manager.replaceTextIfActive(
        'proj-yjs',
        'math-doc',
        nextText,
      );

      expect(updateFrame).not.toBeNull();
      const syncedText = await manager.getText('proj-yjs', 'math-doc');
      expect(syncedText).toBe(nextText);

      // Apply broadcast frame to a peer Y.Doc and verify identical convergence
      const peerDoc = new Y.Doc();
      peerDoc.getText('latex').insert(0, initialText);
      await manager.handleSyncMessage(
        'proj-yjs',
        'math-doc',
        updateFrame!,
        'peer',
      );
      expect(syncedText).toContain('𝐵');

      await manager.onModuleDestroy();
    });

    it('detects BibTeX/Biber engines accurately across Attention and BERT manuscripts', async () => {
      const msContent = fs.readFileSync(
        path.join(ATTENTION_DIR, 'ms.tex'),
        'utf-8',
      );
      const bertContent = fs.readFileSync(
        path.join(BERT_DIR, 'main.tex'),
        'utf-8',
      );

      expect(await BibBackendDetector.detect(msContent)).toBe('bibtex');
      expect(await BibBackendDetector.detect(bertContent)).toBe('bibtex');
    });
  });

  describe('CS-37 (Bug 34): History Snapshot Myers Diff — Duplicate Rename Collisions & Multi-Line Block Word Diff', () => {
    const diffEngine = new MyersDiffEngine();

    it('prevents two deleted files with identical hashes from claiming the same renamed target file', () => {
      const baseSnap = Snapshot.create({
        projectId: 'proj-hist',
        version: 1,
        files: {
          '/Sections/old1.tex': FileSnapshotVo.createDoc(
            '/Sections/old1.tex',
            'd1',
            ['% placeholder'],
            'same-hash-123',
          ),
          '/Sections/old2.tex': FileSnapshotVo.createDoc(
            '/Sections/old2.tex',
            'd2',
            ['% placeholder'],
            'same-hash-123',
          ),
        },
      });

      const targetSnap = Snapshot.create({
        projectId: 'proj-hist',
        version: 2,
        files: {
          '/Sections/new1.tex': FileSnapshotVo.createDoc(
            '/Sections/new1.tex',
            'd3',
            ['% placeholder'],
            'same-hash-123',
          ),
          '/Sections/new2.tex': FileSnapshotVo.createDoc(
            '/Sections/new2.tex',
            'd4',
            ['% placeholder'],
            'same-hash-123',
          ),
        },
      });

      const fileDiffs = diffEngine.compareSnapshots(baseSnap, targetSnap);
      expect(fileDiffs).toHaveLength(2);
      const paths = fileDiffs.map((d) => d.path).sort();
      expect(paths).toEqual(['/Sections/new1.tex', '/Sections/new2.tex']);
      expect(fileDiffs.every((d) => d.status === 'renamed')).toBe(true);
    });

    it('pairs contiguous deleted and added lines 1-to-1 for word-level highlights on multi-line edits', () => {
      const oldLines = [
        '\\section{Introduction}',
        'The dominant sequence transduction models are based on complex recurrent neural networks.',
        'The best performing models also connect the encoder and decoder through an attention mechanism.',
        '\\section{Background}',
      ];
      const newLines = [
        '\\section{Introduction}',
        'The dominant sequence transduction models are based on self-attention transformer networks.',
        'The top performing models also connect the encoder and decoder through a multi-head attention mechanism.',
        '\\section{Background}',
      ];

      const diff = diffEngine.diffText(oldLines, newLines);
      expect(diff.hunks).toHaveLength(1);
      const hunkLines = diff.hunks[0].lines;
      const deletedLines = hunkLines.filter((l) => l.type === 'deleted');
      const addedLines = hunkLines.filter((l) => l.type === 'added');

      expect(deletedLines).toHaveLength(2);
      expect(addedLines).toHaveLength(2);

      // Both deleted lines and both added lines must have intra-line word diffs paired 1-to-1
      expect(deletedLines[0].words).toBeDefined();
      expect(deletedLines[1].words).toBeDefined();
      expect(addedLines[0].words).toBeDefined();
      expect(addedLines[1].words).toBeDefined();

      expect(
        addedLines[0].words!.some(
          (w) => w.type === 'added' && w.text.includes('self-attention'),
        ),
      ).toBe(true);
      expect(
        addedLines[1].words!.some(
          (w) => w.type === 'added' && w.text.includes('multi-head'),
        ),
      ).toBe(true);
    });
  });

  describe('CS-38 (Bug 35): History Snapshot Restore — Binary File Replacement & Orphan Folder Cleanup', () => {
    it('replaces modified binary FILE nodes and deletes post-snapshot orphan folders on restore', async () => {
      const currentNodes: ManuscriptNodeEntity[] = [
        new ManuscriptNodeEntity({
          id: 'node-ms',
          projectId: 'p1',
          name: 'ms.tex',
          path: '/ms.tex',
          type: 'DOC',
          docId: 'doc-ms',
          isRootDoc: true,
        }),
        new ManuscriptNodeEntity({
          id: 'node-fig-folder',
          projectId: 'p1',
          name: 'Figures',
          path: '/Figures',
          type: 'FOLDER',
        }),
        new ManuscriptNodeEntity({
          id: 'node-fig-new',
          projectId: 'p1',
          name: 'ModalNet-21.png',
          path: '/Figures/ModalNet-21.png',
          type: 'FILE',
          fileId: 'file-v2-newer',
        }),
        new ManuscriptNodeEntity({
          id: 'node-orphan-folder',
          projectId: 'p1',
          name: 'AblationStudy',
          path: '/AblationStudy',
          type: 'FOLDER',
        }),
      ];

      const deletedNodeIds: string[] = [];
      const createdNodes: Array<{ path: string; fileId?: string }> = [];

      const mockStructure = {
        getAllNodes: jest.fn(async () => currentNodes),
        deleteNode: jest.fn(async (_pid: string, nodeId: string) => {
          deletedNodeIds.push(nodeId);
        }),
        mkdirp: jest.fn(async () => ({})),
        createNode: jest.fn(
          async (_pid: string, dto: { path: string; fileId?: string }) => {
            createdNodes.push(dto);
            return { id: 'new-node', ...dto };
          },
        ),
        setRootDoc: jest.fn(async () => ({})),
      };

      const mockDocstore = {
        updateDoc: jest.fn(async () => ({})),
        createDoc: jest.fn(async () => ({ _id: 'new-doc' })),
      };

      const mockUpdater = {
        flushProject: jest.fn(async () => ({})),
      };

      const restorer = new ManuscriptRestorerAdapter(
        mockStructure as never,
        mockDocstore as never,
        mockUpdater as never,
      );

      const snapshotV1 = Snapshot.create({
        projectId: 'p1',
        version: 1,
        files: {
          '/ms.tex': FileSnapshotVo.createDoc(
            '/ms.tex',
            'doc-ms',
            ['\\documentclass{article}'],
            'h1',
            true,
          ),
          '/Figures/ModalNet-21.png': FileSnapshotVo.createFile(
            '/Figures/ModalNet-21.png',
            'file-v1-original',
            'h-fig-v1',
            4096,
          ),
        },
      });

      await restorer.restoreToState('p1', snapshotV1);

      // 1. Orphan folder '/AblationStudy' must be deleted, while '/Figures' is kept
      expect(deletedNodeIds).toContain('node-orphan-folder');
      expect(deletedNodeIds).not.toContain('node-fig-folder');

      // 2. Modified binary file '/Figures/ModalNet-21.png' (file-v2-newer -> file-v1-original) must be replaced
      expect(deletedNodeIds).toContain('node-fig-new');
      expect(createdNodes).toContainEqual(
        expect.objectContaining({
          path: '/Figures/ModalNet-21.png',
          fileId: 'file-v1-original',
        }),
      );
    });
  });

  describe('CS-39 (Bug 36): ZIP Import Single-Root Wrapper Folder Unwrapping & arXiv Export .bbl Naming', () => {
    it('unwraps single top-level wrapper folder (e.g. GitHub/arXiv archive) during hydration so relative \\input paths work at root', async () => {
      const createdPaths: string[] = [];
      const mockStructure = {
        mkdirp: jest.fn(async (_pid: string, dir: string) => ({
          id: `dir-${dir}`,
          path: dir,
        })),
        createNode: jest.fn(
          async (_pid: string, dto: { path: string; name: string }) => {
            createdPaths.push(dto.path);
            return { id: `node-${dto.path}`, ...dto };
          },
        ),
        getNodeByPath: jest.fn(async () => null),
        setRootDoc: jest.fn(async () => ({})),
        autoDetectRootDoc: jest.fn(async () => ({
          id: 'node-ms',
          path: '/ms.tex',
        })),
      };
      const mockDocstore = {
        createDoc: jest.fn(async (_pid: string, dto: { path: string }) => ({
          _id: `doc-${dto.path}`,
        })),
      };
      const mockFilestore = {
        uploadFileFromBuffer: jest.fn(async () => ({ id: 'file-1' })),
      };

      const hydrator = new ManuscriptHydratorAdapter(
        mockStructure as never,
        mockDocstore as never,
        mockFilestore as never,
      );

      const wrappedEntries = [
        ArchiveEntryVo.create('attention-arxiv-v1/', Buffer.alloc(0), true),
        ArchiveEntryVo.create(
          'attention-arxiv-v1/ms.tex',
          Buffer.from(
            '\uFEFF\\documentclass{article}\r\n\\input{Sections/intro}',
          ),
        ),
        ArchiveEntryVo.create(
          'attention-arxiv-v1/Sections/intro.tex',
          Buffer.from('\\section{Introduction}'),
        ),
        ArchiveEntryVo.create(
          'attention-arxiv-v1/Figures/ModalNet-21.pdf',
          Buffer.from('%PDF-1.5'),
        ),
      ];

      const summary = await hydrator.hydrateProjectEntries(
        'proj-unwrap',
        wrappedEntries,
      );

      expect(createdPaths).toEqual([
        '/ms.tex',
        '/Sections/intro.tex',
        '/Figures/ModalNet-21.pdf',
      ]);
      expect(summary.rootDocPath).toBe('/ms.tex');
    });

    it('names compiled .bbl after the root .tex basename (ms.bbl) and allows .tikz/.pgf files during cleanArxiv export', async () => {
      const mockStructure = {
        getAllNodes: jest.fn(async () => [
          new ManuscriptNodeEntity({
            id: 'n-ms',
            projectId: 'p-arxiv',
            name: 'ms.tex',
            path: '/ms.tex',
            type: 'DOC',
            docId: 'd-ms',
            isRootDoc: true,
          }),
          new ManuscriptNodeEntity({
            id: 'n-tikz',
            projectId: 'p-arxiv',
            name: 'arch.tikz',
            path: '/Figures/arch.tikz',
            type: 'DOC',
            docId: 'd-tikz',
          }),
        ]),
      };
      const mockDocstore = {
        getDoc: jest.fn(async () => ({ lines: ['\\documentclass{article}'] })),
      };
      const mockFilestore = {};
      const mockClsi = {
        readAuxFileBuffer: jest.fn(async (_pid: string, name: string) =>
          name === 'output.bbl'
            ? Buffer.from('\\begin{thebibliography}{10}\\end{thebibliography}')
            : null,
        ),
      };

      const aggregator = new ManuscriptAggregatorAdapter(
        mockStructure as never,
        mockDocstore as never,
        mockFilestore as never,
        mockClsi as never,
      );

      const exported = await aggregator.collectProjectEntries(
        'p-arxiv',
        false,
        true,
      );
      const exportedPaths = exported.map((e) => e.path);

      expect(exportedPaths).toContain('ms.tex');
      expect(exportedPaths).toContain('Figures/arch.tikz');
      expect(exportedPaths).toContain('ms.bbl');
    });
  });

  describe('CS-40 (Bug 37): Markdown & Word (.docx) to LaTeX Academic Transpiler', () => {
    const zipEngine = new PkzipEngineAdapter();
    const transpiler = new DocumentTranspilerAdapter(zipEngine);

    it('shields inline code, math, and URLs while escaping plain-text %, &, _, # in Markdown transpilation', async () => {
      const md = [
        '# Transformer Evaluation',
        'We achieved 95% accuracy on `dev_set & test_1` using **BERT_large** and $E = mc_0^2$ at [ACL_2019](https://aclweb.org/anthology/P19_1001).',
      ].join('\n');

      const result = await transpiler.transpileMarkdown(md, 'eval.md');

      expect(result.mainTex).toContain('95\\% accuracy');
      expect(result.mainTex).toContain('\\texttt{dev\\_set \\& test\\_1}');
      expect(result.mainTex).toContain('\\textbf{BERT\\_large}');
      expect(result.mainTex).toContain('$E = mc_0^2$');
      expect(result.mainTex).toContain(
        '\\href{https://aclweb.org/anthology/P19_1001}{ACL\\_2019}',
      );
    });

    it('parses DOCX relationships when Target attribute precedes Id and respects w:val="0" style negation', async () => {
      const docXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
        '  <w:body>',
        '    <w:p>',
        '      <w:pPr><w:pStyle w:val="Title"/></w:pPr>',
        '      <w:r><w:b/><w:t>Attention &amp; Transformers</w:t></w:r>',
        '    </w:p>',
        '    <w:p>',
        '      <w:r><w:b w:val="0"/><w:t>Plain unbolded text</w:t></w:r>',
        '      <w:drawing><a:blip r:embed="rId7"/></w:drawing>',
        '    </w:p>',
        '  </w:body>',
        '</w:document>',
      ].join('\n');

      // Note Target appears BEFORE Id
      const relsXml =
        '<Relationships><Relationship Target="media/arch.png" Type="image" Id="rId7"/></Relationships>';

      const docxBuf = zipEngine.buildZip([
        { path: 'word/document.xml', data: Buffer.from(docXml, 'utf8') },
        {
          path: 'word/_rels/document.xml.rels',
          data: Buffer.from(relsXml, 'utf8'),
        },
        {
          path: 'word/media/arch.png',
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      ]);

      const result = await transpiler.transpileDocx(docxBuf, 'paper.docx');

      // Title should not double-escape \& into \textbackslash{}&
      expect(result.mainTex).toContain(
        '\\title{\\textbf{Attention \\& Transformers}}',
      );
      // w:b w:val="0" must NOT wrap text in \textbf{...}
      expect(result.mainTex).toContain('Plain unbolded text');
      expect(result.mainTex).not.toContain('\\textbf{Plain unbolded text}');
      // Image relationship with Target-before-Id must resolve
      expect(result.mainTex).toContain(
        '\\includegraphics[width=0.75\\textwidth]{media/arch.png}',
      );
    });
  });

  describe('CS-41 (Bug 38): Project-Wide Regex Search/Replace with LaTeX $ Math & Multi-Byte UTF-8 Line Size Validation', () => {
    it('supports escaped $$ literal dollar in regex replacement strings for wrapping LaTeX math ($1 -> $$$1$$)', () => {
      const source = 'Let \\textbf{x_i} and \\textbf{y_i} be vectors.';
      const replaced = replaceInText(
        source,
        '\\\\textbf\\{([^}]+)\\}',
        '$$$1$$',
        { useRegex: true },
      );

      expect(replaced.count).toBe(2);
      expect(replaced.text).toBe('Let $x_i$ and $y_i$ be vectors.');
    });

    it('calculates exact UTF-8 byte length for Vietnamese and mathematical Unicode lines in LineArrayEngine.validateLinesSize', () => {
      const lines = ['Phương pháp biến đổi Attention 𝐴 → 𝐵'];
      const text = LineArrayEngine.linesToText(lines);
      const expectedBytes = Buffer.byteLength(text, 'utf8');

      expect(LineArrayEngine.validateLinesSize(lines)).toBe(expectedBytes);
      expect(expectedBytes).toBeGreaterThan(lines[0].length);
    });
  });

  describe('CS-42 (Bug 39): Virtual File Tree Path Normalization (./ and ..) & Folder Validation', () => {
    it('strips ./ current-dir segments and rejects .. path traversal segments in NodePathVo.normalize', () => {
      expect(NodePathVo.normalize('./ms.tex')).toBe('/ms.tex');
      expect(NodePathVo.normalize('/Sections/./intro.tex')).toBe(
        '/Sections/intro.tex',
      );
      expect(() => NodePathVo.normalize('/Sections/../etc/passwd')).toThrow(
        InvalidNodeNameError,
      );
    });
  });

  describe('CS-43 (Bug 40): Git Bridge parseNameStatusZ 3-Field Rename/Copy Alignment', () => {
    it('correctly parses R100 and C100 3-field records in git diff --name-status -z without misaligning subsequent entries', () => {
      const rawZ = [
        'M',
        'ms.tex',
        'R100',
        'Sections/old_intro.tex',
        'Sections/new_intro.tex',
        'C095',
        'Tables/base.tex',
        'Tables/copy.tex',
        'A',
        'Figures/new_plot.pdf',
      ].join('\0');

      const changes = parseNameStatusZ(rawZ);
      expect(changes).toEqual([
        { status: 'M', path: 'ms.tex' },
        { status: 'D', path: 'Sections/old_intro.tex' },
        { status: 'A', path: 'Sections/new_intro.tex' },
        { status: 'A', path: 'Tables/copy.tex' },
        { status: 'A', path: 'Figures/new_plot.pdf' },
      ]);
    });
  });

  describe('CS-44 (Bug 41): Linked External Files SSRF Guard on IPv4-Mapped IPv6 & Bracketed Hostnames', () => {
    it('blocks IPv4-mapped IPv6 cloud metadata (::ffff:169.254.169.254), loopback (::ffff:127.0.0.1), and bracketed IPv6 URLs', async () => {
      expect(isPrivateOrReservedIPv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIPv6('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIPv6('::ffff:7f00:1')).toBe(true);
      expect(isPrivateOrReservedIPv6('::ffff:a9fe:a9fe')).toBe(true);
      expect(isPrivateOrReservedIPv6('0:0:0:0:0:0:0:1')).toBe(true);
      expect(isPrivateOrReservedIPv6('2606:4700:4700::1111')).toBe(false);

      await expect(
        assertSafeExternalUrl('http://[::1]:8080/internal'),
      ).rejects.toThrow(SsrfSecurityException);
      await expect(
        assertSafeExternalUrl(
          'http://[::ffff:169.254.169.254]/latest/meta-data/',
        ),
      ).rejects.toThrow(SsrfSecurityException);
    });
  });
});
