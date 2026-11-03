# Dependency-free regression checks. Runs under Windows PowerShell 5.1 and
# PowerShell 7; the JSON and version checks also run under pwsh on Linux.
[CmdletBinding()]
param([string]$InstallerPath = (Join-Path $PSScriptRoot '..\install.ps1'))

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path $InstallerPath).Path, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$MinNodeMajor = 0
# Load the actual installer functions without downloading or installing Rayu,
# changing the user's PATH, or executing any of the top-level script.
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
    . ([scriptblock]::Create($statement.Extent.Text))
  } elseif ($statement -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $statement.Left.Extent.Text -eq '$MinNodeMajor') {
    . ([scriptblock]::Create($statement.Extent.Text))
  }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -cne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
}

# Preserve Die's diagnostic so tests can assert the complete startup error.
function Die([string]$Message) { throw $Message }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "rayu windows installer $([guid]::NewGuid().ToString('N'))"
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$Quiet = $true
$NpmPackage = '@rayu-dev/rayu-cli'
$GithubRepo = 'Choeng-Rayu/rayu-cli'
$InstallerUrl = 'https://rayucode.com/install.ps1'
$NativePlatform = 'win32-x64'
$RayuHome = Join-Path $tempRoot '.rayu'
$BinDir = Join-Path $RayuHome 'bin with spaces'
$script:InstallMethod = 'tarball'
$script:InstalledVersion = '1.6.13'
$script:NodeExe = $node
$bundleDir = Join-Path $RayuHome 'lib\rayu-1.6.13'
$script:EntryPath = Join-Path $bundleDir 'rayu.js'
$PSCommandPath = (Resolve-Path $InstallerPath).Path

