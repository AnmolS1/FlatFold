import UIKit
import Capacitor
import WebKit

// Capacitor 8 instantiates plugins from the generated `packageClassList`, which
// `cap sync` builds from installed plugin PACKAGES only. Our biometric plugin is
// app-local (compiled into the App target, not a package), so it never lands in
// that list. Register it by hand here — `capacitorDidLoad()` is the supported hook
// and this file survives `cap sync`. The storyboard points at this class.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(FlatFoldBiometricPlugin())
        bridge?.registerPluginInstance(FlatFoldAppIconPlugin())

        // Tell the web layer whether this is the iPad app running on a Mac.
        //
        // It needs to know because iPadOS still fires keyboardWillShow, with a
        // height, for a keyboard it never draws there — the web layer subtracts
        // it, the shell resizes, and WKWebView leaves a stale painted copy of the
        // bottom row. `ProcessInfo.isiOSAppOnMac` is the API that actually
        // answers this; the first attempt guessed from navigator.maxTouchPoints,
        // which is a heuristic about touchscreens, not about this.
        //
        // Injected at documentStart so it is set before any app code reads it.
        let isOnMac = ProcessInfo.processInfo.isiOSAppOnMac
        let script = WKUserScript(
            source: "window.__flatfoldIsIOSAppOnMac = \(isOnMac);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        bridge?.webView?.configuration.userContentController.addUserScript(script)

        // Kill the two bars iPadOS docks at the bottom of the webview on a Mac.
        //
        // The "ghost row" is `suppressInputAssistantBar()` — see the evidence in
        // its doc comment. `suppressInputAccessoryView()` below is the belt to
        // its braces: a runtime dump showed `inputAccessoryView` was ALREADY nil
        // while the ghost row was on screen, so it is not what was drawing the
        // bar. It is kept because it costs nothing and covers the case where a
        // responder other than WKWebView supplies a real accessory view, but it
        // should not be mistaken for the fix. Four attempts were spent on it.
        //
        // Both are scoped to isiOSAppOnMac, so iOS behaviour is untouched.
        if isOnMac { beginMacInputSuppression() }

        #if DEBUG
        // Attempt 4 failed, so the CAUSE is now suspect, not just the fix.
        // Gather evidence before touching anything else. Removed once the ghost
        // row is understood — see `ghostRowDiagnostics()`.
        if isOnMac { installGhostRowDiagnostics() }
        #endif
    }

    /// Suppress the bars iPadOS docks at the bottom of the webview on a Mac.
    ///
    /// **The bug that hid this for five attempts was TIMING, not the API.** At
    /// `capacitorDidLoad` the web content has not loaded, so
    /// `webView.scrollView.subviews` is EMPTY — there is no WKContentView yet.
    /// Both suppressions looked up their target there, found nothing, and hit a
    /// silent `guard ... else { return }`. They never ran.
    ///
    /// That is not a guess. The window dump prints `object_getClass()`, and it
    /// reported a plain `WKContentView` — had the reclass applied it would have
    /// read `FlatFoldNoAccessory_WKContentView`. The fix was absent from the
    /// hierarchy it was supposed to have modified.
    ///
    /// So: retry on the main queue until the content view exists, then apply once
    /// and stop. Capped, so a webview that never loads cannot spin forever.
    private func beginMacInputSuppression(attempt: Int = 0) {
        if applyMacInputSuppression() { return }
        guard attempt < 40 else {
            NSLog("[ghostrow] gave up waiting for the content view after %d attempts", attempt)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.beginMacInputSuppression(attempt: attempt + 1)
        }
    }

    /// Returns true once the content view was found and suppression applied.
    @discardableResult
    private func applyMacInputSuppression() -> Bool {
        guard let webView = bridge?.webView else { return false }
        guard let contentView = webView.scrollView.subviews.first(where: { $0.canBecomeFirstResponder }) else {
            return false
        }

        // Two DIFFERENT mechanisms can draw a bar, and they need separate fixes.
        //
        //   inputAccessoryView   — the view a responder supplies. @capacitor/keyboard
        //                          swizzles this by hardcoded class name.
        //   inputAssistantItem   — the SYSTEM shortcuts bar, with leading/trailing
        //                          bar button groups. iPadOS shows it whenever a
        //                          HARDWARE keyboard is attached, and a Mac always
        //                          has one. Nilling the accessory view does nothing
        //                          to it.
        //
        // The dump showed `.inputAccessoryView = nil` while the bar was on screen,
        // so the assistant item is the better candidate — but the accessory view is
        // cheap and was never actually applied either, so do both and stop guessing
        // which one it is.
        for responder in [webView as UIResponder, contentView as UIResponder] {
            let item = responder.inputAssistantItem
            NSLog("[ghostrow] clearing assistant bar on %@ (leading=%d trailing=%d)",
                  NSStringFromClass(object_getClass(responder) ?? type(of: responder)),
                  item.leadingBarButtonGroups.count, item.trailingBarButtonGroups.count)
            item.leadingBarButtonGroups = []
            item.trailingBarButtonGroups = []
        }

        suppressInputAccessoryView(on: contentView)
        NSLog("[ghostrow] suppression applied; contentView is now %@",
              NSStringFromClass(object_getClass(contentView) ?? type(of: contentView)))
        return true
    }

    private func suppressInputAccessoryView(on contentView: UIView) {
        let baseClass: AnyClass = type(of: contentView)
        guard let baseName = String(cString: class_getName(baseClass), encoding: .utf8) else { return }
        let subclassName = "FlatFoldNoAccessory_\(baseName)"

        // Reuse the subclass if a previous webview already created it.
        let subclass: AnyClass
        if let existing = NSClassFromString(subclassName) {
            subclass = existing
        } else {
            guard let created = objc_allocateClassPair(baseClass, subclassName, 0) else { return }
            let getter = #selector(getter: UIResponder.inputAccessoryView)
            let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            if let method = class_getInstanceMethod(UIResponder.self, getter) {
                class_addMethod(created, getter, imp_implementationWithBlock(block), method_getTypeEncoding(method))
            }
            objc_registerClassPair(created)
            subclass = created
        }
        object_setClass(contentView, subclass)

        // Hardening (build-order step 7): a shipped build must never expose the
        // WKWebView to the Safari Web Inspector — decrypted message content and the
        // bearer token live in this webview, and an inspectable webview on a
        // trusted/unlocked device is a plaintext window. Capacitor already gates
        // isInspectable behind its own #if DEBUG, but we assert it explicitly here
        // so the guarantee is auditable in OUR code and can't regress if the
        // framework's internal default changes. Debug builds (dev on-device) keep
        // inspection — this block compiles out entirely there.
        #if !DEBUG
        if #available(iOS 16.4, *) {
            bridge?.webView?.isInspectable = false
        }
        #endif
    }
}

