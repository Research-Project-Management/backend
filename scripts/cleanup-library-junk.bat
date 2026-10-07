@echo off
echo Cleaning up legacy shims and redundant junk files in library subsystem...

set BASE_DIR=%~dp0..\src\modules\library

:: 1. Ingestion Utils (22 files now living in parsers/, policies/, stages/, providers/)
del /f /q "%BASE_DIR%\ingestion\utils\normalization.policy.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\duplicate.policy.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\reconciliation.policy.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\metadata.policy.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\bibtex.parser.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\ris.parser.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\doi.parser.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\query.classifier.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\identify.stage.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\normalize.stage.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\enrich.stage.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\reconcile.stage.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\match.stage.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\commit.stage.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\crossref.provider.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\arxiv.provider.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\pubmed.provider.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\openalex.provider.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\openlibrary.provider.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\unpaywall.provider.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\url-capture.provider.ts" 2>nul
del /f /q "%BASE_DIR%\ingestion\utils\retraction-scanner.provider.ts" 2>nul

:: 2. Extraction Utils (5 files now living in extractors/)
del /f /q "%BASE_DIR%\extraction\utils\academic-regex.catalog.ts" 2>nul
del /f /q "%BASE_DIR%\extraction\utils\layout-heuristic.extractor.ts" 2>nul
del /f /q "%BASE_DIR%\extraction\utils\mextract.extractor.ts" 2>nul
del /f /q "%BASE_DIR%\extraction\utils\xmp.parser.ts" 2>nul
del /f /q "%BASE_DIR%\extraction\utils\metadata-quality.gate.ts" 2>nul

:: 3. Obsolete legacy core folders
rmdir /s /q "%BASE_DIR%\extraction\core" 2>nul
rmdir /s /q "%BASE_DIR%\catalog\core" 2>nul

echo Done! All redundant files and directories have been completely purged.
