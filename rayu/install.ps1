<#
.SYNOPSIS
  Rayu CLI installer for Windows.

.DESCRIPTION
  irm https://rayucode.com/install.ps1 | iex

  CANONICAL COPY: rayu-web/public/install.ps1 — that is the file the website
  serves at /install.ps1. rayu/install.ps1 must stay byte-identical to it;
  `bun run check:installer` diffs both against the live URLs.

  Mirrors https://rayucode.com/install (the Linux/macOS script):

    1. Prefer a standalone native .exe from GitHub Releases when one is
       published for this platform (embeds its own runtime, nothing else needed).
    2. Otherwise download the published npm tarball straight from the registry
       and extract the single pre-bundled file (dist/rayu.js). No npm, no
       dependency resolution, no node-gyp, no admin rights.
    3. Run it with the system Node when it is >= 18, otherwise unpack a private
       checksum-verified Node into %USERPROFILE%\.rayu\runtime.
    4. Install into %USERPROFILE%\.rayu\bin and add that to the *user* PATH.

.PARAMETER Version
  Install an exact version instead of the latest.

.PARAMETER Dir
  Bin directory. Default: $env:USERPROFILE\.rayu\bin

.PARAMETER NoModifyPath
  Do not touch the user PATH.

.PARAMETER NpmTarball
  Skip the standalone binary and use the bundled JS build.

.PARAMETER Uninstall
  Remove a Rayu install created by this script.

.EXAMPLE
  irm https://rayucode.com/install.ps1 | iex

.EXAMPLE
  # With options, download first (piping to iex cannot forward arguments):
  irm https://rayucode.com/install.ps1 -OutFile install.ps1
  .\install.ps1 -Version 1.6.13