#if DEBUG
/// Holder for the first-responder probe below (Swift has no stored statics in
/// extensions).
private enum GhostRowFirstResponder {
    static weak var found: UIResponder?
}

private extension UIResponder {
    @objc func flatfold_ghostRowCapture() { GhostRowFirstResponder.found = self }
}

/// Diagnostics for the ghost row. DEBUG-only and temporary.
///
/// Four fixes have failed, which means the CAUSE is suspect and not merely the
/// fix. Two hypotheses survive and cannot be told apart by reading source:
///
///   H1  "WKContentView" / "UIWebBrowserView" do not resolve on a Mac, so
///       @capacitor/keyboard's swizzle (Keyboard.m:378, by hardcoded name)
///       no-ops — and our own runtime reclass then failed for its own reason.
///   H2  Those classes DO resolve, the swizzle works, and the ghost row is not
///       an input accessory view at all — in which case every fix so far has
///       been aimed at the wrong object.
///
/// So this logs the discriminating facts rather than changing behaviour. The
/// load-time block settles H1 outright. The focus-time dump names the ghost row:
/// note that an input accessory lives in a SEPARATE UITextEffectsWindow /
/// UIRemoteKeyboardWindow, so a dump that walked only the app's own window would
/// miss it and read as a false negative. Hence every window, every scene.
extension MainViewController {
    func installGhostRowDiagnostics() {
        // H1, settled directly: does Capacitor's swizzle have a target here?
        for name in ["WKContentView", "UIWebBrowserView", "UITextInputTraits"] {
            let resolved = NSClassFromString(name).map { NSStringFromClass($0) } ?? "NULL — swizzle no-ops"
            NSLog("[ghostrow] NSClassFromString(\"%@\") -> %@", name, resolved)
        }

        // What our own lookup saw, and whether the reclass actually stuck.
        if let webView = bridge?.webView {
            let subs = webView.scrollView.subviews
            NSLog("[ghostrow] scrollView has %d subview(s) at capacitorDidLoad", subs.count)
            for (i, v) in subs.enumerated() {
                NSLog("[ghostrow]   [%d] %@ canBecomeFirstResponder=%@ frame=%@",
                      i, NSStringFromClass(object_getClass(v) ?? type(of: v)),
                      v.canBecomeFirstResponder ? "YES" : "NO",
                      NSCoder.string(for: v.frame))
            }
            if subs.isEmpty {
                NSLog("[ghostrow] EMPTY at load — the reclass had nothing to find, so the fix never applied")
            }
        }

        // iPadOS fires the keyboard notifications on a Mac even though it draws
        // no keyboard (that is what the phantom-height bug was), so these are a
        // reliable trigger for "the ghost row is on screen right now".
        for note in [UIResponder.keyboardDidShowNotification, UIResponder.keyboardWillShowNotification] {
            NotificationCenter.default.addObserver(forName: note, object: nil, queue: .main) { [weak self] _ in
                self?.dumpGhostRow(label: note.rawValue)
            }
        }
    }

    private func dumpGhostRow(label: String) {
        NSLog("[ghostrow] ===================== %@ =====================", label)

        GhostRowFirstResponder.found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.flatfold_ghostRowCapture), to: nil, from: nil, for: nil)
        if let fr = GhostRowFirstResponder.found {
            NSLog("[ghostrow] firstResponder = %@", NSStringFromClass(object_getClass(fr) ?? type(of: fr)))
            if let v = fr as? UIView {
                let accessory = v.inputAccessoryView.map { NSStringFromClass(type(of: $0)) } ?? "nil (suppressed)"
                NSLog("[ghostrow]   .inputAccessoryView = %@", accessory)
            }
        } else {
            NSLog("[ghostrow] firstResponder = none found")
        }

        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for win in scene.windows {
                NSLog("[ghostrow] WINDOW %@ level=%.0f hidden=%@ frame=%@",
                      NSStringFromClass(type(of: win)), win.windowLevel.rawValue,
                      win.isHidden ? "YES" : "NO", NSCoder.string(for: win.frame))
                dumpTree(win, depth: 1)
            }
        }
        NSLog("[ghostrow] ===================== end =====================")
    }

    private func dumpTree(_ view: UIView, depth: Int) {
        guard depth < 10 else { return }
        let pad = String(repeating: "  ", count: depth)
        for sub in view.subviews {
            NSLog("[ghostrow] %@%@ frame=%@ hidden=%@ alpha=%.2f",
                  pad, NSStringFromClass(object_getClass(sub) ?? type(of: sub)),
                  NSCoder.string(for: sub.frame), sub.isHidden ? "YES" : "NO", sub.alpha)
            dumpTree(sub, depth: depth + 1)
        }
    }
}
#endif
