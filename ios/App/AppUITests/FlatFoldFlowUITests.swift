import XCTest

/// On-device (simulator) verification for the native redesign. Drives the real
/// WKWebView app through the sim's test host — no macOS Accessibility permission
/// needed — and captures screenshots as attachments at each checkpoint so we can
/// prove the zoom/keyboard/FAB bug class is gone, the tab bar is present, and the
/// floating FAB is replaced by a docked bar.
///
/// Signup hits the LIVE backend (throwaway username per run). If the network or
/// backend is unavailable the signup checkpoints will fail, but the login-screen
/// zoom checkpoint (which needs no account) still runs.
final class FlatFoldFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        // Screenshot the whole screen, not the app element — during a
        // navigation the app-element handle can transiently report "does not
        // exist", which would abort the run. XCUIScreen is always available.
        let shot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: shot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// Launch-only smoke test, safe to run repeatedly.
    ///
    /// Exists so the Mac build can be launched and inspected from the command
    /// line at all. `open` rejects the iphoneos bundle and `devicectl` cannot
    /// address the local Mac, so `xcodebuild test` is the ONLY way to start a
    /// "Designed for iPad" build without a human pressing Run in Xcode — which
    /// is what made every Mac bug in this round a round-trip.
    ///
    /// Deliberately does NOT sign up: the existing flow test creates a real
    /// account on the live backend, which is not something to do on every run.
    func testMacSmoke() throws {
        let app = XCUIApplication(bundleIdentifier: "dev.flatfold")
        app.launch()
        snap(app, "mac-smoke-launch")
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30),
                      "the app did not reach the foreground")
    }

    func testStep1Evidence() throws {
        let app = XCUIApplication(bundleIdentifier: "dev.flatfold")
        app.launch()

        // ── A. Login screen — focus the password field, let the keyboard come
        //    up, and screenshot. The native viewport lock means focus must NOT
        //    auto-zoom (the core bug). Needs no account.
        let pwd = app.secureTextFields.firstMatch
        XCTAssertTrue(pwd.waitForExistence(timeout: 25), "login password field should exist")
        pwd.tap()
        Thread.sleep(forTimeInterval: 1.6)
        snap(app, "A_login_focus_no_zoom")

        // ── B. Sign up a throwaway account → reach the Chats list.
        let signupTab = app.buttons["Sign Up"].firstMatch
        guard signupTab.waitForExistence(timeout: 5) else {
            XCTFail("Sign Up tab not found")
            return
        }
        signupTab.tap()
        Thread.sleep(forTimeInterval: 0.6)

        let uname = "fftest\(Int(Date().timeIntervalSince1970 * 1000) % 1_000_000_000)"
        let pass = "T3st!\(uname.suffix(5))aA"

        let userField = app.textFields.firstMatch
        XCTAssertTrue(userField.waitForExistence(timeout: 5), "signup username field")
        userField.tap()
        userField.typeText(uname)

        let passField = app.secureTextFields.firstMatch
        XCTAssertTrue(passField.waitForExistence(timeout: 5), "signup password field")
        passField.tap()
        passField.typeText(pass)
        Thread.sleep(forTimeInterval: 0.4)
        snap(app, "B0_form_filled")

        // Submit via Enter — the form's onSubmit fires regardless of which of the
        // two "Sign Up"-labelled buttons (tab vs submit) the accessibility tree
        // exposes. Works with the hardware keyboard the sim uses under test.
        passField.typeText("\n")
        Thread.sleep(forTimeInterval: 2.5)
        snap(app, "B1_after_submit")

        // ── B. Chats list: the tab bar (Chats/Contacts/Settings) appears once
        //    signed in. Prove no floating FAB and a docked "New message" bar.
        let chatsTab = app.buttons["Chats"]
        let reachedChats = chatsTab.waitForExistence(timeout: 40)
        if !reachedChats {
            snap(app, "B_signup_did_not_reach_chats")
            XCTFail("Did not reach the Chats list after signup (network/backend?)")
            return
        }
        Thread.sleep(forTimeInterval: 1.2)
        snap(app, "B_chats_list_tabbar_no_fab")

        // ── C. Contacts tab.
        app.buttons["Contacts"].tap()
        Thread.sleep(forTimeInterval: 1.0)
        snap(app, "C_contacts_tab")

        // ── D. Docked new-message input with the keyboard up (the composer's
        //    docking mechanism, no zoom).
        app.buttons["Chats"].tap()
        Thread.sleep(forTimeInterval: 0.6)
        let newMsg = app.buttons["New message"].firstMatch
        if newMsg.waitForExistence(timeout: 6) {
            newMsg.tap()
            Thread.sleep(forTimeInterval: 0.5)
            let addField = app.textFields["Add someone by username"].firstMatch
            if addField.waitForExistence(timeout: 5) {
                addField.tap()
                Thread.sleep(forTimeInterval: 1.6)
                snap(app, "D_docked_input_keyboard_no_zoom")
            } else {
                snap(app, "D_new_message_panel_open")
            }
        }
    }
}
