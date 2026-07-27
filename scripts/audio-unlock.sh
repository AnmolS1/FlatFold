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
  -- `activate` INSIDE this script, not `set frontmost to true` from a separate
  -- osascript call. They are not equivalent: the frontmost property can read
  -- true while the window is not key, and the paste then goes nowhere — which
  -- is exactly the difference between this working by hand and failing inside
  -- a trial. The by-hand version that worked did the activate right here.
  tell application "App" to activate
  delay 1.5
  tell application "System Events"
    tell process "App"
      delay 0.5
      if (count of windows) is 0 then error "no FlatFold window"
      set {wx, wy} to position of window 1
      set {ww, wh} to size of window 1

      -- Click the password box by window fraction, then paste.
      --
      -- Two smarter-looking approaches were tried and are worse:
      --   * an explicit AX path (`text field 1 of group 2 of UI element 1 of
      --     scroll area 1 of ...`) — the tree shape DIFFERS between the unlock
      --     gate and the chat list, so no constant path resolves on both.
      --   * `first text field of entire contents of window 1` — the WKWebView
      --     tree is deep enough that the traversal times out.
      --
      -- And the polling loop that gated on `click at` returning something
      -- containing "text field" was rejecting GOOD clicks: `click at` commonly
      -- reports the enclosing group, not the field. That is why it looped
      -- twenty times and then claimed the field never appeared — the clicks
      -- were landing the whole time.
      --
      -- 0.386 of the window height is the middle of the box, verified by hand
      -- against a capture at the live bounds.
      click at {wx + (ww * 0.5), wy + (wh * 0.386)}

      -- CLICK THE FIELD BEFORE TYPING. It renders as focused, but keystrokes
      -- sent without a click go nowhere — that alone cost an overnight batch.
      -- Positions are FRACTIONS of the live window, so they survive the window
      -- being moved, resized, or switching between the wide two-pane layout and
      -- the narrow one-pane layout with a bottom tab bar.
      -- PASTE VIA THE EDIT MENU. Two things do not work here and both look like
      -- they should: `keystroke <password>` types nothing into this field, and
      -- `keystroke "v" using command down` does not paste into it either. Both
      -- leave the box visibly empty with no error. Catalyst apps carry a real
      -- Edit menu, and driving Paste from it lands every time.
      delay 0.8
      click menu item "Paste" of menu 1 of menu bar item "Edit" of menu bar 1
      delay 0.6
      key code 36 -- Return
      delay 8

      -- Open the first conversation row.
      click at {wx + (ww * 0.5), wy + (wh * 0.15)}
    end tell
  end tell
end run
APPLESCRIPT
echo "unlock: submitted"