#>
[CmdletBinding()]
param(
  [string]$Version = $env:RAYU_VERSION,
  [string]$Dir = $env:RAYU_INSTALL_DIR,
  [switch]$NoModifyPath,
  [switch]$NpmTarball,
  [switch]$Uninstall,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Invoke-WebRequest's own progress bar is both unstylable and, on PowerShell
# 5.1, a large fixed cost per response chunk (it can dominate download time).
# Turned off globally; this script draws its own.
$ProgressPreference = 'SilentlyContinue'

# TLS 1.2 for PowerShell 5.1 on older Windows builds, where the default
# (SSL3/TLS1.0) is rejected by npmjs.org and nodejs.org.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

$NpmPackage = '@rayu-dev/rayu-cli'
$NpmPackageUrlSafe = '@rayu-dev%2frayu-cli'
$NpmRegistry = if ($env:RAYU_NPM_REGISTRY) { $env:RAYU_NPM_REGISTRY } else { 'https://registry.npmjs.org' }
$GithubRepo = if ($env:RAYU_GITHUB_REPO) { $env:RAYU_GITHUB_REPO } else { 'Choeng-Rayu/rayu-cli' }
$InstallerUrl = if ($env:RAYU_INSTALLER_URL) { $env:RAYU_INSTALLER_URL } else { 'https://rayucode.com/install.ps1' }

$NodeVersion = if ($env:RAYU_NODE_VERSION) { $env:RAYU_NODE_VERSION } else { 'v22.20.0' }
$NodeDist = 'https://nodejs.org/dist'
$MinNodeMajor = 18

$RayuHome = if ($env:RAYU_HOME) { $env:RAYU_HOME } else { Join-Path $env:USERPROFILE '.rayu' }
$BinDir = if ($Dir) { $Dir } else { Join-Path $RayuHome 'bin' }
$LibDir = Join-Path $RayuHome 'lib'
$RuntimeDir = Join-Path $RayuHome 'runtime'

if ($Version) { $Version = $Version.TrimStart('v') }

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

# Windows PowerShell 5.1 typically runs in a console whose code page is 437/850,
# where box-drawing and block characters render as mojibake. Only use them when
# the output encoding is actually UTF-8 (PowerShell 7 default, or an explicitly
# switched console).
$script:Unicode = $false
try { $script:Unicode = ([Console]::OutputEncoding.CodePage -eq 65001) } catch {}
$MarkOk   = if ($script:Unicode) { [char]0x2713 } else { '+' }   # ✓
$MarkStep = if ($script:Unicode) { [char]0x25B8 } else { '>' }   # ▸
$BarFull  = if ($script:Unicode) { [char]0x2588 } else { '#' }   # █
$BarEmpty = if ($script:Unicode) { [char]0x2591 } else { '-' }   # ░
$RuleChar = if ($script:Unicode) { [char]0x2500 } else { '-' }   # ─

# Is there a real console to animate in? Redirected output (CI, `> log.txt`)
# must get plain lines, not a thousand carriage returns.
$script:Interactive = $false
try { $script:Interactive = -not [Console]::IsOutputRedirected } catch {}

function Get-TermWidth {
  try {
    $w = [Console]::WindowWidth
    if ($w -ge 40) { return $w }
  } catch {}
  return 80
}

function Write-Info([string]$m) { if (-not $Quiet) { Write-Host $m } }

function Write-Step([string]$m) {
  if ($Quiet) { return }
  Write-Host "  $MarkStep " -NoNewline -ForegroundColor Cyan
  Write-Host $m
}

function Write-Ok([string]$m) {
  if ($Quiet) { return }
  Write-Host "  $MarkOk " -NoNewline -ForegroundColor Green
  Write-Host $m
}

function Write-Warn([string]$m) {
  Write-Host ''
  Write-Host '  warning ' -NoNewline -ForegroundColor Yellow
  Write-Host ($m -replace "`n", "`n          ")
}

# Heading plus a rule, sized to the console and capped so a maximised window
# does not draw a 200-character line.
function Write-Title([string]$m) {
  if ($Quiet) { return }
  $w = [Math]::Min((Get-TermWidth) - 4, 62)
  Write-Host ''
  Write-Host "  $m" -ForegroundColor White
  Write-Host ('  ' + ([string]$RuleChar * $w)) -ForegroundColor DarkGray
}

# Aligned "label   value" line for the summary.
function Write-Field([string]$name, [string]$value) {
  if ($Quiet) { return }
  Write-Host ('  ' + $name.PadRight(9) + ' ') -NoNewline -ForegroundColor DarkGray
  Write-Host $value
}

function Format-Bytes([long]$b) {
  if ($b -lt 0) { return '?' }
  if ($b -lt 1KB) { return "$b B" }
  if ($b -lt 1MB) { return ('{0:N0} KB' -f ($b / 1KB)) }
  if ($b -lt 1GB) { return ('{0:N1} MB' -f ($b / 1MB)) }
  return ('{0:N2} GB' -f ($b / 1GB))
}

function Die([string]$m) {
  if ($script:Interactive) { Write-Host ("`r" + (' ' * ((Get-TermWidth) - 1)) + "`r") -NoNewline }
  Write-Host ''
  Write-Host '  error ' -NoNewline -ForegroundColor Red
  Write-Host ($m -replace "`n", "`n        ")
  Write-Host ''
  Write-Host '  Need help? https://rayucode.com/docs/10-troubleshooting' -ForegroundColor DarkGray
  Write-Host ''
  # throw, not exit: `irm ... | iex` runs this in the caller's session, where
  # `exit` would close the user's PowerShell window before they can read the
  # error. An unhandled throw still yields exit code 1 under `pwsh -File`.
  throw 'Rayu CLI installation failed.'
}

# ---------------------------------------------------------------------------
# Platform
# ---------------------------------------------------------------------------

function Get-RayuArch {
  # PROCESSOR_ARCHITECTURE is x86 for a 32-bit PowerShell on 64-bit Windows;
  # PROCESSOR_ARCHITEW6432 then holds the real machine architecture.
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  switch ($a) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    'x86'   { 'x64' }
    default { Die "unsupported CPU architecture: $a" }
  }
}

$Arch = Get-RayuArch
# Matches getPlatform() in src/utils/nativeInstaller/installer.ts.
$NativePlatform = "win32-$Arch"

# ---------------------------------------------------------------------------
# Download + checksum primitives
# ---------------------------------------------------------------------------

function Get-Url([string]$Url, [string]$OutFile) {
  # -UseBasicParsing keeps this working on machines where IE has never been
  # initialised (Server Core, fresh images), which otherwise throws.
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 120
}

