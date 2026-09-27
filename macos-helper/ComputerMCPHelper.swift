import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import Vision
import Darwin

struct HelperError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

func writeJSON(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ message: String) -> Never {
    writeJSON(["ok": false, "error": message])
    exit(1)
}

func asDict(_ any: Any?) -> [String: Any] {
    any as? [String: Any] ?? [:]
}

func getString(_ dict: [String: Any], _ key: String) -> String? {
    dict[key] as? String
}

func getDouble(_ dict: [String: Any], _ key: String) -> Double? {
    if let n = dict[key] as? NSNumber { return n.doubleValue }
    return nil
}

func getInt(_ dict: [String: Any], _ key: String) -> Int? {
    if let n = dict[key] as? NSNumber { return n.intValue }
    return nil
}

func accessibilityTrusted(prompt: Bool) -> Bool {
    if prompt {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }
    return AXIsProcessTrusted()
}

func screenCaptureAllowed(request: Bool) -> Bool {
    if #available(macOS 10.15, *) {
        return request ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    }
    return true
}

func helperStatus(prompt: Bool = false) -> [String: Any] {
    return [
        "ok": true,
        "bundleIdentifier": Bundle.main.bundleIdentifier ?? "fan.fde.computermcp.helper",
        "executable": CommandLine.arguments.first ?? "",
        "pid": ProcessInfo.processInfo.processIdentifier,
        "accessibilityTrusted": accessibilityTrusted(prompt: prompt),
        "screenCaptureAllowed": screenCaptureAllowed(request: false),
        "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    ]
}

func runningApp(named name: String?) -> NSRunningApplication? {
    if let name = name, !name.isEmpty {
        let lowered = name.lowercased()
        if let exact = NSWorkspace.shared.runningApplications.first(where: {
            ($0.localizedName ?? "").lowercased() == lowered ||
            ($0.bundleIdentifier ?? "").lowercased() == lowered
        }) {
            return exact
        }
        return NSWorkspace.shared.runningApplications.first(where: {
            ($0.localizedName ?? "").lowercased().contains(lowered)
        })
    }
    return NSWorkspace.shared.frontmostApplication
}

func applicationElement(named name: String?) throws -> (NSRunningApplication, AXUIElement) {
    guard accessibilityTrusted(prompt: false) else {
        throw HelperError(message: "Computer MCP Helper does not have macOS Accessibility permission.")
    }
    guard let app = runningApp(named: name) else {
        throw HelperError(message: "Application not found.")
    }
    return (app, AXUIElementCreateApplication(app.processIdentifier))
}

func copyAX(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    return err == .success ? value : nil
}

func axString(_ value: CFTypeRef?) -> String {
    guard let value else { return "" }
    if CFGetTypeID(value) == CFStringGetTypeID() {
        return value as! String
    }
    if CFGetTypeID(value) == CFNumberGetTypeID() {
        return String(describing: value)
    }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
    }
    return ""
}

func axPoint(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let ax = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(ax) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(ax, .cgPoint, &point) ? point : nil
}

func axSize(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let ax = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(ax) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(ax, .cgSize, &size) ? size : nil
}

func focusedWindow(_ appElement: AXUIElement) -> AXUIElement? {
    if let focused = copyAX(appElement, kAXFocusedWindowAttribute as String) {
        return unsafeBitCast(focused, to: AXUIElement.self)
    }
    if let windows = copyAX(appElement, kAXWindowsAttribute as String) as? [AXUIElement] {
        return windows.first
    }
    return nil
}

func elementRecord(_ element: AXUIElement, index: Int) -> [String: Any] {
    let position = axPoint(copyAX(element, kAXPositionAttribute as String))
    let size = axSize(copyAX(element, kAXSizeAttribute as String))
    return [
        "index": index,
        "role": axString(copyAX(element, kAXRoleAttribute as String)),
        "name": axString(copyAX(element, kAXTitleAttribute as String)),
        "description": axString(copyAX(element, kAXDescriptionAttribute as String)),
        "value": axString(copyAX(element, kAXValueAttribute as String)),
        "x": position?.x as Any,
        "y": position?.y as Any,
        "width": size?.width as Any,
        "height": size?.height as Any
    ]
}

func uiTree(appName: String?, maxElements: Int, maxDepth: Int) throws -> [[String: Any]] {
    let (_, appElement) = try applicationElement(named: appName)
    guard let root = focusedWindow(appElement) else {
        throw HelperError(message: "No accessible window found.")
    }

    var results: [[String: Any]] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var cursor = 0

    while cursor < queue.count && results.count < maxElements {
        let (element, depth) = queue[cursor]
        cursor += 1

        results.append(elementRecord(element, index: results.count + 1))
        if depth >= maxDepth { continue }

        if let children = copyAX(element, kAXChildrenAttribute as String) as? [AXUIElement] {
            for child in children {
                if queue.count >= maxElements * 3 { break }
                queue.append((child, depth + 1))
            }
        }
    }
    return results
}

