import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // App-switcher privacy: iOS snapshots the screen when the app deactivates, and
    // that snapshot shows in the multitasking switcher. Cover the UI with a branded
    // overlay (the themed Splash image) before the snapshot is taken, so an open
    // conversation never leaks into the switcher; removed when the app reactivates.
    private var privacyOverlay: UIView?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        showPrivacyOverlay()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Belt-and-suspenders: make sure the overlay is up before backgrounding.
        showPrivacyOverlay()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        hidePrivacyOverlay()
    }

    private func showPrivacyOverlay() {
        guard privacyOverlay == nil, let window = self.window else { return }
        let overlay = UIView(frame: window.bounds)
        overlay.backgroundColor = .systemBackground // adapts light/dark; the image covers it
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if let splash = UIImage(named: "Splash") {
            let imageView = UIImageView(image: splash)
            imageView.contentMode = .scaleAspectFill
            imageView.frame = overlay.bounds
            imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            imageView.clipsToBounds = true
            overlay.addSubview(imageView)
        }
        window.addSubview(overlay)
        privacyOverlay = overlay
    }

    private func hidePrivacyOverlay() {
        privacyOverlay?.removeFromSuperview()
        privacyOverlay = nil
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // APNs registration callbacks. Capacitor's PushNotifications plugin listens on
    // NotificationCenter for these — the AppDelegate must relay them, or
    // PushNotifications.register() never resolves (no 'registration' event).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
