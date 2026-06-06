#!/usr/bin/env bash
# STEP 1 — load each MemBench split ONCE into its own throwaway DB (embeddings
# ON) so every config run afterwards can skip the slow import. Also captures the
# baseline numbers (they're identical across configs). Run this before bench-one.
#
#   ./bench-load.sh                 # all four 10k splits
#   SPLITS="ps-fm" MAXQ=10 ./bench-load.sh
set -uo pipefail

BENCH=/Users/anhdang/Documents/Github/BrainRouter/brainrouter-benchmark
SERVER=/Users/anhdang/Documents/Github/BrainRouter/brainrouter
PORT=3747
URL=http://127.0.0.1:$PORT/mcp
MAXREC=${MAXREC:-3000}
MAXQ=${MAXQ:-30}
SPLITS=${SPLITS:-"ps-fm ps-rm os-fm os-rm"}
LOADENV="$BENCH/envs/.env.benchmark_vector_rrf"   # embeddings on, judge off — import + baselines
STATE="$HOME/.brainrouter-bench"
export NODE_OPTIONS=--max-old-space-size=8192
cd "$BENCH" || exit 1

[ -f "$LOADENV" ] || { echo "ERROR: $LOADENV missing — run ./make-bench-envs.sh first"; exit 1; }
mkdir -p "$STATE"
stamp() { date +%H:%M:%S; }
stop_server() { lsof -ti :$PORT 2>/dev/null | xargs kill 2>/dev/null; for _ in $(seq 1 30); do lsof -ti :$PORT >/dev/null 2>&1 || return 0; sleep 0.5; done; }

echo "============================================================"
echo "[$(stamp)] LOAD  splits=[$SPLITS]  bound=${MAXREC} records / ${MAXQ} queries"
echo "[$(stamp)] (fresh DB per split; baselines captured here too)"
echo "============================================================"

for SP in $SPLITS; do
  SPLIT="membench:$SP:10k"
  DB="$STATE/$SP.db"
  echo ""
  echo "[$(stamp)] ── $SPLIT"
  rm -f "$DB" "$DB-wal" "$DB-shm"
  KEY=$(env BRAINROUTER_MEMORY_DB="$DB" node "$SERVER/scripts/setup-admin.js" \
        --userId bench --email bench@local 2>/dev/null | grep -oE 'br_[a-f0-9]{48}' | head -1)
  if [ -z "$KEY" ]; then echo "[$(stamp)]   ERROR: could not mint key — skipping $SP"; continue; fi
  echo "$KEY" > "$STATE/$SP.key"
  echo "[$(stamp)]   db=$DB   key=${KEY:0:14}…"
  echo "[$(stamp)]   starting loader server (embeddings ON, judge OFF)"
  stop_server
  env BRAINROUTER_ENV_FILE="$LOADENV" BRAINROUTER_MEMORY_DB="$DB" \
      node "$SERVER/dist/index.js" --http --port $PORT > "/tmp/bench-load-$SP.log" 2>&1 &
  curl -s -o /dev/null --retry 90 --retry-delay 1 --retry-connrefused -m 5 -X POST "$URL" >/dev/null 2>&1
  echo "[$(stamp)]   importing ${MAXREC} records + running baselines…"
  env BRAINROUTER_BENCH_MCP_URL="$URL" BRAINROUTER_BENCH_API_KEY="$KEY" BRAINROUTER_BENCH_SYSTEM_ID=_load \
      node dist/index.js memory:retrieval --fixture "$SPLIT" --max-records "$MAXREC" --max-queries "$MAXQ" --progress 2>&1 \
      | grep -E "fixture=|ingesting|results:" || true
  stop_server
  echo "[$(stamp)]   loaded $SP ✓   (baselines:)"
  node print-metrics.mjs baseline-bm25 "$SPLIT"
done

stop_server
echo ""
echo "[$(stamp)] LOAD DONE. Next:  ./bench-one.sh <config>   (or ./bench-all.sh)"
echo "           configs: $(ls envs/.env.benchmark_* 2>/dev/null | sed 's#.*/.env.benchmark_##' | tr '\n' ' ')"
