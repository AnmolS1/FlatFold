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

    @objc func setIcon(_ call: CAPPluginCall) {
        let requested = call.getString("name")
        // nil / "default" → primary icon.
        let iconName: String? = (requested == nil || requested == "default") ? nil : requested
        DispatchQueue.main.async {
            guard UIApplication.shared.supportsAlternateIcons else {
                call.reject("alternate icons not supported")
                return
            }
            UIApplication.shared.setAlternateIconName(iconName) { error in
                if let error = error {
                    call.reject("could not set icon: \(error.localizedDescription)")
                } else {
                    call.resolve()
                }
            }
        }
    }
}
