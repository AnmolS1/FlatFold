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
