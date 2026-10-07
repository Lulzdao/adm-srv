<#
.SYNOPSIS
  Сборка клиента «Искры» на сервере — одной командой, через тот же прокси, что и обновление.

.DESCRIPTION
  Клиент «Искры» (MESSENGER\desktop-client) — программа для компьютеров сотрудников.
  Обновление сервера (update.ps1) привозит его исходники, но не собирает: установщики
  нужно собрать и выложить через панель «Искры». Этот скрипт делает первую часть:

    1. Сверяет версию клиента в исходниках с той, что уже раздаётся сотрудникам
       (MESSENGER\updates\win*\latest.yml). Совпадает — новой версии нет, собирать нечего.
    2. Проверяет Node.js, свободное место и доступ к registry.npmjs.org и github.com.
    3. Настраивает прокси для npm и сборщика (как update.ps1: из update.config.psd1 или
       системный) и доверие к корням Windows — если прокси подменяет HTTPS-сертификаты.
    4. npm ci, затем сборка обеих версий (Windows 7/8.1 и Windows 10+).
    5. Кладёт собранное на сервер «Искры» (MESSENGER\updates-staging): в панели
       «Клиенты» сразу появляется «Собрана на сервере версия …» с кнопкой «Выложить» —
       файлы выбирать не нужно.

  Выкладывает сотрудникам по-прежнему человек — кнопкой в панели «Искры», с паролем
  администратора: это запуск программы на всех компьютерах сразу. Не выложенное ждёт
  в панели неделю.

  Если эта версия уже собрана (MESSENGER\desktop-client\release\<версия>), повторно
  не собирает — только снова кладёт на сервер. Пересобрать — -Force.

  Первая сборка качает около 500 МБ (Electron двух версий и инструменты установщика) и
  идёт 5–15 минут. Скачанное остаётся в кэше (%LOCALAPPDATA%\electron\Cache и
  ...\electron-builder\Cache) — следующие сборки почти не ходят в интернет.

  Журнал сборки — в <корень установки>\.update\iskra-build-<дата>.log.

.PARAMETER Bump
  Поднять номер версии перед сборкой: patch, minor, major или номер вида 1.2.3.
  Обычно НЕ нужно: номер поднимается в репозитории вместе с правками клиента. Номер,
  поднятый здесь, живёт только на сервере, и следующее обновление вернёт в исходники
  прежний — тогда следующая сборка повторит уже выложенный номер.
.PARAMETER Force
  Собрать заново: даже если эта версия уже собрана или выложена (например, проверить,
  что сборка проходит). Выложенную повторно сервер «Искры» выложить не даст.
.PARAMETER NoOpen
  Не открывать папку с результатом в Проводнике (по умолчанию она открывается, только если
  положить сборку на сервер «Искры» не вышло).

.EXAMPLE
  .\build-iskra-client.ps1
.EXAMPLE
  .\build-iskra-client.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string]$Bump,
  [switch]$Force,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# ---------------------------------------------------------------------------
#  Настройки — тот же update.config.psd1, что у update.ps1
# ---------------------------------------------------------------------------

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ConfigPath) { $ConfigPath = Join-Path (Split-Path -Parent $ScriptDir) 'update.config.psd1' }
$Config = @{
  InstallRoot = (Split-Path -Parent $ScriptDir)
  Proxy       = ''
  ProxyUseDefaultCredentials = $true
  Paths       = @{}
}
if (Test-Path -LiteralPath $ConfigPath) {
  $fromFile = Import-PowerShellDataFile -LiteralPath $ConfigPath
  foreach ($k in $fromFile.Keys) { $Config[$k] = $fromFile[$k] }
}
$Root = [IO.Path]::GetFullPath($Config.InstallRoot)
$StateDir = Join-Path $Root '.update'
$Messenger = if ($Config.Paths -and $Config.Paths['MESSENGER']) { [IO.Path]::GetFullPath($Config.Paths['MESSENGER']) } else { Join-Path $Root 'MESSENGER' }
$Client = Join-Path $Messenger 'desktop-client'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { throw [Exception]::new($text) }

# Номер версии из package.json или latest.yml (строка version: 1.0.14).
function Get-PackageVersion([string]$file) {
  $m = [regex]::Match([IO.File]::ReadAllText($file), '"version"\s*:\s*"([^"]+)"')
  if ($m.Success) { return $m.Groups[1].Value } else { return $null }
}
function Get-PublishedVersion([string]$track) {
  $yml = Join-Path $Messenger "updates\$track\latest.yml"
  if (-not (Test-Path -LiteralPath $yml)) { return $null }
  $m = [regex]::Match([IO.File]::ReadAllText($yml), '(?m)^version:\s*([^\s]+)')
  if ($m.Success) { return $m.Groups[1].Value.Trim("'", '"') } else { return $null }
}

