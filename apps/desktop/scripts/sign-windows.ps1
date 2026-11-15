[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Tauri runs this hook (bundle.windows.signCommand) for the main app, sidecars,
# NSIS plugins, the uninstaller, and the final installer. It captures the
# hook's output and reports any failure only as "failed to run pwsh", and NSIS
# ignores the exit status for the uninstaller. Everything is therefore also
# appended to a log file that the release workflow gates on: every failure is
# an "ERROR: " line and every success is exactly one "Signed: " line.
$logDirectory = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { [IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
$logPath = Join-Path $logDirectory "sign-windows.log"

function Write-SignLog {
  param([string]$Message)
  Add-Content -LiteralPath $logPath -Value $Message
  Write-Host $Message
}

function Fail-Signing {
  param([string]$Message)
  Write-SignLog "ERROR: $Message"
  throw $Message
}

function Invoke-SignTool {
  param([string[]]$Arguments)
  $output = @(& $env:SIGNTOOL_PATH @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $output | ForEach-Object { Write-SignLog "$_" }
  return $exitCode
}

Write-SignLog "--- sign-windows.ps1 $(Get-Date -Format o) file=$FilePath cwd=$(Get-Location)"

# SIGNTOOL_PATH, ARTIFACT_SIGNING_*, and AZURE_* are exported by the
# setup-artifact-signing action. ACTIONS_ID_TOKEN_REQUEST_* exist only when the
# job grants `id-token: write`.
$requiredEnvironmentVariables = @(
  "SIGNTOOL_PATH",
  "ARTIFACT_SIGNING_DLIB",
  "ARTIFACT_SIGNING_METADATA",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN"
)

$missingEnvironmentVariables = @(
  $requiredEnvironmentVariables | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
  }
)

if ($missingEnvironmentVariables.Count -gt 0) {
  Fail-Signing "Missing Windows code-signing environment variables: $($missingEnvironmentVariables -join ', ')."
}

$resolvedFilePath = (Resolve-Path -LiteralPath $FilePath).Path

# The dlib authenticates through DefaultAzureCredential's workload identity
# credential, which exchanges the GitHub OIDC token in AZURE_FEDERATED_TOKEN_FILE
# for an Entra access token. A fresh GitHub token is minted for every file:
# signing runs at the end of a long Rust build, well past the lifetime of any
# token obtained when the job started.
$tokenFile = Join-Path $logDirectory "artifact-signing-oidc-$([guid]::NewGuid()).jwt"
try {
  try {
    $tokenResponse = Invoke-RestMethod `
      -Uri "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=api://AzureADTokenExchange" `
      -Headers @{ Authorization = "Bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)" }
  } catch {
    Fail-Signing "Could not obtain a GitHub OIDC token: $($_.Exception.Message)"
  }
  Set-Content -LiteralPath $tokenFile -Value $tokenResponse.value -NoNewline
  $env:AZURE_FEDERATED_TOKEN_FILE = $tokenFile

  # SignTool selects the Authenticode handler from the PE content, not the file
  # extension, so the NSIS uninstaller (handed over as a .tmp file) is signed
  # in place like every other binary.
  $signExitCode = Invoke-SignTool @(
    "sign", "/v",
    "/fd", "SHA256",
    "/tr", "http://timestamp.acs.microsoft.com",
    "/td", "SHA256",
    "/dlib", $env:ARTIFACT_SIGNING_DLIB,
    "/dmdf", $env:ARTIFACT_SIGNING_METADATA,
    $resolvedFilePath
  )
  if ($signExitCode -ne 0) {
    Fail-Signing "SignTool failed to sign '$resolvedFilePath' (exit code $signExitCode)."
  }
} finally {
  Remove-Item -LiteralPath $tokenFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:AZURE_FEDERATED_TOKEN_FILE -ErrorAction SilentlyContinue
}

$verifyExitCode = Invoke-SignTool @("verify", "/pa", "/tw", $resolvedFilePath)
if ($verifyExitCode -ne 0) {
  Fail-Signing "Authenticode verification failed for '$resolvedFilePath' (exit code $verifyExitCode)."
}

Write-SignLog "Signed: $resolvedFilePath"