# Draw one frame of the progress bar. Uses Write-Host with -ForegroundColor
# rather than ANSI escapes: VT processing is not enabled by default in Windows
# PowerShell 5.1's console host, where escapes would print as literal garbage.
function Write-Bar([long]$Done, [long]$Total, [double]$Seconds) {
  $w = Get-TermWidth
  $barw = [Math]::Max(10, [Math]::Min(34, $w - 56))

  if ($Total -gt 0) {
    $pct = [Math]::Min(100, [int](($Done * 100) / $Total))
    $fill = [Math]::Min($barw, [int](($pct * $barw) / 100))
  } else {
    # Unknown size: sweep a block across the bar so it is visibly alive.
    $pct = -1
    $fill = [int](($Done / 262144) % ($barw + 1))
  }

  $rate = ''
  if ($Seconds -ge 1 -and $Done -gt 0) {
    $rate = ' - ' + (Format-Bytes ([long]($Done / $Seconds))) + '/s'
  }

  $tail = if ($pct -ge 0) {
    ('{0,4}%  {1} / {2}{3}' -f $pct, (Format-Bytes $Done), (Format-Bytes $Total), $rate)
  } else {
    ('     {0}{1}' -f (Format-Bytes $Done), $rate)
  }

  Write-Host ("`r    ") -NoNewline
  Write-Host ([string]$BarFull * $fill) -NoNewline -ForegroundColor Cyan
  Write-Host ([string]$BarEmpty * ($barw - $fill)) -NoNewline -ForegroundColor DarkGray
  # Pad to the previous frame's width so a shrinking tail cannot leave residue.
  Write-Host ($tail.PadRight(34)) -NoNewline -ForegroundColor Gray
}

function Clear-Line {
  if ($script:Interactive) {
    Write-Host ("`r" + (' ' * ([Math]::Max(1, (Get-TermWidth) - 1))) + "`r") -NoNewline
  }
}

# Download with a live progress bar.
#
# Streams the response by hand rather than using Invoke-WebRequest, because IWR
# buffers the whole body in memory before writing on PowerShell 5.1 (a 45 MB Node
# runtime becomes a long silent pause) and its own progress UI cannot be labelled
# or styled.
function Get-UrlWithProgress([string]$Url, [string]$OutFile, [string]$Label) {
  if (-not $script:Interactive -or $Quiet) {
    Write-Step "downloading $Label"
    Get-Url $Url $OutFile
    return
  }

  $req = [System.Net.HttpWebRequest]::Create($Url)
  $req.UserAgent = 'rayu-cli-installer'
  $req.Timeout = 60000
  $req.ReadWriteTimeout = 120000
  # AllowAutoRedirect is on by default; GitHub release assets need it.

  $resp = $null; $in = $null; $out = $null
  try {
    $resp = $req.GetResponse()
    $total = [long]$resp.ContentLength   # -1 when the server does not say
    if ($total -gt 0) {
      Write-Step "downloading $Label ($(Format-Bytes $total))"
    } else {
      Write-Step "downloading $Label"
      $total = 0
    }

    $in = $resp.GetResponseStream()
    $out = [System.IO.File]::Create($OutFile)
    $buffer = New-Object byte[] 131072
    $done = [long]0
    $started = Get-Date
    $lastDraw = [datetime]::MinValue

    while (($read = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $out.Write($buffer, 0, $read)
      $done += $read
      # Throttle redraws: repainting per 128 KB chunk on a fast link is pure
      # console overhead and makes the bar flicker.
      if (((Get-Date) - $lastDraw).TotalMilliseconds -ge 120) {
        Write-Bar $done $total ((Get-Date) - $started).TotalSeconds
        $lastDraw = Get-Date
      }
    }
    Write-Bar $done $total ((Get-Date) - $started).TotalSeconds
    $out.Flush()
  } finally {
    if ($out) { $out.Dispose() }
    if ($in) { $in.Dispose() }
    if ($resp) { $resp.Dispose() }
  }

  Clear-Line
  $size = (Get-Item $OutFile).Length
  Write-Ok "$Label ($(Format-Bytes $size))"
}

function Get-UrlString([string]$Url) {
  (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60).Content
}

function Test-Url([string]$Url) {
  try {
    Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 30 | Out-Null
    return $true
  } catch { return $false }
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
  if (-not $Expected) {
    Write-Warn "no checksum published for $Label; skipping verification"
    return
  }
  $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    Die "checksum mismatch for $Label`n  expected $Expected`n  actual   $actual`nThe download was corrupted or tampered with. Nothing was installed."
  }
}

