# BrainRouter — Scale & Cross-Session Evaluation

**Date:** 2026-05-17T18:08:25.503Z
**Platform:** darwin arm64, Node v22.16.0

## 1. Scale: BrainRouter vs Built-in Memory

Every built-in agent memory (CLAUDE.md, .cursorrules, Cline's memory-bank) loads ALL memory into context every session. BrainRouter searches and returns only relevant results.

| Observations | Sessions | Index Build | FTS5 Search | Hybrid Search | Disk Storage | JS Heap | Context Tokens (built-in) | Context Tokens (BrainRouter) | Savings | Built-in Unreachable |
|-------------|----------|------------|-------------|---------------|--------------|---------|--------------------------|-----------------------------|---------|--------------------|
| 240 | 30 | 60ms | 0.235ms | 0.486ms | 4 KB | 1MB | 10,504 | 450 | 96% | 17% |
| 1,000 | 125 | 405ms | 0.322ms | 1.002ms | 4.3 MB | -1MB | 43,834 | 450 | 99% | 80% |
| 5,000 | 625 | 6364ms | 0.861ms | 3.799ms | 20.6 MB | 7MB | 220,335 | 450 | 100% | 96% |
| 10,000 | 1250 | 25741ms | 1.735ms | 9.693ms | 41.0 MB | 10MB | 440,973 | 450 | 100% | 98% |
| 50,000 | 6250 | 678561ms | 6.493ms | 39.708ms | 203.1 MB | 48MB | 2,216,173 | 450 | 100% | 100% |

### What the numbers mean

**Context Tokens (built-in):** How many tokens Claude Code/Cursor/Cline would consume loading ALL memory into the context window. At 5,000 observations, this is ~250K tokens — exceeding most context windows entirely.

**Context Tokens (BrainRouter):** How many tokens the top-10 search results consume. Stays constant regardless of corpus size.

**Built-in Unreachable:** Percentage of memories that built-in systems CANNOT access because they exceed the 200-line MEMORY.md cap or context window limits. At 1,000 observations, 80% of your project history is invisible.

## 2. Cross-Session Retrieval

Can the system find relevant information from past sessions? This is impossible for built-in memory once observations exceed the line/context cap.

| Query | Target Session | Gap | FTS5 Found | FTS5 Rank | Hybrid Found | Hybrid Rank | Built-in Visible |
|-------|---------------|-----|-----------|-----------|-------------|-------------|-----------------|
| How did we set up OAuth providers? | ses_005-009 | 24 | Yes | #1 | Yes | #1 | Yes |
| What was the N+1 query fix? | ses_010-014 | 18 | Yes | #1 | Yes | #1 | Yes |
| PostgreSQL full-text search setup | ses_010-014 | 17 | Yes | #1 | Yes | #1 | Yes |
| bcrypt password hashing configuration | ses_005-009 | 20 | Yes | #1 | Yes | #1 | Yes |
| Vitest unit testing setup | ses_020-024 | 9 | Yes | #1 | Yes | #1 | Yes |
| webhook retry exponential backoff | ses_015-019 | 14 | Yes | #1 | Yes | #1 | Yes |
| ESLint flat config migration | ses_000-004 | 29 | Yes | #1 | Yes | #1 | Yes |
| Kubernetes HPA autoscaling configuration | ses_025-029 | 4 | Yes | #1 | Yes | #1 | No |
| Prisma database seed script | ses_010-014 | 16 | Yes | #1 | Yes | #1 | Yes |
| API cursor-based pagination | ses_015-019 | 14 | Yes | #1 | Yes | #1 | Yes |
| CSRF protection double-submit cookie | ses_005-009 | 24 | Yes | #1 | Yes | #1 | Yes |
| blue-green deployment rollback | ses_025-029 | 4 | Yes | #1 | Yes | #1 | No |

**Summary:** BrainRouter FTS5 found 12/12 cross-session queries. Hybrid found 12/12. Built-in memory (200-line cap) could only reach 10/12.

## 3. The Context Window Problem

```
Agent context window: ~200K tokens
System prompt + tools:  ~20K tokens
User conversation:      ~30K tokens
Available for memory:  ~150K tokens

At 50 tokens/observation:
  200 observations  =  10,000 tokens  (fits, but 200-line cap hits first)
  1,000 observations =  50,000 tokens  (33% of available budget)
  5,000 observations = 250,000 tokens  (EXCEEDS total context window)

BrainRouter top-10 results:
  Any corpus size     =  ~450 tokens  (0.3% of budget)
```

---
*Scale tests: 5 corpus sizes. Cross-session tests: 12 queries.*