fastlane documentation
----

# Installation

Make sure you have the latest version of the Xcode command line tools installed:

```sh
xcode-select --install
```

For _fastlane_ installation instructions, see [Installing _fastlane_](https://docs.fastlane.tools/#installing-fastlane)

# Available Actions

## iOS

### ios certs

```sh
[bundle exec] fastlane ios certs
```

Generate/sync App Store signing certs + profiles into flatfold-certs (encrypted)

### ios verify

```sh
[bundle exec] fastlane ios verify
```

Staging check: validate ASC auth + signing material, report the TestFlight build number. No build, no upload.

### ios beta

```sh
[bundle exec] fastlane ios beta
```

Build the signed app and upload it to TestFlight (CI: on a v* tag)

----


## Mac

### mac certs_mac

```sh
[bundle exec] fastlane mac certs_mac
```

Mint/sync Mac Catalyst App Store signing material. Run by a human, never in CI.

### mac beta_mac

```sh
[bundle exec] fastlane mac beta_mac
```

Build the signed Mac Catalyst app and upload it to TestFlight (CI: on a mac-v* tag)

----

This README.md is auto-generated and will be re-generated every time [_fastlane_](https://fastlane.tools) is run.

More information about _fastlane_ can be found on [fastlane.tools](https://fastlane.tools).

The documentation of _fastlane_ can be found on [docs.fastlane.tools](https://docs.fastlane.tools).
