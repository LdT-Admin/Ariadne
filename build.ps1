# Собирает dist\app.asar из этой папки.
# Использование:  .\build.ps1            (только сборка)
#                 .\build.ps1 -Install   (сборка и замена resources\app.asar в портативной папке; Ariadne должна быть закрыта)
param(
  [switch]$Install,
  [string]$Target = 'D:\Programs\Ariadne\resources\app.asar'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stage = Join-Path $root 'dist\stage'
$out = Join-Path $root 'dist\app.asar'

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  throw 'Нет node_modules. Выполните npm install или скопируйте node_modules из распакованного app.asar.'
}
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage -Force | Out-Null
foreach ($item in 'out', 'assets', 'package.json', 'node_modules') {
  Copy-Item (Join-Path $root $item) $stage -Recurse -Force
}
npx --yes @electron/asar pack $stage $out
if ($LASTEXITCODE -ne 0) { throw 'asar pack failed' }
"Собрано: $out ($([math]::Round((Get-Item $out).Length / 1MB, 1)) MB)"

if ($Install) {
  # MCP-серверы агентов (Ariadne.exe mcp\server.js) app.asar не используют — их не считаем.
  $app = Get-CimInstance Win32_Process -Filter "Name='Ariadne.exe'" | Where-Object { $_.CommandLine -notmatch 'mcp[\\/]server\.js' }
  if ($app) { throw 'Ariadne запущена. Закройте её и повторите.' }
  $bak = "$Target.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
  Copy-Item $Target $bak
  Copy-Item $out $Target -Force
  "Установлено в $Target (бэкап: $bak)"
}
