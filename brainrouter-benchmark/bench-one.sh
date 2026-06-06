#!/usr/bin/env bash
# STEP 2 — benchmark ONE config (one envs/.env.benchmark_<config> file) across
# the loaded splits. Reuses the DB from bench-load.sh (no re-import), so it's
# fast except for judge configs. Verbose: prints the active knobs, the server's
# stage readiness, progress, and the resulting metrics per split.
#
#   ./bench-load.sh                 # once
#   ./bench-one.sh keyword          # then any config
#   ./bench-one.sh judge ps-fm      # one config, one split
#   SPLITS="ps-fm os-fm" ./bench-one.sh reranker
set -uo pipefail

CFG="${1:-}"
shift || true
BENCH=/Users/anhdang/Documents/Github/BrainRouter/brainrouter-benchmark
SERVER=/Users/anhdang/Documents/Github/BrainRouter/brainrouter
PORT=3747
URL=http://127.0.0.1:$PORT/mcp
MAXREC=${MAXREC:-3000}
MAXQ=${MAXQ:-30}
STATE="$HOME/.brainrouter-bench"
export NODE_OPTIONS=--max-old-space-size=8192
cd "$BENCH" || exit 1

if [ -z "$CFG" ]; then
  echo "usage: ./bench-one.sh <config> [splits…]"
  echo "configs: $(ls envs/.env.benchmark_* 2>/dev/null | sed 's#.*/.env.benchmark_##' | tr '\n' ' ')"
  exit 1
fi
ENVF="$BENCH/envs/.env.benchmark_$CFG"
[ -f "$ENVF" ] || { echo "ERROR: no env file $ENVF — run ./make-bench-envs.sh"; exit 1; }
SPLITS="${*:-${SPLITS:-ps-fm ps-rm os-fm os-rm}}"

stamp() { date +%H:%M:%S; }
stop_server() { lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; for _ in $(seq 1 30); do lsof -ti :$PORT >/dev/null 2>&1 || return 0; sleep 0.5; done; }

# Probe a /v1/rerank endpoint the way the server will call it. 0 = usable
# (returns a 'results' array), non-zero = not available.
probe_reranker() { # $1=endpoint $2=key $3=model
  local out
  out=$(curl -s -m 8 "$1" -H "Content-Type: application/json" -H "Authorization: Bearer $2" \
    -d "{\"query\":\"probe\",\"documents\":[\"alpha\",\"beta\"],\"model\":\"$3\",\"top_n\":2}" 2>/dev/null) || return 1
  printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.exit(Array.isArray(j.results)?0:1);}catch{process.exit(1);}})'
}

echo "════════════════════════════════════════════════════════════"
echo "[$(stamp)] CONFIG: $CFG     splits=[$SPLITS]   bound=${MAXREC}rec/${MAXQ}q"
echo "[$(stamp)] env file: $ENVF"
echo "[$(stamp)] active recall knobs:"
grep -E "^(BRAINROUTER_LLM_MODEL|BRAINROUTER_RELEVANCE_JUDGE_ENABLED|BRAINROUTER_RECALL_|BRAINROUTER_RERANKER_(ENDPOINT|MODEL)|BRAINROUTER_EMBEDDING_API_KEY)=" "$ENVF" | sed 's/^/      /'
echo "════════════════════════════════════════════════════════════"

# Pre-flight: if this config declares a reranker, confirm the endpoint really
# reranks. If not, record the config as 'unavailable' rather than benchmarking
# the silent RRF fallback under the reranker label.
FORCE_UNAVAIL=""
RR_KEY=$(grep -E "^BRAINROUTER_RERANKER_API_KEY=.+" "$ENVF" | head -1 | cut -d= -f2-)
if [ -n "${RR_KEY:-}" ]; then
  RR_EP=$(grep -E "^BRAINROUTER_RERANKER_ENDPOINT=" "$ENVF" | head -1 | cut -d= -f2-)
  RR_MODEL=$(grep -E "^BRAINROUTER_RERANKER_MODEL=" "$ENVF" | head -1 | cut -d= -f2-)
  echo "[$(stamp)] reranker config → probing $RR_EP"
  if probe_reranker "$RR_EP" "$RR_KEY" "$RR_MODEL"; then
    echo "[$(stamp)]   reranker endpoint OK ✓"
  else
    FORCE_UNAVAIL="reranker not available — $RR_EP returned no valid /v1/rerank response (skipped, not benchmarked as RRF fallback)"
    echo "[$(stamp)]   ⚠ reranker NOT available — recording this config as 'unavailable' for every split"
  fi
