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
PLAN=()
for _ in $(seq 1 "$REPS"); do
  for c in "${CONDITIONS[@]}"; do PLAN+=("$c"); done
  PLAN+=("control")
done
# Shuffle
mapfile -t PLAN < <(printf '%s\n' "${PLAN[@]}" | sort -R)

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
