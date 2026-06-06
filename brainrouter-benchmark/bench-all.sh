#!/usr/bin/env bash
# Sweep: run EVERY config (envs/.env.benchmark_*) across the splits, then build
# the report. Loads first if needed. This is the "all combinations" run; for a
# single config use ./bench-one.sh <config>.
#
#   ./bench-all.sh
#   SPLITS="ps-fm os-fm" MAXQ=20 ./bench-all.sh
set -uo pipefail
cd "$(dirname "$0")" || exit 1

STATE="$HOME/.brainrouter-bench"
SPLITS=${SPLITS:-"ps-fm ps-rm os-fm os-rm"}
CONFIGS=$(ls envs/.env.benchmark_* 2>/dev/null | sed 's#.*/.env.benchmark_##')
[ -z "$CONFIGS" ] && { echo "no configs — run ./make-bench-envs.sh first"; exit 1; }

echo "configs to run: $(echo "$CONFIGS" | tr '\n' ' ')"
echo "splits: $SPLITS"

# load any split that isn't loaded yet
NEED_LOAD=0
for SP in $SPLITS; do [ -f "$STATE/$SP.key" ] || NEED_LOAD=1; done
if [ "$NEED_LOAD" = "1" ]; then
  echo ">> loading splits first…"
  SPLITS="$SPLITS" ./bench-load.sh
fi

for c in $CONFIGS; do
  SPLITS="$SPLITS" ./bench-one.sh "$c"
done

echo ""
echo "SWEEP DONE. Building report…"
node build-comparison-report.mjs > reports/memory-comparison.md
echo "→ reports/memory-comparison.md"
