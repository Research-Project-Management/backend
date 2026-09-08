-- Add dedicated scalar columns for academic metadata fields previously buried in extraFields JSON blob.
ALTER TABLE "papers" ADD COLUMN IF NOT EXISTS "arxiv_id" TEXT;
ALTER TABLE "papers" ADD COLUMN IF NOT EXISTS "citation_count" INTEGER;
ALTER TABLE "papers" ADD COLUMN IF NOT EXISTS "reference_count" INTEGER;
ALTER TABLE "papers" ADD COLUMN IF NOT EXISTS "influential_citation_count" INTEGER;
ALTER TABLE "papers" ADD COLUMN IF NOT EXISTS "open_access_pdf_url" TEXT;
ALTER TABLE "papers" ADD COLUMN IF NOT EXISTS "tldr" TEXT;
ALTER TABLE "papers" ADD COLUMN IF NOT EXISTS "series_number" TEXT;

-- Backfill from extraFields JSON stored in extra column
UPDATE "papers"
SET
  arxiv_id = COALESCE(arxiv_id, CASE WHEN extra IS NOT NULL AND extra != '' AND extra LIKE '{%' THEN (extra::jsonb->>'arxivId') END),
  citation_count = COALESCE(citation_count, CASE WHEN extra IS NOT NULL AND extra != '' AND extra LIKE '{%' THEN ((extra::jsonb->>'citationCount')::INTEGER) END),
  reference_count = COALESCE(reference_count, CASE WHEN extra IS NOT NULL AND extra != '' AND extra LIKE '{%' THEN ((extra::jsonb->>'referenceCount')::INTEGER) END),
  influential_citation_count = COALESCE(influential_citation_count, CASE WHEN extra IS NOT NULL AND extra != '' AND extra LIKE '{%' THEN ((extra::jsonb->>'influentialCitationCount')::INTEGER) END),
  open_access_pdf_url = COALESCE(open_access_pdf_url, CASE WHEN extra IS NOT NULL AND extra != '' AND extra LIKE '{%' THEN (extra::jsonb->>'openAccessPdfUrl') END),
  tldr = COALESCE(tldr, CASE WHEN extra IS NOT NULL AND extra != '' AND extra LIKE '{%' THEN (extra::jsonb->>'tldr') END),
  series_number = COALESCE(series_number, CASE WHEN extra IS NOT NULL AND extra != '' AND extra LIKE '{%' THEN (extra::jsonb->>'seriesNumber') END)
WHERE extra IS NOT NULL AND extra != '' AND extra LIKE '{%';
