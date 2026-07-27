#!/usr/bin/env bash
# A batch of audio trials: repeated, INTERLEAVED, with controls throughout.
#
#   scripts/audio-batch.sh [reps] [condition ...]
#   scripts/audio-batch.sh 5 control click3 batch10
#
# Interleaving is not a nicety. The pool this measures drifts — with time since
# the last run, with whatever else on the machine is holding media. Running all
# of condition A then all of B lets that drift masquerade as a condition effect,
# which is precisely how you get a confident wrong answer. Shuffling means drift
# adds noise instead of bias, and the interleaved `control` runs make the drift
# itself visible: if control moves across a batch, the batch is void.
#
# At the default 15-minute cooldown a 30-trial batch is ~8 hours — one overnight
# run in place of a week of hand-testing, which is the entire argument for this.
set -euo pipefail
cd "$(dirname "$0")/.."

REPS="${1:-5}"; shift || true
CONDITIONS=("${@:-control click3 batch10}")
[ "${#CONDITIONS[@]}" -eq 1 ] && read -ra CONDITIONS <<< "${CONDITIONS[0]}"

# Every rep gets a control, so drift is sampled at the same rate as the effects.
# Only add one if the caller did not already ask for controls, or they get
# double-weighted (which is how the first batch ended up 10 controls to 5 each).
PLAN=()
HAS_CONTROL=no
for c in "${CONDITIONS[@]}"; do [ "$c" = "control" ] && HAS_CONTROL=yes; done
for _ in $(seq 1 "$REPS"); do
  for c in "${CONDITIONS[@]}"; do PLAN+=("$c"); done
  [ "$HAS_CONTROL" = "no" ] && PLAN+=("control")
done

# Shuffle with python3, NOT `sort -R`.
#
# `sort -R` sorts by a random hash OF THE LINE, so identical lines land
# adjacent. On a plan that is by construction a list of repeated condition
# names, it produces perfectly blocked output — `control x10, click3 x5,
# batch10 x5` — which is the precise arrangement interleaving exists to
# prevent. It looks shuffled and is not. Caught in the first live batch.
mapfile -t PLAN < <(printf '%s\n' "${PLAN[@]}" | python3 -c '
import random, sys
lines = [l for l in sys.stdin.read().split("\n") if l]
random.shuffle(lines)
print("\n".join(lines))
')

echo "batch: ${#PLAN[@]} trials, cooldown ${COOLDOWN:-900}s"
echo "estimated wall clock: $(( ${#PLAN[@]} * (${COOLDOWN:-900} + 120) / 3600 ))h"
echo "order: ${PLAN[*]}"
echo

n=0
for c in "${PLAN[@]}"; do
  n=$(( n + 1 ))
  echo "[$n/${#PLAN[@]}] $c"
  # A failed trial must not abort the batch — it is one lost sample, and the
  # analysis reports n per condition so a gap is visible rather than silent.
  scripts/audio-trial.sh "$c" "$n" || echo "  trial failed, continuing" >&2
done

echo
scripts/audio-analyze.py
