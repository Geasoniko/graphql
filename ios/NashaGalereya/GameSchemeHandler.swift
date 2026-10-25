import Foundation
import WebKit

/// Serves the whole game to the web view under `nashagame://game/…`.
///
/// Every file is fetched from the live GitHub Pages site, so game updates reach the app without a
/// rebuild. Films (`films/<name>.mp4`) are streamed from the GitHub release instead, with range
/// requests passed through and the response labelled `video/mp4`. Safari refuses those files because
/// GitHub serves them as `application/octet-stream`; served this way they also share the page's
/// origin, so the game can paint the film straight onto the 3D cinema screen.
final class GameSchemeHandler: NSObject, WKURLSchemeHandler, URLSessionDataDelegate {
    static let scheme = "nashagame"
    static let startURL = URL(string: "nashagame://game/index.html")!
    private static let site = "https://geasoniko.github.io/graphql/game/"
    private static let films = "https://github.com/Geasoniko/graphql/releases/download/films/"

    private struct Entry {
        let schemeTask: WKURLSchemeTask
        let dataTask: URLSessionDataTask
        let path: String
        let isFilm: Bool
    }

    private var entries: [Int: Entry] = [:]
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)

    // MARK: WKURLSchemeHandler (called on the main thread)

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty { path = "index.html" }

        let isFilm = path.hasPrefix("films/") && path.lowercased().hasSuffix(".mp4")
        let base = isFilm ? Self.films + String(path.dropFirst("films/".count)) : Self.site + path
        guard let target = URL(string: base.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? base) else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        var request = URLRequest(url: target)
        request.cachePolicy = isFilm ? .reloadIgnoringLocalCacheData : .useProtocolCachePolicy
        if let range = urlSchemeTask.request.value(forHTTPHeaderField: "Range") {
            request.setValue(range, forHTTPHeaderField: "Range")
        }
        let dataTask = session.dataTask(with: request)
        entries[dataTask.taskIdentifier] = Entry(schemeTask: urlSchemeTask, dataTask: dataTask, path: path, isFilm: isFilm)
        dataTask.resume()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Forget the task first: WebKit crashes if a stopped task receives anything.
        let ids = entries.filter { $0.value.schemeTask === urlSchemeTask }.map { $0.key }
        for id in ids {
            entries.removeValue(forKey: id)?.dataTask.cancel()
        }
    }

    // MARK: URLSessionDataDelegate (delegate queue is main)

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // GitHub redirects release downloads to its file storage; keep asking for the same byte range.
        var next = request
        if let range = task.originalRequest?.value(forHTTPHeaderField: "Range") {
            next.setValue(range, forHTTPHeaderField: "Range")
        }
        completionHandler(next)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let entry = entries[dataTask.taskIdentifier], let url = entry.schemeTask.request.url else {
            completionHandler(.cancel)
            return
        }
        let http = response as? HTTPURLResponse
        var upstream: [String: String] = [:]
        for (key, value) in http?.allHeaderFields ?? [:] {
            if let key = key as? String, let value = value as? String { upstream[key.lowercased()] = value }
        }

        var headers: [String: String] = ["Access-Control-Allow-Origin": "*"]
        for name in ["Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified"] {
            if let value = upstream[name.lowercased()] { headers[name] = value }
        }
        // URLSession has already unpacked gzip, so the upstream length would be wrong in that case.
        if upstream["content-encoding"] == nil, let length = upstream["content-length"] {
            headers["Content-Length"] = length
        }
        if entry.isFilm {
            headers["Content-Type"] = "video/mp4"
            headers["Accept-Ranges"] = "bytes"
        } else {
            headers["Content-Type"] = Self.mimeType(for: entry.path) ?? upstream["content-type"] ?? "application/octet-stream"
        }

        let status = http?.statusCode ?? 200
        if let out = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) {
            entry.schemeTask.didReceive(out)
            completionHandler(.allow)
        } else {
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        entries[dataTask.taskIdentifier]?.schemeTask.didReceive(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let entry = entries.removeValue(forKey: task.taskIdentifier) else { return }
        if let error = error {
            entry.schemeTask.didFailWithError(error)
        } else {
            entry.schemeTask.didFinish()
        }
    }

    private static func mimeType(for path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "md": return "text/markdown; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "mp4": return "video/mp4"
        case "wav": return "audio/wav"
        default: return nil
        }
    }
}
