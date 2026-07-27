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
        bridge?.registerPluginInstance(FlatFoldAudioPlugin())

        // Tell the web layer whether this is the iPad app running on a Mac.
        //
        // `ProcessInfo.isiOSAppOnMac` is the API that actually answers this; an
        // earlier attempt guessed from navigator.maxTouchPoints, which is a
        // heuristic about touchscreens and not about this.
        //
        // Injected at documentStart so it is set before any app code reads it.
        let isOnMac = ProcessInfo.processInfo.isiOSAppOnMac
        let script = WKUserScript(
            source: "window.__flatfoldIsIOSAppOnMac = \(isOnMac);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        bridge?.webView?.configuration.userContentController.addUserScript(script)

        if isOnMac { installMacInputBarHide() }

        hardenWebInspector()
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
