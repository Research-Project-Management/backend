import { PdfExtractorProvider } from '../../../src/modules/library/attachments/providers/pdf-extractor.provider';

describe('PdfExtractorProvider', () => {
  let provider: PdfExtractorProvider;

  beforeEach(() => {
    provider = new PdfExtractorProvider();
  });

  describe('extractMetadataFromText', () => {
    it('extracts title, authors, doi and abstract from academic paper text', () => {
      const sampleText = `
arXiv:1512.03385v1 [cs.CV] 10 Dec 2015
Deep Residual Learning for Image Recognition
Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun
Microsoft Research
{kahe, xiangz, v-shren, jiansun}@microsoft.com
doi: 10.1109/CVPR.2016.90

Abstract
Deeper neural networks are more difficult to train. We present a residual learning framework.
Keywords: Deep learning, Residual networks, Computer vision
1. Introduction
      `;

      const meta = provider.extractMetadataFromText(sampleText);

      expect(meta.title).toBe('Deep Residual Learning for Image Recognition');
      expect(meta.authors).toEqual([
        'Kaiming He',
        'Xiangyu Zhang',
        'Shaoqing Ren',
        'Jian Sun',
      ]);
      expect(meta.doi).toBe('10.1109/CVPR.2016.90');
      expect(meta.arxivId).toBe('1512.03385v1');
      expect(meta.abstract).toContain(
        'Deeper neural networks are more difficult to train',
      );
      expect(meta.keywords).toEqual([
        'Deep learning',
        'Residual networks',
        'Computer vision',
      ]);
    });

    it('extracts comma-separated authors and title when no DOI is present', () => {
      const sampleText = `
YOLO9000: Better, Faster, Stronger
Joseph Redmon, Ali Farhadi
University of Washington, Allen Institute for AI
http://pjreddie.com/yolo9000/

Abstract
We introduce YOLO9000, a state-of-the-art, real-time object detection system that can detect over 9000 object categories.
      `;

      const meta = provider.extractMetadataFromText(sampleText);

      expect(meta.title).toBe('YOLO9000: Better, Faster, Stronger');
      expect(meta.authors).toEqual(['Joseph Redmon', 'Ali Farhadi']);
      expect(meta.abstract).toContain('We introduce YOLO9000');
    });

    it('extracts authors with footnote markers and space separation', () => {
      const sampleText = `
Attention Is All You Need
Ashish Vaswani*, Noam Shazeer*, Niki Parmar*, Jakob Uszkoreit*
Google Brain, Google Research
Abstract
The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.
      `;

      const meta = provider.extractMetadataFromText(sampleText);

      expect(meta.title).toBe('Attention Is All You Need');
      expect(meta.authors).toEqual([
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
        'Jakob Uszkoreit',
      ]);
    });
  });
});
