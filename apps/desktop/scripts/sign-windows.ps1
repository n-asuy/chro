[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$requiredEnvironmentVariables = @(
  "CODE_SIGN_TOOL_PATH",
  "ES_USERNAME",
  "ES_PASSWORD",
  "ES_CREDENTIAL_ID",
  "ES_TOTP_SECRET"
)

$missingEnvironmentVariables = @(
  $requiredEnvironmentVariables | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
  }
)

if ($missingEnvironmentVariables.Count -gt 0) {
  throw "Missing Windows code-signing environment variables: $($missingEnvironmentVariables -join ', ')."
}

$resolvedFilePath = (Resolve-Path -LiteralPath $FilePath).Path
$codeSignTool = Join-Path $env:CODE_SIGN_TOOL_PATH "CodeSignTool.bat"

if (-not (Test-Path -LiteralPath $codeSignTool -PathType Leaf)) {
  throw "SSL.com CodeSignTool was not found at '$codeSignTool'."
}

# CodeSignTool normally writes a signed copy to a separate directory. Tauri's
# signCommand contract requires the file passed as %1 to be signed in place, so
# use eSigner's override mode. Tauri invokes this script for the main app,
# sidecars, NSIS plugins/uninstaller, and the final installer.
$signerOutput = @(
  & $codeSignTool sign `
    "-username=$env:ES_USERNAME" `
    "-password=$env:ES_PASSWORD" `
    "-credential_id=$env:ES_CREDENTIAL_ID" `
    "-totp_secret=$env:ES_TOTP_SECRET" `
    "-input_file_path=$resolvedFilePath" `
    "-override=true" 2>&1
)
$signerExitCode = $LASTEXITCODE
$signerOutput | ForEach-Object { Write-Host $_ }

$signerText = $signerOutput -join "`n"
$reportedFailure = $signerText -match "Error|Exception|Missing required option|Unmatched argument"
if ($signerExitCode -ne 0 -or $reportedFailure) {
  throw "SSL.com CodeSignTool failed to sign '$resolvedFilePath' (exit code $signerExitCode)."
}

$signature = Get-AuthenticodeSignature -FilePath $resolvedFilePath
if ($signature.Status -ne "Valid" -or $null -eq $signature.SignerCertificate) {
  throw "Authenticode verification failed for '$resolvedFilePath': $($signature.StatusMessage)"
}

Write-Host "Verified Authenticode signature: $resolvedFilePath"
Write-Host "Signer: $($signature.SignerCertificate.Subject)"
