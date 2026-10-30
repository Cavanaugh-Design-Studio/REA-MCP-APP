#!/usr/bin/env bash
# Full benchmark: 3 arms x 4 tasks x REPS reps, arms run side by side. Appends to results/run.jsonl.
set -euo pipefail
cd "$(dirname "$0")"; REPS="${REPS:-3}"
for r in $(seq 1 "$REPS"); do for t in electron native go deep; do
  for a in none leanrea rea; do python3 -I run.py "$a" "$t" "$r" & done; wait
done; done | tee -a results/run.jsonl
