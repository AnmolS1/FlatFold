import Foundation
import Capacitor
import UIKit

// D3 extra — a manual app-icon picker. iOS shows a system alert on every
// setAlternateIconName, so this is user-initiated (Settings), never auto-tied to
// the theme. "default" / nil restores the primary (asset-catalog) icon, which
// already does its own light/dark appearance switching.
@objc(FlatFoldAppIconPlugin)
public class FlatFoldAppIconPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FlatFoldAppIconPlugin"
    public let jsName = "FlatFoldAppIcon"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getIcon", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setIcon", returnType: CAPPluginReturnPromise),
    ]

    @objc func isSupported(_ call: CAPPluginCall) {
        // Main thread, like getIcon/setIcon below. Capacitor dispatches plugin
        // calls off the main thread, and every UIApplication accessor is
        // main-thread-only — Main Thread Checker flags this one specifically.
        // It was the only accessor here missing the hop.
        DispatchQueue.main.async {
            call.resolve(["supported": UIApplication.shared.supportsAlternateIcons])
        }
    }

    @objc func getIcon(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["name": UIApplication.shared.alternateIconName ?? "default"])
        }
    }

    /// Set the icon, resolving on what the icon ACTUALLY IS rather than only on
    /// the callback.
    ///
    /// `setAlternateIconName`'s completion handler is not reliably called for a
    /// change that succeeds — measured 2026-07-29 on an iPad Pro (M4) simulator,
    /// where three real changes all took effect (`alternateIconName` read back
    /// correctly) and none called back within 6s, while a deliberately invalid
    /// name failed instantly. Resolving only from the completion meant the
    /// promise never settled, and `AppIconSection` disables every button while it
    /// awaits this — so the picker locked up, showing no error, until relaunch.
    ///
    /// That path is newly reachable: until the alternates moved into the asset
    /// catalog, `supportsAlternateIcons` was false on iPad and the picker did not
    /// render there at all.
    ///
    /// So: poll the read-back, and only ever report success when the icon the
    /// system reports is the one that was asked for.
    @objc func setIcon(_ call: CAPPluginCall) {
        let requested = call.getString("name")
        // nil / "default" → primary icon.
        let iconName: String? = (requested == nil || requested == "default") ? nil : requested
        DispatchQueue.main.async {
            guard UIApplication.shared.supportsAlternateIcons else {
                call.reject("alternate icons not supported")
                return
            }

            // Everything below runs on the main queue, so this needs no lock.
            var settled = false
            func settle(_ finish: () -> Void) {
                guard !settled else { return }
                settled = true
                finish()
            }

            // A read-back that still shows the OLD icon means "not landed yet",
            // not "failed" — so keep looking rather than reporting either way.
            // Ten seconds, then admit defeat honestly instead of resolving a
            // change that never happened.
            func poll(_ attempt: Int) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    guard !settled else { return }
                    if UIApplication.shared.alternateIconName == iconName {
                        settle { call.resolve() }
                    } else if attempt >= 9 {
                        settle { call.reject("timed out changing the app icon") }
                    } else {
                        poll(attempt + 1)
                    }
                }
            }
            poll(0)

            UIApplication.shared.setAlternateIconName(iconName) { error in
                DispatchQueue.main.async {
                    // An error is only believable if the icon did not change.
                    // iOS has reported one for a change that plainly took.
                    let landed = UIApplication.shared.alternateIconName == iconName
                    if let error = error, !landed {
                        settle { call.reject("could not set icon: \(error.localizedDescription)") }
                    } else {
                        settle { call.resolve() }
                    }
                }
            }
        }
    }
}
