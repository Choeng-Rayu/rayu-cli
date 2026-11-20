<#
# rayu-installer-api: 2
.SYNOPSIS
    Install RayuCode CLI (v3 Rust) on Windows.
.DESCRIPTION
    Downloads the latest RayuCode v3 release and installs it to %LOCALAPPDATA%\rayu\bin.

    One-liner install:
      irm https://rayucode.com/install.ps1 | iex

    Or download and run (allows parameters):
      & ([scriptblock]::Create((irm https://rayucode.com/install.ps1)))

    Need the legacy Node/Bun v2 CLI instead?
      irm https://rayucode.com/install-rayu-legacy.ps1 | iex
.PARAMETER InstallDir
    Override the installation directory (default: $env:LOCALAPPDATA\rayu\bin). Alias: -Dir.
.PARAMETER Version
    Override the version tag to install. Required when using a local artifact path.
.PARAMETER ArtifactExePath
    Use a local rayu.exe artifact instead of downloading from GitHub.
.PARAMETER ArtifactTgzPath
    Use a local rayu .tar.gz artifact instead of downloading from GitHub.
.PARAMETER BuildFromSource
    If no prebuilt release asset is available, explicitly allow a source build.
    Source builds require Git, Rust, and the Visual Studio C++ Build Tools.
.PARAMETER NoModifyPath
    Do not update the user PATH environment variable.
.PARAMETER Quiet
    Reduce output and skip interactive prompts.
.PARAMETER RemoveLegacy
    Automatically uninstall legacy Node Rayu (rayu-legacy) after upgrade.
.PARAMETER KeepLegacy
    Keep legacy Node Rayu as rayu-legacy without prompting.
.PARAMETER Uninstall
    Uninstall RayuCode binaries (keeps user settings in %USERPROFILE%\.rayu).
.PARAMETER ConfigureAlacritty
    Install Alacritty through winget when it is not already available.
.PARAMETER ConfigureHotkey
    Configure the optional global launch hotkey.
.PARAMETER SkipAlacrittySetup
    Deprecated compatibility switch. Alacritty setup is opt-in by default.
.PARAMETER SkipHotkeySetup
    Deprecated compatibility switch. Hotkey setup is opt-in by default.
#>
param(
    [Alias('Dir')]
    [string]$InstallDir,
    [string]$Version,
    [string]$ArtifactExePath,
    [string]$ArtifactTgzPath,
    [switch]$BuildFromSource,
    [switch]$NoModifyPath,
    [switch]$Quiet,
    [switch]$RemoveLegacy,
    [switch]$KeepLegacy,
    [switch]$Uninstall,
    [switch]$NpmTarball,
    [switch]$ConfigureAlacritty,
    [switch]$ConfigureHotkey,
    [switch]$SkipAlacrittySetup,
    [switch]$SkipHotkeySetup
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Host "error: PowerShell 5.1 or later is required" -ForegroundColor Red
    exit 1
}

$Repo = if ($env:RAYU_RELEASE_REPO) {
    $env:RAYU_RELEASE_REPO
} else {
    "Choeng-Rayu/rayucode-v2-releases"
}
$ReleaseMetadataBase = if ($env:RAYU_RELEASE_METADATA_BASE) {
    $env:RAYU_RELEASE_METADATA_BASE.TrimEnd('/')
} else {
    "https://raw.githubusercontent.com/$Repo/main/releases"
}
$LegacyInstallerUrl = if ($env:RAYU_LEGACY_INSTALLER_URL) {
    $env:RAYU_LEGACY_INSTALLER_URL
} else {
    "https://rayucode.com/install-rayu-legacy.ps1"
}
$NpmLegacyPackage = "@rayu-dev/rayu-cli"

if (-not $InstallDir) {
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData) }
    if (-not $localAppData -and $env:USERPROFILE) { $localAppData = Join-Path $env:USERPROFILE "AppData\Local" }
    $InstallDir = Join-Path $localAppData "rayu\bin"
}

$RayuHome = if ($env:RAYU_HOME) {
    $env:RAYU_HOME
} elseif ($env:USERPROFILE) {
    Join-Path $env:USERPROFILE ".rayu"
} else {
    Join-Path ([Environment]::GetFolderPath("UserProfile")) ".rayu"
}

$HotkeyDir = Join-Path $RayuHome "hotkey"
$SetupHintsPath = Join-Path $RayuHome "setup_hints.json"

function Write-Info($msg) { if (-not $Quiet) { Write-Host $msg -ForegroundColor Blue } }
function Write-Ok($msg)   { if (-not $Quiet) { Write-Host $msg -ForegroundColor Green } }
function Write-Err($msg)  { throw "error: $msg" }
function Write-Warn($msg) { Write-Host "warning: $msg" -ForegroundColor Yellow }

function ConvertFrom-RayuWebContent($Content) {
    if ($null -eq $Content) { return "" }

    # Windows PowerShell 5.1 returns Byte[] for some text responses when the
    # server uses application/octet-stream (including rayucode.com metadata and
    # GitHub release checksum manifests). Casting Byte[] directly to [string]
    # produces a space-separated list of decimal bytes instead of the text.
    if ($Content -is [byte[]]) {
        return [System.Text.Encoding]::UTF8.GetString($Content)
    }

    return [string]$Content
}

function Test-RayuReleaseTag([string]$Tag) {
    return [bool]($Tag -match '^v[0-9]+\.[0-9]+\.[0-9]+(?:[+.-][A-Za-z0-9.-]+)?$')
}

function Resolve-RayuReleaseTagFromUri([string]$Uri) {
    if (-not $Uri) { return $null }
    if ($Uri -match '/releases/tag/([^/?#]+)') {
        return [Uri]::UnescapeDataString($Matches[1])
    }
    return $null
}

function Get-LatestRayuReleaseTag {
    # Avoid api.github.com here. Its unauthenticated limit is only 60 requests
    # per public IP per hour, so installs are unreliable behind shared NAT/VPNs.
    $metadataTag = $null
    try {
        $metadataResponse = Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseMetadataBase/latest/version"
        $candidate = (ConvertFrom-RayuWebContent -Content $metadataResponse.Content).Trim()
        if (Test-RayuReleaseTag $candidate) { $metadataTag = $candidate }
    } catch {}

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri "https://github.com/$Repo/releases/latest"
        $baseResponse = $response.BaseResponse
        $resolvedUri = $null

        if ($baseResponse) {
            $responseUriProperty = $baseResponse.PSObject.Properties['ResponseUri']
            if ($responseUriProperty -and $responseUriProperty.Value) {
                $resolvedUri = [string]$responseUriProperty.Value
            }

            if (-not $resolvedUri) {
                $requestMessageProperty = $baseResponse.PSObject.Properties['RequestMessage']
                if ($requestMessageProperty -and $requestMessageProperty.Value) {
                    $resolvedUri = [string]$requestMessageProperty.Value.RequestUri
                }
            }
        }

        $tag = Resolve-RayuReleaseTagFromUri $resolvedUri
        if ($tag) { return $tag }
    } catch {
        if (-not $metadataTag) {
            Write-Err "Failed to determine latest version: $_"
        }
    }

    if ($metadataTag) {
        Write-Warn "GitHub release lookup unavailable; using cached rayucode.com metadata ($metadataTag)."
        return $metadataTag
    }
    Write-Err "Failed to determine latest version"
}

