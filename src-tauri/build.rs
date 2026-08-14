/// The build script, and one link argument macOS needs.
fn main() {
    link_clang_builtins();
    tauri_build::build()
}

/// Links clang's builtin runtime, for the Metal backend's availability checks.
///
/// ggml's Metal code asks `@available(macOS 13, …)` at runtime, because it has
/// to work on machines older than the features it uses. clang compiles that
/// into a call to `__isPlatformVersionAtLeast`, which lives in
/// `libclang_rt.osx.a` — and Rust links with `-nodefaultlibs`, so nothing puts
/// that library on the command line and the link fails with three undefined
/// symbols and no mention of Metal.
///
/// Only macOS, and only when the library can be found. A toolchain laid out
/// differently gets a build without this argument, which is exactly the build
/// that worked before Metal was enabled.
fn link_clang_builtins() {
    if !cfg!(target_os = "macos") {
        return;
    }

    let developer = std::process::Command::new("xcode-select")
        .arg("-p")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());

    let Some(developer) = developer else { return };
    let clang = format!("{developer}/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang");

    // The version directory changes with Xcode, so it is found rather than
    // written down -- a path with a number in it is a path that breaks on the
    // next upgrade, on somebody else's machine, months later.
    let Ok(entries) = std::fs::read_dir(&clang) else { return };
    for entry in entries.flatten() {
        let darwin = entry.path().join("lib/darwin");
        if darwin.join("libclang_rt.osx.a").exists() {
            println!("cargo:rustc-link-search=native={}", darwin.display());
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
            return;
        }
    }
}
