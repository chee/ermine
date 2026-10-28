// the type declarations this mac's bundles make, as JSON on stdout, for gather.ts:
//   swift ermine/types/mac/scan.swift > mac.json
//
// every Info.plist under the folders below, each UTExportedTypeDeclarations and
// UTImportedTypeDeclarations entry: { "<identifier>": [{ kind, from, decl }] }, kind "exported" or
// "imported", from the plist's path, decl the entry as the plist has it
import Foundation

let home = FileManager.default.homeDirectoryForCurrentUser.path
let roots = [
	"/System/Library/CoreServices",
	"/System/Library/Frameworks",
	"/System/Library/PrivateFrameworks",
	"/System/Applications",
	"/Applications",
	"\(home)/Applications",
]

var found: [String: [[String: Any]]] = [:]

func scan(_ path: String) {
	guard let data = FileManager.default.contents(atPath: path),
		let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
	else { return }
	for (key, kind) in [("UTExportedTypeDeclarations", "exported"), ("UTImportedTypeDeclarations", "imported")] {
		for decl in plist[key] as? [[String: Any]] ?? [] {
			guard let id = decl["UTTypeIdentifier"] as? String, JSONSerialization.isValidJSONObject(decl)
			else { continue }
			found[id, default: []].append(["kind": kind, "from": path, "decl": decl])
		}
	}
}

for root in roots {
	guard let walk = FileManager.default.enumerator(atPath: root) else { continue }
	for case let rel as String in walk where rel.hasSuffix("/Info.plist") || rel == "Info.plist" {
		scan("\(root)/\(rel)")
	}
}

let out = try JSONSerialization.data(withJSONObject: found, options: [.sortedKeys])
FileHandle.standardOutput.write(out)
FileHandle.standardError.write("\(found.count) types\n".data(using: .utf8)!)
