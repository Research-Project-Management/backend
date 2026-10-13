# Empirical Benchmark Report: Legacy (External APIs) vs. Current (Local-First Regex / Zero-API)

*Generated: 21:42:24 12/10/2026*

## 1. Executive Summary

| Test Track | Evaluated Samples | Legacy (External APIs) | Current (Local Regex / Zero-API) | Accuracy Difference |
| :--- | :---: | :---: | :---: | :---: |
| **Links Ingestion** | 100 | **95.3%** (332ms) | **19.9%** (875ms) | **-75.4%** |
| **PDF Paper Ingestion** | 100 | **70.5%** (938ms) | **63.3%** (491ms) | **-7.2%** |
| **Overall Combined** | **200** | **82.9%** | **41.6%** | **-41.3%** |

## 2. In-Depth Metric Breakdown

### A. PDF Paper Ingestion (External API Retrieval vs. Local-First Zero-API Cascade)

| Metric | Legacy (API Query via DOI/Text) | Current (Local Regex / Layout / XMP) | Comparison Insight |
| :--- | :---: | :---: | :--- |
| **Title Token F1** | 78.0% | **81.8%** | Local Layout Heuristic clusters font sizes directly from page |
| **DOI Match Rate** | 62% | **37%** | Academic Regex Catalog scans ISO 26324 patterns offline |
| **Year Match Rate** | 62% | **48%** | Publication date validation |
| **Author Jaccard** | 68.8% | **72.3%** | Footnote & affiliation cleaning |
| **Mean Completeness** | 81.7% | **91.7%** | Quality Gate validation |
| **Average Latency** | 938 ms | **491 ms** | Local-First Zero-API processing speed |

### B. Link Ingestion (Remote API Resolution vs. Direct Embedded Regex)

| Metric | Legacy (CrossRef / OpenAlex API) | Current (Embedded Meta Tag Regex) | Comparison Insight |
| :--- | :---: | :---: | :--- |
| **DOI Match Rate** | 99% | **19%** | Highwire Press & Dublin Core direct regex |
| **Title Accuracy** | 96.9% | **21.2%** | Direct document title vs API record |
| **Average Latency** | 332 ms | **875 ms** | Remote round-trip vs Single HTTP fetch |

## 3. Publisher Domain Breakdown

| Publisher / Domain | Tested | Legacy Acc. | Current Acc. | Legacy WAF Blocks | Current WAF Blocks |
| :--- | :---: | :---: | :---: | :---: | :---: |
| sciencedirect.com | 16 | 97.4% | **0%** | 0 | **0** |
| nature.com | 6 | 98.5% | **49.3%** | 0 | **0** |
| ieeexplore.ieee.org | 6 | 96.5% | **0%** | 0 | **0** |
| onlinelibrary.wiley.com | 6 | 98.5% | **0%** | 0 | **0** |
| dl.acm.org | 6 | 95% | **1.3%** | 0 | **0** |
| journals.plos.org | 6 | 98.5% | **98.2%** | 0 | **0** |
| frontiersin.org | 6 | 97.1% | **32.8%** | 0 | **0** |
| academic.oup.com | 6 | 98.5% | **0%** | 0 | **0** |
| cambridge.org | 6 | 92.1% | **0%** | 0 | **0** |
| biorxiv.org | 6 | 92.3% | **57.9%** | 0 | **0** |
| aclanthology.org | 6 | 96.3% | **0%** | 0 | **0** |
| link.springer.com | 6 | 94.6% | **80.7%** | 0 | **0** |
| arxiv.org | 6 | 78.2% | **11.1%** | 0 | **0** |
| pubmed.ncbi.nlm.nih.gov | 6 | 96.5% | **0%** | 0 | **0** |
| europepmc.org | 6 | 96.5% | **0%** | 0 | **0** |
| Springer Nature | 10 | 85.5% | **74.3%** | 0 | **0** |
| arXiv Open Access | 57 | 62.7% | **47.9%** | 0 | **0** |
| PLOS Open Access | 33 | 79.4% | **86.6%** | 0 | **0** |
