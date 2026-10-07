# PowerShell script to purge all legacy shims and redundant junk files in library subsystem
$baseDir = Join-Path $PSScriptRoot "..\src\modules\library"

Write-Host "Purging redundant junk files from $baseDir..." -ForegroundColor Cyan

# 1. Ingestion Utils (22 files now living in parsers/, policies/, stages/, providers/)
$ingestionJunk = @(
  "ingestion\utils\normalization.policy.ts",
  "ingestion\utils\duplicate.policy.ts",
  "ingestion\utils\reconciliation.policy.ts",
  "ingestion\utils\metadata.policy.ts",
  "ingestion\utils\bibtex.parser.ts",
  "ingestion\utils\ris.parser.ts",
  "ingestion\utils\doi.parser.ts",
  "ingestion\utils\query.classifier.ts",
  "ingestion\utils\identify.stage.ts",
  "ingestion\utils\normalize.stage.ts",
  "ingestion\utils\enrich.stage.ts",
  "ingestion\utils\reconcile.stage.ts",
  "ingestion\utils\match.stage.ts",
  "ingestion\utils\commit.stage.ts",
  "ingestion\utils\crossref.provider.ts",
  "ingestion\utils\arxiv.provider.ts",
  "ingestion\utils\pubmed.provider.ts",
  "ingestion\utils\openalex.provider.ts",
  "ingestion\utils\openlibrary.provider.ts",
  "ingestion\utils\unpaywall.provider.ts",
  "ingestion\utils\url-capture.provider.ts",
  "ingestion\utils\retraction-scanner.provider.ts"
)

foreach ($file in $ingestionJunk) {
  $target = Join-Path $baseDir $file
  if (Test-Path $target) {
    Remove-Item -Path $target -Force
    Write-Host "Deleted: $file" -ForegroundColor Yellow
  }
}

# 2. Extraction Utils (5 files now living in extractors/)
$extractionJunk = @(
  "extraction\utils\academic-regex.catalog.ts",
  "extraction\utils\layout-heuristic.extractor.ts",
  "extraction\utils\mextract.extractor.ts",
  "extraction\utils\xmp.parser.ts",
  "extraction\utils\metadata-quality.gate.ts"
)

foreach ($file in $extractionJunk) {
  $target = Join-Path $baseDir $file
  if (Test-Path $target) {
    Remove-Item -Path $target -Force
    Write-Host "Deleted: $file" -ForegroundColor Yellow
  }
}

# 3. Obsolete legacy core folders
$coreDirs = @(
  "extraction\core",
  "catalog\core"
)

foreach ($dir in $coreDirs) {
  $target = Join-Path $baseDir $dir
  if (Test-Path $target) {
    Remove-Item -Path $target -Recurse -Force
    Write-Host "Removed directory: $dir" -ForegroundColor Red
  }
}

Write-Host "All redundant files purged successfully! Clean state achieved." -ForegroundColor Green
