use std::env;
use std::path::PathBuf;
use std::process::{Command, ExitCode};

const VERSION: &str = "3.0.0";

fn rust_rayu_path() -> Option<PathBuf> {
    if let Ok(dir) = env::var("RAYU_INSTALL_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join(bin_name()));
        }
    }
    #[cfg(windows)]
    {
        if let Ok(local) = env::var("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join("rayu").join("bin").join("rayu.exe"));
        }
        env::var("USERPROFILE")
            .ok()
            .map(|h| PathBuf::from(h).join("AppData").join("Local").join("rayu").join("bin").join("rayu.exe"))
    }
    #[cfg(not(windows))]
    {
        env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".local").join("bin").join("rayu"))
    }
}

fn bin_name() -> &'static str {
    if cfg!(windows) { "rayu.exe" } else { "rayu" }
}

fn run_v3_installer() -> Result<(), String> {
    #[cfg(windows)]
    {
        let url = env::var("RAYU_INSTALLER_URL")
            .unwrap_or_else(|_| "https://rayucode.com/install.ps1".to_string());
        let ps_cmd = format!("irm '{}' | iex", url.replace('\'', "''"));
        let status = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps_cmd])
            .status()
            .map_err(|e| format!("Failed to start PowerShell: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Installer exited with status {status}"))
        }
    }
    #[cfg(not(windows))]
    {
        let url = env::var("RAYU_INSTALLER_URL")
            .unwrap_or_else(|_| "https://rayucode.com/install.sh".to_string());
        let shell_cmd = format!(
            "if command -v curl >/dev/null 2>&1; then curl -fsSL '{u}' | bash; \
             elif command -v wget >/dev/null 2>&1; then wget -qO- '{u}' | bash; \
             else echo 'rayu: curl or wget is required to complete the upgrade.' >&2; exit 1; fi",
            u = url.replace('\'', "'\\''")
        );
        let status = Command::new("sh")
            .args(["-c", &shell_cmd])
            .status()
            .map_err(|e| format!("Failed to run installer shell: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Installer exited with status {status}"))
        }
    }
}

fn forward_to_rust(args: &[String]) -> ExitCode {
    let Some(exe) = rust_rayu_path() else {
        eprintln!("rayu: installed RayuCode v3, please open a new terminal and run `rayu`.");
        return ExitCode::SUCCESS;
    };
    if !exe.exists() {
        eprintln!(
            "rayu: RayuCode v3 installed, but {} was not found. Open a new terminal and run `rayu`.",
            exe.display()
        );
        return ExitCode::SUCCESS;
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = Command::new(&exe).args(args).exec();
        eprintln!("rayu: failed to exec {}: {err}", exe.display());
        ExitCode::FAILURE
    }
    #[cfg(not(unix))]
    {
        match Command::new(&exe).args(args).status() {
            Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
            Err(err) => {
                eprintln!("rayu: failed to launch {}: {err}", exe.display());
                ExitCode::FAILURE
            }
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();

    // Old rayucode.com/install.sh and install.ps1 verify downloaded binaries by
    // running `rayu --version` and matching `^\d+\.\d+\.\d+`. Keep this fast and pure.
    if args.len() == 1 && matches!(args[0].as_str(), "--version" | "-V" | "-v") {
        println!("{VERSION}");
        return ExitCode::SUCCESS;
    }

    let is_update_cmd = args
        .first()
        .is_some_and(|a| matches!(a.as_str(), "update" | "upgrade"));

    eprintln!("Upgrading from legacy Node Rayu CLI to RayuCode v3 (Rust)...");
    if let Err(err) = run_v3_installer() {
        eprintln!("rayu: automatic migration did not complete ({err}).");
        if cfg!(windows) {
            eprintln!("Run manually in PowerShell:\n  irm https://rayucode.com/install.ps1 | iex");
        } else {
            eprintln!("Run manually:\n  curl -fsSL https://rayucode.com/install | bash");
        }
        return ExitCode::FAILURE;
    }

    if is_update_cmd {
        return ExitCode::SUCCESS;
    }

    forward_to_rust(&args)
}
