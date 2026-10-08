// Compiles ../line.c, which includes core/graph/c/main.c whole, and every
// other C source main.c links (core/graph/c/Makefile's SOURCES less main.c).

fn main() {
    let root = "../../../../..";
    let sources = [
        "core/graph/c/json.c",
        "core/graph/c/ermine.c",
        "core/graph/c/graph.c",
        "core/protect/c/protect.c",
        "core/scheduler/c/schedule.c",
        "core/scheduler/c/steps.c",
        "core/graph/c/cbor.c",
        "layers/cache/c/cache.c",
        "layers/cache/c/hash.c",
        "layers/cache/c/harness.c",
        "layers/link/c/link.c",
        "layers/subduction/c/blob.c",
        "layers/subduction/c/sync.c",
        "layers/subduction/c/harness.c",
        "layers/subduction/c/ed25519.c",
        "layers/subduction/c/sha2.c",
    ];
    let mut build = cc::Build::new();
    build.std("c11").warnings(false).file("../line.c");
    for source in sources {
        build.file(format!("{root}/{source}"));
    }
    build.compile("ermine");
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rerun-if-changed=../line.c");
    // the C files themselves, not their folders: layers/subduction/c holds this one, and its target/
    for dir in ["core/graph/c", "core/protect/c", "core/scheduler/c", "layers/cache/c", "layers/cache/c/blake3", "layers/link/c", "layers/subduction/c"] {
        for entry in std::fs::read_dir(format!("{root}/{dir}")).expect("a C folder").flatten() {
            let path = entry.path();
            if matches!(path.extension().and_then(|e| e.to_str()), Some("c" | "h")) {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}
