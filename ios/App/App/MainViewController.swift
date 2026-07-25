import UIKit
import Capacitor

// Capacitor 8 instantiates plugins from the generated `packageClassList`, which
// `cap sync` builds from installed plugin PACKAGES only. Our biometric plugin is
// app-local (compiled into the App target, not a package), so it never lands in
// that list. Register it by hand here — `capacitorDidLoad()` is the supported hook
// and this file survives `cap sync`. The storyboard points at this class.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(FlatFoldBiometricPlugin())
        bridge?.registerPluginInstance(FlatFoldAppIconPlugin())

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
