# TLS public-key pinning: what's pinned, why, and how to rotate it

The native iOS app pins the TLS public keys for `flatfold.ponderance.dev`. Getting the pins wrong bricks the app: every installed copy loses all connectivity until an App Store update ships a fix, and there is no server-side way to undo it. That is the failure mode this page exists to prevent.

This page has two halves. The first explains what is pinned and why, for anyone auditing FlatFold. The second is an operational runbook for whoever maintains or forks the build: how to rotate the pins, and how to prove they actually work.

## Where it lives

The pins sit in `ios/App/App/Info.plist`, under `NSAppTransportSecurity`, then `NSPinnedDomains`, then `flatfold.ponderance.dev`, then `NSPinnedCAIdentities`. Each entry is a dictionary with a single key, `SPKI-SHA256-BASE64`, whose value is the base64 SHA-256 of a certificate's public key.

`NSPinnedDomains` (iOS 14 and later) is the only mechanism that pins WKWebView traffic, and that is the whole reason we use it. The app's API `fetch()` calls and its `new WebSocket()` connection both run inside WebKit's networking process rather than the app's own `URLSession`, so a URLSession delegate or a JavaScript-level pin never sees those TLS challenges and cannot enforce anything on them. `NSPinnedDomains` is App Transport Security configuration, so it covers every connection the app makes to the domain: the HTTPS API and the `wss://` WebSocket alike. It is scoped by domain, not by URL scheme. All of this was checked on device and in the simulator, and the method is written up under "How to test" below.

## What is pinned, and why we pin roots

| CA root | SPKI-SHA256 (base64) | Role |
| --- | --- | --- |
| Google Trust Services **GTS Root R4** | `mEflZT5enoR1FuXLgYYGqnVEoZvmf9c2bVBpiOjYQ0c=` | current CA (Cloudflare Universal SSL) |
| Let's Encrypt **ISRG Root X1** | `C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=` | cross-CA backup |

We pin two certificate-authority roots. We deliberately do not pin the leaf or the intermediate, and each of those choices has a reason.

The leaf certificate (`CN=ponderance.dev`) is issued by Cloudflare, rotates roughly every ninety days, and uses a key we do not control. Pinning it would break the app on every rotation. The intermediate (`GTS WE1`) rolls over whenever Google rotates its intermediates, and pinning it buys nothing that pinning the root does not already give us. The two roots belong to different certificate authorities on purpose, so if Cloudflare moves the domain from Google Trust Services over to Let's Encrypt, the app keeps connecting.

The pin is narrower than it looks, and the gap matters. Pinning to a set of CA roots is not the same as pinning to our own key. If Google Trust Services or Let's Encrypt themselves mis-issued a certificate for the domain, that certificate would still satisfy the pin. What the pin stops is a certificate from any authority outside the set: a corporate proxy's own root, say, or a rogue or compromised CA. FlatFold payloads are already end-to-end encrypted, so that is the threat actually worth closing here. The pin protects the auth token and the metadata channel from interception, and it does not pretend to protect against the pinned CAs turning on us. The full write-up is THREAT_MODEL residual #24.

## Re-derive and verify the pins

To compute the SPKI-SHA256 of any certificate, whether it is the leaf, an intermediate, or a root:

```sh
# Pull the live chain for the domain (leaf, then intermediate, then root):
openssl s_client -connect flatfold.ponderance.dev:443 \
  -servername flatfold.ponderance.dev -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/{c++} c>0{print > ("c" c ".pem")}'

# SPKI-SHA256 (base64) of a PEM certificate. This is the value that goes in the plist:
spki() { openssl x509 -in "$1" -noout -pubkey \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | openssl enc -base64; }
spki c3.pem   # the root, currently GTS Root R4

# For a CA root that is not in the served chain, such as the Let's Encrypt backup:
curl -s https://letsencrypt.org/certs/isrgrootx1.pem | \
  openssl x509 -noout -pubkey | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | openssl enc -base64
```

## Rotate carefully, and never skip the overlap

The pin is baked into the signed binary, so changing it means shipping an app update that has to reach users before the old certificate stops validating. A straight swap will strand everyone who has not updated yet, so never do one. Follow these steps instead.

1. **Watch the live chain.** Run the `openssl` check above every so often. If the root changes, or Cloudflare announces a CA change, act before it takes effect.
2. **Add, do not replace.** Append the new CA root's SPKI as an additional `NSPinnedCAIdentities` entry. During the transition both the old and the new root are pinned, so whichever certificate Cloudflare happens to serve will validate. `NSPinnedCAIdentities` accepts a connection if any one of the listed identities appears in the chain.
3. **Ship the update.** Wait until the large majority of installs have picked it up, which realistically takes weeks, before you touch the old pin.
4. **Prune the old root.** Only once that transition window has passed, drop the retired root in a later release.

If you are ever forced to turn pinning off in an emergency, remove the whole `NSPinnedDomains` block rather than a single identity, then ship. The domain still goes through normal App Transport Security validation, so the app keeps working. It just is not pinned any more.

## How to test (run both controls; a happy path proves nothing)

A pin that happens to match everything also lets the app work, so one passing check tells you nothing. You have to run both halves.

The negative control comes first. Inject a deliberately wrong pin, meaning a valid-format 44-character base64 string that matches nothing in the real chain (all `A`s works), then build, launch, and confirm the API request is blocked. In the unified log, inside `com.apple.WebKit.Networking`, you will see the trust evaluation fail:

```
Trust evaluate failure: [ca1 CAspkiSHA256] [root CAspkiSHA256]
System Trust Evaluation yielded status(-9802)
Task <...> finished with error [-1200] Error Domain=NSURLErrorDomain
```

Then the positive control. Restore the real pins, rebuild, and confirm the same request now succeeds against the live certificate: `TLS Trust result 0` and a normal HTTP response, with no `-9802` anywhere. A `401` from `/api/me` on a fresh install is the expected response, since there is no session yet; what matters is that the connection completed.

The simulator is fine for both, because App Transport Security and pinning behave the same there, and the bootstrap `GET /api/me` fires on launch before any crypto runs, so the WebAssembly SIGSEGV that blocks a real login on the simulator never gets in the way.

```sh
SIM=<booted-sim-udid>
xcrun simctl spawn $SIM log stream --level info --style compact > /tmp/simlog.txt 2>&1 &
xcrun simctl launch $SIM dev.flatfold      # wait about 15s, then kill the log stream
grep "WebKit.Networking" /tmp/simlog.txt | grep -iE "Trust result|9802|1200|CAspkiSHA256|status [0-9]"
```

One caveat the simulator cannot cover: it cannot log in, so it never opens the `wss://` WebSocket. To confirm the WebSocket is pinned and still working, install the build on a real device, sign in, and send a message. If the conversation works, the WebSocket connected under the live pin.
