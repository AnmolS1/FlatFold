#!/usr/bin/env bash
# One trial of the Mac audio-loader experiment, with the protocol enforced.
#
#   scripts/audio-trial.sh <condition> <trial-n>
#
# WHY THIS EXISTS: the media loader pool is system-wide and reclaimed over
# MINUTES, while a build-and-relaunch cycle is ~2 minutes. So the natural rhythm
# of this work measures an exhausted pool — and an exhausted pool fails totally,
# which is indistinguishable from every hypothesis anyone has proposed. Three
# rounds of conclusions were void for exactly that reason. The cooldown gate
# below is the single most important line in this harness.
#
# The condition is a LAUNCH ARGUMENT, so one build serves every condition and a
# trial costs a cooldown rather than a rebuild.
set -euo pipefail

cd "$(dirname "$0")/.."
CONDITION="${1:?usage: audio-trial.sh <condition> <trial-n>}"
TRIAL="${2:?usage: audio-trial.sh <condition> <trial-n>}"

COOLDOWN=${COOLDOWN:-900}          # seconds; generous vs the ~5 min observed
SETTLE=${SETTLE:-140}               # unlock + open chat + condition, after a slow boot
APP="ios/App/build/DDcat/Build/Products/Debug-maccatalyst/App.app"
STAMP=".audio-last-quit"           # gitignored: machine state, not source
OUT="docs/redesign/verify/audio-trials.jsonl"

[ -d "$APP" ] || { echo "no build at $APP — build first" >&2; exit 1; }

# --- Cooldown gate -----------------------------------------------------------
if [ -f "$STAMP" ]; then
  elapsed=$(( $(date +%s) - $(cat "$STAMP") ))
  if [ "$elapsed" -lt "$COOLDOWN" ]; then
    remain=$(( COOLDOWN - elapsed ))
    echo "cooldown: ${remain}s remaining (elapsed ${elapsed}s of ${COOLDOWN}s)"
    sleep "$remain"
  fi
fi
SINCE_QUIT=$([ -f "$STAMP" ] && echo $(( $(date +%s) - $(cat "$STAMP") )) || echo -1)

# --- Launch ------------------------------------------------------------------
osascript -e 'quit app "App"' >/dev/null 2>&1 || true
sleep 3
pkill -f "Debug-maccatalyst/App.app" 2>/dev/null || true
sleep 1

START=$(date +%s)
# DEBUG-only test credential, read from .env at run time and never echoed.
# The UI-automation unlock is unreliable under the runner (see audio-unlock.sh);
# the probe does it from the DOM instead, which is the one actor that works.
PW=$(grep -m1 '^DISCOINFERNO_PROD_PASSWORD=' .env 2>/dev/null | cut -d= -f2- | sed 's/^"//; s/"$//')
open -n "$APP" --args --audio-experiment="$CONDITION" --trial="$TRIAL" --unlock-pw="$PW"
sleep 30

# Unlock, then open the conversation — the keystore gate blocks the chat, and
# with no chat there are no notes, no baseline, and the trial is void.
# Unlock AND open the conversation, both through the accessibility tree. A
# failure here aborts the trial rather than measuring a locked app: a batch that
# silently ran against the unlock gate produced 14 discarded trials in a row.
# Unlock is done BY THE PROBE, from the DOM. The System Events route is not
# used: it worked by hand and failed under the runner, and having two actors
# type into the same gate can only interfere. audio-unlock.sh is kept for
# manual driving only.

sleep "$SETTLE"

# --- Harvest -----------------------------------------------------------------
LINE=$(/usr/bin/log show --start "@$START" --info --debug \
         --predicate 'subsystem == "dev.flatfold"' --style compact 2>/dev/null \
       | grep -o 'FLATFOLD_EXP {.*}' | tail -1 | sed 's/^FLATFOLD_EXP //') || true

osascript -e 'quit app "App"' >/dev/null 2>&1 || true
date +%s > "$STAMP"

if [ -z "${LINE:-}" ]; then
  echo "trial $TRIAL/$CONDITION: NO RESULT (discarded)" >&2
  exit 2
fi

# A trial with no baseline is discarded automatically. A drained pool reports
# appTotal=0 or appReady=0, and reading either as a condition effect is the
# mistake this whole harness exists to prevent.
mkdir -p "$(dirname "$OUT")"
python3 - "$LINE" "$SINCE_QUIT" "$OUT" <<'PY'
import json, sys, subprocess, datetime
line, since, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = json.loads(line)
d["msSinceLastQuit"] = since * 1000 if since >= 0 else None
d["at"] = datetime.datetime.now().isoformat(timespec="seconds")
# Record whether anything else on the machine was holding audio — a system-wide
# pool means another app can starve this one, and that must be visible.
try:
    ps = subprocess.run(["pgrep", "-fl", "com.apple.WebKit.WebContent"],
                        capture_output=True, text=True, timeout=5)
    d["otherWebContent"] = len([l for l in ps.stdout.splitlines() if l.strip()])
except Exception:
    d["otherWebContent"] = None
if not d.get("appTotal"):
    d["discarded"] = "no baseline: app rendered no notes"
elif not d.get("appReady"):
    d["discarded"] = "no baseline: zero app notes loaded (pool likely drained)"
with open(out, "a") as f:
    f.write(json.dumps(d) + "\n")
flag = f"  DISCARDED ({d['discarded']})" if d.get("discarded") else ""
print(f"trial {d['trial']}/{d['condition']}: app={d['appReady']}/{d['appTotal']} "
      f"exp={d['expReady']}/{d['expTotal']} cooldown={since}s{flag}")
PY