function Get-RayuReleaseDownloadBases([string]$ReleaseTag) {
    $bases = New-Object System.Collections.Generic.List[string]
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseMetadataBase/$ReleaseTag/download-bases"
        foreach ($line in ((ConvertFrom-RayuWebContent -Content $response.Content) -split "`r?`n")) {
            $candidate = $line.Trim().TrimEnd('/')
            if ($candidate -match '^https://\S+$' -and -not $bases.Contains($candidate)) {
                $bases.Add($candidate)
            }
        }
    } catch {}

    $githubBase = "https://github.com/$Repo/releases/download/$ReleaseTag"
    if (-not $bases.Contains($githubBase)) { $bases.Add($githubBase) }
    return $bases.ToArray()
}

function Get-RayuSha256FromManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestText,
        [Parameter(Mandatory = $true)][string]$AssetName
    )

    foreach ($line in ($ManifestText -split "`r?`n")) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
            $candidateName = [System.IO.Path]::GetFileName($Matches[2])
            if ($candidateName -eq $AssetName) {
                return $Matches[1].ToLowerInvariant()
            }
        }
    }

    return $null
}

function Get-ReleaseChecksum([string]$ReleaseTag, [string]$AssetName) {
    $lastError = $null
    foreach ($checksumUrl in @(
        "$ReleaseMetadataBase/$ReleaseTag/SHA256SUMS",
        "https://github.com/$Repo/releases/download/$ReleaseTag/SHA256SUMS"
    )) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $checksumUrl
            $expected = Get-RayuSha256FromManifest -ManifestText (ConvertFrom-RayuWebContent -Content $response.Content) -AssetName $AssetName
            if ($expected) { return $expected }
        } catch {
            $lastError = $_
        }
    }

    if ($lastError) {
        Write-Err "Could not download SHA256SUMS for $ReleaseTag. Refusing to install an unverified download: $lastError"
    }
    Write-Err "SHA256SUMS for $ReleaseTag does not list $AssetName"
}

function Assert-RayuFileChecksum([string]$FilePath, [string]$ExpectedSha256, [string]$AssetName) {
    try {
        $actual = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
        Write-Err "Could not calculate SHA256 for ${AssetName}: $_"
    }

    if ($actual -ne $ExpectedSha256) {
        Remove-Item -LiteralPath $FilePath -Force -ErrorAction SilentlyContinue
        Write-Err "SHA256 verification failed for $AssetName (expected $ExpectedSha256, got $actual)"
    }

    Write-Info "Verified SHA256: $AssetName"
    return $actual
}

function Get-RayuLocalAppDataDir {
    if ($env:LOCALAPPDATA) {
        return $env:LOCALAPPDATA
    }

    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ($localAppData) {
        return $localAppData
    }

    if ($env:USERPROFILE) {
        return (Join-Path $env:USERPROFILE "AppData\Local")
    }

    return (Join-Path ([Environment]::GetFolderPath("UserProfile")) "AppData\Local")
}

function Get-DefaultRayuInstallDir {
    return (Join-Path (Get-RayuLocalAppDataDir) "rayu\bin")
}

function ConvertTo-RayuPathKey([string]$PathValue) {
    if (-not $PathValue) {
        return ""
    }

    $clean = [Environment]::ExpandEnvironmentVariables($PathValue.Trim().Trim('"'))
    if (-not $clean) {
        return ""
    }

    try {
        $clean = [System.IO.Path]::GetFullPath($clean)
    } catch {
    }


    $clean = $clean.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    return $clean.ToUpperInvariant()
}

function Split-RayuPathList([string]$PathValue) {
    if (-not $PathValue) {
        return @()
    }

    $entries = @()
    foreach ($entry in ($PathValue -split ';')) {
        $clean = $entry.Trim().Trim('"')
        if ($clean) {
            $entries += $clean
        }
    }
    return $entries
}

function Join-RayuPathList([string[]]$Entries) {
    if (-not $Entries -or $Entries.Count -eq 0) {
        return ""
    }

    return ($Entries -join ';')
}

function Get-RayuManagedPathKeys([string]$InstallDir) {
    $keys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in @($InstallDir, (Get-DefaultRayuInstallDir))) {
        $key = ConvertTo-RayuPathKey $candidate
        if ($key) {
            [void]$keys.Add($key)
        }
    }
    return $keys
}

function Resolve-RayuPathUpdate {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [AllowNull()][string]$CurrentPath,
        [switch]$RemoveOnly
    )

    $managedKeys = Get-RayuManagedPathKeys -InstallDir $InstallDir
    $nextEntries = @()
    $removedManaged = 0

    foreach ($entry in (Split-RayuPathList $CurrentPath)) {
        $key = ConvertTo-RayuPathKey $entry
        if (-not $key) {
            continue
        }

        if ($managedKeys.Contains($key)) {
            $removedManaged += 1
            continue
        }

        $nextEntries += $entry
    }

    if (-not $RemoveOnly) {
        $nextEntries = @($InstallDir) + $nextEntries
    }

    $nextPath = Join-RayuPathList $nextEntries
    $changed = ($nextPath -ne ([string]$CurrentPath))

    return [pscustomobject]@{
        Path = $nextPath
        Changed = $changed
        RemovedManagedEntries = $removedManaged
        RemovedDuplicateEntries = 0
        AddedLauncherEntry = (-not $RemoveOnly)
        InstallDir = $InstallDir
    }
}

function Send-RayuEnvironmentChangedBroadcast {
    if ($env:RAYU_DISABLE_ENV_BROADCAST -eq "1") {
        return $false
    }

    if (-not ("Rayu.EnvironmentBroadcast" -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace Rayu {
    public static class EnvironmentBroadcast {
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd,
            UInt32 Msg,
            UIntPtr wParam,
            string lParam,
            UInt32 fuFlags,
            UInt32 uTimeout,
            out UIntPtr lpdwResult);
    }
}
"@
    }

    $result = [UIntPtr]::Zero
    [Rayu.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$result) | Out-Null
    return $true
}

function Set-RayuUserPath {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [AllowNull()][string]$CurrentPath,
        [scriptblock]$SetUserPathAction,
        [scriptblock]$BroadcastAction,
        [bool]$Broadcast = $true
    )

    if (-not $PSBoundParameters.ContainsKey('CurrentPath')) {
        $CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    }

    $update = Resolve-RayuPathUpdate -InstallDir $InstallDir -CurrentPath $CurrentPath
    $broadcasted = $false

    if ($update.Changed) {
        if ($SetUserPathAction) {
            & $SetUserPathAction $update.Path
        } else {
            [Environment]::SetEnvironmentVariable("Path", $update.Path, "User")
        }

        if ($Broadcast) {
            if ($BroadcastAction) {
                & $BroadcastAction | Out-Null
            } else {
                Send-RayuEnvironmentChangedBroadcast | Out-Null
            }
            $broadcasted = $true
        }
    }

    $update | Add-Member -NotePropertyName Broadcasted -NotePropertyValue $broadcasted
    return $update
}