func launchApp(_ name: String) throws {
    if let app = runningApp(named: name) {
        app.activate(options: [])
        return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", name]
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        throw HelperError(message: "Could not open application: \(name)")
    }
}

func sendMouseClick(x: Double, y: Double) throws {
    guard accessibilityTrusted(prompt: false) else {
        throw HelperError(message: "Accessibility permission is required for mouse input.")
    }
    let point = CGPoint(x: x, y: y)
    guard
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else {
        throw HelperError(message: "Could not create mouse events.")
    }
    down.post(tap: .cghidEventTap)
    usleep(30_000)
    up.post(tap: .cghidEventTap)
}

func keyCode(_ key: String) -> CGKeyCode? {
    let map: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
        "backspace": 51, "escape": 53, "left": 123, "right": 124,
        "down": 125, "up": 126, "pageup": 116, "pagedown": 121,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
        "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
        "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "n": 45, "m": 46, ".": 47
    ]
    return map[key.lowercased()]
}

func sendKey(_ key: String, modifiers: [String]) throws {
    guard accessibilityTrusted(prompt: false) else {
        throw HelperError(message: "Accessibility permission is required for keyboard input.")
    }
    guard let code = keyCode(key) else {
        throw HelperError(message: "Unsupported key: \(key)")
    }

    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier.lowercased() {
        case "command": flags.insert(.maskCommand)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        case "shift": flags.insert(.maskShift)
        default: break
        }
    }

    guard
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else {
        throw HelperError(message: "Could not create keyboard events.")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(20_000)
    up.post(tap: .cghidEventTap)
}

func runScreenshot(path: String, region: CGRect?) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    var args = ["-x"]
    if let region {
        args.append("-R\(Int(region.origin.x)),\(Int(region.origin.y)),\(Int(region.size.width)),\(Int(region.size.height))")
    }
    args.append(path)
    process.arguments = args
    let pipe = Pipe()
    process.standardError = pipe
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let message = String(data: data, encoding: .utf8) ?? "screencapture failed"
        throw HelperError(message: message.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

func primaryWindowInfo(appName: String?) throws -> (CGWindowID, CGRect, String) {
    guard let app = runningApp(named: appName) else {
        throw HelperError(message: "Application not found.")
    }
    guard let raw = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)
        as? [[String: Any]]
    else {
        throw HelperError(message: "Could not enumerate macOS windows.")
    }

    let pid = app.processIdentifier
    let candidates: [(CGWindowID, CGRect, String)] = raw.compactMap { info in
        guard
            let ownerPid = info[kCGWindowOwnerPID as String] as? NSNumber,
            ownerPid.int32Value == pid,
            let number = info[kCGWindowNumber as String] as? NSNumber,
            let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDict)
        else {
            return nil
        }

        let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        guard layer == 0, alpha > 0, bounds.width > 100, bounds.height > 100 else {
            return nil
        }
        let name = info[kCGWindowName as String] as? String ?? ""
        return (CGWindowID(number.uint32Value), bounds, name)
    }

    guard let best = candidates.max(by: {
        ($0.1.width * $0.1.height) < ($1.1.width * $1.1.height)
    }) else {
        throw HelperError(message: "No capturable application window found.")
    }
    return best
}

func runWindowScreenshot(path: String, appName: String?) throws -> [String: Any] {
    let (windowID, bounds, windowName) = try primaryWindowInfo(appName: appName)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-l", String(windowID), path]
    let pipe = Pipe()
    process.standardError = pipe
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let message = String(data: data, encoding: .utf8) ?? "screencapture failed"
        throw HelperError(message: message.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return [
        "path": path,
        "windowId": windowID,
        "windowName": windowName,
        "x": bounds.origin.x,
        "y": bounds.origin.y,
        "width": bounds.size.width,
        "height": bounds.size.height
    ]
}

func recognizeText(path: String, languages: [String]) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if !languages.isEmpty {
        request.recognitionLanguages = languages
    }

    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
    try handler.perform([request])

    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }
        let box = observation.boundingBox
        return [
            "text": candidate.string,
            "confidence": candidate.confidence,
            "x": box.origin.x,
            "y": box.origin.y,
            "width": box.size.width,
            "height": box.size.height
        ]
    }
}

func requestPermissions() {
    _ = accessibilityTrusted(prompt: true)
    _ = screenCaptureAllowed(request: true)
    writeJSON(helperStatus(prompt: false))
}


func defaultSocketPath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return ProcessInfo.processInfo.environment["COMPUTER_MCP_HELPER_SOCKET"]
        ?? home + "/.computer-mcp/helper.sock"
}

