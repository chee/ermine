// Keychain.swift: passwords the OS asks the Mac's login keychain to keep
// (the vnc driver's Remember password): generic passwords, service
// "ermineOS VNC", each by the account the OS names. A get's answer is an
// irq 66 record; a password is never logged.

import Foundation
import Security

enum Keychain {
    static let service = "ermineOS VNC"
    private static let queue = DispatchQueue(label: "keychain")

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// act "get", "set" or "drop", off the command thread: the keychain may ask the person first
    static func run(act: String, account: String, password: String?, bus: Bus) {
        queue.async {
            switch act {
            case "get":
                var q = query(account)
                q[kSecReturnData as String] = true
                q[kSecMatchLimit as String] = kSecMatchLimitOne
                var item: CFTypeRef?
                let status = SecItemCopyMatching(q as CFDictionary, &item)
                let found = status == errSecSuccess ? (item as? Data).flatMap { String(data: $0, encoding: .utf8) } : nil
                if status != errSecSuccess && status != errSecItemNotFound { log("keychain: get \(account): \(status)") }
                bus.send(66, [("event", "keychain"), ("account", account), ("password", found)])
            case "set":
                guard let password, let data = password.data(using: .utf8) else { return }
                let status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
                if status == errSecItemNotFound {
                    var q = query(account)
                    q[kSecValueData as String] = data
                    q[kSecAttrLabel as String] = "\(service): \(account)"
                    let added = SecItemAdd(q as CFDictionary, nil)
                    if added != errSecSuccess { log("keychain: set \(account): \(added)") }
                } else if status != errSecSuccess { log("keychain: set \(account): \(status)") }
            case "drop":
                let status = SecItemDelete(query(account) as CFDictionary)
                if status != errSecSuccess && status != errSecItemNotFound { log("keychain: drop \(account): \(status)") }
            default:
                log("keychain: no act \(act)")
            }
        }
    }
}
