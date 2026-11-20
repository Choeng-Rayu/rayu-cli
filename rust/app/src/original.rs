use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::{Command, ExitCode, ExitStatus};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const RUN: &[&str] = &[
    "/usr/bin/bwrap",
    "--bind",
    "/",
    "/",
    "--ro-bind",
    "/home/rayu",
    "/home/rayu",
    "--unshare-net",
    "--",
    "/home/rayu/.n/bin/node",
    "/home/rayu/rayu/rayu-cli/rayu/dist/rayu.js",
];
const FALLBACK_LOG: &str = "RUST_ANYTHING_FALLBACK_LOG";

fn resolve(word: &str) -> OsString {
    if word.starts_with('-') {
        return word.into();
    }
    let path = Path::new(ROOT).join(word);
    let looks_like_path = word.contains('/') || word.contains('\\') || path.is_file();
    if looks_like_path && path.exists() {
        return path.canonicalize().unwrap_or(path).into_os_string();
    }
    word.into()
}

fn log() -> Option<std::fs::File> {
    let path = std::env::var_os(FALLBACK_LOG)?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

/// Tells `rust-anything app replay` this build counts its fallbacks, even when it makes none.
pub fn report_fallbacks() {
    let _ = log();
}

/// Runs the original with the same arguments, stdin and environment, and passes its output and
/// exit code through. Each call is one fallback.
pub fn run(args: &[OsString]) -> ExitCode {
    if let Some(mut file) = log() {
        let line: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let _ = writeln!(file, "{}", line.join(" "));
    }
    let Some((program, rest)) = RUN.split_first() else {
        return ExitCode::from(127);
    };
    let status = Command::new(resolve(program))
        .args(rest.iter().map(|w| resolve(w)))
        .args(args)
        .status();
    match status {
        Ok(status) => ExitCode::from(exit_code(status)),
        Err(e) => {
            eprintln!(
                "front door: cannot run the original `{}`: {e}",
                RUN.join(" ")
            );
            ExitCode::from(127)
        }
    }
}

fn exit_code(status: ExitStatus) -> u8 {
    if let Some(code) = status.code() {
        return (code & 0xff) as u8;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return (128 + signal) as u8;
        }
    }
    1
}
