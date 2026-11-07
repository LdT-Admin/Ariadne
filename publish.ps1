param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = "",
  [string]$Asar = "",
  [string]$Remote = "crm"
)
$ErrorActionPreference = 'Stop'
# Publish Ariadne build to the update channel on server A (/srv/ariadne/updates).
# Usage: .\publish.ps1 -Version 0.1.0 [-Notes "..."]  (run build.ps1 first)
if (-not $Asar) { $Asar = Join-Path $PSScriptRoot 'dist\app.asar' }
if (-not (Test-Path $Asar)) { throw "No $Asar - run build.ps1 first" }
$hash = (Get-FileHash $Asar -Algorithm SHA256).Hash.ToLower()
$name = "ariadne-$Version.asar"
Write-Host "Version $Version, sha256 $hash"
scp $Asar "${Remote}:/srv/ariadne/updates/asar/$name"
$latest = @{
  version = $Version
  asar    = $name
  sha256  = $hash
  notes   = $Notes
} | ConvertTo-Json
$tmp = Join-Path $env:TEMP "latest-ariadne.json"
[IO.File]::WriteAllText($tmp, $latest, [Text.UTF8Encoding]::new($false))
scp $tmp "${Remote}:/srv/ariadne/updates/latest.json"
Remove-Item $tmp
Write-Host "Published: latest.json -> $Version"
