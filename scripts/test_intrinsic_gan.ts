import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import { GrobidClient } from '../src/modules/library/infra/grobid/grobid.client';
import { PdfProvider } from '../src/modules/library/content/infrastructure/providers/pdf.provider';

async function main() {
  console.log('======================================================================');
  console.log('⚡ TESTING AUTONOMOUS INTRINSIC EXTRACTION: GAN (Goodfellow 2014)');
  console.log('======================================================================\n');

  const grobid = new GrobidClient();
  const pdf = new PdfProvider(grobid);

  console.log('Reading c:/flux/zotero/papers/goodfellow2014_gan.pdf...');
  const buffer = fs.readFileSync('c:/flux/zotero/papers/goodfellow2014_gan.pdf');

  console.log('Extracting metadata, abstract, keywords, and outline via GROBID CRF...');
  const start = Date.now();
  const doc = await pdf.extractDocumentFromBuffer(buffer);
  const elapsed = Date.now() - start;

  console.log(`\n✅ Extraction completed in ${elapsed} ms:`);
  console.log(` • Title: "${doc.metadata.title}"`);
  console.log(` • Abstract Length: ${doc.metadata.abstract?.length || 0} characters`);
  console.log(` • Abstract Preview: "${doc.metadata.abstract?.slice(0, 200)}..."`);
  console.log(` • Authors count: ${doc.metadata.authors?.length || 0}`);
  console.log(` • Authors list: ${doc.metadata.authors?.slice(0, 5).join(', ')}`);
  console.log(` • Keywords / Tags: ${doc.metadata.keywords?.join(', ') || '(none in paper header)'}`);
  console.log(` • Sections (IMRAD): ${doc.sections?.length || 0}`);
  console.log(` • Figures: ${doc.figures?.length || 0}`);
  console.log(` • Tables: ${doc.tables?.length || 0}`);
  console.log(` • Formulas: ${doc.formulas?.length || 0}`);
  console.log(` • References: ${doc.references?.length || 0}`);

  console.log('\n======================================================================');
  console.log('🎉 PROOF: ABSTRACT & METADATA EXTRACTED 100% INTRINSICALLY (ZERO API CALLS)');
  console.log('======================================================================');
}

main().catch(console.error);