function Remove-RayuUserPath {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [AllowNull()][string]$CurrentPath,
        [scriptblock]$SetUserPathAction,
        [scriptblock]$BroadcastAction,
        [bool]$Broadcast = $true
    )

    if (-not $PSBoundParameters.ContainsKey('CurrentPath')) {
        $CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    }

    $update = Resolve-RayuPathUpdate -InstallDir $InstallDir -CurrentPath $CurrentPath -RemoveOnly
    $broadcasted = $false

    if ($update.Changed) {
        if ($SetUserPathAction) {
            & $SetUserPathAction $update.Path
        } else {
            [Environment]::SetEnvironmentVariable("Path", $update.Path, "User")
        }

        if ($Broadcast) {
            if ($BroadcastAction) {
                & $BroadcastAction | Out-Null
            } else {
                Send-RayuEnvironmentChangedBroadcast | Out-Null
            }
            $broadcasted = $true
        }
    }

    $update | Add-Member -NotePropertyName Broadcasted -NotePropertyValue $broadcasted
    return $update
}

function Set-RayuProcessPath([string]$InstallDir) {
    $update = Resolve-RayuPathUpdate -InstallDir $InstallDir -CurrentPath $env:Path
    $env:Path = $update.Path
    return $update
}

function Remove-RayuStaleLauncherBackups {
    param(
        [Parameter(Mandatory = $true)][string]$LauncherDir
    )

    Get-ChildItem -LiteralPath $LauncherDir -Filter '.rayu-launcher-old-*.exe' -File -Force -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

function Install-RayuLauncher {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$LauncherPath
    )

    $launcherDir = Split-Path -Parent $LauncherPath
    New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null

    $operationId = [guid]::NewGuid().ToString('N')
    $tempLauncher = Join-Path $launcherDir (".rayu-launcher-{0}.tmp.exe" -f $operationId)
    $oldLauncher = Join-Path $launcherDir (".rayu-launcher-old-{0}.exe" -f $operationId)
    $movedExistingLauncher = $false
    try {
        Copy-Item -Path $SourcePath -Destination $tempLauncher -Force
        if (Test-Path -LiteralPath $LauncherPath) {
            # Windows will not overwrite a loaded executable, but it does allow
            # the directory entry to be renamed while the process keeps running
            # from its existing file handle. Move the old launcher aside first,
            # then atomically put the new binary at the stable PATH location.
            Move-Item -LiteralPath $LauncherPath -Destination $oldLauncher
            $movedExistingLauncher = $true
        }

        try {
            Move-Item -LiteralPath $tempLauncher -Destination $LauncherPath
        } catch {
            if ($movedExistingLauncher -and -not (Test-Path -LiteralPath $LauncherPath)) {
                Move-Item -LiteralPath $oldLauncher -Destination $LauncherPath
                $movedExistingLauncher = $false
            }
            throw
        }

        if ($movedExistingLauncher) {
            # Removal succeeds immediately for an idle launcher. If an older
            # rayu process still has the renamed executable loaded, Windows
            # keeps it until that process exits and the next install cleans it.
            Remove-Item -LiteralPath $oldLauncher -Force -ErrorAction SilentlyContinue
        }

        # Only prune backups after the stable path contains the new launcher.
        # Doing this before replacement could delete another concurrent
        # installer's rollback file during its short rename window.
        Remove-RayuStaleLauncherBackups -LauncherDir $launcherDir
    } finally {
        Remove-Item -LiteralPath $tempLauncher -Force -ErrorAction SilentlyContinue
    }

    return $LauncherPath
}

function Resolve-OptionalPath([string]$PathValue) {
    if (-not $PathValue) {
        return $null
    }

    try {
        return (Resolve-Path -LiteralPath $PathValue -ErrorAction Stop).Path
    } catch {
        Write-Err "Provided path does not exist: $PathValue"
    }
}

function Stop-ProcessTree([int]$ProcessId) {
    try {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ParentProcessId -eq $ProcessId } |
            ForEach-Object { Stop-ProcessTree -ProcessId $_.ProcessId }
    } catch {}

    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    } catch {}
}

function Invoke-ProcessWithTimeout {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$FriendlyName,
        [switch]$CaptureOutput
    )

    $startParams = @{
        FilePath = $FilePath
        ArgumentList = $ArgumentList
        PassThru = $true
        NoNewWindow = $true
    }

    $stdoutPath = $null
    $stderrPath = $null
    if ($CaptureOutput) {
        $stdoutPath = Join-Path $env:TEMP ("rayu-{0}-{1}-stdout.log" -f $FriendlyName, [guid]::NewGuid().ToString('N'))
        $stderrPath = Join-Path $env:TEMP ("rayu-{0}-{1}-stderr.log" -f $FriendlyName, [guid]::NewGuid().ToString('N'))
        $startParams.RedirectStandardOutput = $stdoutPath
        $startParams.RedirectStandardError = $stderrPath
    }

    $process = Start-Process @startParams
    # Wait-Process did not gain -Timeout until newer PowerShell releases. Use
    # the underlying .NET Process API so the documented PowerShell 5.1 minimum
    # is real rather than only passing on PowerShell 7.
    $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
    if ($timedOut) {
        Stop-ProcessTree -ProcessId $process.Id
        return [pscustomobject]@{
            TimedOut = $true
            ExitCode = $null
            StdoutPath = $stdoutPath
            StderrPath = $stderrPath
        }
    }

    # Ensure redirected streams have finished flushing before callers inspect
    # their files, then refresh ExitCode from the completed process.
    $process.WaitForExit()
    $process.Refresh()
    return [pscustomobject]@{
        TimedOut = $false
        ExitCode = $process.ExitCode
        StdoutPath = $stdoutPath
        StderrPath = $stderrPath
    }
}

function Write-LogTail([string]$Path, [string]$Label) {
    if (-not $Path -or -not (Test-Path $Path)) {
        return
    }

    $lines = Get-Content -Path $Path -Tail 40 -ErrorAction SilentlyContinue
    if ($lines -and $lines.Count -gt 0) {
        Write-Warn "$Label (last 40 lines):"
        $lines | ForEach-Object { Write-Host $_ }
    }
}

