# Building FlatFold for Mac Catalyst

## Open the WORKSPACE, not the project

    open ios/App/App.xcworkspace     # correct
    open ios/App/App.xcodeproj       # WRONG — pods are invisible

If Xcode already has the PROJECT open, opening the workspace is not enough —
quit Xcode first. Xcode keeps building whatever window is open, and the two have
separate DerivedData directories, so the stale one keeps reproducing the same
errors after the workspace is fixed:

    osascript -e 'quit app "Xcode"'
    rm -rf ~/Library/Developer/Xcode/DerivedData/App-*
    open ios/App/App.xcworkspace

The tell is the DerivedData hash in the error text. If it differs from the one a
workspace build reports, the project is being built.

This is the single most likely thing to go wrong. Building the `.xcodeproj`
fails with `Unable to resolve module dependency: 'Capacitor'` and a list of
`Search path ... not found` warnings naming every pod, because the project alone
has no idea the pods exist. If you have built the project before, its stale
DerivedData will keep producing those warnings — delete that DerivedData
directory (the hash differs from the workspace's).

## The two configurations — YOU MUST RE-RUN pod install WHEN SWITCHING

    FLATFOLD_CATALYST=1 pod install   # Mac Catalyst — filesystem EXCLUDED
    pod install                       # iOS — @capacitor/filesystem INCLUDED

**This is stateful.** Whichever ran last decides what Xcode builds against, and
building the wrong one fails deep inside a vendor pod:

    Unable to resolve module dependency: 'IONFilesystemLib'

which reads like a broken dependency rather than the wrong install mode. It has
cost two rounds already. `pod install` now prints a banner naming the mode and
writes `ios/App/Pods/.flatfold-pod-mode`, so the current state is checkable:

    cat ios/App/Pods/.flatfold-pod-mode

If it says `ios` and you are building Catalyst, that error is why.

### Why the switch exists at all

`IONFilesystemLib` ships ONLY `ios-arm64` and `ios-arm64_x86_64-simulator`, and
the pod contains no source — just the `.xcframework` and a LICENSE. It cannot be
rebuilt for Catalyst, so exclusion is the only option. CocoaPods cannot include a
pod conditionally per SDK within one target, which is why this is an env var and
not something automatic. It is a wart caused by an upstream binary-only
dependency, not a design choice.

`@capacitor/filesystem` depends on `IONFilesystemLib`, a PREBUILT binary
(`vendored_frameworks: IONFilesystemLib.xcframework`) with no `maccatalyst`
slice. This is the same root cause that made the original SwiftPM setup unable to
target Catalyst — except Capacitor itself was fixable by building from source,
and a vendored third-party framework is not.

It is used in exactly ONE place: `MediaAttachment`'s native file save. On
Catalyst the real macOS WKWebView should handle `<a download>` directly, which
would make the plugin unnecessary there — unconfirmed, and the reason the
exclusion is an explicit switch rather than a silent omission.

## Required build setting

`ENABLE_USER_SCRIPT_SANDBOXING = NO`. Without it the compile succeeds and then
the sandbox denies CocoaPods' own `Pods-App-frameworks.sh`:

    Sandbox: bash(...) deny(1) file-read-data .../Pods-App-frameworks.sh

## Vendor header warnings

`use_frameworks!` builds every pod as a framework, and CapacitorCordova's public
headers use double-quoted includes (`#include "CDVPlugin.h"`), which warns in a
framework but not in a static library. SwiftPM did not build them as frameworks,
so ~22 of these warnings are NEW to this migration and not new to the code.

They are vendor headers we do not control, and that volume buries anything that
matters, so `CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = NO` is set on the
pod targets in `post_install`. It is scoped to pods — FlatFold's own code keeps
the warning.

## Verified 2026-07-26

| target | pods | warnings | result |
| --- | --- | --- | --- |
| Mac Catalyst (filesystem excluded) | 9 | 0 | BUILD SUCCEEDED, `platform MACCATALYST` |
| iOS (filesystem included) | 10 | 0 | BUILD SUCCEEDED |

Pod counts are part of the assertion: removing dependencies makes a build MORE
likely to succeed, so `BUILD SUCCEEDED` alone means little on a migration.

`Pods/` and `App.xcworkspace/` are gitignored; `pod install` regenerates both.

## Not yet done

Launching and signing it, and confirming the actual payoff: that the real macOS
WKWebView exposes `navigator.mediaDevices`. That is the test that would justify
deleting `FlatFoldAudioPlugin` (~280 lines of Swift plus its transport, finalize
handling and audio-session juggling) and the ghost-row hack in
`MainViewController`. Unlike "Designed for iPad", a Catalyst app CAN be launched
and UI-tested from the command line, so that feedback loop opens up too.
