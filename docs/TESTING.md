# FlatFold — the on-device test plan

**Run this before every App Store submission, and after any change to the chat
surface, the auth flow, or the Worker.** It exists because the automated suite
(784 tests) cannot see the things that have actually broken in this app.

## Why a manual plan exists at all

Three classes of bug have shipped or nearly shipped here, and **none of them can
fail a unit test**:

| Class | Real example | Why the suite is blind to it |
| --- | --- | --- |
| **Layout** | The "New message" button rode up under the last chat row on all three platforms | jsdom performs no layout. Every test passed. |
| **Host focus / input** | Tab did nothing between Username and Password on macOS | UIKit claims the key before the DOM sees it; jsdom has no UIKit. |
| **Deploy / environment** | An unreviewed branch went to prod because `--env` is ignored | Nothing about a green suite says which worker you deployed to. |

So: a green `npm test` is a precondition for running this plan, never a
substitute for it.

---

## 0. Before you start

```bash
npm test -- --run      # must be green
npx tsc -b             # must be silent
npm run lint           # must be silent
```

### Choose the backend deliberately

The native app's backend is baked in at **build** time.

```bash
# Against the preview backend (use this for reviewing unreleased work):
VITE_API_ORIGIN=https://flatfold-preview.<subdomain>.workers.dev npm run build:native

# Against production (use this ONLY for the build you will actually ship):
npm run build:native
```

This single variable also rewrites the native CSP's `connect-src`
(`scripts/inject-native-csp.mjs`), so you do not have to touch the CSP by hand.
**Verify it landed** rather than assuming:

```bash
grep -o "connect-src[^\"]*" ios/App/App/public/index.html
```

### The pod-mode dance — this bites every time

iOS and macOS need **opposite** pod modes, and `cap sync` does **not** flip an
already-installed one (it finishes in ~0.05s and silently skips).

```bash
cd ios/App
pod install                      # iOS   — includes @capacitor/filesystem
FLATFOLD_CATALYST=1 pod install  # macOS — EXCLUDES it (no maccatalyst slice)
```

`bundle exec pod install` fails here — CocoaPods is not in the Gemfile. Use plain
`pod install`. Check which mode you are in before building:

```bash
cat ios/App/Pods/.flatfold-pod-mode    # "ios" or "catalyst" — authoritative
```

**Use the marker, not the lock file, and not the Pods directory.** Two obvious
checks are both wrong. `Podfile.lock` is *tracked*, so it gets restored after
every lane and can say `catalyst` while the installed pods are iOS. And
`ls Pods/CapacitorFilesystem` tells you nothing: it is a `:path =>` development
pod, referenced in place, so it **never gets a `Pods/<Name>/` directory** — it
lives under `Pods/Local Podspecs/` and as a target in `Pods/Pods.xcodeproj`.
Checking for the directory reports a perfectly good iOS install as Catalyst.

If you build iOS with Catalyst pods, native file save is silently missing from
the binary. If you build Catalyst with iOS pods, the build fails outright — the
noisy failure is the lucky one. For that reason, **leave the tree in `ios` mode
when you finish**: it is the state whose mistake announces itself.

### Build and install

```bash
# macOS
cd ios/App && xcodebuild -workspace App.xcworkspace -scheme App \
  -configuration Debug -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath build/DDcat build
cp -R build/DDcat/Build/Products/Debug-maccatalyst/FlatFold.app /Applications/

# iPhone (disco)
cd ios/App && pod install && xcodebuild -workspace App.xcworkspace -scheme App \
  -configuration Debug -destination 'id=<device-udid>' \
  -derivedDataPath build/DDdev -allowProvisioningUpdates build
xcrun devicectl list devices          # get the device identifier
xcrun devicectl device install app --device <identifier> \
  build/DDdev/Build/Products/Debug-iphoneos/FlatFold.app
```

Afterwards, `git checkout -- ios/App/App.xcodeproj/project.pbxproj
ios/App/Podfile.lock` — pod switching dirties both.

### You need TWO accounts

FlatFold is E2EE between real people. **One account cannot demonstrate a
conversation** — there is no server-side history and no bot. Use two accounts on
two devices (or one device + the web preview). Call them **A** and **B** below.

---

## 1. Smoke: is this even the build you think it is?

A stale WKWebView bundle has caused misfiled bug reports twice. Check first.

- [ ] **Settings → About → Build** matches the build you just installed
- [ ] **Settings → About → Platform** reads what you expect (`iPad app on Mac`
      vs `iOS/iPadOS`)
- [ ] The header shows **connected** (not `connecting…` stuck)

