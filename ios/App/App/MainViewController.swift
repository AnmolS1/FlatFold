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

        if ProcessInfo.processInfo.arguments.contains("--audio-experiment") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
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

    /// The element-budget experiment, run in the app's own page.
    ///
    /// Answers one question: with the app's real conversation already rendered,
    /// how many ADDITIONAL `<audio>` elements can reach `readyState >= 1`? That
    /// is the ceiling the fix in `347944c` assumes exists, and its real value.
    private func runAudioExperiment(_ probe: os.Logger) {
        #if DEBUG
        // SINGLETON ONLY, and deliberately frugal.
        //
        // The resource this measures is system-wide and is NOT returned when the
        // process exits — only a reboot restores it (measured: 0/39 elements
        // loaded before a reboot, 28/39 after, on identical code). So a fresh
        // machine is a consumable, and the earlier 1→80 element sweep spent the
        // whole thing and then reported "there is no ceiling" from an exhausted
        // pool. One element, reused, is the only question worth that budget.
        //
        // It answers: can ONE element serve many notes by swapping `src`, and
        // does each swap RELEASE the previous pipeline or leak it? A leak shows
        // up as a failure partway through, at roughly the remaining headroom.
        // THE CONTROL THAT WAS MISSING ALL ALONG.
        //
        // Every previous experiment used a fixture generated with `say` +
        // `afconvert`, and NONE of them ever checked that fixture against a
        // source known to work in this app. A source WebKit will not open
        // stalls exactly like an exhausted pool — networkState 2, readyState 0,
        // `error` null — so a bad fixture is indistinguishable from the bug
        // being investigated, and would make every result look like a resource
        // failure. That is very likely what happened.
        //
        // So: wait for the app's own notes to render, take the blob URL of one
        // that PROVABLY loaded, and build a fresh element around that exact
        // URL. Then the only variable is programmatic-vs-React creation.
        let js = """
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        // Wait for a conversation with at least one LOADED note.
        let good = null;
        for (let t = 0; t < 60 && !good; t++) {
          good = [...document.querySelectorAll('audio')].find(e => e.readyState >= 1) || null;
          if (!good) await wait(1000);
        }
        if (!good) return 'CONTROL no loaded note found — open a conversation';

        const els = [...document.querySelectorAll('audio')];
        const appState = `appReady=${els.filter(e=>e.readyState>=1).length}/${els.length}`;

        // DOES SWAPPING `src` REUSE THE PIPELINE, OR ASK FOR A NEW ONE?
        //
        // This is the question the singleton design turns on, and it can be
        // answered without a free pool: take an element that ALREADY HAS a
        // pipeline (readyState >= 1) and repoint it at a note that is stalled
        // for want of one. If it loads, swapping reuses — one element can serve
        // every note and the fix is a singleton. If it stalls, a swap requests a
        // fresh pipeline and a singleton buys nothing.
        const stalled = [...document.querySelectorAll('audio')]
          .find(e => e.readyState === 0 && e.networkState === 2);
        if (!stalled) return `SWAP no stalled note to borrow — ${appState}`;

        const target = stalled.src;
        const st = (e) => `ready=${e.readyState} net=${e.networkState} err=${e.error?.code ?? '-'}`;
        const beforeGood = st(good);

        good.src = target;
        good.load();
        await wait(8000);

        return `SWAP ${appState} | donorBefore ${beforeGood} | donorAfterSwap ${st(good)} | stalledOriginal ${st(stalled)}`;
        """
        bridge?.webView?.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let v): probe.notice("\(String(describing: v), privacy: .public)")
            case .failure(let e): probe.notice("EXPERIMENT failed=\(String(describing: e), privacy: .public)")
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
