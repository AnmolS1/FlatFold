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

## The two configurations

    pod install                       # iOS — @capacitor/filesystem INCLUDED
    FLATFOLD_CATALYST=1 pod install   # Mac Catalyst — filesystem EXCLUDED

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

## Verified 2026-07-26

| target | result |
| --- | --- |
| Mac Catalyst (9 pods, filesystem excluded) | BUILD SUCCEEDED, `platform MACCATALYST` |
| iOS (10 pods, filesystem included) | BUILD SUCCEEDED |

`Pods/` and `App.xcworkspace/` are gitignored; `pod install` regenerates both.

## Not yet done

Launching and signing it, and confirming the actual payoff: that the real macOS
WKWebView exposes `navigator.mediaDevices`. That is the test that would justify
deleting `FlatFoldAudioPlugin` (~280 lines of Swift plus its transport, finalize
handling and audio-session juggling) and the ghost-row hack in
`MainViewController`. Unlike "Designed for iPad", a Catalyst app CAN be launched
and UI-tested from the command line, so that feedback loop opens up too.