If Build is stale: force-quit the app fully and relaunch. A rebuild that was not
force-quit keeps the old JavaScript.

---

## 2. The App Review 1.2 mechanisms

These are the reason the app was rejected. Each maps to a bullet Apple checks,
and each is asserted in the review notes — if one fails here, the review notes
are a false statement, not just a bug.

### 2.1 Terms gate (EULA)

- [ ] Sign up a **new** account → the terms screen appears **before** the chat
- [ ] It states *"There is no tolerance for objectionable content, and none for
      abusive users"* and that offending accounts are **terminated**
- [ ] The terms **scroll inside their own box**; the buttons stay visible
- [ ] "I do not agree — sign out" returns you to login (it must not be a trap)
- [ ] "I agree" → the chat surface appears
- [ ] Force-quit and relaunch → the gate does **not** reappear
- [ ] **An existing account is gated too**: the gate is retroactive by design.
      Sign in as an account created before the migration → gate appears.
- [ ] With the keystore locked (fresh tab / relaunch), the **terms come first**,
      before the password unlock prompt

### 2.2 Unknown-sender gate (the "filter")

From **B**, add **A** and send a message. A has never spoken to B.

- [ ] On **A**: it appears under **Requests**, showing only B's **username**
- [ ] **No message text, no preview, no media thumbnail, no timestamp**
- [ ] **No notification fired** with content
- [ ] It is **not** in the chat list, and B is **not** in Contacts
- [ ] **Accept** → the conversation opens **with the held message(s) present**
- [ ] Send a reply; normal conversation works from here

Now the decline path, with a **fresh** third account (or re-test after removing):

- [ ] **Decline** → the request disappears, nothing is shown
- [ ] The declined sender gets **no error and no indication** on their side
- [ ] They **cannot** deliver again — send from them; nothing arrives, and no new
      request appears

### 2.3 Group invites are gated too

This is the one most likely to regress, because it is a separate code path.

- [ ] From a **stranger** account, create a group including **A**
- [ ] On **A**: it shows under **Requests** as *"added you to a group"*, naming
      the **inviter** — **not** the group name (a group name is attacker-supplied
      text)
- [ ] Group messages sent before acceptance do **not** render anywhere
- [ ] **Accept** → the group appears and becomes usable (you can send to it)
- [ ] **Decline** on another group → gone, and the inviter is blocked

### 2.4 Reporting

- [ ] Conversation **⋮ → Report contact** opens the dialog
- [ ] It says reports are reviewed within **24 hours**
- [ ] **Nothing is ticked by default**
- [ ] The disclosure text is visible **without scrolling past the checkboxes**
- [ ] Only the **other person's** messages are listed — never your own
- [ ] Send with **nothing ticked** → works (a report with no evidence is valid)
- [ ] Send **with** messages ticked → the button names the count
- [ ] After sending, the contact is **also blocked** (same step)

### 2.5 Blocking

- [ ] Block someone → their conversation disappears from the list
- [ ] They **cannot deliver**: send from them, nothing arrives (this is now
      enforced server-side, not just hidden)
- [ ] Unblock → they can reach you again
- [ ] A block survives a **force-quit and relaunch** (it is server-side now)

### 2.6 In-app contact info

- [ ] **Settings → About** shows **report@**, **support@** and **security@**
      as three separate rows
- [ ] Support / Privacy / Terms links all open

---

## 3. Layout — the class the suite cannot see

Do this on **all three** surfaces. Check both an **empty** chat list and one with
several conversations; the empty case is where docking bugs show up worst.

- [ ] **"New message" is docked at the BOTTOM** of the list pane, directly above
      the tab bar — **not** floating under the last chat row
- [ ] With a pending **request** showing, the button is still at the bottom
- [ ] The chat list scrolls; the button does not scroll away
- [ ] Rotate / resize the window — the button stays docked
- [ ] Open the composer: the add-username input sits directly above the keyboard
      and the tab bar hides
- [ ] Mac: resize the window narrow and wide across the 900px breakpoint —
      master/detail switches cleanly

**Measuring it beats eyeballing it.** In a browser at a phone viewport:

```js
const b = [...document.querySelectorAll('button')].find(x => /New message/.test(x.textContent));
window.innerHeight - b.getBoundingClientRect().bottom   // ~10 = docked; ~470 = the bug
```

---

## 4. macOS-specific

Catalyst has its own failure modes that exist on no other platform.

