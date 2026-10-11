//! The C the tests run: both stores and the POSIX host.
fn main() {
    let files = ["../store_memory.c", "../store_files.c", "../platform_posix.c"];
    for file in files.iter().chain(&["../store.h", "../platform.h"]) {
        println!("cargo:rerun-if-changed={file}");
    }
    cc::Build::new().files(files).include("..").std("c11").warnings(true).compile("subduction_c_host");
}
