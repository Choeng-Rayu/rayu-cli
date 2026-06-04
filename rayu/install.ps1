# Rayu-CLI installer (Windows, PowerShell).
#
# Installs rayu.exe to %USERPROFILE%\.rayu\bin and adds it to your user PATH so
# you can just run `rayu` from any terminal.
#
#   irm https://<host>/install.ps1 | iex      # download a release
#   .\install.ps1                             # install from a local build (dist\bin)
#
# Env overrides:
#   RAYU_INSTALL_DIR        install location (default: %USERPROFILE%\.rayu\bin)
#   RAYU_RELEASE_BASE_URL   base URL to download binaries from
$ErrorActionPreference = 'Stop'

$installDir = if ($env:RAYU_INSTALL_DIR) { $env:RAYU_INSTALL_DIR } else { "$env:USERPROFILE\.rayu\bin" }
$releaseBase = if ($env:RAYU_RELEASE_BASE_URL) { $env:RAYU_RELEASE_BASE_URL } else { 'https://github.com/Choeng-Rayu/rayu-cli/releases/latest/download' }

# Detect architecture (x64 / arm64). Only x64 is currently published.
$arch = if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') { 'arm64' } else { 'x64' }
$bin = "rayu-windows-$arch.exe"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$dest = Join-Path $installDir 'rayu.exe'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
# Newest local build matching this arch (versioned or unversioned).
$localBuild = Get-ChildItem -Path (Join-Path $scriptDir 'dist\bin') -Filter "rayu-windows-$arch*.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$localFile = Join-Path $scriptDir $bin

if ($localBuild) {
  Write-Host "rayu: installing from local build ($($localBuild.Name))..."
  Copy-Item $localBuild.FullName $dest -Force
} elseif (Test-Path $localFile) {
  Write-Host "rayu: installing from local file ($bin)..."
  Copy-Item $localFile $dest -Force
} else {
  $url = "$releaseBase/$bin"
  Write-Host "rayu: downloading $url ..."
  Invoke-WebRequest -Uri $url -OutFile $dest
}

# Add install dir to the user PATH (idempotent).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if ($userPath -notlike "*$installDir*") {
  $newPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host ""
  Write-Host "PATH updated (user). Open a NEW terminal, then run: rayu"
} else {
  Write-Host ""
  Write-Host "$installDir already on PATH. Run: rayu"
}
Write-Host "Rayu-CLI installed to $dest"
