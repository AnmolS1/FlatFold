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

# The gate's password field autofocuses; a click first in case it does not.
osascript - "$PW" <<'APPLESCRIPT'
on run argv
  tell application "System Events"
    tell process "App"
      set frontmost to true
    end tell
    delay 0.5
    keystroke (item 1 of argv)
    delay 0.3
    key code 36 -- Return
  end tell
end run
APPLESCRIPT
echo "unlock: submitted"