func ensureSocketDirectory(_ socketPath: String) throws {
    let directory = URL(fileURLWithPath: socketPath).deletingLastPathComponent()
    try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
}

func makeUnixListener(path: String) throws -> Int32 {
    try ensureSocketDirectory(path)
    unlink(path)

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 {
        throw HelperError(message: "Could not create helper Unix socket.")
    }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

    let pathBytes = path.utf8CString
    if pathBytes.count > MemoryLayout.size(ofValue: address.sun_path) {
        close(fd)
        throw HelperError(message: "Helper Unix socket path is too long.")
    }

    let sunPathCapacity = MemoryLayout.size(ofValue: address.sun_path)
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(
            to: CChar.self,
            capacity: sunPathCapacity
        ) { destination in
            for index in 0..<pathBytes.count {
                destination[index] = pathBytes[index]
            }
        }
    }

    let bindResult = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }

    if bindResult != 0 {
        let message = String(cString: strerror(errno))
        close(fd)
        throw HelperError(message: "Could not bind helper Unix socket: " + message)
    }

    chmod(path, mode_t(0o600))

    if listen(fd, 16) != 0 {
        let message = String(cString: strerror(errno))
        close(fd)
        throw HelperError(message: "Could not listen on helper Unix socket: " + message)
    }

    return fd
}

func readRequestLine(fd: Int32, maxBytes: Int = 8 * 1024 * 1024) throws -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)

    while data.count < maxBytes {
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count < 0 {
            if errno == EINTR { continue }
            throw HelperError(message: "Helper socket read failed.")
        }
        if count == 0 { break }

        if let newlineIndex = buffer.prefix(count).firstIndex(of: 0x0A) {
            data.append(buffer, count: newlineIndex)
            return data
        }
        data.append(buffer, count: count)
    }

    if data.count >= maxBytes {
        throw HelperError(message: "Helper request exceeded size limit.")
    }
    return data
}

func writeResponse(fd: Int32, object: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
        return
    }
    var output = data
    output.append(0x0A)
    output.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var sent = 0
        while sent < raw.count {
            let count = Darwin.write(fd, base.advanced(by: sent), raw.count - sent)
            if count <= 0 { break }
            sent += count
        }
    }
}

func serve(socketPath: String) throws -> Never {
    let listener = try makeUnixListener(path: socketPath)
    defer {
        close(listener)
        unlink(socketPath)
    }

    signal(SIGPIPE, SIG_IGN)

    while true {
        let client = accept(listener, nil, nil)
        if client < 0 {
            if errno == EINTR { continue }
            throw HelperError(message: "Helper Unix socket accept failed.")
        }

        autoreleasepool {
            do {
                let data = try readRequestLine(fd: client)
                let object = try JSONSerialization.jsonObject(with: data, options: [])
                guard let request = object as? [String: Any] else {
                    throw HelperError(message: "Request must be a JSON object.")
                }
                let result = try handle(request)
                writeResponse(fd: client, object: ["ok": true, "result": result])
            } catch {
                writeResponse(
                    fd: client,
                    object: ["ok": false, "error": String(describing: error)]
                )
            }
            close(client)
        }
    }
}

