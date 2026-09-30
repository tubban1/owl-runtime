import Foundation
import Darwin

func jsonStatus() {
    let bundle = Bundle.main
    let info = bundle.infoDictionary ?? [:]
    let payload: [String: Any] = [
        "ok": true,
        "bundleIdentifier": bundle.bundleIdentifier ?? "fan.fde.owl.runtime",
        "version": info["CFBundleShortVersionString"] as? String ?? "unknown",
        "executable": CommandLine.arguments.first ?? ""
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

func loadEnvironmentFile(_ filePath: String, into environment: inout [String: String]) {
    guard let text = try? String(contentsOfFile: filePath, encoding: .utf8) else { return }
    for rawLine in text.components(separatedBy: .newlines) {
        var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty || line.hasPrefix("#") { continue }
        if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
        guard let separator = line.firstIndex(of: "=") else { continue }
        let key = String(line[..<separator]).trimmingCharacters(in: .whitespacesAndNewlines)
        var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        if value.count >= 2 {
            let first = value.first
            let last = value.last
            if (first == "\"" && last == "\"") || (first == "'" && last == "'") {
                value.removeFirst()
                value.removeLast()
            }
        }
        if !key.isEmpty { environment[key] = value }
    }
}

var arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--status" {
    jsonStatus()
    exit(0)
}

var envFile = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".owl/runtime.env").path
if arguments.count >= 2 && arguments[0] == "--env-file" {
    envFile = arguments[1]
    arguments.removeFirst(2)
}

guard arguments.count >= 2 else {
    fputs("Usage: OwlRuntimeHost [--env-file <path>] <node-path> <server-script> [args...]\n", stderr)
    exit(64)
}

let nodePath = arguments[0]
let serverScript = arguments[1]
let forwarded = Array(arguments.dropFirst(2))

guard FileManager.default.isExecutableFile(atPath: nodePath) else {
    fputs("OWL Runtime Host: node executable is unavailable: \(nodePath)\n", stderr)
    exit(69)
}
guard FileManager.default.fileExists(atPath: serverScript) else {
    fputs("OWL Runtime Host: server script is unavailable: \(serverScript)\n", stderr)
    exit(69)
}

var environment = ProcessInfo.processInfo.environment
loadEnvironmentFile(envFile, into: &environment)
environment["OWL_RUNTIME_MODE"] = "production"
if environment["OWL_STATE_ROOT"] == nil {
    environment["OWL_STATE_ROOT"] =
        environment["OWL_PRODUCTION_STATE_ROOT"] ??
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".owl-runtime").path
}

let child = Process()
child.executableURL = URL(fileURLWithPath: nodePath)
child.arguments = [serverScript] + forwarded
child.environment = environment
child.standardInput = FileHandle.standardInput
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termSource.setEventHandler {
    if child.isRunning {
        Darwin.kill(child.processIdentifier, SIGTERM)
    }
}
termSource.resume()

let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
intSource.setEventHandler {
    if child.isRunning {
        Darwin.kill(child.processIdentifier, SIGINT)
    }
}
intSource.resume()

do {
    try child.run()
} catch {
    fputs("OWL Runtime Host: failed to launch Node: \(error)\n", stderr)
    exit(70)
}

child.waitUntilExit()
termSource.cancel()
intSource.cancel()

if child.terminationReason == .uncaughtSignal {
    exit(128 + child.terminationStatus)
}
exit(child.terminationStatus)