function Test-CommandExists([string]$CommandName) {
    return [bool](Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Test-AlacrittyInstalled {
    return [bool](Find-AlacrittyPath)
}

function Find-AlacrittyPath {
    $candidates = @(
        "C:\Program Files\Alacritty\alacritty.exe",
        "C:\Program Files (x86)\Alacritty\alacritty.exe"
    )

    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\alacritty.exe")
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    try {
        $command = Get-Command alacritty -ErrorAction Stop
        if ($command -and $command.Source) {
            return $command.Source
        }
    } catch {}

    return $null
}

function Install-Alacritty {
    if (Test-AlacrittyInstalled) {
        Write-Info "Alacritty is already installed"
        return $true
    }

    if (-not (Test-CommandExists "winget")) {
        Write-Warn "winget was not found, so Alacritty could not be installed automatically"
        Write-Warn "Install App Installer / winget from Microsoft, then run: winget install -e --id Alacritty.Alacritty"
        return $false
    }

    Write-Info "Installing Alacritty..."
    $wingetArgs = @(
        "install",
        "-e",
        "--id", "Alacritty.Alacritty",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity"
    )

    $wingetResult = Invoke-ProcessWithTimeout -FilePath "winget" -ArgumentList $wingetArgs -TimeoutSeconds 180 -FriendlyName "winget-install"
    if ($wingetResult.TimedOut) {
        Write-Warn "Alacritty install timed out after 180 seconds; skipping automatic setup"
        return $false
    }

    if ($wingetResult.ExitCode -ne 0) {
        Write-Warn "Alacritty install failed (winget exit code: $($wingetResult.ExitCode))"
        return $false
    }

    $alacrittyPath = Find-AlacrittyPath
    if (-not $alacrittyPath) {
        Write-Warn "Alacritty install finished, but alacritty.exe was not found on PATH yet"
        return $false
    }

    Write-Info "Alacritty installed: $alacrittyPath"
    return $true
}

function Stop-RayuHotkeyListeners {
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*rayu-hotkey*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}

    try {
        $currentPid = $PID
        Get-CimInstance Win32_Process -Filter "Name = 'rayu.exe' OR Name = 'rayucode.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessId -ne $currentPid -and $_.CommandLine -like '*--listen-windows-hotkey*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}
}

function ConvertFrom-RayuVersionOutput([string]$Output) {
    if (-not $Output) {
        return $null
    }

    # A genuinely fresh profile may print the one-time telemetry notice before
    # the version. When output is captured by PowerShell, terminal control
    # sequences can also leave the final `rayu v...` on the same logical line.
    if ($Output -match '(?i)\b(?:rayu|rayucode)\s+v?([0-9][0-9A-Za-z.+-]*)') {
        return "v$($Matches[1])"
    }

    return $null
}

function Get-RayuVersionFromBinary([string]$BinaryPath) {
    if (-not $BinaryPath -or -not (Test-Path -LiteralPath $BinaryPath)) {
        return $null
    }

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Fresh profiles emit the one-time telemetry notice on stderr. Under
        # Windows PowerShell with ErrorActionPreference=Stop, native stderr is
        # promoted to a terminating NativeCommandError even when the process
        # succeeds. Capture both streams without letting that notice abort the
        # version probe.
        $ErrorActionPreference = 'Continue'
        $output = (& $BinaryPath --version 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            return $null
        }
        return (ConvertFrom-RayuVersionOutput $output)
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Assert-RayuBinaryCandidate {
    param(
        [Parameter(Mandatory = $true)][string]$BinaryPath,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    if ($env:RAYU_INSTALL_SKIP_BINARY_VALIDATION -eq "1") {
        return $null
    }

    $reportedVersion = Get-RayuVersionFromBinary $BinaryPath
    if (-not $reportedVersion) {
        Write-Err "Downloaded rayu binary could not run '--version'. It may be corrupt, quarantined by antivirus, or built for the wrong architecture."
    }

    $expectedNumber = $ExpectedVersion.TrimStart('v')
    if ($reportedVersion.TrimStart('v') -ne $expectedNumber) {
        Write-Err "Downloaded binary reports $reportedVersion, but the installer requested $ExpectedVersion"
    }

    Write-Info "Validated rayu binary: $reportedVersion"
    return $reportedVersion
}

function Test-RayuMsvcBuildToolsAvailable {
    if (Get-Command link.exe -ErrorAction SilentlyContinue) {
        return $true
    }

    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    if (-not $programFilesX86) {
        return $false
    }

    $vswhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) {
        return $false
    }

    try {
        $linkPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\link.exe' 2>$null | Select-Object -First 1
        return [bool]$linkPath
    } catch {
        return $false
    }
}

function Assert-RayuSourceBuildPrerequisites {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err "Git is required for -BuildFromSource. Install it with: winget install -e --id Git.Git"
    }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -or -not (Get-Command rustc -ErrorAction SilentlyContinue)) {
        Write-Err "Rust is required for -BuildFromSource. Install it from https://rustup.rs, then open a new PowerShell window."
    }

    $rustHost = ""
    try {
        $rustHost = (& rustc -vV 2>$null | Select-String '^host:' | Select-Object -First 1).ToString()
    } catch {}

    if ($rustHost -match 'pc-windows-msvc' -and -not (Test-RayuMsvcBuildToolsAvailable)) {
        Write-Err "The MSVC linker (link.exe) was not found. Install Visual Studio 2022 Build Tools with the 'Desktop development with C++' workload, then open a new PowerShell window before using -BuildFromSource."
    }
}

function Set-SetupHintsState([bool]$AlacrittyConfigured, [bool]$HotkeyConfigured) {
    New-Item -ItemType Directory -Path $RayuHome -Force | Out-Null

    $state = @{
        launch_count = 0
        hotkey_configured = $HotkeyConfigured
        hotkey_dismissed = $HotkeyConfigured
        alacritty_configured = $AlacrittyConfigured
        alacritty_dismissed = $AlacrittyConfigured
        desktop_shortcut_created = $false
        mac_ghostty_guided = $false
        mac_ghostty_dismissed = $false
    }

    if (Test-Path $SetupHintsPath) {
        try {
            $existing = Get-Content $SetupHintsPath -Raw | ConvertFrom-Json -ErrorAction Stop
            foreach ($property in $existing.PSObject.Properties) {
                $state[$property.Name] = $property.Value
            }
        } catch {
            Write-Warn "Could not read existing setup hints state; overwriting it"
        }
    }

    if ($AlacrittyConfigured) {
        $state.alacritty_configured = $true
        $state.alacritty_dismissed = $true
    }

    if ($HotkeyConfigured) {
        $state.hotkey_configured = $true
        $state.hotkey_dismissed = $true
    }

    $state | ConvertTo-Json | Set-Content -Path $SetupHintsPath -Encoding UTF8
}

function Get-RayuHotkeyShortcutScript([string]$StartupShortcutPath, [string]$RayuExePath) {
    $escapedShortcutPath = $StartupShortcutPath.Replace("'", "''")
    $escapedExePath = $RayuExePath.Replace("'", "''")
    $listenerArguments = "-NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -Command `"& '$escapedExePath' setup-hotkey --listen-windows-hotkey`""
    $escapedListenerArguments = $listenerArguments.Replace("'", "''")
    $shortcutLines = @(
        '$ErrorActionPreference = ''Stop''',
        '$shell = New-Object -ComObject WScript.Shell',
        "`$shortcut = `$shell.CreateShortcut('$escapedShortcutPath')",
        "`$shortcut.TargetPath = 'powershell.exe'",
        "`$shortcut.Arguments = '$escapedListenerArguments'",
        "`$shortcut.Description = 'rayu global launch hotkey listener'",
        '$shortcut.WindowStyle = 7',
        '$shortcut.Save()',
        "Write-Output 'OK'"
    )
    return ($shortcutLines -join "`r`n")
}

