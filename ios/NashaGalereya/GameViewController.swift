import UIKit
import WebKit

/// Full-screen web view that runs the game from `nashagame://game/`.
final class GameViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {
    private let schemeHandler = GameSchemeHandler()
    private var webView: WKWebView!
    private let background = UIColor(red: 0.11, green: 0.08, blue: 0.125, alpha: 1)

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: GameSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        let web = WKWebView(frame: .zero, configuration: config)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = background
        web.scrollView.backgroundColor = background
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }
        webView = web
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: GameSchemeHandler.startURL))
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: Microphone for the walkie-talkie and calls (the app's Info.plist explains why)

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // MARK: alert / prompt used by the game (e.g. "copy this invite link")

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { field in field.text = defaultText }
        if let text = defaultText, !text.isEmpty {
            alert.addAction(UIAlertAction(title: "Скопировать", style: .default) { _ in
                UIPasteboard.general.string = text
                completionHandler(text)
            })
        }
        alert.addAction(UIAlertAction(title: "OK", style: .cancel) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }

    // Links meant for a new window (e.g. a photo's original) open in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }

    // MARK: no internet → a friendly page with a retry button

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showOffline() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.request.url?.absoluteString == "nashagame://retry" {
            decisionHandler(.cancel)
            webView.load(URLRequest(url: GameSchemeHandler.startURL))
            return
        }
        decisionHandler(.allow)
    }

    private func showOffline() {
        let html = """
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:#1c1420;color:#fff4f7;font-family:-apple-system,sans-serif;text-align:center;padding:24px">
        <div style="font-size:56px">💕</div><h2>Нет связи с интернетом</h2>
        <p style="color:#d9b9c8">Проверьте Wi-Fi или мобильный интернет</p>
        <a href="nashagame://retry" style="margin-top:16px;padding:14px 28px;border-radius:14px;color:#fff;text-decoration:none;
        background:linear-gradient(135deg,#ff5c9a,#c46bff);font-weight:700">Попробовать снова</a></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}