try {
  New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null
  Write-ModuleMarker $bundleDir
  $moduleJson = [IO.File]::ReadAllText((Join-Path $bundleDir 'package.json'))
  try { $module = $moduleJson | ConvertFrom-Json } catch {
    throw "package.json must be valid JSON so Node can start Rayu: $($_.Exception.Message)"
  }
  Assert-Equal $module.type 'module' 'The extracted bundle must be an ES module'

  # A real import proves Node loads .js as ESM, including on Node 18/20 where
  # there is no automatic ESM syntax detection.
  [IO.File]::WriteAllText($script:EntryPath, @'
import { readFileSync } from 'node:fs';
const module = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
if (module.type !== 'module') process.exit(3);
console.log('1.6.13 (Beta-Rayu-CLI)');
'@)
  $version = & $node $script:EntryPath --version
  Assert-Equal $LASTEXITCODE 0 'Node must load the installed JS bundle'
  Assert-Equal $version '1.6.13 (Beta-Rayu-CLI)' 'Node must print the Rayu version'
  Write-Host 'PASS: module marker and real Node ESM startup'

  Assert-Equal $MinNodeMajor 22 'Windows installs must select a compatible LTS runtime'
  function Test-SystemNodeSelection {
    # Keep runtime installation isolated; the version probe itself uses the
    # real system Node. Node 18 in CI must request a private runtime, while
    # Node 22 must be reused without downloading one.
    $RuntimeDir = Join-Path $tempRoot 'runtime'
    function Get-Command {
      [CmdletBinding()]
      param([string]$Name)
      if ($Name -ne 'node.exe') { throw "Unexpected command lookup: $Name" }
      return [pscustomobject]@{ Source = $node }
    }
    function Install-PrivateNode { $script:NodeExe = 'private-runtime-requested' }
    $script:NodeExe = ''
    Resolve-Node
    $expected = if ((Get-NodeMajor $node) -ge 22) { $node } else { 'private-runtime-requested' }
    Assert-Equal $script:NodeExe $expected 'Unsupported system Node must trigger private runtime installation'
  }
  Test-SystemNodeSelection
  $script:NodeExe = $node
  Write-Host 'PASS: system Node compatibility and private runtime selection'

  # Backslashes, quotes and non-ASCII profile names must survive JSON writing.
  # JSON.parse (rather than only ConvertFrom-Json) also catches a UTF-8 BOM.
  $actualBinDir = $BinDir
  $BinDir = 'C:\Users\Ren' + [char]0x00E9 + '\bin with "quotes"'
  $script:NodeExe = 'C:\Program Files\nodejs\node.exe'
  Write-InstallMetadata
  $metadata = Get-Content -Raw (Join-Path $RayuHome 'install.json') | ConvertFrom-Json
  Assert-Equal $metadata.binDir $BinDir 'Windows paths must round-trip through install.json'
  Assert-Equal $metadata.node $script:NodeExe 'The pinned Node path must round-trip'
  Assert-Equal $metadata.method 'tarball' 'Install classification must be retained'
  $env:RAYU_INSTALLER_TEST_JSON = Join-Path $RayuHome 'install.json'
  $env:RAYU_INSTALLER_TEST_BIN = $BinDir
  & $node -e 'const fs = require("node:fs"); const m = JSON.parse(fs.readFileSync(process.env.RAYU_INSTALLER_TEST_JSON, "utf8")); if (m.binDir !== process.env.RAYU_INSTALLER_TEST_BIN) process.exit(3);'
  Assert-Equal $LASTEXITCODE 0 'Node must parse install.json without losing path characters'
  $script:InstallMethod = 'native'
  $script:NodeExe = ''
  Write-InstallMetadata
  $nativeMetadata = Get-Content -Raw (Join-Path $RayuHome 'install.json') | ConvertFrom-Json
  Assert-Equal $nativeMetadata.node 'embedded' 'Standalone installs must record their embedded runtime'
  Assert-Equal $nativeMetadata.method 'native' 'Standalone install classification must be retained'
  $script:InstallMethod = 'tarball'
  $BinDir = $actualBinDir
  $script:NodeExe = $node
  Write-Host 'PASS: Windows install metadata is valid UTF-8 JSON'

  # Use a real native process to check exit codes and multi-line stderr.
  # .cmd launchers can only be executed on Windows; elsewhere use a tiny shell
  # launcher for the same version-check function.
  function New-VersionFixture([string]$Name, [string]$JavaScript) {
    $js = Join-Path $tempRoot "$Name.cjs"
    [IO.File]::WriteAllText($js, $JavaScript)
    if ($onWindows) {
      $path = Join-Path $tempRoot "$Name.cmd"
      [IO.File]::WriteAllText($path, "@echo off`r`n`"$node`" `"$js`" %*`r`nexit /b %ERRORLEVEL%`r`n")
    } else {
      $path = Join-Path $tempRoot $Name
      [IO.File]::WriteAllText($path, "#!/bin/sh`nexec `"$node`" `"$js`" `"`$@`"`n")
      & chmod +x $path
    }
    return $path
  }

  $success = New-VersionFixture 'success' "console.error('runtime warning'); console.log('1.6.13 (Beta-Rayu-CLI)');"
  $PSNativeCommandUseErrorActionPreference = $true
  Assert-Equal (Get-RayuVersion $success) '1.6.13 (Beta-Rayu-CLI)' 'Warnings on stderr must not fail a successful version check'
  Assert-Equal $ErrorActionPreference 'Stop' 'Version checks must preserve caller error preferences'
  Assert-Equal $PSNativeCommandUseErrorActionPreference $true 'Native error preferences must be preserved'

  $failure = New-VersionFixture 'failure' "console.log('1.6.13 (Beta-Rayu-CLI)'); console.error('node:internal/modules/run_main:92'); console.error('ERR_INVALID_PACKAGE_CONFIG: detailed cause'); process.exit(7);"
  $failureMessage = ''
  try { Get-RayuVersion $failure | Out-Null } catch { $failureMessage = $_.Exception.Message }
  if ($failureMessage -notmatch 'exit code 7' -or
      $failureMessage -notmatch 'node:internal/modules/run_main:92' -or
      $failureMessage -notmatch 'ERR_INVALID_PACKAGE_CONFIG: detailed cause') {
    throw "Failed version checks must include the exit code and complete diagnostics: $failureMessage"
  }
  foreach ($js in @('', "console.log('unexpected output');")) {
    $invalid = New-VersionFixture 'invalid' $js
    $invalidMessage = ''
    try { Get-RayuVersion $invalid | Out-Null } catch { $invalidMessage = $_.Exception.Message }
    if (-not $invalidMessage) { throw 'Empty or invalid version output must not report success' }
  }
  $PSNativeCommandUseErrorActionPreference = $false
  Write-Host 'PASS: version checks validate exit codes and retain complete stderr'

  if ($onWindows) {
    Write-Launcher
    $launcher = Join-Path $BinDir 'rayu.cmd'
    Assert-Equal (Get-RayuVersion $launcher) '1.6.13 (Beta-Rayu-CLI)' 'The actual .cmd launcher must work with spaces in paths'
    if (-not (Test-Path (Join-Path $BinDir '.rayu-installer.ps1'))) {
      throw 'The launcher must retain a local installer for updates'
    }
    Write-Host 'PASS: actual Windows .cmd launcher and local installer copy'
  }
} finally {
  Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
  Remove-Item Env:RAYU_INSTALLER_TEST_JSON -ErrorAction SilentlyContinue
  Remove-Item Env:RAYU_INSTALLER_TEST_BIN -ErrorAction SilentlyContinue
}
