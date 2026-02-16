# Code Grounding -- Semantic Project Context for Geth Consensus

Semantic embedding system that indexes user project code and documents to inject only the most relevant content into each agent's context during Geth Consensus sessions.

---

## Overview

When a user scans their project with `--scan-dir`, the ProjectScanner collects file contents and sends them as `projectContext` in the session creation request. Code Grounding replaces the old `relevantFiles` lookup (where the decomposer LLM guessed which files were relevant) with a **semantic similarity search** using 384-dimensional embeddings.

### How It Works

```
CLI (user machine)                    Server
  |                                     |
  |-- ProjectScanner scans files       |
  |-- POST /geth/sessions ------------>|
  |   { projectContext: JSON }         |
  |                                    |-- SENTINEL scans projectContext (sample)
  |                                    |-- Parse JSON, store in memory
  |                                    |-- CodeGroundingService.buildIndex()
  |                                    |     chunk files -> embed -> store
  |                                    |
  |                                    |-- Per agent round:
  |                                    |     query(taskDescription) -> top 4 chunks
  |                                    |     inject in agent prompt
  |                                    |     track grounding stats
  |                                    |
  |                                    |-- Synthesis:
  |                                    |     grounding boost in authority score
  |                                    |     agents with relevant code ranked higher
  |                                    |
  |                                    |-- Session end: deleteIndex()
```

---

## Architecture

### CodeGroundingService

Pure TypeScript module at `apps/api/src/services/code-grounding.service.ts` (~960 lines). Identical copy at `apps/geth-premium/src/services/code-grounding.service.ts`.

**Key exports:**
- `CodeGroundingService` -- static methods for build, query, cleanup
- `CodeGroundingResult` -- search result type
- `CodeGroundingStats` -- index build statistics

### Embedding Model

All embeddings computed server-side via `MLInferenceService.getEmbedding()` using **all-MiniLM-L6-v2** (ONNX, 384 dimensions). No external API calls -- the model runs locally on the server CPU (~3ms per embedding).

### Memory Management

| Parameter | Value | Notes |
|-----------|-------|-------|
| TTL | 30 min | Aligned with session lifecycle |
| Max indices | 50 | LRU eviction when cap exceeded |
| Memory budget | ~23 MB worst case | 50 * 300 chunks * 384 * 4 bytes |

---

## Chunking Engine

### File Type Detection

| Type | Extensions | Strategy |
|------|-----------|----------|
| Code | .ts, .js, .py, .go, .rs, .java, .rb, .php, .c, .cpp, .h, .cs, .swift, .kt | Language-aware boundary detection |
| Document | .md, .txt, .rst, .pdf, .docx | Heading-based / paragraph fallback |
| Config | .json, .yaml, .yml, .toml, .ini, .conf | Sliding window (50 lines, 10 overlap) |
| Data | .csv, .tsv, .xml | Header chunk + sliding window (40 lines, 5 overlap) |

### Code Chunking

1. Detect language from extension
2. Regex boundary detection per language:
   - **JS/TS**: `function`, `class`, `const/let/var ... =`, `export default`
   - **Python**: `def`, `class`, `async def`
   - **Go**: `func`
   - **Rust**: `pub? fn/struct/impl/enum`
3. First 8 lines = `module_header` chunk
4. Merge small chunks (<10 lines) with next
5. Split large chunks (>80 lines) at empty line boundaries
6. **Never** cut mid-function

### Document Chunking

1. Split on markdown headings (`^#{1,6} `)
2. Fallback: split on double newline (`\n\n`)
3. Merge small paragraphs (<5 lines)
4. Split large sections (>60 lines)
5. **Noise filter**: discard chunks <50 chars, >70% symbols, or >3 repeated lines

### Data Capping

- CSV/XML: max 1000 lines per file, max 50K chars
- Prevents large datasets from consuming memory

---

## Query Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| topK | 4 | ~10K chars max injected into agent context |
| minSimilarity | 0.30 | Filters out low-relevance noise |
| Dynamic floor | 0.28 | Even after priority boost, below 0.28 = discarded |
| Max chars/chunk | 2500 | 4 * 2500 = 10K chars |
| Priority boost | +0.05 | Only P1/P2 security-critical files |
| Embedding text cap | 800 chars | 500 start + 300 end for large chunks |

### Priority Boost

Files classified as P1 (critical security) or P2 (high importance) by ProjectScanner receive a +0.05 similarity boost. This means a security file with raw similarity 0.25 becomes 0.30 and passes the threshold, while a non-critical file at 0.28 stays below. **Design choice**: favor security-relevant content.

---

## Grounding Authority Boost

When agents receive highly relevant code chunks, they get a credibility boost in synthesis:

| Top Similarity | Boost | Effect |
|---------------|-------|--------|
| >= 0.60 | +0.10 | Agent strongly grounded in relevant code |
| >= 0.45 | +0.05 | Agent moderately grounded |
| < 0.45 | 0 | No boost |

This is the 7th factor in the Synthesis Intelligence Engine's authority ranking (the 6 existing factors: Thompson 30%, avgQuality 20%, successRate 15%, calibration 15%, consistency 10%, capabilityQuality 10%).

**Caveat**: High similarity does not equal good reasoning. The boost is intentionally small (+0.05/+0.10 on a 0-1 scale) to avoid overvaluing context relevance vs argument quality.

---

## SENTINEL Integration

`projectContext` is scanned by SENTINEL to detect prompt injection via user project files:

- **Random sampling**: 3 random code chunks (max 2K chars each) are extracted and scanned
- **Random > sequential**: Prevents attackers from hiding injection in the 4th+ file
- **Performance**: Only samples ~6K chars, not the full 200K+ projectContext

---

## CLI: PDF and DOCX Support

Both Legion X and Legion X1 CLIs now support PDF and DOCX files in project scans:

- **PDF**: via `pdf-parse` (dynamic import, text-only -- no OCR for scanned PDFs)
- **DOCX**: via `mammoth` (dynamic import, raw text extraction)
- **Optional dependencies**: `npm install -g pdf-parse mammoth`
- **Graceful fallback**: If not installed, PDF/DOCX files are silently skipped

### Document Priority

| Pattern in filename | Priority |
|--------------------|----------|
| security, auth, policy | P2 (HIGH) |
| architecture, design, spec | P3 (MEDIUM) |
| Other documents | P4 (LOW) |

---

## Fallback Behavior

If semantic search produces no results (no index, or all results below threshold), the system falls back to the legacy `relevantFiles` lookup from the decomposer. This ensures backward compatibility with older clients.

---

## Files

### New (2, identical):
1. `apps/api/src/services/code-grounding.service.ts`
2. `apps/geth-premium/src/services/code-grounding.service.ts`

### Modified (9):
1. `apps/api/src/services/geth-consensus.service.ts` -- buildIndex, 2x query, 2x deleteIndex, cleanup
2. `apps/geth-premium/src/services/geth-premium.service.ts` -- same + dynamic import callback
3. `apps/api/src/services/synthesis-intelligence.service.ts` -- grounding boost in authority
4. `apps/geth-premium/src/services/synthesis-intelligence.service.ts` -- same
5. `apps/api/src/middleware/sentinel.ts` -- projectContext sample scan
6. `apps/api/src/services/index.ts` -- CodeGroundingService export
7. `apps/web/public/cli/legion-x.mjs` -- PDF/DOCX support, async selectSecurityFiles
8. `apps/web/public/cli/legion-x1.mjs` -- same
9. `apps/web/public/cli/install-legion.sh` -- optional dependency note