function Assert-Sha1([string]$Path, [string]$Expected, [string]$Label) {
  if (-not $Expected) { return }
  $actual = (Get-FileHash -Path $Path -Algorithm SHA1).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    Die "checksum mismatch for $Label`n  expected $Expected`n  actual   $actual`nThe download was corrupted or tampered with. Nothing was installed."
  }
}

function Expand-Tarball([string]$Archive, [string]$Dest) {
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $tar) {
    Die "this installer needs tar.exe (shipped with Windows 10 1803 and later).`nUpgrade Windows, or install with: npm install -g $NpmPackage"
  }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  & $tar.Source -xzf $Archive -C $Dest
  if ($LASTEXITCODE -ne 0) { Die "failed to extract $Archive" }
}

# ---------------------------------------------------------------------------
# PATH handling
# ---------------------------------------------------------------------------

# The user PATH is edited through the registry rather than
# [Environment]::SetEnvironmentVariable, which rewrites the value as REG_SZ.
# Many machines store PATH as REG_EXPAND_SZ containing entries like
# %USERPROFILE%\bin; converting the type freezes those to whatever they expanded
# to at that moment (and breaks them outright for a roaming profile). Corrupting
# someone's PATH to install a CLI is not an acceptable trade, so the original
# value kind is read and preserved.
$script:PathBroadcastReady = $false

function Send-EnvironmentChange {
  # SetEnvironmentVariable normally broadcasts WM_SETTINGCHANGE for us; writing
  # the registry directly does not, so Explorer (and therefore every newly
  # launched terminal) would keep the stale PATH until sign-out.
  if (-not $script:PathBroadcastReady) {
    try {
      Add-Type -Namespace RayuWin32 -Name Env -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.IntPtr lpdwResult);
'@ -ErrorAction Stop
      $script:PathBroadcastReady = $true
    } catch {
      # Compilation unavailable (constrained language mode, no compiler): the
      # PATH is still written, it just needs a new sign-in to be picked up
      # everywhere. Not worth failing the install over.
      return
    }
  }
  try {
    $result = [System.IntPtr]::Zero
    # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5s timeout
    [RayuWin32.Env]::SendMessageTimeout([System.IntPtr]0xFFFF, 0x1A, [System.IntPtr]::Zero,
      'Environment', 0x0002, 5000, [ref]$result) | Out-Null
  } catch {}
}

function Get-UserPathRaw {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  if (-not $key) { return @{ Value = ''; Kind = 'ExpandString' } }
  try {
    # DoNotExpandEnvironmentNames keeps %USERPROFILE% literal instead of baking
    # in the expansion.
    $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = 'ExpandString'
    try { $kind = $key.GetValueKind('Path').ToString() } catch {}
    if ($null -eq $value) { $value = '' }
    return @{ Value = [string]$value; Kind = $kind }
  } finally { $key.Close() }
}

function Set-UserPathRaw([string]$Value, [string]$Kind) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
  try {
    $valueKind = switch ($Kind) {
      'String' { [Microsoft.Win32.RegistryValueKind]::String }
      default  { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    }
    $key.SetValue('Path', $Value, $valueKind)
  } finally { $key.Close() }
  Send-EnvironmentChange
}

