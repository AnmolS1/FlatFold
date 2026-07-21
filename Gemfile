source "https://rubygems.org"

# Pin fastlane through bundler so CI resolves the same version every run
# (`bundle exec fastlane ...`). Reproducibility is the point — the same reason
# `npm ci` is used over `npm install`. Commit Gemfile.lock alongside this file.
#
# CocoaPods is intentionally NOT listed: the Capacitor iOS project uses Swift
# Package Manager (ios/App/CapApp-SPM), so there is no `pod install` step.
gem "fastlane", "~> 2.237"