- [ ] **Tab** moves Username → Password on login; **Shift+Tab** goes back
- [ ] Typing still works normally in both fields
- [ ] The app is called **FlatFold** in Finder, the Dock, and the menu bar —
      **not** "App" (this caused a rejection; the bundle FILENAME is what Finder
      shows, so `PRODUCT_NAME` is what fixes it, not `CFBundleDisplayName`)
- [ ] **Voice notes record and play back** (Mac uses a native Swift plugin, not
      the web audio path — `navigator.mediaDevices` does not exist here at all)
- [ ] The QR scanner is **absent**, not broken — there is no camera path on Mac
- [ ] No stray "ghost row" at the bottom of the window

## 5. iOS-specific

- [ ] Face ID unlock works, and **cancelling** it leaves the password path usable
- [ ] The app-switcher snapshot is **obscured** (no message content visible)
- [ ] Push arrives and carries **no message content** on the lock screen
- [ ] Voice notes record and play
- [ ] The QR scanner opens the camera and scans a safety number

---

## 6. Core regression pass — the things that must not break

Quick but non-negotiable. These are the app's actual purpose.

- [ ] Sign up, sign out, sign back in
- [ ] Keystore unlock after relaunch (it asks again by design — the key is never
      stored, and this is **not** a failed login)
- [ ] Send and receive text, both directions
- [ ] Send a photo, a file, and a voice note; receive each
- [ ] Create a group with two members; send and receive in it
- [ ] Delete a message for everyone → it tombstones on **both** sides
- [ ] Set a disappearing timer → messages expire on both sides
- [ ] Verify a safety number (QR on iOS, numeric comparison anywhere)
- [ ] Search finds messages locally
- [ ] **/transparency** loads and lists every stored field
- [ ] Reconnect: kill the network, send, restore it → the message flushes
- [ ] Change password → other sessions die, this one survives
- [ ] Panic wipe (on a throwaway account) clears everything

---

## 7. Before you ship

- [ ] **Stash first, so the build stamp is honest.** `git status --porcelain`
      counts untracked files, so stray assets stamp the bundle `abc1234+` — a
      binary that matches no commit. Then confirm the sha landed *in the built
      output*, with no `+`: `grep -roh '<sha>[+]*' dist/client/assets/`
- [ ] Rebuild native against **production** (`npm run build:native`, no
      `VITE_API_ORIGIN`), then verify on the artifact:
      `grep -o "connect-src[^\"]*" ios/App/App/public/index.html`
- [ ] **Deploy the web from its OWN `npm run build` — never from a `dist/` that
      `build:native` touched.** The two share an output directory but not a
      valid final state: `inject-native-csp.mjs` rewrites
      `dist/client/index.html` **in place**, and that CSP pins `connect-src` to
      the app's own origin. Ship it to browsers and the page still loads while
      the sealed-sender relay is silently blocked. Check
      `grep -c connect-src dist/client/index.html` — must be **0**.
- [ ] Migrations applied to prod **before** the Worker deploy — additive
      migrations are what make a Worker rollback survivable
- [ ] Verify the deploy target **before** deploying:
      `python3 -c "import json;print(json.load(open('dist/flatfold/wrangler.json'))['name'])"`
      — `wrangler deploy --env X` is **ignored**; the environment is chosen at
      build time by `CLOUDFLARE_ENV`
- [ ] After deploying, probe **30+ times** — propagation is not atomic, and for a
      couple of minutes requests hit either version. Probe a route that only the
      new code answers, and keep a **control** (a route that does not exist) so
      a 404 means "old version" rather than "wrong probe"
- [ ] `MARKETING_VERSION` bumped **only if the previous version actually went
      live**. A rejected version's train is still open: keep the version and let
      the build number rise. Check before assuming —
      `get_app_store_versions` reports `app_store_state` per platform
- [ ] Archive verified on the **built artifact**, not the project file:
      `plutil -p` the bundle Info.plist, `codesign -d --entitlements :-`
- [ ] Poll App Store Connect to a terminal state — a green lane means "upload
      accepted", not "VALID"

---

## Appendix — what automated tests DO cover

Do not re-test these by hand; they are pinned in CI:

- the terms gate withholds the app, and the no-tolerance clause is rendered
  (`test-ui/termsGate.test.tsx`)
- the inbound gate decision table, accept/decline/block precedence, and upgrade
  seeding (`test-ui/contactRequests.test.ts`)
- requests show a username and never message content
  (`test-ui/messageRequests.test.tsx`)
- report validation, evidence caps, rate limiting, 90-day pruning
  (`test/report.test.ts`)
- server-side block enforcement **on the delivery path**, with a control, and
  account termination (`test/blocks.test.ts`)
- the transparency page matching the real D1 schema (`test/schema-drift.test.ts`)