function Install-RayuHotkey([string]$RayuExePath) {
    New-Item -ItemType Directory -Path $HotkeyDir -Force | Out-Null
    $skipProcessLifecycle = (
        $env:RAYU_WINDOWS_SETUP_SKIP_EXTERNALS -eq "1" -or
        $env:RAYU_WINDOWS_SETUP_SKIP_PROCESS_LIFECYCLE -eq "1"
    )
    if (-not $skipProcessLifecycle) {
        Stop-RayuHotkeyListeners
    }

    # Upgrade cleanup: legacy installs wrote a generated PowerShell listener.
    # The first-party listener now lives in rayu.exe itself and is launched via
    # `rayu setup-hotkey --listen-windows-hotkey` from a login shortcut.
    Remove-Item -Path (Join-Path $HotkeyDir "rayu-hotkey.ps1") -Force -ErrorAction SilentlyContinue
    Remove-Item -Path (Join-Path $HotkeyDir "rayu-hotkey-launcher.vbs") -Force -ErrorAction SilentlyContinue
    $startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
    New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
    $startupShortcutPath = Join-Path $startupDir "rayu-hotkey.lnk"
    $shortcutScript = Get-RayuHotkeyShortcutScript -StartupShortcutPath $startupShortcutPath -RayuExePath $RayuExePath

    if ($env:RAYU_WINDOWS_SETUP_SKIP_EXTERNALS -eq "1") {
        Set-Content -Path (Join-Path $HotkeyDir "rayu-hotkey-shortcut.ps1") -Value $shortcutScript -Encoding UTF8
        Write-Info "Configured Alt+; and the Copilot key to launch rayu"
        return $true
    }

    $shortcutOutput = & powershell -NoProfile -Command $shortcutScript
    if ($LASTEXITCODE -ne 0 -or -not ($shortcutOutput -match 'OK')) {
        Write-Warn "Created hotkey files, but could not create the Startup shortcut"
        return $false
    }

    $escapedExePath = $RayuExePath.Replace("'", "''")
    $launchHotkeyCommand = "Start-Process -FilePath '$escapedExePath' -ArgumentList @('setup-hotkey', '--listen-windows-hotkey') -WindowStyle Hidden"
    if (-not $skipProcessLifecycle) {
        & powershell -NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -Command $launchHotkeyCommand | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "Hotkey will start on next login, but could not be launched immediately"
        }
    }

    Write-Info "Configured Alt+; and the Copilot key to launch rayu"
    return $true
}
function Resolve-RayuWindowsArtifact([string[]]$ArchitectureCandidates) {
    $sawX64 = $false

    foreach ($arch in @($ArchitectureCandidates)) {
        if (-not $arch) { continue }
        switch -Regex ($arch.Trim()) {
            '^(Arm64|ARM64|AARCH64|aarch64)$' { return "rayu-windows-aarch64" }
            '^(X64|AMD64|x86_64)$' { $sawX64 = $true }
        }
    }

    if ($sawX64) { return "rayu-windows-x86_64" }
    return $null
}

function Get-RayuWindowsArtifact {
    $candidates = @()

    try {
        $runtimeArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
        if ($runtimeArch) { $candidates += [string]$runtimeArch }
    } catch {}

    foreach ($envArch in @($env:PROCESSOR_ARCHITECTURE, $env:PROCESSOR_ARCHITEW6432)) {
        if ($envArch) { $candidates += [string]$envArch }
    }

    $artifact = Resolve-RayuWindowsArtifact $candidates
    if ($artifact) { return $artifact }

    $displayArch = if ($candidates.Count -gt 0) { $candidates -join ", " } else { "<unknown>" }
    Write-Err "Unsupported architecture: $displayArch (supported: x86_64, ARM64)"
}

