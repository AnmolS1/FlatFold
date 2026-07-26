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

        // Kill the empty input-accessory bar on Mac.
        //
        // THIS is the "ghost row": focusing any text field made iPadOS dock an
        // input accessory bar at the bottom of the webview, drawn over the real
        // bottom row and empty because a Mac has no software keyboard. Three
        // CSS-side fixes failed because it was never in the web layer at all.
        //
        // @capacitor/keyboard already suppresses this — but by swizzling
        // `inputAccessoryView` on classes looked up by HARDCODED name
        // ("UIWebBrowserView", "WKContentView"). On a Mac those do not resolve,
        // `class_getInstanceMethod(nil, ...)` returns NULL, and the swizzle
        // silently no-ops. Hence: iPhone and iPad fine, Mac not.
        //
        // Fixed by finding the content view at RUNTIME and reclassing that one
        // instance, rather than guessing a name or mutating a shared class.
        // Scoped to isiOSAppOnMac so iOS behaviour is untouched.
        if isOnMac { suppressInputAccessoryView() }

        #if DEBUG
        // Attempt 4 failed, so the CAUSE is now suspect, not just the fix.
        // Gather evidence before touching anything else. Removed once the ghost
        // row is understood — see `ghostRowDiagnostics()`.
        if isOnMac { installGhostRowDiagnostics() }
        #endif
    }

    private func suppressInputAccessoryView() {
        guard let webView = bridge?.webView else { return }
        // The content view is the scroll view's subview that can become first
        // responder — that is the one UIKit asks for an accessory view.
        guard let contentView = webView.scrollView.subviews.first(where: { $0.canBecomeFirstResponder }) else { return }

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
