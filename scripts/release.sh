#!/usr/bin/env bash
# The one safe action for shipping a build.
#
#   scripts/release.sh ios 1.0.1        # -> tag v1.0.1        -> TestFlight (iOS)
#   scripts/release.sh mac 1.0.1        # -> tag mac-v1.0.1    -> TestFlight (macOS)
#
# WHY NOT "OPEN XCODE AND HIT ARCHIVE". Every local archive depends on machine
# state that is invisible in the Xcode UI and wrong by default at least half the
# time here:
#
#   - the CocoaPods mode is STATEFUL (`ios/App/Pods/.flatfold-pod-mode`). An iOS
#     archive taken while it says `catalyst` fails; a Catalyst archive taken
#     while it says `ios` fails with a misleading missing-module error.
#   - the web assets in `ios/App/App/public` are a COPY. Xcode will happily
#     archive last week's JavaScript with today's Swift and tell you nothing.
#   - `App.xcworkspace` and `App.xcodeproj` both open, and only the workspace
#     builds. Opening the project is a silent wrong answer.
#   - an uncommitted change produces a binary that matches no commit, which the
#     app itself will report as `abc1234+` in Settings -> About.
#
# CI has none of that state: it clones the tagged commit into an empty runner and
# builds from scratch. So the safest local action is not to build at all — it is
# to name a commit and let CI build it. That is what this script does, after
# refusing to tag anything that would produce an ambiguous build.
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORM="${1:-}"
VERSION="${2:-}"
case "$PLATFORM" in
  ios) TAG="v$VERSION" ;;
  mac) TAG="mac-v$VERSION" ;;
  *) echo "usage: scripts/release.sh {ios|mac} <version>   e.g. scripts/release.sh ios 1.0.1" >&2; exit 1 ;;
esac
[ -n "$VERSION" ] || { echo "usage: scripts/release.sh {ios|mac} <version>" >&2; exit 1; }

fail() { echo "REFUSING: $1" >&2; exit 1; }

# --- Guards. Each one exists because it is invisible at archive time. ---------

git diff --quiet && git diff --cached --quiet \
  || fail "the working tree is dirty. A build from it matches no commit, and Settings -> About would show a '+'. Commit or stash first."

[ -z "$(git ls-files --others --exclude-standard)" ] \
  || echo "note: untracked files present (they will NOT be in the build)" >&2

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse --short HEAD)"

git fetch -q origin
git merge-base --is-ancestor HEAD "origin/$BRANCH" 2>/dev/null \
  || fail "HEAD is not pushed to origin/$BRANCH. CI builds what is on the remote, so an unpushed commit would tag code nobody can build."

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  && fail "tag $TAG already exists. Build numbers are derived from TestFlight, but a tag is a name for one commit — pick a new version."

# The version the app will report. Keep the tag and the app honest with each other.
PKG_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
if [ "$PKG_VERSION" != "$VERSION" ] && [ "$PKG_VERSION" != "?" ]; then
  fail "package.json says $PKG_VERSION but you asked to ship $VERSION. Bump one of them; a store listing that disagrees with the binary is a support problem later."
fi

echo "About to tag:"
echo "  platform : $PLATFORM"
echo "  version  : $VERSION"
echo "  tag      : $TAG"
echo "  branch   : $BRANCH"
echo "  commit   : $SHA   <- this is what Settings -> About will show"
echo
read -r -p "Push this tag and start the release build? [y/N] " ok
[ "$ok" = "y" ] || { echo "aborted"; exit 1; }

git tag -a "$TAG" -m "Release $VERSION ($PLATFORM) from $SHA"
git push origin "$TAG"

echo
echo "Tagged and pushed. CI is building from $SHA."
echo "  watch:  gh run list --limit 3"
echo
echo "AFTER it lands in App Store Connect, confirm you shipped what you think:"
echo "  install the build, open Settings -> About, and check Build reads exactly '$SHA'"
echo "  with no trailing '+'. That is the only check that ties a binary to a commit."
