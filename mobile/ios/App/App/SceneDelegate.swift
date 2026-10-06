import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    // The app switcher shows a plain PGBX-green cover instead of balances or collection codes
    private var cover: UIView?
    func sceneWillResignActive(_ scene: UIScene) {
        guard let window = window, cover == nil else { return }
        let v = UIView(frame: window.bounds)
        v.backgroundColor = UIColor(red: 11 / 255, green: 74 / 255, blue: 44 / 255, alpha: 1)
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(v)
        cover = v
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        cover?.removeFromSuperview()
        cover = nil
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
