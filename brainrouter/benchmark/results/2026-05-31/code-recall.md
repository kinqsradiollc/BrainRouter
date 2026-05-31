# Code-recall benchmark (chunk symbol isolation)

**Date:** 2026-05-31 · **Harness:** `benchmarkCodeChunking(DEFAULT_CODE_SAMPLES)`
(`brainrouter/src/memory/bench/code-recall.ts`) · pure, no store / LLM / network.

- samples: 3 (TypeScript, Python, Rust)
- expected symbols: 8
- isolated: 8 (**symbol recall 100.0%**)
- chunks per isolated symbol: 1.13 (1.0 ideal)

Reproduce:

```bash
npx tsx -e "import {benchmarkCodeChunking, DEFAULT_CODE_SAMPLES, formatCodeRecallMd} from './brainrouter/src/memory/bench/code-recall.ts'; console.log(formatCodeRecallMd(benchmarkCodeChunking(DEFAULT_CODE_SAMPLES)))"
```
