# Set up the prebuilt Electron binary on Windows when npm's postinstall download
# is blocked by the office network. Idempotent and offline-friendly:
#   1) if dist\electron.exe already correct -> just fix path.txt
#   2) if a nested folder (manual unzip) sits in dist -> flatten it
#   3) else use an already-downloaded zip (Downloads or repo root, or -Zip),
#      otherwise download from the npmmirror CDN, then extract cleanly
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI and
# would corrupt non-ASCII literals.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-electron-win.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-electron-win.ps1 -Zip "C:\path\electron-v40.6.1-win32-x64.zip"

param([string]$Zip = "")
$ErrorActionPreference = "Stop"

$repo  = Split-Path -Parent $PSScriptRoot
$elDir = Join-Path $repo "node_modules\electron"
$dist  = Join-Path $elDir "dist"
if (-not (Test-Path (Join-Path $elDir "package.json"))) {
  throw "node_modules\electron not found. Run 'npm install' first."
}

function Write-PathTxt {
  Set-Content -Path (Join-Path $elDir "path.txt") -Value "electron.exe" -NoNewline -Encoding ascii
  Write-Host "[OK] path.txt -> electron.exe" -ForegroundColor Green
}

# Move contents of a nested electron-*\ folder up into dist\
function Flatten-Nested {
  $inner = Get-ChildItem $dist -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "electron.exe") } | Select-Object -First 1
  if ($inner) {
    Write-Host "Flattening $($inner.Name) -> dist"
    Get-ChildItem $inner.FullName -Force | Move-Item -Destination $dist -Force
    Remove-Item $inner.FullName -Recurse -Force
    return $true
  }
  return $false
}

# 1) already correct
if (Test-Path (Join-Path $dist "electron.exe")) {
  Write-Host "electron.exe already in dist"
  Write-PathTxt
  Write-Host "Done. Now run:  npm start"
  return
}

# 2) nested manual-unzip folder present
if ((Test-Path $dist) -and (Flatten-Nested) -and (Test-Path (Join-Path $dist "electron.exe"))) {
  Write-PathTxt
  Write-Host "Done. Now run:  npm start"
  return
}

# 3) need a zip
$ver = (Get-Content (Join-Path $elDir "package.json") -Raw | ConvertFrom-Json).version
$zipName = "electron-v$ver-win32-x64.zip"
Write-Host "Electron $ver - locating $zipName"

$zipPath = ""
if ($Zip -and (Test-Path $Zip)) {
  $zipPath = $Zip
} else {
  $cands = @(
    (Join-Path $env:USERPROFILE "Downloads\$zipName"),
    (Join-Path $repo $zipName)
  )
  $zipPath = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $zipPath) {
  $zipPath = Join-Path $env:TEMP $zipName
  $url = "https://registry.npmmirror.com/-/binary/electron/$ver/$zipName"
  Write-Host "No local zip found. Downloading: $url"
  Invoke-WebRequest $url -OutFile $zipPath
}
Write-Host "Using zip: $zipPath"

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $dist -Force
Flatten-Nested | Out-Null

if (-not (Test-Path (Join-Path $dist "electron.exe"))) {
  throw "electron.exe still not found after extracting $zipPath"
}
Write-PathTxt
Write-Host "Done. Now run:  npm start"
