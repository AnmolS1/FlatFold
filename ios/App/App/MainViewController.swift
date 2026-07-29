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
        // `__flatfoldNativeAudio`: play voice notes through the plugin instead of
        // an <audio> element.
        //
        // INJECTED, RATHER THAN ASKED FOR, because of WHEN it is needed. The
        // recorder's capability check is a plugin call on a user gesture and can
        // afford to be async. This one is read during React's FIRST RENDER: if it
        // resolved even a tick late, every note would mount an <audio src> first
        // and spend the very loader grant the native path exists to avoid. A
        // documentStart injection is set before any app code runs.
        let nativeAudio = FlatFoldAudioPlugin.isMacShell
        let script = WKUserScript(
            source: "window.__flatfoldIsIOSAppOnMac = \(isOnMac); window.__flatfoldDebug = \(isDebug); window.__flatfoldNoSW = \(noSW); window.__flatfoldNativeAudio = \(nativeAudio);",
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
        // The audio-budget harness (docs/redesign/MAC_AUDIO_FINDINGS.md).
        // Launched with:
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

        // Can a SIMULATOR reach a logged-in state? STATUS.md records that it
        // cannot — Argon2 and HPKE WebAssembly segfault there — and that claim
        // gates every screenshot plan, because the simulator is the only thing
        // that renders the real native chrome at exact device pixel sizes.
        // Worth re-measuring rather than inheriting.
        // `--scene=<name>`: park the app on a named screen and say when it is
        // settled, so a screenshot run is deterministic instead of a sleep.
        if let sceneArg = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--scene=") }) {
            let scene = String(sceneArg.dropFirst("--scene=".count))
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                self?.showScene(scene, probe)
            }
        }

        if ProcessInfo.processInfo.arguments.contains("--verify-login") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                self?.verifyLogin(probe)
            }
        }

        if ProcessInfo.processInfo.arguments.contains("--verify-links") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                self?.verifyExternalLinks(probe)
            }
        }

        if ProcessInfo.processInfo.arguments.contains("--verify-audio") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                self?.verifyNativeAudio(probe)
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
    /// Park the app on a named screen for a screenshot, and report when it has
    /// settled. Deterministic, so a capture never races the render.
    ///
    /// Only screens reachable WITHOUT an account are here. That is a real limit,
    /// not a design choice — see the note in the screenshot script.
    private func showScene(_ scene: String, _ probe: os.Logger) {
        #if DEBUG
        let js = """
        try {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const scene = arguments0;
        for (let t = 0; t < 30 && !document.querySelector('form, main, h1'); t++) await wait(500);

        const setNative = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
        };

        // Unlock the keystore if the gate is up. A relaunch always re-locks it —
        // the key is derived from the password and never stored — so every scene
        // after a signup needs this, and the first attempt at a chat screenshot
        // photographed the unlock gate instead.
        if (scene !== 'signup' && scene !== 'login' && scene !== 'transparency' && arguments2) {
          // POLL for the gate. Checking once ran before the gate had rendered,
          // skipped the unlock entirely, and photographed the unlock screen —
          // the third time in this session that a single timed check has been
          // mistaken for a missing element.
          window.__ffdbg = { pwLen: String(arguments2 || '').length };
          let gate = null;
          for (let t = 0; t < 40 && !gate; t++) {
            gate = document.querySelector('input[type=password]');
            if (!gate && document.querySelector('button[aria-label="Settings"]')) break; // already unlocked
            if (!gate) await wait(500);
          }
          // "Is this the unlock gate or the login form?" cannot be answered by
          // the PRESENCE of a username field: the unlock gate deliberately
          // carries a HIDDEN one so password managers will autofill it. Ask
          // whether it is visible instead. This cost a build cycle and three
          // screenshots of the unlock screen.
          const uname = document.querySelector('input[autocomplete="username"]');
          const unameVisible = !!uname && uname.offsetParent !== null;
          window.__ffdbg.gate = !!gate;
          window.__ffdbg.unameVisible = unameVisible;
          if (gate && !unameVisible) {
            setNative(gate, arguments2);
            await wait(300);
            const sb = (gate.form || gate.closest('form'))?.querySelector('button[type=submit]');
            window.__ffdbg.filled = gate.value.length;
            window.__ffdbg.btn = !!sb;
            window.__ffdbg.btnDisabled = sb ? sb.disabled : null;
            sb?.click();
            for (let t = 0; t < 60 && document.querySelector('input[type=password]'); t++) await wait(1000);
            // Drop focus, or the software keyboard stays up and eats half the
            // screenshot.
            document.activeElement?.blur?.();
            await wait(3000);
          }
        }

        if (scene === 'signup') {
          // Create a fresh account so the screenshots can show a real, SEEDED
          // conversation. Deliberately NOT a borrowed real account: history is
          // on-device only (so a real login shows an empty app anyway), and a
          // marketing screenshot should never carry someone's actual messages.
          const tab = [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').trim() === 'Sign Up');
          tab?.click();
          await wait(800);
          const u = document.querySelector('input[autocomplete="username"]');
          const p = document.querySelector('input[autocomplete="new-password"]');
          if (!u || !p) return 'FLATFOLD_SCENE ' + JSON.stringify({ scene, ok: false, note: 'signup fields missing' });
          setNative(u, arguments1); setNative(p, arguments2);
          await wait(400);
          // The submit button INSIDE the form — matching on the text "Sign Up"
          // finds the tab, which sits earlier in the DOM.
          (p.form || p.closest('form'))?.querySelector('button[type=submit]')?.click();
          for (let t = 0; t < 90; t++) {
            await wait(1000);
            if (!document.querySelector('input[autocomplete="new-password"]')) break;
          }
          await wait(4000);
          return 'FLATFOLD_SCENE ' + JSON.stringify({
            scene, ok: !document.querySelector('input[autocomplete="new-password"]'),
            path: location.pathname, user: arguments1,
          });
        }

        if (scene === 'chat' || scene === 'contacts' || scene === 'settings') {
          const byText = (t) => [...document.querySelectorAll('button')]
            .find(b => (b.textContent || '').trim() === t);
          for (let t = 0; t < 30 && !byText('Chats') && !document.querySelector('button[aria-label="Settings"]'); t++) await wait(1000);
          if (scene === 'contacts') { byText('Contacts')?.click(); await wait(2000); }
          if (scene === 'settings') {
            (document.querySelector('button[aria-label="Settings"]') ?? byText('Settings'))?.click();
            await wait(2500);
          }
          if (scene === 'chat') {
            byText('Chats')?.click(); await wait(1200);
            const skip = /search|panic|settings|new message|chats|contacts|theme/i;
            const row = [...document.querySelectorAll('button')]
              .find(b => (b.textContent || '').trim().length > 2 && !skip.test(b.textContent || ''));
            row?.click(); await wait(2500);
            // Reply, so the screenshot shows BOTH bubble styles. A one-sided
            // conversation reads as an empty app in a store listing.
            if (arguments3) {
              const box = document.querySelector('textarea');
              if (box) {
                const setter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value').set;
                for (const line of arguments3.split('|')) {
                  setter.call(box, line);
                  box.dispatchEvent(new Event('input', { bubbles: true }));
                  await wait(500);
                  (box.form || box.closest('form'))?.querySelector('button[type=submit]')?.click();
                  await wait(2500);
                }
                box.blur();
                await wait(2500);
              }
            }
          }
        }

        if (scene === 'transparency') {
          // Reachable from TWO places, and which one exists depends on whether
          // you are signed in: a link on the login screen, and Settings → About
          // → "What the server stores" once you are. Handling only the first
          // broke this scene the moment the run became a logged-in one.
          // Navigate the ROUTER directly. Clicking a link meant finding it, and
          // it lives in two different places depending on sign-in state — the
          // login screen, or Settings → About. Pushing the route works from
          // either, and from a state where neither is on screen.
          if (!/transparency/.test(location.pathname)) {
            history.pushState({}, '', '/transparency');
            dispatchEvent(new PopStateEvent('popstate'));
            for (let t = 0; t < 20 && !/transparency/.test(location.pathname); t++) await wait(400);
            await wait(2500);
          }
          let a = /transparency/.test(location.pathname) ? true : [...document.querySelectorAll('a')]
            .find(x => /what the server stores/i.test(x.textContent || ''));
          if (!a) {
            const sb = document.querySelector('button[aria-label="Settings"]')
              ?? [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Settings');
            sb?.click();
            for (let t = 0; t < 20 && !a; t++) {
              await wait(800);
              a = [...document.querySelectorAll('a')]
                .find(x => /what the server stores/i.test(x.textContent || ''));
            }
          }
          if (!a) return 'FLATFOLD_SCENE ' + JSON.stringify({ scene, ok: false, note: 'link not found' });
          if (a !== true) a.click();
          for (let t = 0; t < 30 && !/transparency/.test(location.pathname); t++) await wait(500);
          await wait(1500); // let the table paint
        }

        // Settled = a full frame has rendered with no pending layout work.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        return 'FLATFOLD_SCENE ' + JSON.stringify({
          scene, ok: true, path: location.pathname,
          title: (document.querySelector('h1,h2')?.textContent || '').trim().slice(0, 40),
          dbg: window.__ffdbg,
        });
        } catch (e) {
          return 'FLATFOLD_SCENE ' + JSON.stringify({ scene: arguments0, ok: false, note: String(e) });
        }
        """
        let args2 = ProcessInfo.processInfo.arguments
        func val(_ n: String) -> String {
            (args2.first(where: { $0.hasPrefix("--\(n)=") }).map { String($0.dropFirst(n.count + 3)) }) ?? ""
        }
        bridge?.webView?.callAsyncJavaScript(
            js, arguments: [
                "arguments0": scene, "arguments1": val("seed-user"),
                "arguments2": val("seed-pw"), "arguments3": val("seed-reply"),
            ],
            in: nil, in: .page
        ) { result in
            switch result {
            case .success(let v):
                probe.notice("\(String(describing: v), privacy: .public)")
                print("PROBE \(String(describing: v))")
            case .failure(let e):
                print("PROBE_FAIL \(String(describing: e))")
            }
        }
        #endif
    }

    /// Drive a real login, and report how far it got.
    ///
    /// DEBUG-only, and it carries the same stated tradeoff as `--unlock-pw`: a
    /// throwaway test credential reaches the web context, only when the operator
    /// passes it explicitly, and it is never logged.
    private func verifyLogin(_ probe: os.Logger) {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        func value(_ name: String) -> String? {
            if let a = args.first(where: { $0.hasPrefix("--\(name)=") }) {
                return String(a.dropFirst(name.count + 3))
            }
            if let i = args.firstIndex(of: "--\(name)") { return args.dropFirst(i + 1).first }
            return nil
        }
        let js = """
        try {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        // React owns these inputs, so assigning .value is not enough — go
        // through the native setter and dispatch the event React listens for.
        const setNative = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const stage = () => {
          if (document.querySelector('input[autocomplete="username"]')) return 'login';
          if (document.querySelector('input[type=password]')) return 'unlock';
          if (document.querySelector('button[aria-label="Settings"]')) return 'chat';
          if ([...document.querySelectorAll('button')].some(b => (b.textContent||'').trim() === 'Settings')) return 'chat';
          return 'unknown';
        };

        for (let t = 0; t < 40 && stage() === 'unknown'; t++) await wait(1000);
        const reached = [stage()];

        const user = document.querySelector('input[autocomplete="username"]');
        const pass = document.querySelector('input[autocomplete="current-password"]')
          ?? document.querySelector('input[type=password]');
        if (user && pass && arguments0 && arguments1) {
          setNative(user, arguments0);
          setNative(pass, arguments1);
          await wait(400);
          // Click the submit button INSIDE THE FORM. Two earlier attempts both
          // reported "still on login, no error" — which reads as a rejected
          // credential and is not: `requestSubmit()` did nothing, and matching
          // a button by the text "Login" found the Login/Sign Up TAB, which
          // appears earlier in the DOM and whose click just re-selects the tab
          // that is already active. Scoping to the form is what distinguishes
          // them; there is no text that does.
          const form = pass.form || pass.closest('form');
          const btn = form?.querySelector('button[type=submit]');
          if (btn) btn.click();
          else form?.requestSubmit?.();
          // Argon2 is deliberately slow; give it room before calling it dead.
          for (let t = 0; t < 60; t++) {
            await wait(1000);
            const st = stage();
            if (st !== reached[reached.length - 1]) reached.push(st);
            if (st === 'chat') break;
          }
        }
        const err = [...document.querySelectorAll('p,div')]
          .map(e => (e.textContent || '').trim())
          .filter(t => t.length < 140 && /incorrect|failed|error|wrong|unable/i.test(t));
        return 'FLATFOLD_LOGIN ' + JSON.stringify({
          reached, stage: stage(), errors: err.slice(0, 2),
          totp: !!document.querySelector('input[autocomplete="one-time-code"]'),
        });
        } catch (e) {
          return 'FLATFOLD_LOGIN ' + JSON.stringify({ note: 'probe threw: ' + (e && e.message ? e.message : String(e)) });
        }
        """
        bridge?.webView?.callAsyncJavaScript(
            js, arguments: ["arguments0": value("login-user") ?? "", "arguments1": value("unlock-pw") ?? ""],
            in: nil, in: .page
        ) { result in
            switch result {
            case .success(let v):
                probe.notice("\(String(describing: v), privacy: .public)")
                print("PROBE \(String(describing: v))")
            case .failure(let e):
                probe.notice("FLATFOLD_LOGIN_FAIL \(String(describing: e), privacy: .public)")
                print("PROBE_FAIL \(String(describing: e))")
            }
        }
        #endif
    }

    /// Does an external link strand the WebView?
    ///
    /// THE RISK, stated precisely: in a `capacitor://localhost` WebView an
    /// `<a href="https://…">` that navigates the MAIN FRAME would replace the
    /// app with a web page, and there is no browser chrome to come back from —
    /// the user would have to force-quit. Settings → About carries four such
    /// links, so this is worth answering with a measurement rather than a
    /// reading of Capacitor's source.
    ///
    /// What the source says, for comparison: `WebViewDelegationHandler`
    /// CANCELS any top-level navigation to a non-application URL and hands it to
    /// `UIApplication.shared.open`, and separately handles `target="_blank"` in
    /// `createWebViewWith` the same way. `allowNavigation` would override that,
    /// and this app configures none. So the prediction is "never strands".
    ///
    /// Reads `location.href` before and after clicking the REAL link, rather
    /// than a synthesised one — provenance has mattered before in this codebase.
    private func verifyExternalLinks(_ probe: os.Logger) {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        func value(_ name: String) -> String? {
            if let a = args.first(where: { $0.hasPrefix("--\(name)=") }) {
                return String(a.dropFirst(name.count + 3))
            }
            if let i = args.firstIndex(of: "--\(name)") { return args.dropFirst(i + 1).first }
            return nil
        }
        let js = """
        try {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        // Settings has TWO homes and the probe must accept either: a header
        // glyph with aria-label="Settings" on a wide window, and a bottom
        // tab-bar item labelled by its TEXT on a narrow one (chatChrome.ts
        // showHeaderSettings). The first version of this probe looked only for
        // the aria-label, found nothing on a default-sized Catalyst window, and
        // reported "no View source link" — which reads as a missing link rather
        // than a probe that never opened the dialog.
        const settingsBtn = () => document.querySelector('button[aria-label="Settings"]')
          ?? [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Settings');
        const byLabel = (l) => l === 'Settings' ? settingsBtn() : document.querySelector(`button[aria-label="${l}"]`);

        let unlocked = 'n/a';
        let pwField = null;
        if (arguments0) {
          for (let t = 0; t < 40 && !pwField; t++) {
            pwField = document.querySelector('input[type=password]');
            if (!pwField && byLabel('Settings')) break;
            if (!pwField) await wait(1000);
          }
        }
        if (pwField && arguments0) {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value').set;
          setter.call(pwField, arguments0);
          pwField.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(300);
          (pwField.form || pwField.closest('form'))?.requestSubmit?.();
          await wait(2500);
          unlocked = document.querySelector('input[type=password]') ? 'failed' : 'ok';
          await wait(2000);
        }

        // Settings is a dialog off the chat surface, so the chat has to be up.
        for (let t = 0; t < 25 && !byLabel('Settings'); t++) await wait(1000);
        const hadSettingsBtn = !!byLabel('Settings');
        byLabel('Settings')?.click();

        // POLL for the link rather than waiting a fixed beat. The dialog mounts
        // a long scrolling form and the first attempt at this reported "no View
        // source link found" purely because 2.5s was not enough.
        const find = () => [...document.querySelectorAll('a')]
          .find(a => /view source/i.test(a.textContent || ''));
        let link = null;
        for (let t = 0; t < 20 && !link; t++) { link = find(); if (!link) await wait(1000); }

        if (!link) return 'FLATFOLD_LINKS ' + JSON.stringify({
          unlocked, note: 'no View source link found', hadSettingsBtn,
          anchors: document.querySelectorAll('a').length,
          anchorText: [...document.querySelectorAll('a')].map(a => (a.textContent || '').trim().slice(0, 20)).slice(0, 12),
          dialogs: document.querySelectorAll('[role=dialog]').length,
        });

        // Every external link in About, not just the one. They share a pattern,
        // but "shares a pattern" is an argument and this is a measurement.
        const wanted = ['view source', 'support', 'privacy policy', 'terms'];
        const results = [];
        for (const label of wanted) {
          const a = [...document.querySelectorAll('a')]
            .find(x => (x.textContent || '').trim().toLowerCase() === label);
          if (!a) { results.push({ label, found: false }); continue; }
          const before = location.href;
          a.click();
          await wait(2500);
          results.push({
            label, found: true,
            href: a.getAttribute('href'),
            target: a.getAttribute('target'),
            stranded: location.href !== before,
          });
          if (location.href !== before) break; // stranded: nothing after this is meaningful
        }

        return 'FLATFOLD_LINKS ' + JSON.stringify({
          unlocked,
          results,
          anyStranded: results.some(r => r.stranded),
          allFound: results.every(r => r.found),
          endedAt: location.href,
          stillHasApp: !!byLabel('Settings') || !!document.querySelector('input[type=password]'),
        });
        } catch (e) {
          return 'FLATFOLD_LINKS ' + JSON.stringify({ note: 'probe threw: ' + (e && e.message ? e.message : String(e)) });
        }
        """
        runProbeJS(js, pw: value("unlock-pw") ?? "", newNote: "no", probe)
        #endif
    }

    /// Verify NATIVE voice-note playback end to end, unattended.
    ///
    /// Replaces the `--audio-experiment` conditions, which measured `<audio>`
    /// elements — the exact thing this platform no longer renders. The unlock and
    /// open-the-conversation preamble is kept verbatim, because both were paid
    /// for: every UI-automation route to the keystore gate failed under a runner
    /// while working by hand, and a batch once measured a chat list with no notes
    /// in it because the row was found by screen position rather than by name.
    ///
    /// Answers the checks that can be answered without a second device: no
    /// `<audio>` elements exist, every note plays including the tail, notes play
    /// in any order and repeatedly, and a paused note resumes where it stopped.
    /// The resume position is read from the PLUGIN'S OWN LOG (`from=` / `resume
    /// at=`) rather than the DOM, because the DOM only shows a waveform and the
    /// number that matters is the one Swift actually seeked to.
    private func verifyNativeAudio(_ probe: os.Logger) {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        func value(_ name: String) -> String? {
            if let a = args.first(where: { $0.hasPrefix("--\(name)=") }) {
                return String(a.dropFirst(name.count + 3))
            }
            if let i = args.firstIndex(of: "--\(name)") { return args.dropFirst(i + 1).first }
            return nil
        }
        // DEBUG-ONLY test credential, for unattended runs.
        //
        // The keystore gate blocks the chat, and with no chat there are no notes
        // and nothing to verify. The tradeoff, stated rather than buried: this
        // puts a plaintext password into the web context. It is confined to
        // `#if DEBUG`, so it cannot exist in TestFlight or the App Store; it is a
        // throwaway test account, never the user's; it is never logged; and it
        // arrives only when the operator passes --unlock-pw explicitly. It is NOT
        // a mechanism the app has otherwise, and must never be reused for one.
        let unlockPw = value("unlock-pw") ?? ""

        let js = """
        // EVERY path returns a STRING. `callAsyncJavaScript` rejects with
        // WKErrorDomain Code=5 for any other result type, and that failure is
        // indistinguishable from the probe never having run.
        try {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        // The play/pause control, per note. Found by accessible name, which is
        // the app's own contract with a screen reader and therefore the most
        // stable handle in the DOM.
        //
        // BOTH LABELS, EXACTLY. A suffix match on "voice note" also caught the
        // composer's "Record a voice note" button, and the first run of this
        // probe duly clicked it — starting a real recording, and then reporting
        // the note it could not pause as a playback failure.
        const notes = () => [...document.querySelectorAll(
          'button[aria-label="Play voice note"], button[aria-label="Pause voice note"]')];
        const isPlaying = (b) => /^Pause/.test(b.getAttribute('aria-label') || '');

        let unlocked = 'n/a';
        let pwField = null;
        if (arguments0) {
          // POLL for the gate. A single check at a fixed delay missed it whenever
          // the app was still booting through Argon2/WASM — roughly 40% of runs.
          for (let t = 0; t < 40 && !pwField; t++) {
            pwField = document.querySelector('input[type=password]');
            if (!pwField && notes().length) break; // already unlocked
            if (!pwField) await wait(1000);
          }
        }
        if (pwField && arguments0) {
          // React owns this input, so assigning .value is not enough — set it
          // through the native setter and dispatch the event React listens for,
          // or the state never updates and submitting sends an empty password.
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value').set;
          setter.call(pwField, arguments0);
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

        // OPEN THE CONVERSATION FROM THE DOM, not with a synthetic click at a
        // screen coordinate. The row's position depends on window size, layout
        // and scroll — three things that changed under an overnight batch.
        let opened = '';
        if (!notes().length) {
          for (let t = 0; t < 20 && !notes().length; t++) {
            const skip = /search|panic|settings|new message|chats|contacts|theme/i;
            const row = [...document.querySelectorAll('button')]
              .find(b => (b.textContent || '').trim().length > 2 && !skip.test(b.textContent || ''));
            if (row) { opened = (row.textContent || '').trim().slice(0, 24); row.click(); await wait(3000); }
            else await wait(1000);
          }
        }
        for (let t = 0; t < 20 && !notes().length; t++) await wait(1000);

        const all = notes();
        const audioEls = document.querySelectorAll('audio').length;
        const errText = () => [...document.querySelectorAll('p')]
          .map(p => p.textContent || '').filter(t => /play|audio|resourc|unavail/i.test(t));

        // CHECK 1 + 3: every note plays, including the ones past the old ~30
        // line. Clicking the next note stops the previous one natively, so this
        // is also the "in any order, repeatedly" pass at its most demanding —
        // forty starts back to back with no reload in between.
        // CHECKED AT 250ms, not at 900ms. The shortest note in the test
        // conversation is 0.58s, so a late check catches it after it has
        // already finished and reads a successful play as a failure.
        const failed = [];
        for (let i = 0; i < all.length; i++) {
          all[i].click();
          await wait(250);
          if (!isPlaying(all[i])) failed.push(i);
          await wait(650);
        }
        const errorsAfterAll = errText();

        // CHECK 4: pause A, play B, come back to A. The position it resumes from
        // is in the plugin's log line, not here.
        // Every wait here is short on purpose: these notes are 2-4 seconds, and
        // a note that ENDS while the probe is waiting looks exactly like a note
        // that never played.
        let resume = 'skipped';
        if (all.length >= 2) {
          const A = all[0], B = all[1];
          A.click(); await wait(1100);         // play A for ~1.1s
          const playedA = isPlaying(A);
          A.click(); await wait(400);          // pause A
          const pausedA = !isPlaying(A);
          B.click(); await wait(400);          // play B — A is no longer loaded
          const playedB = isPlaying(B);
          A.click(); await wait(300);          // back to A: must resume, not restart
          const backToA = isPlaying(A);
          A.click();                            // leave it quiet
          resume = `playedA=${playedA} pausedA=${pausedA} playedB=${playedB} backToA=${backToA}`;
        }

        // CHECK 2 + 7, opt-in with --verify-new-note because it SENDS a real
        // voice note to whichever conversation is open. It is the only way to
        // test the symptom that started all of this — a note that ARRIVES never
        // played, because it mounted after the page-load grant window closed —
        // and it exercises recording-after-playback in the same pass.
        let newNote = 'skipped';
        if (arguments1 === 'yes') {
          const before = notes().length;
          const rec = document.querySelector('button[aria-label="Record a voice note"]');
          if (!rec) newNote = 'no record button';
          else {
            rec.click(); await wait(2500);
            document.querySelector('button[aria-label="Stop recording"]')?.click();
            let after = before;
            for (let t = 0; t < 45 && after <= before; t++) { await wait(1000); after = notes().length; }
            if (after > before) {
              const fresh = notes()[after - 1];
              fresh.click(); await wait(250);
              const plays = isPlaying(fresh);
              fresh.click();
              newNote = `arrived=${after - before} plays=${plays}`;
            } else newNote = `did not arrive (still ${after})`;
          }
        }

        return 'FLATFOLD_VERIFY ' + JSON.stringify({
          unlocked, opened,
          notes: all.length,
          audioEls,                 // MUST be 0 on this platform
          playedOk: all.length - failed.length,
          failedIdx: failed.slice(0, 12),
          errors: errorsAfterAll.slice(0, 3),
          resume, newNote,
        });
        } catch (e) {
          return 'FLATFOLD_VERIFY ' + JSON.stringify({
            note: 'probe threw: ' + (e && e.message ? e.message : String(e)) });
        }
        """
        // --verify-new-note SENDS A REAL VOICE NOTE to whichever conversation is
        // open, to a real contact, on both sides, permanently. Opt-in for that
        // reason and for no other: "verify" reads as harmless and this is not.
        let newNote = args.contains("--verify-new-note") ? "yes" : "no"
        runProbeJS(js, pw: unlockPw, newNote: newNote, probe)
        #endif
    }


    /// Run the probe body and log its one JSON line.
    private func runProbeJS(_ js: String, pw: String, newNote: String, _ probe: os.Logger) {
        #if DEBUG
        bridge?.webView?.callAsyncJavaScript(
            js, arguments: ["arguments0": pw, "arguments1": newNote], in: nil, in: .page
        ) { result in
            // BOTH sinks, deliberately. os_log is readable on a Mac; `print`
            // reaches stdout, which is the ONLY one `devicectl … --console`
            // carries from a real device — an earlier iOS probe ran correctly
            // and its result was simply unreadable.
            switch result {
            case .success(let v):
                probe.notice("\(String(describing: v), privacy: .public)")
                print("PROBE \(String(describing: v))")
            case .failure(let e):
                probe.notice("FLATFOLD_VERIFY_FAIL \(String(describing: e), privacy: .public)")
                print("PROBE_FAIL \(String(describing: e))")
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
