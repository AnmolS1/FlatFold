import UIKit
import Capacitor
import WebKit
import os

// Capacitor 8 instantiates plugins from the generated `packageClassList`, which
// `cap sync` builds from installed plugin PACKAGES only. Our biometric plugin is
// app-local (compiled into the App target, not a package), so it never lands in
// that list. Register it by hand here — `capacitorDidLoad()` is the supported hook
// and this file survives `cap sync`. The storyboard points at this class.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(FlatFoldBiometricPlugin())
        bridge?.registerPluginInstance(FlatFoldAppIconPlugin())
        bridge?.registerPluginInstance(FlatFoldAudioPlugin())

        // Tell the web layer whether this is the iPad app running on a Mac.
        //
        // `ProcessInfo.isiOSAppOnMac` is the API that actually answers this; an
        // earlier attempt guessed from navigator.maxTouchPoints, which is a
        // heuristic about touchscreens and not about this.
        //
        // Injected at documentStart so it is set before any app code reads it.
        let isOnMac = ProcessInfo.processInfo.isiOSAppOnMac
        // `__flatfoldDebug` gates the web layer's os_log bridge (lib/nativeLog).
        // Without it, instrumentation added for one debugging round would keep
        // making a bridge round-trip per voice note in TestFlight and the App
        // Store — the NSLog compiles out, the IPC does not.
        #if DEBUG
        let isDebug = true
        #else
        let isDebug = false
        #endif
        // `--no-sw`: run with the service worker provably absent, to test whether
        // it is what stops late media loads. Injected at documentStart so the
        // flag is set before main.tsx reads it — the SW re-registers on every
        // launch, so unregistering at runtime cannot answer the question.
        let noSW = ProcessInfo.processInfo.arguments.contains("--no-sw")
        let script = WKUserScript(
            source: "window.__flatfoldIsIOSAppOnMac = \(isOnMac); window.__flatfoldDebug = \(isDebug); window.__flatfoldNoSW = \(noSW);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        bridge?.webView?.configuration.userContentController.addUserScript(script)

        if isOnMac { installMacInputBarHide() }

        hardenWebInspector()
        probeMacCapabilities()
    }

    // MARK: - Capability probe (DEBUG only)

    /// Report the two Mac flags and the WebView's actual media surface.
    ///
    /// These three facts have to be read TOGETHER or they mislead. The absence of
    /// `navigator.mediaDevices` was previously recorded as "Catalyst buys
    /// nothing", but it was measured on a build where the native recorder was
    /// gated on `isiOSAppOnMac` — false on Catalyst — so the plugin was inert and
    /// the web layer fell through to `getUserMedia` regardless of what the
    /// WebView could do. Whether Catalyst exposes the API is a SEPARATE question
    /// from whether the app used the native path, and only probing both in one
    /// launch tells them apart.
    private func probeMacCapabilities() {
        #if DEBUG
        // `os.Logger`, not NSLog: NSLog from this target produced NOTHING in the
        // unified log (the JS eval was visibly running in WebKit's own entries at
        // the same moment, so the code ran and only the logging was lost).
        // Every interpolation is `.public` — Logger redacts them to `<private>`
        // by default, which would have looked exactly like a failed probe.
        let probe = os.Logger(subsystem: "dev.flatfold", category: "probe")
        let info = ProcessInfo.processInfo
        probe.notice("""
        flags isiOSAppOnMac=\(info.isiOSAppOnMac, privacy: .public) \
        isMacCatalystApp=\(info.isMacCatalystApp, privacy: .public) \
        home=\(NSHomeDirectory(), privacy: .public)
        """)
        // The audio-budget harness (docs/redesign/PROMPT_MAC_AUDIO_FIX.md
        // Phase 1). Launched with:
        //
        //   open -n <App.app> --args --audio-harness
        //
        // It must run INSIDE this shell, not in a browser tab: the whole point
        // is the real media stack at the real origin (capacitor://localhost).
        // The audio-budget experiment runs INSIDE THE APP'S OWN PAGE.
        //
        // It was first written as a standalone page navigated to with
        // `webView.load`, and every measurement it produced was void: on that
        // page NOTHING loaded — not a blob, not a direct custom-scheme URL, not
        // a single element after a user gesture — while this very same WebView
        // loads 31 elements on the app's page. A harness that cannot reproduce
        // the working baseline cannot measure a deviation from it.
        //
        // Injecting into the real page keeps the origin, the CSP, the bridge and
        // whatever else index.html establishes, so the only variable is the one
        // being tested.
        // `--no-sw` also tears down anything already installed. Registration is
        // suppressed by the injected flag above, but a PREVIOUS launch's worker
        // survives in the profile and would still control this page.
        if ProcessInfo.processInfo.arguments.contains("--no-sw") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                let js = """
                const regs = await navigator.serviceWorker.getRegistrations();
                for (const r of regs) await r.unregister();
                for (const k of await caches.keys()) await caches.delete(k);
                return `SW regs=${regs.length} unregistered, caches cleared, ` +
                       `controlled=${!!navigator.serviceWorker.controller}`;
                """
                self?.bridge?.webView?.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
                    probe.notice("\(String(describing: r), privacy: .public)")
                }
            }
        }

        // Matches both `--audio-experiment` and `--audio-experiment=<condition>`.
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--audio-experiment") }) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 50) { [weak self] in
                self?.runAudioExperiment(probe)
            }
        }

        // Repeating, because the interesting state only appears after a chat is
        // open and voice notes have mounted — not at launch. 10s is slow enough
        // to stay readable in the log and fast enough to catch the transition
        // from "playing fine" to "out of resources".
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.logAudioCensus(probe)
        }

        // After load: the bridge's webView has no document at capacitorDidLoad.
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            // `supported` is the one that matters. It is what MessageInput.tsx
            // branches on, so it — not the presence of the plugin object —
            // decides whether the microphone works at all on this platform.
            // `callAsyncJavaScript`, not `evaluateJavaScript`: the latter cannot
            // await, so an async IIFE would come back as an unserialisable
            // Promise rather than the answer.
            let js = """
            return JSON.stringify({
              mediaDevices: typeof navigator.mediaDevices,
              getUserMedia: typeof navigator.mediaDevices?.getUserMedia,
              secure: window.isSecureContext,
              origin: location.origin,
              plugin: typeof window.Capacitor?.Plugins?.FlatFoldAudio,
              supported: await window.Capacitor?.Plugins?.FlatFoldAudio
                ?.isSupported().then(r => r.supported).catch(e => 'threw: ' + e)
            })
            """
            self?.bridge?.webView?.callAsyncJavaScript(
                js, arguments: [:], in: nil, in: .page
            ) { result in
                probe.notice("web=\(String(describing: result), privacy: .public)")
            }
        }
        #endif
    }

    /// One parameterised trial of the audio-loader experiment.
    ///
    /// The condition is a LAUNCH ARGUMENT, not source, so one build runs every
    /// condition. Editing probe JS per condition meant each one cost a rebuild,
    /// which made batches expensive and pushed the work toward n=1 — and n=1 is
    /// where every wrong conclusion in this investigation came from.
    ///
    /// Emits a single `FLATFOLD_EXP {json}` line for the runner to harvest.
    /// `appReady`/`appTotal` are the app's OWN notes and are the trial's
    /// baseline: a trial without one is discarded, because a drained pool fails
    /// totally and is indistinguishable from any hypothesis being tested.
    private func runAudioExperiment(_ probe: os.Logger) {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        func value(_ name: String) -> String? {
            if let a = args.first(where: { $0.hasPrefix("--\(name)=") }) {
                return String(a.dropFirst(name.count + 3))
            }
            if let i = args.firstIndex(of: "--\(name)") { return args.dropFirst(i + 1).first }
            return nil
        }
        let condition = value("audio-experiment") ?? "control"
        let trial = value("trial") ?? "0"
        // DEBUG-ONLY test credential, for unattended trials.
        //
        // The keystore gate blocks the chat, and with no chat there are no
        // notes and no trial. Every UI-automation route to it failed under the
        // runner while working by hand — the click lands, the Paste menu item
        // is enabled, the clipboard is populated, and the field stays empty —
        // which points at first responder in a freshly launched WKWebView.
        //
        // The tradeoff, stated rather than buried: this puts a plaintext
        // password into the web context. It is confined to `#if DEBUG`, so it
        // cannot exist in TestFlight or the App Store; it is a throwaway test
        // account, never the user's; it is never logged; and it arrives only
        // when the operator passes --unlock-pw explicitly. It is NOT a
        // mechanism the app has otherwise, and must never be reused for one.
        let unlockPw = value("unlock-pw") ?? ""

        let js = """
        // EVERY path returns a STRING.
        //
        // `callAsyncJavaScript` rejected with WKErrorDomain Code=5, "JavaScript
        // execution returned a result of an unsupported type", and a trial then
        // reported NO RESULT even though the app was correctly driven. Any path
        // that falls out without an explicit string return — a throw, or a
        // branch that ends without one — produces exactly that, and it is
        // indistinguishable from the probe never running.
        try {
        const condition = arguments0, trial = arguments1;
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const st = (e) => ({ ready: e.readyState, net: e.networkState, err: e.error?.code ?? null });

        // Unlock from the DOM if the gate is up. React owns this input, so
        // assigning .value is not enough — set it through the native setter and
        // dispatch the event React listens for, or the state never updates and
        // submitting sends an empty password.
        let unlocked = 'n/a';
        // POLL for the gate. A single check ran at a fixed delay after launch
        // and missed it whenever the app was still booting through Argon2/WASM
        // — roughly 40% of trials, every one of them then discarded for "app
        // rendered no notes". Waiting costs seconds; missing costs a trial.
        let pwField = null;
        if (arguments2) {
          for (let t = 0; t < 40 && !pwField; t++) {
            pwField = document.querySelector('input[type=password]');
            if (!pwField && document.querySelector('audio')) break; // already unlocked
            if (!pwField) await wait(1000);
          }
        }
        if (pwField && arguments2) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value').set;
          setter.call(pwField, arguments2);
          pwField.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(300);
          (pwField.form || pwField.closest('form'))?.requestSubmit?.();
          await wait(1000);
          if (!document.querySelector('input[type=password]')) unlocked = 'ok';
          else {
            const btn = [...document.querySelectorAll('button')]
              .find(b => /unlock/i.test(b.textContent || ''));
            if (btn) { btn.click(); await wait(2500); }
            unlocked = document.querySelector('input[type=password]') ? 'failed' : 'ok';
          }
          await wait(4000);
        }
        const mask = (els, f) => els.map(f).join('');

        // OPEN THE CONVERSATION FROM THE DOM, not with a synthetic click at a
        // screen coordinate. The chat row's position depends on window size,
        // layout (the narrow one-pane vs wide two-pane), and scroll — three
        // things that changed under an overnight batch and left every trial
        // measuring a chat list with no notes in it. In here we can just ask
        // for the link.
        let opened = '';
        if (!document.querySelector('audio')) {
          for (let t = 0; t < 20 && !document.querySelector('audio'); t++) {
            // Rows are BUTTONS with click handlers, not links — there is no
            // href to match on. Exclude the chrome by name rather than by
            // position, which is the thing that keeps changing.
            const skip = /search|panic|settings|new message|chats|contacts|theme/i;
            const row = [...document.querySelectorAll('button')]
              .find(b => (b.textContent || '').trim().length > 2 && !skip.test(b.textContent || ''));
            if (row) { opened = (row.textContent || '').trim().slice(0, 24); row.click(); await wait(3000); }
            else await wait(1000);
          }
        }

        // Baseline: wait for the conversation's own notes to settle.
        let app = [];
        for (let t = 0; t < 45; t++) {
          app = [...document.querySelectorAll('audio')];
          if (app.length && app.some(e => e.readyState >= 1 || e.networkState === 3)) break;
          await wait(1000);
        }
        await wait(4000);
        app = [...document.querySelectorAll('audio')];
        const appReady = app.filter(e => e.readyState >= 1).length;

        // Borrow a URL that PROVABLY loads, so the source is never the variable.
        const good = app.find(e => e.readyState >= 1);
        const srcOf = () => good ? good.src : null;

        const mine = [];
        // `host` is the uncontrolled variable from round 4: the probe appended
        // to document.body while the app's own elements live INSIDE the React
        // tree, in the scrolling message container. Containment was never
        // isolated from provenance, and it is just as plausible an explanation
        // for "added elements never load".
        const mk = (src, host) => {
          const a = document.createElement('audio');
          a.preload = 'metadata'; a.playsInline = true;
          if (src) a.src = src;
          (host || document.body).appendChild(a);
          mine.push(a);
          return a;
        };
        // The container the app's own working notes actually live in.
        const noteHost = () => (good && good.parentNode) ? good.parentNode : document.body;

        let note = '';
        if (condition === 'control') {
          // Baseline only. Interleaved through every batch: if the control
          // drifts, the batch is void and no condition in it can be trusted.
        } else if (condition === 'click3') {
          for (let i = 0; i < 3; i++) { mk(srcOf()); await wait(1500); }
          await wait(9000);
        } else if (condition === 'batch10') {
          // Batch vs timing: 10 at once. If several load where click3's 3 did
          // not, the variable is BATCH, not when the load starts.
          for (let i = 0; i < 10; i++) mk(srcOf());
          await wait(12000);
        } else if (condition === 'reinsert') {
          // Does an element keep its loader across DOM removal + re-insert?
          if (good) {
            const before = st(good);
            const parent = good.parentNode, next = good.nextSibling;
            good.remove(); await wait(2000); parent.insertBefore(good, next);
            await wait(8000);
            note = `before=${JSON.stringify(before)} after=${JSON.stringify(st(good))}`;
          }
        } else if (condition === 'delayed3') {
          // Same as click3 but created OUTSIDE any user-activation window.
          await wait(2000);
          for (let i = 0; i < 3; i++) { mk(srcOf()); await wait(1500); }
          await wait(9000);
        } else if (condition === 'container3') {
          // Same as click3, but inserted into the container that holds the
          // app's own loaded notes. If THESE load and click3's do not, the
          // answer is DOM containment, not how the element was created.
          for (let i = 0; i < 3; i++) { mk(srcOf(), noteHost()); await wait(1500); }
          await wait(9000);
        } else if (condition === 'clone3') {
          // Clone elements the app itself rendered and reinsert the clones
          // beside the originals. Closest possible copy of a working element:
          // same attributes, same source, same parent — differing only in that
          // React did not create it.
          for (let i = 0; i < 3; i++) {
            if (!good) break;
            const c = good.cloneNode(true);
            good.parentNode.appendChild(c);
            mine.push(c);
            await wait(1500);
          }
          await wait(9000);
        } else if (condition === 'react3') {
          // Ask REACT to render the elements (components/debug/ExperimentAudio).
          // Every imperative variant loads zero, including a clone of a working
          // element in its own parent, so this tests the surviving hypothesis
          // directly instead of by elimination: does an element created inside
          // React's commit get a media loader where an appended one does not?
          window.dispatchEvent(new CustomEvent('flatfold:exp-audio',
            { detail: { count: 3, src: srcOf() } }));
          await wait(12000);
          mine.push(...document.querySelectorAll('audio[data-exp="react"]'));
        } else if (condition === 'remount') {
          // THE FIX CANDIDATE. If a loader is granted only at a view's first
          // render, then unmounting the conversation and rendering it again
          // should rescue the stalled tail — the notes are part of a FRESH
          // initial render, not additions to a mounted one.
          //
          // ROUND3_BRIEF §7 says not to try this, reasoning that a remount is
          // still a late load. That reasoning is wrong under the round-5 model,
          // which is why this is measured rather than assumed.
          const before = app.filter(e => e.readyState >= 1).length;
          const skipNav = /search|panic|settings|new message|theme/i;
          // history.back() rather than hunting for a tab button: the first
          // attempt looked for text matching /contacts/i and found nothing
          // (navAway=false), so no remount happened and before==after said
          // nothing at all. The router owns the route, so pop it directly.
          // Drive the router directly. `history.back()` did not move the route
          // (navAway=false) — entering a conversation evidently does not push a
          // history entry — so pop it by pushing the list route and telling the
          // router about it, which is what React Router listens for.
          const fromRoute = location.pathname;
          history.pushState({}, '', '/chat');
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
          await wait(3500);
          const leftRoute = !document.querySelector('audio');
          // Re-enter the conversation, which mounts the view afresh.
          const row = [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').trim().length > 2 && !skipNav.test(b.textContent || '') && !/chats|contacts/i.test(b.textContent || ''));
          if (row) { row.click(); await wait(14000); }
          const navAway = leftRoute;
          const now = [...document.querySelectorAll('audio')];
          const after = now.filter(e => e.readyState >= 1).length;
          note = `before=${before}/${app.length} after=${after}/${now.length} navAway=${!!navAway}`;
          app = now;
        } else if (condition === 'fixture3') {
          // 3 elements from the generated fixture rather than a real note, to
          // confirm the source stays irrelevant under the cooled protocol.
          const buf = await (await fetch('/fixture.m4a')).arrayBuffer();
          for (let i = 0; i < 3; i++) { mk(URL.createObjectURL(new Blob([buf.slice(0)], {type:'audio/mp4'}))); await wait(1500); }
          await wait(9000);
        } else {
          note = 'unknown condition';
        }

        const out = {
          trial: Number(trial), condition,
          appReady, appTotal: app.length,
          expReady: mine.filter(e => e.readyState >= 1).length,
          expTotal: mine.length,
          readyMask: mask(mine, e => e.readyState),
          netMask: mask(mine, e => e.networkState),
          errors: mine.map(e => e.error?.code ?? null).filter(c => c !== null),
          appReadyMask: mask(app, e => e.readyState),
          borrowedRealUrl: !!good,
          opened, unlocked,
          note,
        };
        mine.forEach(e => { e.removeAttribute('src'); e.remove(); });
        return 'FLATFOLD_EXP ' + JSON.stringify(out);
        } catch (e) {
          return 'FLATFOLD_EXP ' + JSON.stringify({
            trial: Number(arguments1), condition: arguments0,
            appReady: 0, appTotal: 0, expReady: 0, expTotal: 0,
            readyMask: '', netMask: '', errors: [], appReadyMask: '',
            borrowedRealUrl: false,
            note: 'probe threw: ' + (e && e.message ? e.message : String(e)),
          });
        }
        """
        bridge?.webView?.callAsyncJavaScript(
            js, arguments: ["arguments0": condition, "arguments1": trial, "arguments2": unlockPw], in: nil, in: .page
        ) { result in
            switch result {
            case .success(let v): probe.notice("\(String(describing: v), privacy: .public)")
            case .failure(let e): probe.notice("FLATFOLD_EXP_FAIL \(String(describing: e), privacy: .public)")
            }
        }
        #endif
    }

    /// Census both audio pools in one shot, so they can be told apart.
    ///
    /// The <audio> side reports per-element `readyState`/`networkState`/`error`,
    /// because "how many elements exist" is not the question — "how many are
    /// holding a decoder" is. The Web Audio side reports the module's own queue
    /// state from `audioContext.ts`.
    ///
    /// Reading one without the other is what made this bug expensive: a note
    /// that FAILS with code 4 and a note that HANGS with no duration look the
    /// same to a user and come from opposite pools.
    private func logAudioCensus(_ probe: os.Logger) {
        #if DEBUG
        // The harness accumulates its results on `window.__harnessOut` for
        // exactly this reason: console.log from a WKWebView reaches neither the
        // unified log nor any console when launched outside Xcode, so a harness
        // that only printed would be unreadable on the platform it tests.
        let js = """
        if (window.__harnessOut) {
          const drained = window.__harnessOut.splice(0);
          if (drained.length) return 'HARNESS ' + drained.join(' | ');
        }
        const els = [...document.querySelectorAll('audio')];
        return JSON.stringify({
          audioEls: els.length,
          withSrc: els.filter(e => !!e.currentSrc || !!e.getAttribute('src')).length,
          ready: els.map(e => e.readyState).join(''),
          network: els.map(e => e.networkState).join(''),
          errs: els.map(e => e.error?.code ?? '-').join(''),
          pool: window.__flatfoldAudioStats?.() ?? 'absent'
        })
        """
        bridge?.webView?.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                probe.notice("census=\(String(describing: value), privacy: .public)")
            case .failure(let err):
                probe.notice("census failed=\(String(describing: err), privacy: .public)")
            }
        }
        #endif
    }


    // MARK: - The ghost row (Mac only)

    /// Hide the input host view that iPadOS docks at the bottom of the screen on
    /// a Mac. THIS is the ghost row, and this is the fix.
    ///
    /// It took six attempts because the first five went after the wrong object,
    /// so the ruled-out list is worth more than the fix. All of this is measured
    /// from a runtime dump of every window, not reasoned:
    ///
    ///   - NOT the web layer. Three CSS attempts failed; the bar is UIKit, and it
    ///     lives in UITextEffectsWindow at level 1, NOT the app's own UIWindow.
    ///     A hierarchy dump scoped to the app window comes back clean and reads as
    ///     a false negative.
    ///   - NOT `inputAccessoryView`. The dump reported `.inputAccessoryView = nil`
    ///     on the first responder WHILE the bar was on screen. Nilling it, which
    ///     is what @capacitor/keyboard swizzles for, cannot be the answer.
    ///   - NOT `inputAssistantItem`. Cleared on the WKWebView and then, once the
    ///     lookup was fixed, on the WKContentView too. The bar's 44pt UIInputView
    ///     stayed 44pt both times.
    ///   - NOT the keyboard height. The software keyboard inside this host view is
    ///     already 0pt on a Mac, so keyboard suppression was working the whole
    ///     time and the original phantom-height theory was a red herring.
    ///
    /// What remains is blunt: hide `UIInputSetHostView` outright. That is safe
    /// HERE SPECIFICALLY because the same dump proves there is no real keyboard UI
    /// inside it to lose on a Mac. Re-applied on every keyboard notification
    /// because UIKit rebuilds the view per input session.
    ///
    /// Scoped to `isiOSAppOnMac`, so iPhone and iPad are untouched — they get a
    /// real software keyboard in this exact view and must keep it.
    private func installMacInputBarHide() {
        for note in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardDidShowNotification] {
            NotificationCenter.default.addObserver(forName: note, object: nil, queue: .main) { [weak self] _ in
                self?.hideMacInputHostView()
            }
        }
    }

    private func hideMacInputHostView() {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows where NSStringFromClass(type(of: window)) == "UITextEffectsWindow" {
                for container in window.subviews {
                    for host in container.subviews
                    where NSStringFromClass(type(of: host)) == "UIInputSetHostView" && !host.isHidden {
                        host.isHidden = true
                    }
                }
            }
        }
    }

    // MARK: - Hardening

    /// A shipped build must never expose the WKWebView to the Safari Web
    /// Inspector — decrypted message content and the bearer token live in this
    /// webview, and an inspectable webview on a trusted, unlocked device is a
    /// plaintext window. Capacitor already gates `isInspectable` behind its own
    /// `#if DEBUG`; this asserts it explicitly so the guarantee is auditable in
    /// OUR code and cannot regress if the framework's internal default changes.
    ///
    /// This used to live inside the Mac-only accessory-view suppression, which
    /// meant it ran ONLY when `isiOSAppOnMac` — so on a real iPhone Release build
    /// it never executed at all. Now unconditional, which is what build-order
    /// step 7 always intended.
    ///
    /// Debug builds keep inspection for on-device development: the block compiles
    /// out entirely there.
    private func hardenWebInspector() {
        #if !DEBUG
        if #available(iOS 16.4, *) {
            bridge?.webView?.isInspectable = false
        }
        #endif
    }
}
