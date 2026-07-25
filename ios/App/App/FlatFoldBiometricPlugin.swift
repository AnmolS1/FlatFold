import Foundation
import Capacitor
import LocalAuthentication
import Security

// FlatFold's biometric unlock (D7 §5). A true Secure-Enclave-gated store: the
// keystore master key (MK) is written to the Keychain with an access-control
// object requiring the CURRENT biometric set (`.biometryCurrentSet`), and read
// only through a live, biometric-authenticated `LAContext`. The OS — not JS —
// enforces the gate, so MK is NOT reachable by device-unlock alone or by the
// device passcode. If Face ID fails/changes, MK is simply unreadable and the user
// falls back to their FlatFold password. This is why we ship a custom plugin
// rather than an off-the-shelf verify-then-retrieve one (which would leave MK
// retrievable from the Keychain without a live biometric match).
@objc(FlatFoldBiometricPlugin)
public class FlatFoldBiometricPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FlatFoldBiometricPlugin"
    public let jsName = "FlatFoldBiometric"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSecret", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteSecret", returnType: CAPPluginReturnPromise),
    ]

    private let service = "dev.flatfold.biometric"

    // Is biometric auth available and enrolled on this device?
    @objc func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        var type = "none"
        if available {
            switch context.biometryType {
            case .faceID: type = "faceId"
            case .touchID: type = "touchId"
            default: type = "unknown"
            }
        }
        call.resolve(["available": available, "biometryType": type])
    }

    // Store `value` under `key`, gated by the current biometric set. Overwrites any
    // existing item for that key.
    @objc func setSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("key and value are required")
            return
        }
        var acError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, // device-only, requires a passcode set, never synced
            .biometryCurrentSet, // invalidated if the enrolled biometrics change
            &acError
        ) else {
            call.reject("could not create access control")
            return
        }
        // Clear any prior item so the add can't hit a duplicate.
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)

        var add = base
        add[kSecValueData as String] = value.data(using: .utf8)!
        add[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("keychain store failed (\(status))")
        }
    }

    // Read the secret for `key`. Triggers the OS Face ID / Touch ID sheet; resolves
    // { value } only on a live biometric match. Rejects "CANCELLED" on
    // cancel/failure, "NOT_FOUND" when nothing is enrolled.
    @objc func getSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        let reason = call.getString("reason") ?? "Unlock FlatFold"
        let context = LAContext()
        context.localizedFallbackTitle = "" // no device-passcode fallback — password is the in-app fallback

        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, _ in
            guard success else {
                DispatchQueue.main.async { call.reject("cancelled", "CANCELLED") }
                return
            }
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: self.service,
                kSecAttrAccount as String: key,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecUseAuthenticationContext as String: context, // the item's access control only opens for this authed context
            ]
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            DispatchQueue.main.async {
                if status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) {
                    call.resolve(["value": value])
                } else if status == errSecItemNotFound {
                    call.reject("not found", "NOT_FOUND")
                } else {
                    call.reject("keychain read failed (\(status))")
                }
            }
        }
    }

    // Whether a secret is stored for `key`, WITHOUT prompting for biometrics — for
    // showing the right UI. Uses UI-fail so a present-but-locked item reports as
    // existing (errSecInteractionNotAllowed) rather than triggering Face ID.
    @objc func hasSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        let context = LAContext()
        context.interactionNotAllowed = true // don't prompt: a locked-but-present item returns errSecInteractionNotAllowed
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: false,
            kSecUseAuthenticationContext as String: context,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        let exists = (status == errSecSuccess || status == errSecInteractionNotAllowed)
        call.resolve(["enrolled": exists])
    }

    // Remove the stored secret (disabling biometric unlock).
    @objc func deleteSecret(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("key is required")
            return
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        call.resolve()
    }
}