function Invoke-RayuUninstall {
    $BuildsDir = Join-Path (Get-RayuLocalAppDataDir) "rayu\builds"
    foreach ($f in @("rayu.exe", "rayucode.exe")) {
        $p = Join-Path $InstallDir $f
        if (Test-Path -LiteralPath $p) {
            Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $BuildsDir) {
        Remove-Item -LiteralPath $BuildsDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not $NoModifyPath) {
        Remove-RayuUserPath -InstallDir $InstallDir | Out-Null
    }
    Write-Ok "RayuCode binaries uninstalled. Your settings and sessions in $RayuHome were kept."
}

function Write-GuardedLegacyCmdLauncher([string]$TargetPath, [string]$NodeExe, [string]$EntryPath) {
    $cmd = @"
@echo off
setlocal
set "RAYU_NODE=$NodeExe"
set "RAYU_ENTRY=$EntryPath"
if not exist "%RAYU_NODE%" for %%I in (node.exe) do @set "RAYU_NODE=%%~`$PATH:I"
if not exist "%RAYU_NODE%" (
  echo rayu-legacy: Node was not found. 1>&2
  exit /b 127
)
if not exist "%RAYU_ENTRY%" (
  echo rayu-legacy: legacy bundle missing (%RAYU_ENTRY%). 1>&2
  exit /b 127
)
if /i "%~1"=="update" goto :blocked
if /i "%~1"=="upgrade" goto :blocked
"%RAYU_NODE%" "%RAYU_ENTRY%" %*
exit /b %ERRORLEVEL%
:blocked
echo rayu-legacy: self-update is disabled because 'rayu' is now managed by RayuCode v3. 1>&2
echo rayu-legacy: run 'rayu update' to update RayuCode instead. 1>&2
exit /b 1
"@
    Set-Content -Path $TargetPath -Value $cmd -Encoding ASCII
}

function Invoke-RayuLegacyMigration([string]$LauncherPath, [string]$InstalledVersion) {
    $legacyFound = $false
    $legacyScriptFound = $false
    $legacyRenamedNow = $false
    $legacyNpmFound = $false
    $legacyVersion = ""
    $legacyBinDir = Join-Path $RayuHome "bin"
    $legacyBinPath = ""
    $legacyNodeExe = ""
    $legacyEntryPath = ""

    $installJsonPath = Join-Path $RayuHome "install.json"
    if (Test-Path -LiteralPath $installJsonPath) {
        try {
            $meta = Get-Content -LiteralPath $installJsonPath -Raw | ConvertFrom-Json
            if ($meta.binDir) { $legacyBinDir = [string]$meta.binDir }
            if ($meta.version) { $legacyVersion = [string]$meta.version }
            if ($meta.node -and $meta.node -ne "embedded") { $legacyNodeExe = [string]$meta.node }
        } catch {}
    }

    $libDir = Join-Path $RayuHome "lib"
    if (Test-Path -LiteralPath $libDir) {
        $latestLib = Get-ChildItem -LiteralPath $libDir -Directory -Filter "rayu-*" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latestLib) {
            $candidateEntry = Join-Path $latestLib.FullName "rayu.js"
            if (Test-Path -LiteralPath $candidateEntry) { $legacyEntryPath = $candidateEntry }
        }
    }

    $sameInstallDir = (ConvertTo-RayuPathKey $legacyBinDir) -eq (ConvertTo-RayuPathKey $InstallDir)
    if (-not $sameInstallDir) {
        $oldCmd = Join-Path $legacyBinDir "rayu.cmd"
        $oldExe = Join-Path $legacyBinDir "rayu.exe"
        $legacyCmd = Join-Path $legacyBinDir "rayu-legacy.cmd"
        $legacyExe = Join-Path $legacyBinDir "rayu-legacy.exe"
        $oldInstaller = Join-Path $legacyBinDir ".rayu-installer.ps1"

        if (Test-Path -LiteralPath $oldCmd) {
            $legacyFound = $true
            $legacyScriptFound = $true
            if (-not $legacyEntryPath) {
                $m = Select-String -Path $oldCmd -Pattern '^set "RAYU_ENTRY=(.+)"$' -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($m) { $legacyEntryPath = $m.Matches[0].Groups[1].Value }
            }
            if (-not $legacyNodeExe) {
                $m = Select-String -Path $oldCmd -Pattern '^set "RAYU_NODE=(.+)"$' -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($m) { $legacyNodeExe = $m.Matches[0].Groups[1].Value }
            }
            if ($legacyEntryPath -and (Test-Path -LiteralPath $legacyEntryPath)) {
                Write-GuardedLegacyCmdLauncher -TargetPath $legacyCmd -NodeExe $legacyNodeExe -EntryPath $legacyEntryPath
                Remove-Item -LiteralPath $oldCmd -Force -ErrorAction SilentlyContinue
            } else {
                Move-Item -LiteralPath $oldCmd -Destination $legacyCmd -Force
            }
            if (Test-Path -LiteralPath $oldExe) { Remove-Item -LiteralPath $oldExe -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $oldInstaller) { Remove-Item -LiteralPath $oldInstaller -Force -ErrorAction SilentlyContinue }
            $legacyRenamedNow = $true
            $legacyBinPath = $legacyCmd
        } elseif ((Test-Path -LiteralPath $oldExe) -and ((Test-Path -LiteralPath $installJsonPath) -or $legacyEntryPath)) {
            $legacyFound = $true
            $legacyScriptFound = $true
            if ($legacyEntryPath -and (Test-Path -LiteralPath $legacyEntryPath)) {
                Write-GuardedLegacyCmdLauncher -TargetPath $legacyCmd -NodeExe $legacyNodeExe -EntryPath $legacyEntryPath
                Remove-Item -LiteralPath $oldExe -Force -ErrorAction SilentlyContinue
                $legacyBinPath = $legacyCmd
            } else {
                Move-Item -LiteralPath $oldExe -Destination $legacyExe -Force
                $legacyBinPath = $legacyExe
            }
            if (Test-Path -LiteralPath $oldInstaller) { Remove-Item -LiteralPath $oldInstaller -Force -ErrorAction SilentlyContinue }
            $legacyRenamedNow = $true
        } elseif ((Test-Path -LiteralPath $legacyCmd) -or (Test-Path -LiteralPath $legacyExe) -or $legacyEntryPath -or (Test-Path -LiteralPath $installJsonPath)) {
            $legacyFound = $true
            $legacyScriptFound = $true
            if (Test-Path -LiteralPath $oldInstaller) { Remove-Item -LiteralPath $oldInstaller -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $legacyCmd) { $legacyBinPath = $legacyCmd }
            elseif (Test-Path -LiteralPath $legacyExe) { $legacyBinPath = $legacyExe }
            elseif ($legacyEntryPath) {
                New-Item -ItemType Directory -Force -Path $legacyBinDir | Out-Null
                Write-GuardedLegacyCmdLauncher -TargetPath $legacyCmd -NodeExe $legacyNodeExe -EntryPath $legacyEntryPath
                $legacyRenamedNow = $true
                $legacyBinPath = $legacyCmd
            }
        }
    }

    if ($env:RAYU_SKIP_NPM_CHECK -ne "1" -and (Get-Command npm -ErrorAction SilentlyContinue)) {
        try {
            $npmOut = (& npm ls -g --depth=0 $NpmLegacyPackage 2>$null | Out-String)
            if ($npmOut -match '@rayu-dev/rayu-cli@([^\s]+)') {
                $legacyFound = $true
                $legacyNpmFound = $true
                if (-not $legacyVersion) { $legacyVersion = "npm $($Matches[1])" }
            }
        } catch {}
    }

    if (-not $legacyFound) { return }

    $legacyLabel = if ($legacyVersion) { "legacy Node Rayu ($legacyVersion)" } else { "legacy Node Rayu" }
    if (-not $Quiet) {
        Write-Host ""
        Write-Info "Migration status:"
        if ($legacyRenamedNow) {
            Write-Info "  * Your old $legacyLabel was renamed to: rayu-legacy"
        } else {
            Write-Info "  * Existing $legacyLabel detected as: rayu-legacy"
        }
        if ($legacyBinPath) { Write-Info "    Location: $legacyBinPath" }
        Write-Info "  * New RayuCode $InstalledVersion (Rust) is installed at: $LauncherPath"
        Write-Info "  * Your settings, API keys, and sessions in $RayuHome were preserved."
        Write-Host ""
    }

    $action = "ask"
    if ($RemoveLegacy -or $env:RAYU_REMOVE_LEGACY -eq "1") { $action = "remove" }
    elseif ($KeepLegacy -or $env:RAYU_KEEP_LEGACY -eq "1" -or $Quiet -or $env:CI) { $action = "keep" }

    $doRemove = $false
    if ($action -eq "remove") {
        $doRemove = $true
    } elseif ($action -eq "ask" -and [Environment]::UserInteractive -and $Host.Name -ne 'ServerRemoteHost') {
        try {
            $reply = Read-Host "Do you want to uninstall rayu-legacy now? [y/N]"
            if ($reply -match '^(y|yes)$') { $doRemove = $true }
        } catch {}
    }

    if ($doRemove) {
        if ($legacyScriptFound) {
            foreach ($f in @("rayu-legacy.cmd", "rayu-legacy.exe", "rayu.cmd", ".rayu-installer.ps1")) {
                $p = Join-Path $legacyBinDir $f
                if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
            }
            foreach ($d in @((Join-Path $RayuHome "lib"), (Join-Path $RayuHome "runtime"))) {
                if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
            }
            if (Test-Path -LiteralPath $installJsonPath) { Remove-Item -LiteralPath $installJsonPath -Force -ErrorAction SilentlyContinue }
            try { Remove-RayuUserPath -InstallDir $legacyBinDir | Out-Null } catch {}
        }
        if ($legacyNpmFound) {
            if ($env:RAYU_FROM_NPM_POSTINSTALL -eq "1" -or $env:npm_lifecycle_event) {
                Write-Warn "Running inside npm lifecycle; finish removing the legacy npm package with:"
                Write-Info "    npm uninstall -g $NpmLegacyPackage"
            } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
                try {
                    & npm uninstall -g $NpmLegacyPackage 2>$null | Out-Null
                    Write-Ok "Uninstalled global npm package $NpmLegacyPackage."
                } catch {
                    Write-Warn "Could not run 'npm uninstall -g $NpmLegacyPackage' automatically."
                }
            }
        }
        Write-Ok "Removed rayu-legacy. Your settings, API keys, and sessions in $RayuHome were kept."
    } elseif (-not $Quiet) {
        Write-Info "Kept rayu-legacy. You can still run the old CLI with 'rayu-legacy'."
        Write-Info "To uninstall rayu-legacy later, run:"
        if ($legacyScriptFound) {
            Write-Info "  irm $LegacyInstallerUrl -OutFile install-rayu-legacy.ps1; .\install-rayu-legacy.ps1 -Uninstall"
        }
        if ($legacyNpmFound) {
            Write-Info "  npm uninstall -g $NpmLegacyPackage"
        }
    }
}