function Add-ToUserPath([string]$PathToAdd) {
  $current = Get-UserPathRaw
  $entries = @($current.Value.Split(';') | Where-Object { $_ -ne '' })
  foreach ($e in $entries) {
    if ($e.TrimEnd('\') -ieq $PathToAdd.TrimEnd('\')) { return $false }
  }
  $newPath = if ($current.Value) { "$($current.Value);$PathToAdd" } else { $PathToAdd }
  Set-UserPathRaw $newPath $current.Kind
  return $true
}

function Remove-FromUserPath([string]$PathToRemove) {
  $current = Get-UserPathRaw
  if (-not $current.Value) { return $false }
  $kept = @($current.Value.Split(';') | Where-Object {
    $_ -ne '' -and $_.TrimEnd('\') -ine $PathToRemove.TrimEnd('\')
  })
  $newPath = ($kept -join ';')
  if ($newPath -eq $current.Value) { return $false }
  Set-UserPathRaw $newPath $current.Kind
  return $true
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------

function Invoke-Uninstall {
  Write-Title 'Uninstalling Rayu CLI'
  if (Remove-FromUserPath $BinDir) { Write-Step "removed $BinDir from the user PATH" }
  foreach ($f in @('rayu.cmd', 'rayu.exe', 'rayu.ps1', '.rayu-installer.ps1')) {
    $p = Join-Path $BinDir $f
    if (Test-Path $p) { Remove-Item -Force $p; Write-Step "removed $p" }
  }
  foreach ($d in @($LibDir, $RuntimeDir)) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d; Write-Step "removed $d" }
  }
  $meta = Join-Path $RayuHome 'install.json'
  if (Test-Path $meta) { Remove-Item -Force $meta }
  Write-Ok 'Rayu CLI removed.'
  Write-Info ''
  Write-Info "Your settings and credentials in $RayuHome were kept."
  Write-Info "Delete them too with:  Remove-Item -Recurse -Force `"$RayuHome`""
}

if ($Uninstall) { Invoke-Uninstall; return }

# ---------------------------------------------------------------------------
# Path 1 - standalone native .exe from GitHub Releases
# ---------------------------------------------------------------------------

$script:InstallMethod = ''
$script:InstalledVersion = ''
$script:NodeExe = ''
$script:EntryPath = ''

function Try-InstallNative {
  if ($NpmTarball) { return $false }

  $base = if ($Version) {
    "https://github.com/$GithubRepo/releases/download/v$Version"
  } else {
    "https://github.com/$GithubRepo/releases/latest/download"
  }
  $asset = "rayu-cli-$NativePlatform.exe"

  Write-Step "looking for a standalone binary for $NativePlatform"
  if (-not (Test-Url "$base/$asset")) { return $false }

  $sum = ''
  $mversion = ''
  try {
    $manifest = Get-UrlString "$base/manifest.json" | ConvertFrom-Json
    $mversion = $manifest.version
    $sum = $manifest.platforms.$NativePlatform.checksum
  } catch {}

  Write-Step "downloading $asset"
  $tmp = Join-Path $env:TEMP "rayu-$([guid]::NewGuid().ToString('N')).exe"
  Get-UrlWithProgress "$base/$asset" $tmp $asset
  Write-Step 'verifying the binary checksum'
  Assert-Sha256 $tmp $sum $asset

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $dest = Join-Path $BinDir 'rayu.exe'
  # A running rayu.exe cannot be overwritten, but it can be renamed out of the
  # way; Windows deletes the old inode once the process exits.
  if (Test-Path $dest) {
    try { Move-Item -Force $dest "$dest.old.$((Get-Date).ToString('yyyyMMddHHmmss'))" } catch {}
  }
  Move-Item -Force $tmp $dest

  # A leftover .cmd launcher from a previous tarball install would shadow the
  # .exe, because PATHEXT resolves .COM;.EXE;.BAT;.CMD in that order only for
  # extensionless lookups within the *same* directory - keep the dir clean.
  $stale = Join-Path $BinDir 'rayu.cmd'
  if (Test-Path $stale) { Remove-Item -Force $stale }

  $script:InstallMethod = 'native'
  $script:InstalledVersion = if ($mversion) { $mversion } elseif ($Version) { $Version } else { 'unknown' }
  return $true
}

# ---------------------------------------------------------------------------
# Path 2 - npm tarball + Node runtime
# ---------------------------------------------------------------------------

function Get-NodeMajor([string]$NodePath) {
  try {
    $v = & $NodePath --version 2>$null
    if (-not $v) { return 0 }
    return [int]($v.TrimStart('v').Split('.')[0])
  } catch { return 0 }
}

function Install-PrivateNode {
  $name = "node-$NodeVersion-win-$Arch"
  $zip = "$name.zip"
  $url = "$NodeDist/$NodeVersion/$zip"

  Write-Step "no usable Node found - fetching a private Node $NodeVersion runtime"
  $tmpZip = Join-Path $env:TEMP $zip
  try { Get-UrlWithProgress $url $tmpZip "node $NodeVersion (win-$Arch)" } catch {
    Die "could not download the Node runtime from $url.`nInstall Node >= $MinNodeMajor from https://nodejs.org, then re-run this installer."
  }

  $expected = ''
  try {
    $sums = Get-UrlString "$NodeDist/$NodeVersion/SHASUMS256.txt"
    foreach ($line in $sums -split "`n") {
      if ($line -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($zip))\s*$") { $expected = $Matches[1]; break }
    }
  } catch {}
  Write-Step 'verifying the runtime checksum'
  Assert-Sha256 $tmpZip $expected $zip

  Write-Step 'unpacking the Node runtime'
  $staging = Join-Path $RuntimeDir 'node.tmp'
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Expand-Archive -Path $tmpZip -DestinationPath $staging -Force
  Remove-Item -Force $tmpZip

  $target = Join-Path $RuntimeDir 'node'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item (Join-Path $staging $name) $target
  Remove-Item -Recurse -Force $staging

  $exe = Join-Path $target 'node.exe'
  if (-not (Test-Path $exe)) { Die "the downloaded Node runtime is missing node.exe" }
  $script:NodeExe = $exe
  Write-Ok "Node $(& $exe --version) installed privately in $target"
}

function Resolve-Node {
  $private = Join-Path (Join-Path $RuntimeDir 'node') 'node.exe'
  if ((Test-Path $private) -and (Get-NodeMajor $private) -ge $MinNodeMajor) {
    $script:NodeExe = $private
    Write-Step "using the private Node runtime ($(& $private --version))"
    return
  }
  $sys = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($sys) {
    $major = Get-NodeMajor $sys.Source
    if ($major -ge $MinNodeMajor) {
      $script:NodeExe = $sys.Source
      Write-Step "using system Node $(& $sys.Source --version) ($($sys.Source))"
      return
    }
    Write-Step "system Node is too old (need >= $MinNodeMajor)"
  }
  Install-PrivateNode
}

function Write-ModuleMarker([string]$Dir) {
  # dist/rayu.js is an ES module. Without package.json {"type":"module"} Node
  # parses .js as CommonJS and dies with "Cannot use import statement outside a
  # module" on Node 18/20 — i.e. Windows installs via nvm/winget and the
  # pre-installed Node that ships with many CI images.
  $content = "{\n  `"type`": `"module`",\n  `"//`": `"Required so Node loads rayu.js as an ES module on Node < 22.7.`"\n}\n"
  [IO.File]::WriteAllText((Join-Path $Dir 'package.json'), $content)
}

function Install-FromTarball {
  $metaUrl = if ($Version) {
    "$NpmRegistry/$NpmPackageUrlSafe/$Version"
  } else {
    "$NpmRegistry/$NpmPackageUrlSafe/latest"
  }
  $label = if ($Version) { $Version } else { 'latest' }
  Write-Step "resolving $label from the npm registry"
  try {
    $meta = Get-UrlString $metaUrl | ConvertFrom-Json
  } catch {
    Die "could not reach the npm registry at $NpmRegistry.`nCheck your network or proxy, then re-run."
  }
  # Guarded reads: Set-StrictMode turns a missing property into a terminating
  # error, and a registry mirror can return an unexpected shape.
  $tarballUrl = $null; $sha1 = $null; $resolvedVersion = $null
  try { $tarballUrl = $meta.dist.tarball } catch {}
  try { $sha1 = $meta.dist.shasum } catch {}
  try { $resolvedVersion = $meta.version } catch {}
  if (-not $tarballUrl) { Die "the npm registry returned no tarball for $label" }
  if (-not $resolvedVersion) {
    # rayu-cli-1.6.13.tgz -> 1.6.13
    $resolvedVersion = [regex]::Match($tarballUrl, 'rayu-cli-(.+)\.tgz$').Groups[1].Value
  }
  if (-not $resolvedVersion) { $resolvedVersion = if ($Version) { $Version } else { 'unknown' } }
  $script:InstalledVersion = $resolvedVersion

  Resolve-Node

  $tmpTgz = Join-Path $env:TEMP "rayu-cli-$($script:InstalledVersion).tgz"
  Get-UrlWithProgress $tarballUrl $tmpTgz "rayu-cli $($script:InstalledVersion)"
  Write-Step 'verifying the package checksum'
  Assert-Sha1 $tmpTgz $sha1 "rayu-cli-$($script:InstalledVersion).tgz"

  Write-Step 'unpacking the bundle'
  $extract = Join-Path $env:TEMP "rayu-pkg-$([guid]::NewGuid().ToString('N'))"
  Expand-Tarball $tmpTgz $extract
  Remove-Item -Force $tmpTgz

  $entry = Join-Path $extract 'package\dist\rayu.js'
  if (-not (Test-Path $entry)) {
    Die "the published package is missing dist/rayu.js - please report this at https://github.com/$GithubRepo/issues"
  }

  # Stage, then swap, so an interrupted install leaves the previous version
  # working instead of a half-written one.
  $target = Join-Path $LibDir "rayu-$($script:InstalledVersion)"
  New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
  if (Test-Path "$target.tmp") { Remove-Item -Recurse -Force "$target.tmp" }
  New-Item -ItemType Directory -Force -Path "$target.tmp" | Out-Null
  Write-ModuleMarker "$target.tmp"
  Copy-Item $entry (Join-Path "$target.tmp" 'rayu.js')
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item "$target.tmp" $target
  Remove-Item -Recurse -Force $extract

  $script:EntryPath = Join-Path $target 'rayu.js'
  Write-Launcher
  # Old bundles are ~24 MB each; keep only the one in use.
  Get-ChildItem -Path $LibDir -Directory -Filter 'rayu-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $target } |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName }

  $script:InstallMethod = 'tarball'
}