# Прокси — как в update.ps1: из настроек, иначе системный Windows (как у браузера).
# GitHub и npm принимают только TLS 1.2+, а Windows PowerShell 5.1 по умолчанию его не предлагает.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$SystemProxy = [Net.WebRequest]::GetSystemWebProxy()
if ($Config.ProxyUseDefaultCredentials) { $SystemProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
[Net.WebRequest]::DefaultWebProxy = $SystemProxy
function Get-ProxyFor([string]$url) {
  if ($Config.Proxy) { return $Config.Proxy.TrimEnd('/') }
  $u = [Uri]$url
  $px = $SystemProxy.GetProxy($u)
  if ($px -and $px.AbsoluteUri -ne $u.AbsoluteUri) { return $px.AbsoluteUri.TrimEnd('/') }
  return $null
}

# Достучаться до адреса так, как это сделает PowerShell (с входом на прокси под учёткой).
function Test-Url([string]$url) {
  try {
    $p = @{ Uri = $url; Method = 'Head'; UseBasicParsing = $true; TimeoutSec = 20 }
    if ($Config.Proxy) { $p.Proxy = $Config.Proxy; if ($Config.ProxyUseDefaultCredentials) { $p.ProxyUseDefaultCredentials = $true } }
    Invoke-WebRequest @p | Out-Null
    return $null
  } catch { return $_.Exception.Message }
}

# Запуск npm: вывод — на экран и в журнал; при ошибке — хвост и подсказка по типичным причинам.
function Invoke-Npm([string[]]$arguments, [string]$what) {
  Say "   npm $($arguments -join ' ')" 'DarkGray'
  # Continue, а не Stop: в Windows PowerShell 5.1 первая же строка npm в stderr (а предупреждения
  # npm идут именно туда) при Stop и 2>&1 обрывает скрипт, хотя сам npm работает дальше.
  # Вывод идёт и на экран (сборка долгая — видно, что она жива), и в журнал.
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $log = [IO.StreamWriter]::new($script:Log, $true, [Text.UTF8Encoding]::new($false))
  try {
    $out = & $script:Npm @arguments 2>&1 | ForEach-Object {
      $line = "$_"
      $log.WriteLine($line)
      Write-Host "     $line" -ForegroundColor DarkGray
      $line
    }
    $code = $LASTEXITCODE
  } finally { $log.Dispose(); $ErrorActionPreference = $eap }
  if ($code -ne 0) {
    $tail = ($out | Select-Object -Last 25) -join "`n"
    $hint = ''
    if ($tail -match '407|Proxy Authentication') {
      $hint = "Прокси требует вход по учётной записи домена — npm и сборщик так не умеют (PowerShell умеет, поэтому обновление сервера работает).`n" +
              "Варианты: попросить пропускать этот сервер без авторизации на registry.npmjs.org, github.com,`n" +
              "objects.githubusercontent.com, release-assets.githubusercontent.com; либо указать в update.config.psd1`n" +
              "Proxy = 'http://логин:пароль@прокси:порт' (пароль будет лежать в файле открытым текстом);`n" +
              "либо собрать на машине с прямым интернетом: npm ci, затем npm run release -- same."
    } elseif ($tail -match 'SELF_SIGNED|UNABLE_TO_GET_ISSUER|unable to get local issuer|self.signed certificate') {
      $hint = "Прокси подменяет HTTPS-сертификаты, а Node не доверяет его корню. Нужен Node.js 22.15 или новее —`n" +
              "он берёт корни из хранилища Windows (скрипт включает это сам, если версия подходит)."
    } elseif ($tail -match 'ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo|socket hang up|ECONNRESET') {
      $hint = "Не удалось соединиться с сайтом. Проверьте адрес прокси (строка Proxy в update.config.psd1) и что сайты из проверки выше открываются."
    } elseif ($tail -match 'ENOSPC|no space') {
      $hint = 'Кончилось место на диске.'
    }
    Fail ("$what не удалось. Последние строки:`n$tail" + $(if ($hint) { "`n`nЧто делать: $hint" } else { '' }) + "`n`nПолный журнал: $script:Log")
  }
}

# ---------------------------------------------------------------------------
#  Сборка
# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$script:Log = Join-Path $StateDir ('iskra-build-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date))
$savedEnv = @{}
foreach ($n in 'HTTP_PROXY', 'HTTPS_PROXY', 'ELECTRON_GET_USE_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_HTTP_PROXY', 'ELECTRON_SKIP_BINARY_DOWNLOAD', 'NODE_OPTIONS') {
  $savedEnv[$n] = [Environment]::GetEnvironmentVariable($n, 'Process')
}

try {
  Step 'Что собираем'
  $pkg = Join-Path $Client 'package.json'
  if (-not (Test-Path -LiteralPath $pkg)) { Fail "Нет исходников клиента: $pkg. Сначала обновите сервер (update.cmd) — клиент приезжает вместе с «Искрой»." }
  $version = Get-PackageVersion $pkg
  $pub7 = Get-PublishedVersion 'win7'
  $pub10 = Get-PublishedVersion 'win10'
  Say "   исходники клиента: $Client"
  Say "   версия в исходниках: $version"
  Say ("   выложено сотрудникам: Windows 7 — {0}, Windows 10 — {1}" -f $(if ($pub7) { $pub7 } else { 'нет' }), $(if ($pub10) { $pub10 } else { 'нет' }))

  $how = 'same'
  if ($Bump) {
    $how = $Bump
    Say "   номер будет поднят ($Bump). Он останется только на сервере — см. справку: Get-Help .\build-iskra-client.ps1 -Parameter Bump" 'Yellow'
  } elseif (($pub7 -eq $version -or $pub10 -eq $version) -and -not $Force) {
    Say ''
    Say "Версия $version уже выложена — новой версии клиента в исходниках нет, собирать нечего." 'Green'
    Say 'Когда в клиенте будут правки, номер поднимется в репозитории; обновите сервер и запустите сборку снова.' 'DarkGray'
    Say 'Собрать всё равно (проверка сборки): .\build-iskra-client.ps1 -Force' 'DarkGray'
    return
  }

  $releaseDir = Join-Path $Client "release\$version"
  $alreadyBuilt = ($how -eq 'same') -and -not $Force -and (@(Get-ChildItem -LiteralPath $releaseDir -File -ErrorAction SilentlyContinue).Count -eq 6)
  if ($alreadyBuilt) {
    Say "   версия $version уже собрана ($releaseDir) — собирать заново не нужно, только положить на сервер" 'DarkGray'
  } else {

  Step 'Проверка'
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $script:Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
  if (-not $node -or -not $script:Npm) { Fail 'Не найден Node.js (node.exe и npm.cmd). Он стоит на сервере для платформы — откройте новое окно PowerShell или проверьте PATH.' }
  $script:Npm = $script:Npm.Source
  $nodeVer = [version]((& $node.Source --version).TrimStart('v'))
  Say "   Node.js $nodeVer"
  if ($nodeVer -lt [version]'18.0') { Fail "Для сборки нужен Node.js 18 или новее, стоит $nodeVer." }

  $needGb = 2
  foreach ($dir in @($Client, $env:LOCALAPPDATA)) {
    $drive = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($dir))
    $free = (New-Object IO.DriveInfo $drive).AvailableFreeSpace / 1GB
    Say ("   свободно на {0} — {1:N1} ГБ" -f $drive, $free)
    if ($free -lt $needGb) { Fail "На диске $drive меньше $needGb ГБ свободного места — сборке нужно около 2 ГБ (зависимости и кэш Electron)." }
  }

  $proxy = Get-ProxyFor 'https://registry.npmjs.org/'
  if ($proxy) { Say "   прокси: $proxy $(if ($Config.Proxy) { '(из update.config.psd1)' } else { '(системный Windows)' })" }
  else { Say '   прокси: нет, напрямую' }
  foreach ($url in 'https://registry.npmjs.org/electron-builder', 'https://github.com/electron/electron/releases') {
    $err = Test-Url $url
    if ($err) { Say "   [!] $url — $err" 'Yellow' } else { Say "   доступен $url" }
  }

  # Окружение только этого процесса: npm, сборщик и загрузчик Electron берут прокси из переменных.
  if ($proxy) {
    $env:HTTP_PROXY = $proxy; $env:HTTPS_PROXY = $proxy
    $env:ELECTRON_GET_USE_PROXY = '1'; $env:GLOBAL_AGENT_HTTPS_PROXY = $proxy; $env:GLOBAL_AGENT_HTTP_PROXY = $proxy
  }
  # Свой Electron пакету electron не нужен: сборщик качает нужные версии сам, в свой кэш.
  $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
  # Прокси, подменяющий HTTPS, Node пропустит, только доверяя корням Windows (Node 22.15+).
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $node.Source --use-system-ca -e "0" 2>&1 | Out-Null; $systemCa = ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $eap }
  if ($systemCa) { $env:NODE_OPTIONS = (@($savedEnv['NODE_OPTIONS'], '--use-system-ca') | Where-Object { $_ }) -join ' ' }

  Step 'Зависимости (npm ci)'
  Push-Location $Client
  try {
    Invoke-Npm @('ci', '--no-audit', '--no-fund') 'Установка зависимостей'

    Step "Сборка версии $(if ($how -eq 'same') { $version } else { "($how)" }) — Windows 7/8.1 и Windows 10+"
    Say '   первая сборка качает около 500 МБ и идёт 5–15 минут' 'DarkGray'
    Invoke-Npm @('run', 'release', '--', $how) 'Сборка'
  } finally { Pop-Location }

  }   # конец сборки (пропускается, если версия уже собрана)

  $built = Get-PackageVersion $pkg
  $out = Join-Path $Client "release\$built"
  $files = @(Get-ChildItem -LiteralPath $out -File -ErrorAction SilentlyContinue)
  if ($files.Count -ne 6) { Fail "Сборка закончилась, но в $out не шесть файлов, а $($files.Count). Журнал: $script:Log" }
  foreach ($f in $files) { Say ("   {0,-40} {1,6:N1} МБ" -f $f.Name, ($f.Length / 1MB)) }

  # На сервер «Искры» — в папку ожидания выкладки, рядом с updates (НЕ внутрь: всё, что в updates,
  # раздаётся клиентам). Раскладка — как у загрузки из панели, плюс latest.yml сборщика под именем
  # latest-<версия>.yml: по нему панель покажет версию готовой, а выкладка сверит контрольную сумму.
  Step 'На сервер «Искры»'
  $staged = $false
  try {
    foreach ($track in 'win7', 'win10') {
      $dir = Join-Path $Messenger "updates-staging\$track"
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $exe = "iskra-setup-$track-$built.exe"
      $items = @(
        @{ From = (Join-Path $out $exe); To = (Join-Path $dir $exe) },
        @{ From = (Join-Path $out "$exe.blockmap"); To = (Join-Path $dir "$exe.blockmap") },
        # latest.yml — последним: панель считает версию готовой, когда он на месте.
        @{ From = (Join-Path $out "latest-$track.yml"); To = (Join-Path $dir "latest-$built.yml") }
      )
      foreach ($it in $items) {
        Copy-Item -LiteralPath $it.From -Destination $it.To -Force
        # Срок ожидания на сервере считается от времени файла; копия сохранила бы время сборки.
        (Get-Item -LiteralPath $it.To).LastWriteTime = Get-Date
      }
      Say "   $track — $exe"
    }
    $staged = $true
  } catch {
    Say "   не удалось: $($_.Exception.Message)" 'Yellow'
    Say "   нет прав на запись в $Messenger\updates-staging? Запустите окно от администратора или выложите файлы из папки вручную." 'Yellow'
  }

  Step 'Готово'
  if ($staged) {
    Say "Версия $built собрана и лежит на сервере «Искры»." 'Green'
    Say 'Дальше: панель «Искры» → «Клиенты» → «Собрана на сервере версия …» → свой пароль → «Выложить».' 'Green'
    Say 'Сотрудники получат обновление при следующем запуске клиента. Не выложенное ждёт в панели неделю.' 'Green'
  } else {
    Say "Версия $built собрана: $out" 'Green'
    Say 'Дальше: панель «Искры» → «Клиенты» → «Выложить новую версию» → выбрать все шесть файлов из этой папки,' 'Green'
    Say 'ввести свой пароль, «Выложить».' 'Green'
  }
  if ($built -ne $version) { Say "Номер $built поднят только на сервере — поднимите его и в репозитории." 'Yellow' }
  Say "Журнал сборки: $script:Log" 'DarkGray'
  if (-not $staged -and -not $NoOpen) { Start-Process explorer.exe $out }
}
catch {
  Say ''
  Say $_.Exception.Message 'Red'
  exit 1
}
finally {
  foreach ($n in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $savedEnv[$n], 'Process') }
}