function Invoke-RayuInstall {
if ($Uninstall) {
    Invoke-RayuUninstall
    return
}

$Artifact = Get-RayuWindowsArtifact

$ResolvedArtifactExePath = Resolve-OptionalPath $ArtifactExePath
$ResolvedArtifactTgzPath = Resolve-OptionalPath $ArtifactTgzPath

if ($ResolvedArtifactExePath -and $ResolvedArtifactTgzPath) {
    Write-Err "Provide only one of -ArtifactExePath or -ArtifactTgzPath"
}

if ($Version -and -not $ResolvedArtifactExePath -and -not $ResolvedArtifactTgzPath) {
    if (-not $Version.StartsWith('v')) { $Version = "v$Version" }
    if ($env:RAYU_ALLOW_LEGACY_TAG -ne "1" -and $Version -match '^v([012])\.') {
        Write-Info "Requested legacy version $Version - upgrading to the latest RayuCode v3 (Rust) release."
        Write-Info "  (To install the legacy Node v2 CLI instead: irm $LegacyInstallerUrl | iex)"
        $Version = ""
    }
}

if (-not $Version) {
    if ($ResolvedArtifactExePath) {
        $Version = Get-RayuVersionFromBinary $ResolvedArtifactExePath
        if (-not $Version) {
            Write-Err "Could not detect a rayu version from '$ResolvedArtifactExePath'. Pass -Version explicitly if this is a trusted local build."
        }
        Write-Info "Detected local artifact version: $Version"
    } elseif ($ResolvedArtifactTgzPath) {
        Write-Err "-Version is required when using -ArtifactTgzPath"
    } else {
        Write-Info "Fetching latest release..."
        $Version = Get-LatestRayuReleaseTag
    }
}

if (-not $Version) { Write-Err "Failed to determine latest version" }

$VersionNum = $Version.TrimStart('v')
$DownloadBases = Get-RayuReleaseDownloadBases $Version

$BuildsDir = Join-Path (Get-RayuLocalAppDataDir) "rayu\builds"
$StableDir = Join-Path $BuildsDir "stable"
$VersionDir = Join-Path $BuildsDir "versions\$VersionNum"
$LauncherPath = Join-Path $InstallDir "rayu.exe"
$AliasLauncherPath = Join-Path $InstallDir "rayucode.exe"

$Existing = ""
if (Test-Path $LauncherPath) {
    try { $Existing = & $LauncherPath --version 2>$null | Select-Object -First 1 } catch {}
}

if ($Existing) {
    if ($Existing -match [regex]::Escape($VersionNum)) {
        Write-Info "rayu $Version is already installed - reinstalling"
    } else {
        Write-Info "Updating rayu $Existing -> $Version"
    }
} else {
    Write-Info "Installing rayu $Version"
}
Write-Info "  launcher: $LauncherPath"

foreach ($d in @($InstallDir, $StableDir, $VersionDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

$TempDir = Join-Path $env:TEMP "rayu-install-$(Get-Random)"
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
$DownloadMode = ""
$DownloadPath = Join-Path $TempDir "rayu.download"
$DownloadedAssetName = $null

if ($ResolvedArtifactExePath) {
    Write-Info "Using local artifact exe: $ResolvedArtifactExePath"
    Copy-Item -Path $ResolvedArtifactExePath -Destination $DownloadPath -Force
    $DownloadMode = "bin"
} elseif ($ResolvedArtifactTgzPath) {
    Write-Info "Using local artifact archive: $ResolvedArtifactTgzPath"
    Copy-Item -Path $ResolvedArtifactTgzPath -Destination $DownloadPath -Force
    $DownloadMode = "tar"
} else {
    foreach ($candidate in @(
        @{ Name = "$Artifact.exe"; Mode = "bin" },
        @{ Name = "$Artifact.tar.gz"; Mode = "tar" }
    )) {
        foreach ($base in $DownloadBases) {
            try {
                Write-Info "Downloading $($candidate.Name) from $base..."
                Invoke-WebRequest -UseBasicParsing -Uri "$base/$($candidate.Name)" -OutFile $DownloadPath
                $DownloadMode = $candidate.Mode
                $DownloadedAssetName = $candidate.Name
                break
            } catch {}
        }
        if ($DownloadMode) { break }
    }
}

if (-not $ResolvedArtifactExePath -and -not $ResolvedArtifactTgzPath -and $DownloadMode) {
    $downloadedAssetName = if ($DownloadMode -eq "bin") { "$Artifact.exe" } else { "$Artifact.tar.gz" }
    $expectedSha256 = Get-ReleaseChecksum -ReleaseTag $Version -AssetName $downloadedAssetName
    Assert-RayuFileChecksum -FilePath $DownloadPath -ExpectedSha256 $expectedSha256 -AssetName $downloadedAssetName | Out-Null
}

$DestBin = Join-Path $VersionDir "rayu.exe"
$NoticesSource = $null

if ($DownloadMode -eq "tar") {
    Write-Info "Extracting..."
    tar xzf $DownloadPath -C $TempDir 2>$null
    $SrcBin = Join-Path $TempDir "$Artifact.exe"
    if (-not (Test-Path $SrcBin)) {
        Write-Err "Downloaded archive did not contain expected binary: $Artifact.exe"
    }
    Move-Item -Path $SrcBin -Destination $DestBin -Force
    $NoticesSource = $TempDir
} elseif ($DownloadMode -eq "bin") {
    Move-Item -Path $DownloadPath -Destination $DestBin -Force
} else {
    if (-not $BuildFromSource) {
        $releaseUrl = "https://github.com/$Repo/releases/tag/$Version"
        Write-Err "No prebuilt $Artifact asset was found in $Version. Check $releaseUrl or rerun the downloaded script with -BuildFromSource. The installer will not start a long source build automatically."
    }

    Write-Info "No prebuilt asset found for $Artifact in $Version; -BuildFromSource was requested"
    Assert-RayuSourceBuildPrerequisites

    $SrcDir = Join-Path $TempDir "rayu-src"
    Write-Info "Cloning $Repo at $Version..."
    $gitCloneResult = Invoke-ProcessWithTimeout -FilePath "git" -ArgumentList @(
        "clone",
        "--depth", "1",
        "--branch", $Version,
        "https://github.com/$Repo.git",
        $SrcDir
    ) -TimeoutSeconds 600 -FriendlyName "git-clone" -CaptureOutput
    if ($gitCloneResult.TimedOut) {
        Write-LogTail -Path $gitCloneResult.StdoutPath -Label "git stdout"
        Write-LogTail -Path $gitCloneResult.StderrPath -Label "git stderr"
        Write-Err "git clone timed out after 600 seconds"
    }
    if ($gitCloneResult.ExitCode -ne 0) {
        Write-LogTail -Path $gitCloneResult.StdoutPath -Label "git stdout"
        Write-LogTail -Path $gitCloneResult.StderrPath -Label "git stderr"
        Write-Err "Failed to clone $Repo at $Version (exit code: $($gitCloneResult.ExitCode))"
    }

    Write-Info "Building rayu from source (this can take several minutes)..."
    # .cargo/config.toml sets a POSIX shell rustc wrapper for local builds.
    # Windows cannot run it, so clear it for this build.
    $env:CARGO_BUILD_RUSTC_WRAPPER = ""
    $cargoResult = Invoke-ProcessWithTimeout -FilePath "cargo" -ArgumentList @(
        "build", "--release", "--locked", "-p", "rayucode", "--bin", "rayu",
        "--manifest-path", (Join-Path $SrcDir "Cargo.toml")
    ) -TimeoutSeconds 1800 -FriendlyName "cargo-build" -CaptureOutput
    if ($cargoResult.TimedOut) {
        Write-LogTail -Path $cargoResult.StdoutPath -Label "cargo stdout"
        Write-LogTail -Path $cargoResult.StderrPath -Label "cargo stderr"
        Write-Err "cargo build timed out after 1800 seconds"
    }
    if ($cargoResult.ExitCode -ne 0) {
        Write-LogTail -Path $cargoResult.StdoutPath -Label "cargo stdout"
        Write-LogTail -Path $cargoResult.StderrPath -Label "cargo stderr"
        Write-Err "cargo build failed (exit code: $($cargoResult.ExitCode))"
    }

    $BuiltBin = Join-Path $SrcDir "target\release\rayu.exe"
    if (-not (Test-Path $BuiltBin)) { Write-Err "Built binary not found at $BuiltBin" }
    Copy-Item -Path $BuiltBin -Destination $DestBin -Force
    $NoticesSource = $SrcDir
}

Assert-RayuBinaryCandidate -BinaryPath $DestBin -ExpectedVersion $Version | Out-Null

$StableBin = Join-Path $StableDir "rayu.exe"
Copy-Item -Path $DestBin -Destination $StableBin -Force
if ($NoticesSource) {
    foreach ($notice in @("LICENSE", "THIRD_PARTY_NOTICES", "dependency-inventory.json")) {
        $noticePath = Join-Path $NoticesSource $notice
        if (Test-Path -LiteralPath $noticePath -PathType Leaf) {
            Copy-Item -LiteralPath $noticePath -Destination $VersionDir -Force
            Copy-Item -LiteralPath $noticePath -Destination $StableDir -Force
        }
    }
} elseif ($DownloadMode -eq "bin") {
    # Current standalone builds embed their notices. Older tagged binaries may
    # not support this option, so keep their installer path working.
    $notices = $null
    try {
        $notices = & $DestBin --licenses 2>$null
        if ($LASTEXITCODE -ne 0) { $notices = $null }
    } catch {}
    if ($notices) {
        $noticePath = Join-Path $TempDir "LICENSES.txt"
        $notices | Set-Content -Path $noticePath -Encoding UTF8
        Copy-Item -LiteralPath $noticePath -Destination $VersionDir -Force
        Copy-Item -LiteralPath $noticePath -Destination $StableDir -Force
    }
}
Set-Content -Path (Join-Path $BuildsDir "stable-version") -Value $VersionNum
Install-RayuLauncher -SourcePath $StableBin -LauncherPath $LauncherPath | Out-Null
Install-RayuLauncher -SourcePath $StableBin -LauncherPath $AliasLauncherPath | Out-Null
} finally {
    Get-Item -LiteralPath $TempDir -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# Gracefully reload any running background server onto the freshly installed
# binary (issue #291). `server reload` only reloads a genuinely-older daemon,
# hands its live sessions to the new process, and is a no-op when nothing is
# running, so it is safe to call unconditionally. Best-effort: never fail the
# install over it.
if ($env:RAYU_SKIP_SERVER_RELOAD -ne "1") {
    try {
        & $LauncherPath server reload 2>$null | Out-Null
    } catch {
    }
}

if (-not $NoModifyPath) {
    $userPathUpdate = Set-RayuUserPath -InstallDir $InstallDir
    if ($userPathUpdate.Changed) {
        Write-Info "Updated user PATH with $InstallDir"
        if ($userPathUpdate.RemovedManagedEntries -gt 0 -or $userPathUpdate.RemovedDuplicateEntries -gt 0) {
            Write-Info "  removed $($userPathUpdate.RemovedManagedEntries) stale rayu PATH entr$(if ($userPathUpdate.RemovedManagedEntries -eq 1) { 'y' } else { 'ies' }) and $($userPathUpdate.RemovedDuplicateEntries) duplicate entr$(if ($userPathUpdate.RemovedDuplicateEntries -eq 1) { 'y' } else { 'ies' })"
        }
    } else {
        Write-Info "User PATH already contains $InstallDir"
    }

    Set-RayuProcessPath -InstallDir $InstallDir | Out-Null
}

$installedAlacritty = $false
$configuredHotkey = $false
$shouldSetupAlacritty = [bool]($ConfigureAlacritty -and -not $SkipAlacrittySetup)
$shouldSetupHotkey = [bool]($ConfigureHotkey -and -not $SkipHotkeySetup)

if ($ConfigureAlacritty -and $SkipAlacrittySetup) {
    Write-Warn "Both -ConfigureAlacritty and -SkipAlacrittySetup were provided; skipping Alacritty setup"
}
if ($ConfigureHotkey -and $SkipHotkeySetup) {
    Write-Warn "Both -ConfigureHotkey and -SkipHotkeySetup were provided; skipping hotkey setup"
}

if ($shouldSetupAlacritty) {
    $installedAlacritty = Install-Alacritty
} else {
    $installedAlacritty = Test-AlacrittyInstalled
    Write-Info "Optional Alacritty setup not requested"
}

if ($shouldSetupHotkey) {
    $configuredHotkey = Install-RayuHotkey -RayuExePath $LauncherPath
} else {
    Write-Info "Optional global hotkey setup not requested"
}

Set-SetupHintsState -AlacrittyConfigured:(Test-AlacrittyInstalled) -HotkeyConfigured:$configuredHotkey

if (-not $Quiet) {
    Write-Host ""
    Write-Ok "rayu $Version installed successfully!"
    Write-Host ""
}

Invoke-RayuLegacyMigration -LauncherPath $LauncherPath -InstalledVersion $Version

if (Test-AlacrittyInstalled) {
    $alacrittyPath = Find-AlacrittyPath
    if ($alacrittyPath) {
        Write-Info "Alacritty ready: $alacrittyPath"
    }
}

if ($configuredHotkey) {
    Write-Info "Global launch keys ready: Alt+; and the Copilot key open rayu"
    Write-Host ""
} elseif (-not $ConfigureHotkey) {
    Write-Info "Optional: run 'rayu setup-hotkey' to configure global launch hotkeys and terminal preferences."
    Write-Host ""
}

if (Get-Command rayu -ErrorAction SilentlyContinue) {
    Write-Info "Run 'rayu' to get started."
} else {
    Write-Host "  Open a new terminal window, then run:"
    Write-Host ""
    Write-Host "    rayu" -ForegroundColor Green
}
}

if ($env:RAYU_INSTALL_PS1_IMPORT_ONLY -ne "1") {
    Invoke-RayuInstall
}