# A .cmd launcher (rather than a symlink, which needs Developer Mode or admin)
# that pins the Node it was installed with, falls back to any Node on PATH if
# that one disappears, and routes `rayu update` back through this installer -
# the built-in updater shells out to `npm install -g`, which would install a
# second copy this launcher never runs.
function Write-Launcher {
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $installerCopy = Join-Path $BinDir '.rayu-installer.ps1'

  $cmd = @"
@echo off
setlocal
set "RAYU_NODE=$($script:NodeExe)"
set "RAYU_ENTRY=$($script:EntryPath)"
if not exist "%RAYU_NODE%" for %%I in (node.exe) do @set "RAYU_NODE=%%~`$PATH:I"
if not exist "%RAYU_NODE%" (
  echo rayu: Node was not found. Reinstall with: irm $InstallerUrl ^| iex 1>&2
  exit /b 127
)
if not exist "%RAYU_ENTRY%" (
  echo rayu: install is incomplete. Reinstall with: irm $InstallerUrl ^| iex 1>&2
  exit /b 127
)
if /i "%~1"=="update" goto :selfupdate
if /i "%~1"=="upgrade" goto :selfupdate
"%RAYU_NODE%" "%RAYU_ENTRY%" %*
exit /b %ERRORLEVEL%
:selfupdate
if not exist "$installerCopy" goto :run
echo Updating Rayu CLI with the rayucode.com installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "$installerCopy"
exit /b %ERRORLEVEL%
:run
"%RAYU_NODE%" "%RAYU_ENTRY%" %*
exit /b %ERRORLEVEL%
"@

  $launcher = Join-Path $BinDir 'rayu.cmd'
  Set-Content -Path $launcher -Value $cmd -Encoding ASCII
  # A leftover rayu.exe from a previous native install would win over this .cmd.
  $staleExe = Join-Path $BinDir 'rayu.exe'
  if (Test-Path $staleExe) { Remove-Item -Force $staleExe -ErrorAction SilentlyContinue }

  # Keep a local copy of this installer so `rayu update` and -Uninstall work
  # without going back to the website.
  try {
    if ($PSCommandPath -and (Test-Path $PSCommandPath)) {
      Copy-Item $PSCommandPath $installerCopy -Force
    } else {
      Get-Url $InstallerUrl $installerCopy
    }
  } catch { Write-Warn "could not save a local installer copy ($($_.Exception.Message))" }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

Write-Title 'Rayu CLI installer'
Write-Field 'platform' $NativePlatform
Write-Info ''

if (Try-InstallNative) {
  Write-Ok "installed the standalone $NativePlatform binary"
} else {
  if (-not $NpmTarball) {
    Write-Step "no standalone build for $NativePlatform yet - using the bundled JS build"
  }
  Install-FromTarball
}

# Metadata + the marker the npm postinstall writes, so the CLI does not replay
# its "installed successfully" banner (this script already said it).
New-Item -ItemType Directory -Force -Path $RayuHome | Out-Null
$nodeForMeta = if ($script:NodeExe) { $script:NodeExe } else { 'embedded' }
@"
{
  "installer": "rayucode.com/install.ps1",
  "method": "$($script:InstallMethod)",
  "version": "$($script:InstalledVersion)",
  "platform": "$NativePlatform",
  "binDir": "$BinDir",
  "node": "$nodeForMeta",
  "installedAt": "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))"
}
"@ | Set-Content -Path (Join-Path $RayuHome 'install.json') -Encoding ASCII

$cfgDir = if ($env:RAYU_CONFIG_DIR) { $env:RAYU_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.rayu' }
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$marker = Join-Path $cfgDir '.installed'
if (-not (Test-Path $marker)) { Set-Content -Path $marker -Value $script:InstalledVersion -Encoding ASCII }

# PATH
$pathAdded = $false
# @(...) so an empty or single-element pipeline result still exposes .Count
# under Set-StrictMode.
$pathActive = @($env:Path -split [IO.Path]::PathSeparator |
  Where-Object { $_ -and $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') }).Count -gt 0
if (-not $NoModifyPath) {
  $pathAdded = Add-ToUserPath $BinDir
  # Make `rayu` usable in *this* session too, not just new terminals.
  if (-not $pathActive) { $env:Path = "$BinDir;$env:Path" }
}

# Verify
Write-Step 'verifying the install'
$exePath = if ($script:InstallMethod -eq 'native') { Join-Path $BinDir 'rayu.exe' } else { Join-Path $BinDir 'rayu.cmd' }
try {
  $reported = (& $exePath --version 2>&1 | Select-Object -First 1)
} catch {
  Die "'$exePath --version' failed: $($_.Exception.Message)`nPlease report this at https://github.com/$GithubRepo/issues"
}

$methodLabel = switch ($script:InstallMethod) {
  'native'  { 'standalone binary' }
  'tarball' { 'bundled JS build' }
  default   { $script:InstallMethod }
}

Write-Title "$MarkOk Rayu CLI $($script:InstalledVersion) installed"
Write-Field 'version' $reported
Write-Field 'command' $exePath
Write-Field 'method' $methodLabel
if ($script:NodeExe) { Write-Field 'runtime' $script:NodeExe }
Write-Info ''

if ($NoModifyPath) {
  Write-Info '  PATH was left untouched (-NoModifyPath). Add it yourself:'
  Write-Info "      `$env:Path = `"$BinDir;`$env:Path`""
} elseif ($pathAdded) {
  Write-Host "  $BinDir added to your user PATH." -ForegroundColor DarkGray
  Write-Host '  Active in this window already; reopen other terminals.' -ForegroundColor DarkGray
} else {
  Write-Host "  $BinDir was already on your user PATH." -ForegroundColor DarkGray
}
Write-Info ''
Write-Info '  Start Rayu:'
Write-Host '      rayu' -ForegroundColor Cyan
Write-Info ''
Write-Host '  update     rayu update   (or re-run this installer)' -ForegroundColor DarkGray
Write-Host "  uninstall  & `"$BinDir\.rayu-installer.ps1`" -Uninstall" -ForegroundColor DarkGray
Write-Host '  docs       https://rayucode.com/docs' -ForegroundColor DarkGray
Write-Info ''

# Another rayu earlier on PATH (typically an old `npm install -g`) would win.
$found = Get-Command rayu -ErrorAction SilentlyContinue
if ($found -and $found.Source -and ($found.Source -ne $exePath)) {
  Write-Warn "another 'rayu' is earlier on your PATH and will be used instead:`n  $($found.Source)`nRemove it so the new install takes effect:`n  npm uninstall -g $NpmPackage"
}
