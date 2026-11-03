/// Sets `TOODO_COMMIT` to the commit being built (empty outside a git checkout), so that
/// `toodo-server --version` shows when a build is not the release it reports.
fn main() {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        let dir = std::path::Path::new(&dir);
        // HEAD changes on a checkout, its log on every commit.
        for file in [dir.join("HEAD"), dir.join("logs").join("HEAD")] {
            if file.exists() {
                println!("cargo:rerun-if-changed={}", file.display());
            }
        }
    }
    let commit = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_default();
    println!("cargo:rustc-env=TOODO_COMMIT={commit}");
}
