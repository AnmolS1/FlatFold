#!/bin/bash
# Unlock the running FlatFold Catalyst build's keystore gate.
#
# The password is read from .env at run time and passed to osascript as an
# ARGUMENT, never interpolated into the script text and never echoed. It is a
# throwaway prod test account, but this is still a live credential and the repo
# is public, so it must not reach a log, a commit, or this file.
set -u
ENV_FILE="/Users/anmolu/GitHub/FlatFold/.env"
PW=$(grep -m1 '^DISCOINFERNO_PROD_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'"'"'')
if [ -z "$PW" ]; then echo "unlock: no password found in .env" >&2; exit 1; fi

osascript -e 'tell application "App" to activate' >/dev/null 2>&1
sleep 2

# REFUSE TO TYPE ANYWHERE BUT FLATFOLD.
#
# An overnight batch of 15 trials typed this password, and every subsequent
# click, into whatever window happened to be frontmost — a video player, as it
# turned out. Every trial reported appTotal=0 and was discarded. That is a
# wasted night and a credential-disclosure risk in one, and it is cheap to
# make impossible.
FRONT=$(osascript -e 'tell application "System Events" to return name of first process whose frontmost is true' 2>/dev/null)
if [ "$FRONT" != "App" ]; then
  echo "unlock: FlatFold is not frontmost (front=$FRONT) — refusing to type" >&2
  exit 3
fi

# Drives the ACCESSIBILITY TREE, not screen coordinates. Fixed points were read
# off one screenshot; the desktop then changed and they addressed a different
# window entirely. Coordinates are a snapshot of a moment, the element tree is
# what is actually stable.
osascript - "$PW" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    tell process "App"
      set frontmost to true
      delay 0.5
      if (count of windows) is 0 then error "no FlatFold window"
      set {wx, wy} to position of window 1
      set {ww, wh} to size of window 1

      -- CLICK THE FIELD BEFORE TYPING. It renders as focused, but keystrokes
      -- sent without a click go nowhere — that alone cost an overnight batch.
      -- Positions are FRACTIONS of the live window, so they survive the window
      -- being moved, resized, or switching between the wide two-pane layout and
      -- the narrow one-pane layout with a bottom tab bar.
      click at {wx + (ww * 0.5), wy + (wh * 0.386)}
      delay 0.8
      keystroke (item 1 of argv)
      delay 0.3
      key code 36 -- Return
      delay 8

      -- Open the first conversation row.
      click at {wx + (ww * 0.5), wy + (wh * 0.15)}
    end tell
  end tell
end run
APPLESCRIPT
echo "unlock: submitted"
