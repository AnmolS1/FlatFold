#!/usr/bin/env bash
# App Store screenshots, at exact device pixel sizes, from the REAL native app.
#
#   scripts/screenshots.sh [scene ...]        # default: login transparency
#
# WHY THE SIMULATOR AND NOT A BROWSER RENDER. Apple checks dimensions, so a
# Playwright render at viewport × DPR would be the right SIZE — but it would be
# the WEB layout. The native chrome differs materially (chatChrome.ts puts
# Settings in a bottom tab bar on a phone, which the web build never renders),
# and a screenshot has to depict the app as it actually appears. A simulator
# gives both: real native chrome, and a screenshot that is already exactly the
# device's pixel dimensions with no scaling.
#
# WHAT THIS CANNOT DO YET: anything behind the login. STATUS.md records that the
# simulator cannot reach a logged-in state (Argon2/HPKE WASM). Re-measured
# 2026-07-28 and the picture is more specific than that: the app LAUNCHES,
# renders and stays alive in the simulator — it does not segfault — but
# submitting the login form produces no state change and no error, so the chat
# surface is still unreachable here. Everything below is therefore a screen you
# can see without an account. The chat, group and voice-note shots still need a
# real device or a fix to that.
#
# The scenes are driven by `--scene=` in MainViewController (DEBUG), which
# reports when the screen has SETTLED — two rAFs after the navigation — so a
# capture never races the render.
#
# PREREQUISITE, and it is stateful: this needs the iOS pod mode and a simulator
# build. Pod mode is left at `catalyst` by default, so run:
#
#   (cd ios/App && pod install)   # iOS mode — Catalyst builds will fail until reverted
#   (cd ios/App && xcodebuild -workspace App.xcworkspace -scheme App \
#      -destination 'id=<sim-udid>' -derivedDataPath build/DDsim -configuration Debug build)
#   scripts/screenshots.sh
#   (cd ios/App && FLATFOLD_CATALYST=1 pod install)   # put it back
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="screenshots/appstore"
mkdir -p "$OUT"

# name:udid:expected-pixels. Sizes are what App Store Connect asks for; the
# expectation is asserted after every capture, because a silently wrong-sized
# screenshot is rejected at upload time and the run looks successful here.
DEVICES=(
  "iphone-6.9:F27642A1-E169-4D1C-8695-4638E2931F58:1320x2868"
  "ipad-13:D9CE0BFD-048E-4F0B-BDB3-ABBBDF89D9E5:2064x2752"
)
SCENES=("${@:-login transparency}")
read -r -a SCENES <<< "${SCENES[*]}"

APP_ID="dev.flatfold"

for entry in "${DEVICES[@]}"; do
  IFS=: read -r name udid expected <<< "$entry"
  echo "=== $name ($expected)"

  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true

  # Light appearance, and a clean status bar — Apple rejects a carrier name or a
  # half-empty battery in a marketing shot, and the default sim clock is not 9:41.
  xcrun simctl ui "$udid" appearance light >/dev/null 2>&1 || true
  xcrun simctl status_bar "$udid" override \
    --time "9:41" --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 --wifiMode active --wifiBars 3 >/dev/null 2>&1 || true

  build="ios/App/build/DDsim/Build/Products/Debug-iphonesimulator/App.app"
  [ -d "$build" ] || { echo "no simulator build at $build" >&2; exit 1; }
  xcrun simctl install "$udid" "$build" >/dev/null

  for scene in "${SCENES[@]}"; do
    xcrun simctl terminate "$udid" "$APP_ID" >/dev/null 2>&1 || true
    log="$(mktemp)"
    xcrun simctl launch --console-pty "$udid" "$APP_ID" "--scene=$scene" >"$log" 2>&1 &

    # Wait for the app's own "settled" signal rather than sleeping.
    for _ in $(seq 1 60); do
      grep -q "FLATFOLD_SCENE" "$log" 2>/dev/null && break
      sleep 1
    done
    grep -q "FLATFOLD_SCENE" "$log" || { echo "  $scene: never settled" >&2; continue; }
    grep -q '"ok":true' "$log" || { echo "  $scene: $(grep -o 'FLATFOLD_SCENE.*' "$log" | head -1)" >&2; continue; }

    shot="$OUT/${name}-${scene}.png"
    xcrun simctl io "$udid" screenshot "$shot" >/dev/null 2>&1

    got="$(sips -g pixelWidth -g pixelHeight "$shot" | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"x"h}')"
    if [ "$got" = "$expected" ]; then
      echo "  $scene -> $shot  $got ✓"
    else
      echo "  $scene -> $shot  $got ✗ EXPECTED $expected" >&2
    fi
    rm -f "$log"
  done

  xcrun simctl status_bar "$udid" clear >/dev/null 2>&1 || true
done

echo
echo "Wrote:"; ls -1 "$OUT"
