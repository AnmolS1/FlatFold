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
# The credential sits on the clipboard only for the moment it takes to paste,
# and is overwritten immediately afterwards. Never echoed, never logged.
printf '%s' "$PW" | pbcopy
trap 'printf "" | pbcopy' EXIT

osascript - "$PW" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    tell process "App"
      set frontmost to true
      delay 0.5
      if (count of windows) is 0 then error "no FlatFold window"
      set {wx, wy} to position of window 1
      set {ww, wh} to size of window 1

      -- FIND THE FIELD IN THE ACCESSIBILITY TREE, then click where it actually
      -- is. Fractions of the window were the previous approach and they are the
      -- wrong abstraction: 0.386 of the height landed between the password box
      -- and the Unlock button, so a polling loop clicked *Unlock* twenty times
      -- against an empty field and reported "field never appeared".
      --
      -- Polling also handles boot time: the app comes up through Argon2 and
      -- WASM, so at any fixed delay after launch it may still be loading.
      set fld to missing value
      repeat 20 times
        try
          set fld to first text field of entire contents of window 1
          exit repeat
        end try
        delay 2
      end repeat
      if fld is missing value then error "password field never appeared"

      set {fx, fy} to position of fld
      set {fw, fh} to size of fld
      click at {fx + (fw / 2), fy + (fh / 2)}

      -- CLICK THE FIELD BEFORE TYPING. It renders as focused, but keystrokes
      -- sent without a click go nowhere — that alone cost an overnight batch.
      -- Positions are FRACTIONS of the live window, so they survive the window
      -- being moved, resized, or switching between the wide two-pane layout and
      -- the narrow one-pane layout with a bottom tab bar.
      -- PASTE, don't keystroke. `keystroke` landed the click on the field and
      -- then typed nothing — the field stayed visibly empty — and per-character
      -- synthesis is fragile with punctuation besides. One paste event is also
      -- what a password manager does, so the web layer handles it normally.
      delay 0.8
      keystroke "v" using command down
      delay 0.5
      key code 36 -- Return
      delay 8

      -- Open the first conversation row.
      click at {wx + (ww * 0.5), wy + (wh * 0.15)}
    end tell
  end tell
end run
APPLESCRIPT
echo "unlock: submitted"
