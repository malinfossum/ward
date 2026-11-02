# Runs the Pester tests at $env:WARD_PESTER_PATH with Pester 5 and writes the
# counts as JSON to $env:WARD_PESTER_RESULT; powershell-check.mjs decides on
# them. The runner's newest Pester 5 is used as it is; only a runner without one
# installs the pinned $env:WARD_PESTER_VERSION. Pester 3 (inbox on Windows) and
# Pester 6 are never picked.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Find-Pester5 {
  Get-Module -ListAvailable Pester |
    Where-Object { $_.Version.Major -eq 5 } |
    Sort-Object Version -Descending |
    Select-Object -First 1
}

$pester = Find-Pester5
if (-not $pester) {
  Install-Module Pester -RequiredVersion $env:WARD_PESTER_VERSION -Scope CurrentUser -Force -SkipPublisherCheck
  $pester = Find-Pester5
}
Import-Module -ModuleInfo $pester
Write-Host "Pester $($pester.Version) on PowerShell $($PSVersionTable.PSVersion)"

$config = New-PesterConfiguration
$config.Run.Path = $env:WARD_PESTER_PATH
$config.Run.PassThru = $true
$config.Output.Verbosity = 'Detailed'
$result = Invoke-Pester -Configuration $config

[ordered]@{
  result = $result.Result
  total = $result.TotalCount
  passed = $result.PassedCount
  failed = $result.FailedCount
  skipped = $result.SkippedCount
  failedBlocks = $result.FailedBlocksCount
  failedContainers = $result.FailedContainersCount
} | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:WARD_PESTER_RESULT -Encoding utf8NoBOM