fi

for SP in $SPLITS; do
  SPLIT="membench:$SP:10k"
  DB="$STATE/$SP.db"
  KEYF="$STATE/$SP.key"
  echo ""
  if [ ! -f "$DB" ] || [ ! -f "$KEYF" ]; then
    echo "[$(stamp)] ⚠ $SP not loaded — run ./bench-load.sh first. Skipping."
    continue
  fi
  KEY=$(cat "$KEYF")
  if [ -n "$FORCE_UNAVAIL" ]; then
    echo "[$(stamp)] ── $CFG × $SPLIT — recording 'unavailable' (no server needed)"
    env BRAINROUTER_BENCH_MCP_URL="$URL" BRAINROUTER_BENCH_API_KEY="$KEY" \
        BRAINROUTER_BENCH_SYSTEM_ID="brainrouter-$CFG" BRAINROUTER_BENCH_SKIP_IMPORT=1 \
        BRAINROUTER_BENCH_FORCE_UNAVAILABLE="$FORCE_UNAVAIL" \
        node dist/index.js memory:retrieval --fixture "$SPLIT" --max-records "$MAXREC" --max-queries "$MAXQ" 2>&1 \
        | grep -E "results:" || true
    node print-metrics.mjs "brainrouter-$CFG" "$SPLIT"
    echo "[$(stamp)]   $CFG × $SP → unavailable ✓"
    continue
  fi
  echo "[$(stamp)] ── $CFG × $SPLIT   (reuse loaded DB, skip import)"
  echo "[$(stamp)]   starting server for config '$CFG'"
  stop_server
  env BRAINROUTER_ENV_FILE="$ENVF" BRAINROUTER_MEMORY_DB="$DB" \
      node "$SERVER/dist/index.js" --http --port $PORT > "/tmp/bench-$CFG-$SP.log" 2>&1 &
  curl -s -o /dev/null --retry 90 --retry-delay 1 --retry-connrefused -m 5 -X POST "$URL" >/dev/null 2>&1
  # show which stages the server actually enabled (helps confirm the config took effect)
  grep -E "env: loaded|Reranker|Relevance|judge" "/tmp/bench-$CFG-$SP.log" 2>/dev/null | head -4 | sed 's/^/      server: /'
  echo "[$(stamp)]   querying ${MAXQ} (system id: brainrouter-$CFG)…"
  env BRAINROUTER_BENCH_MCP_URL="$URL" BRAINROUTER_BENCH_API_KEY="$KEY" \
      BRAINROUTER_BENCH_SYSTEM_ID="brainrouter-$CFG" BRAINROUTER_BENCH_SKIP_IMPORT=1 \
      node dist/index.js memory:retrieval --fixture "$SPLIT" --max-records "$MAXREC" --max-queries "$MAXQ" --progress 2>&1 \
      | grep -E "fixture=|brainrouter-$CFG: query (1|$MAXQ)/|results:" || true
  stop_server
  if grep -q "Reranker failed" "/tmp/bench-$CFG-$SP.log" 2>/dev/null; then
    echo "[$(stamp)]   ⚠ reranker fell back to RRF — endpoint is not a compatible /v1/rerank service."
    echo "[$(stamp)]     (LM Studio has no rerank API. Re-generate with RERANKER_ENDPOINT=<vllm/cohere url> bash make-bench-envs.sh)"
  fi
  node print-metrics.mjs "brainrouter-$CFG" "$SPLIT"
  echo "[$(stamp)]   done $CFG × $SP ✓"
done

stop_server
echo ""
echo "[$(stamp)] CONFIG $CFG DONE. Build the report when finished with all configs:"
echo "           node build-comparison-report.mjs > reports/memory-comparison.md"
