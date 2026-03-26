#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

function Get-PlatformInfo {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()

  if ($IsWindows) {
    switch ($arch) {
      "X64" { return @{ PlatformDir = "windows-x64"; BinName = "chro.exe" } }
      "Arm64" { return @{ PlatformDir = "windows-arm64"; BinName = "chro.exe" } }
      default { throw "Unsupported Windows arch: $arch" }
    }
  }

  if ($IsMacOS) {
    switch ($arch) {
      "X64" { return @{ PlatformDir = "macos-x64"; BinName = "chro" } }
      "Arm64" { return @{ PlatformDir = "macos-arm64"; BinName = "chro" } }
      default { throw "Unsupported macOS arch: $arch" }
    }
  }

  if ($IsLinux) {
    switch ($arch) {
      "X64" { return @{ PlatformDir = "linux-x64"; BinName = "chro" } }
      "Arm64" { return @{ PlatformDir = "linux-arm64"; BinName = "chro" } }
      default { throw "Unsupported Linux arch: $arch" }
    }
  }

  throw "Unsupported OS"
}

function Join-PublicUrl([string]$BaseUrl, [string]$Prefix) {
  $normalizedBase = $BaseUrl.TrimEnd("/")
  $normalizedPrefix = $Prefix.Trim("/").Trim()

  if ([string]::IsNullOrWhiteSpace($normalizedPrefix)) {
    return $normalizedBase
  }

  if ([string]::IsNullOrWhiteSpace($normalizedBase)) {
    return ""
  }

  return "$normalizedBase/$normalizedPrefix"
}

$versionLine = Select-String -Path "Cargo.toml" -Pattern '^version = "(.*)"$' | Select-Object -First 1
$version = $versionLine.Matches[0].Groups[1].Value
$platform = Get-PlatformInfo
$r2PublicUrl = if ($env:R2_PUBLIC_URL) { $env:R2_PUBLIC_URL } else { $env:CHRO_R2_PUBLIC_URL }
$resolvedPublicUrl = Join-PublicUrl $r2PublicUrl $env:R2_PREFIX

Write-Host "=== Chro CLI Build ==="
Write-Host "Version:  $version"
Write-Host "Platform: $($platform.PlatformDir)"

Write-Host "Cleaning previous builds..."
if (Test-Path "npx-cli\dist") { Remove-Item -Recurse -Force "npx-cli\dist" }
New-Item -ItemType Directory -Force -Path "npx-cli\dist\$($platform.PlatformDir)" | Out-Null

Write-Host "Building Rust binary..."
cargo build --release

Write-Host "Creating distribution package..."
Copy-Item "target\release\$($platform.BinName)" $platform.BinName
Compress-Archive -Path $platform.BinName -DestinationPath "npx-cli\dist\$($platform.PlatformDir)\chro.zip" -Force
Remove-Item $platform.BinName

Write-Host "Syncing npm package metadata..."
node -e @'
const fs = require("fs");
const path = "npx-cli/package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.version = process.argv[1];
pkg.config = { ...(pkg.config || {}), r2PublicUrl: process.argv[2] || "" };
fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
'@ $version $resolvedPublicUrl

Push-Location npx-cli
Get-ChildItem -Filter "*.tgz" | Remove-Item -Force -ErrorAction SilentlyContinue
$tgzFile = (npm pack --quiet | Select-Object -Last 1).Trim()
Pop-Location

Write-Host ""
Write-Host "=== Build complete ==="
Write-Host "  apps/cli/npx-cli/$tgzFile"
if ($resolvedPublicUrl) {
  Write-Host "  R2 public base: $resolvedPublicUrl"
} else {
  Write-Host "  R2 public base: not configured"
}
Write-Host ""
Write-Host "Install locally:"
Write-Host "  npm install -g .\apps\cli\npx-cli\$tgzFile"