func handle(_ request: [String: Any]) throws -> Any {
    guard let action = request["action"] as? String else {
        throw HelperError(message: "Missing action.")
    }
    let args = asDict(request["args"])

    switch action {
    case "status":
        return helperStatus()

    case "request_permissions":
        _ = accessibilityTrusted(prompt: true)
        _ = screenCaptureAllowed(request: true)
        return helperStatus()

    case "frontmost_app":
        guard accessibilityTrusted(prompt: false) else {
            throw HelperError(message: "Accessibility permission is required to resolve the focused application.")
        }
        let systemWide = AXUIElementCreateSystemWide()
        guard let focusedValue = copyAX(systemWide, kAXFocusedApplicationAttribute as String) else {
            throw HelperError(message: "Focused application is unavailable.")
        }
        let focusedElement = unsafeBitCast(focusedValue, to: AXUIElement.self)
        var focusedPid: pid_t = 0
        guard AXUIElementGetPid(focusedElement, &focusedPid) == .success else {
            throw HelperError(message: "Focused application PID is unavailable.")
        }
        let focusedApp = NSRunningApplication(processIdentifier: focusedPid)
        return [
            "app": focusedApp?.localizedName ?? "",
            "bundleIdentifier": focusedApp?.bundleIdentifier ?? "",
            "pid": focusedPid
        ]

    case "open_app":
        guard let name = getString(args, "app_name") else {
            throw HelperError(message: "Missing app_name.")
        }
        try launchApp(name)
        return ["app": name, "activated": true]

    case "window_bounds":
        let name = getString(args, "app_name")
        let (app, appElement) = try applicationElement(named: name)
        guard let window = focusedWindow(appElement) else {
            throw HelperError(message: "No accessible window found.")
        }
        guard
            let position = axPoint(copyAX(window, kAXPositionAttribute as String)),
            let size = axSize(copyAX(window, kAXSizeAttribute as String))
        else {
            throw HelperError(message: "Window geometry unavailable.")
        }
        return [
            "app": app.localizedName ?? name ?? "",
            "x": position.x,
            "y": position.y,
            "width": size.width,
            "height": size.height
        ]

    case "ui_tree":
        let name = getString(args, "app_name")
        let maxElements = max(1, min(getInt(args, "max_elements") ?? 300, 1000))
        let maxDepth = max(1, min(getInt(args, "max_depth") ?? 12, 30))
        let records = try uiTree(appName: name, maxElements: maxElements, maxDepth: maxDepth)
        return [
            "app": runningApp(named: name)?.localizedName ?? name ?? "",
            "elements": records,
            "truncated": records.count >= maxElements
        ]

    case "ui_find":
        guard let query = getString(args, "query"), !query.isEmpty else {
            throw HelperError(message: "Missing query.")
        }
        let name = getString(args, "app_name")
        let maxResults = max(1, min(getInt(args, "max_results") ?? 20, 100))
        let maxElements = max(1, min(getInt(args, "max_elements") ?? 500, 1000))
        let records = try uiTree(appName: name, maxElements: maxElements, maxDepth: 16)
        let q = query.lowercased()
        let matches = records.filter { record in
            let haystack = [
                record["role"] as? String ?? "",
                record["name"] as? String ?? "",
                record["description"] as? String ?? "",
                record["value"] as? String ?? ""
            ].joined(separator: "\n").lowercased()
            return haystack.contains(q)
        }
        return [
            "app": runningApp(named: name)?.localizedName ?? name ?? "",
            "query": query,
            "matches": Array(matches.prefix(maxResults)),
            "scanned": records.count,
            "truncated": records.count >= maxElements
        ]

    case "click":
        guard let x = getDouble(args, "x"), let y = getDouble(args, "y") else {
            throw HelperError(message: "Missing x/y.")
        }
        try sendMouseClick(x: x, y: y)
        return ["x": x, "y": y, "clicked": true]

    case "key":
        guard let key = getString(args, "key") else {
            throw HelperError(message: "Missing key.")
        }
        let modifiers = args["modifiers"] as? [String] ?? []
        try sendKey(key, modifiers: modifiers)
        return ["key": key, "modifiers": modifiers]

    case "screenshot":
        guard let output = getString(args, "path") else {
            throw HelperError(message: "Missing path.")
        }
        try runScreenshot(path: output, region: nil)
        return ["path": output]

    case "screenshot_region":
        guard
            let output = getString(args, "path"),
            let x = getDouble(args, "x"),
            let y = getDouble(args, "y"),
            let width = getDouble(args, "width"),
            let height = getDouble(args, "height")
        else {
            throw HelperError(message: "Missing screenshot region.")
        }
        try runScreenshot(path: output, region: CGRect(x: x, y: y, width: width, height: height))
        return ["path": output, "x": x, "y": y, "width": width, "height": height]

    case "screenshot_window":
        guard let output = getString(args, "path") else {
            throw HelperError(message: "Missing path.")
        }
        let name = getString(args, "app_name")
        return try runWindowScreenshot(path: output, appName: name)

    case "ocr_window":
        guard let output = getString(args, "path") else {
            throw HelperError(message: "Missing path.")
        }
        let name = getString(args, "app_name")
        let languages = args["languages"] as? [String] ?? []
        var captured = try runWindowScreenshot(path: output, appName: name)
        let observations = try recognizeText(path: output, languages: languages)
        captured["observations"] = observations
        captured["text"] = observations.compactMap { $0["text"] as? String }.joined(separator: "\n")
        return captured

    default:
        throw HelperError(message: "Unsupported action: \(action)")
    }
}

let args = CommandLine.arguments.dropFirst()

if args.contains("--request-permissions") {
    requestPermissions()
    exit(0)
}

if args.contains("--status") {
    writeJSON(helperStatus())
    exit(0)
}

if args.contains("--serve") || args.isEmpty {
    do {
        try serve(socketPath: defaultSocketPath())
    } catch {
        fail(String(describing: error))
    }
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard !input.isEmpty else {
        requestPermissions()
        exit(0)
    }
    let object = try JSONSerialization.jsonObject(with: input, options: [])
    guard let request = object as? [String: Any] else {
        throw HelperError(message: "Request must be a JSON object.")
    }
    let result = try handle(request)
    writeJSON(["ok": true, "result": result])
} catch {
    fail(String(describing: error))
}
