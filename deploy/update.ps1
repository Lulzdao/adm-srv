<#
.SYNOPSIS
  Обновление adm-srv на сервере до актуальной версии с GitHub — одной командой.

.DESCRIPTION
  Раньше обновление было ручным: изменённые файлы перекидывали на сервер по одному и
  перезапускали службы. Скрипт делает это сам и так, чтобы ошибка не оставила сервер
  в полуобновлённом виде:

    1. Подготовка — службы в это время работают:
       скачивает архив ветки с GitHub (через прокси), сравнивает с тем, что стоит на
       сервере, показывает, какие файлы изменятся, какие службы будут перезапущены и
       какие коммиты вошли. Если поменялись зависимости (package-lock.json), собирает
       node_modules заранее, во временной папке.
    2. После подтверждения: резервная копия заменяемых файлов, остановка ТОЛЬКО тех
       служб, чьи файлы меняются, замена файлов, запуск, проверка — служба работает и
       слушает свой порт.
    3. Что-то не поднялось — прежняя версия возвращается сама, службы перезапускаются
       на ней.

  НИКОГДА не трогает: .env, базы (*.db), uploads, data, logs, certs, updates,
  node_modules (кроме случая, когда поменялись зависимости), bootstrap-admin.js.
  Эти файлы в репозитории и не лежат — список ниже лишь страховка.

  Где что стоит, скрипт узнаёт сам: по службам NSSM (их рабочие каталоги) и по
  характерным файлам внутри. Если «Искра» или модуль стоит не в корне установки,
  можно указать путь в update.config.psd1 (см. update.config.example.psd1).

.PARAMETER CheckOnly
  Только показать, что изменится. Ничего не менять.
.PARAMETER Yes
  Не спрашивать подтверждение (для запуска по расписанию).
.PARAMETER SourceZip
  Взять архив из файла, а не скачивать: если GitHub недоступен, архив ветки
  (github.com/<repo>/archive/refs/heads/main.zip) приносят на флешке.
.PARAMETER SkipServices
  Только для проверки на копии каталога: службы не искать, не останавливать и не
  запускать. На рабочем сервере не использовать.

.EXAMPLE
  .\update.ps1 -CheckOnly
.EXAMPLE
  .\update.ps1
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string]$SourceZip,
  [switch]$Yes,
  [switch]$CheckOnly,
  [switch]$SkipServices,
  # Только для test-update.ps1: оборвать обновление после замены файлов, чтобы
  # проверить откат.
  [switch]$TestFailAfterCopy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# ---------------------------------------------------------------------------
#  Настройки
# ---------------------------------------------------------------------------

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ConfigPath) { $ConfigPath = Join-Path (Split-Path -Parent $ScriptDir) 'update.config.psd1' }

$Config = @{
  # Корень установки. По умолчанию — папка над deploy\, то есть там, куда скрипт
  # сам и приезжает вместе с остальными файлами.
  InstallRoot = (Split-Path -Parent $ScriptDir)
  Repo        = 'Lulzdao/adm-srv'
  Branch      = 'main'
  # Пусто — системный прокси Windows (как у браузера). Иначе адрес: 'http://proxy:3128'.
  Proxy       = ''
  # Входить на прокси под учётной записью, от которой запущен скрипт (NTLM/Kerberos).
  ProxyUseDefaultCredentials = $true
  # Компонент стоит не в <InstallRoot>\<имя>: @{ MESSENGER = 'C:\ISKRA\iskra-server' }
  Paths       = @{}
  # Порт для проверки после запуска, если он не 3000/3101/3102/3103 и не указан в .env.
  Ports       = @{}
  KeepBackups = 5
}
if (Test-Path -LiteralPath $ConfigPath) {
  $fromFile = Import-PowerShellDataFile -LiteralPath $ConfigPath
  foreach ($k in $fromFile.Keys) { $Config[$k] = $fromFile[$k] }
}
$Root = [IO.Path]::GetFullPath($Config.InstallRoot)
$StateDir = Join-Path $Root '.update'

# Компоненты репозитория. Marker — файлы, по которым каталог узнаётся в рабочем
# каталоге службы NSSM (имена служб и папок на сервере могут отличаться от DEPLOY.md).
$Components = [ordered]@{
  'helpdesk-backend' = @{ Markers = @('app.js', 'config\modules.js');       Port = 3000; EnvPort = '.env' }
  'CERTVIEWER'       = @{ Markers = @('mchd.js', 'server.js');              Port = 3101; EnvPort = '.env' }
  'SMDR'             = @{ Markers = @('Collector.Py');                      Port = $null; EnvPort = $null }
  'SMDR\web-node'    = @{ Markers = @('views\dashboard.ejs', 'db.js');      Port = 3102; EnvPort = '.env' }
  'MESSENGER'        = @{ Markers = @('server.js', 'bootstrap-admin.example.js'); Port = 3103; EnvPort = $null }
}
# Каталоги с зависимостями на сервере. desktop-client собирается не здесь.
$DepDirs = @('helpdesk-backend', 'CERTVIEWER', 'SMDR\web-node', 'MESSENGER')

# Страховка: даже если такое окажется в архиве, не записывать и не удалять.
$Protected = @(
  '(^|\\)\.env$', '\.db(-shm|-wal)?$', '\.log$', '(^|\\)bootstrap-admin\.js$', '(^|\\)update\.config\.psd1$',
  '(^|\\)(node_modules|uploads|data|logs|certs|updates|backups|dist|\.update|\.claude)(\\|$)'
)
# Документация и тесты: их изменение не требует перезапуска службы.
$NoRestart = @('\.(md|txt|pdf)$', '(^|\\)test(\\|$)', '(^|\\)\.env\.example$', '(^|\\)public\\')

# ---------------------------------------------------------------------------
#  Вывод
# ---------------------------------------------------------------------------

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { throw [Exception]::new($text) }

function Test-Protected([string]$rel) {
  foreach ($p in $Protected) { if ($rel -match $p) { return $true } }
  return $false
}

# ---------------------------------------------------------------------------
#  Где что стоит
# ---------------------------------------------------------------------------

function Test-Markers([string]$dir, [string[]]$markers) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { return $false }
  foreach ($m in $markers) { if (-not (Test-Path -LiteralPath (Join-Path $dir $m))) { return $false } }
  return $true
}

# Службы NSSM: имя, рабочий каталог, какому компоненту он соответствует.
function Get-NssmServices {
  $result = @()
  foreach ($svc in Get-CimInstance Win32_Service) {
    $params = "HKLM:\SYSTEM\CurrentControlSet\Services\$($svc.Name)\Parameters"
    if (-not (Test-Path -LiteralPath $params)) { continue }
    # Раздел Parameters есть у многих служб Windows, но AppDirectory — только у служб NSSM.
    # GetValue отдаёт $null, если значения нет; обращение к свойству в строгом режиме упало бы.
    $appDir = (Get-Item -LiteralPath $params).GetValue('AppDirectory')
    if (-not $appDir) { continue }
    $appDir = [IO.Path]::GetFullPath($appDir)
    foreach ($name in $Components.Keys) {
      if (Test-Markers $appDir $Components[$name].Markers) {
        $result += [pscustomobject]@{ Name = $svc.Name; Dir = $appDir; Component = $name }
        break
      }
    }
  }
  return ,$result
}

# Каталог каждого компонента: из настроек, по службам, или <корень>\<имя>.
function Resolve-ComponentDirs($services) {
  $dirs = @{}
  foreach ($name in $Components.Keys) {
    if ($name -like '*\*') { continue }   # вложенные (SMDR\web-node) едут вместе с родителем
    $dir = $null
    if ($Config.Paths.ContainsKey($name)) { $dir = [IO.Path]::GetFullPath($Config.Paths[$name]) }
    if (-not $dir) {
      $svc = $services | Where-Object Component -eq $name | Select-Object -First 1
      if ($svc) { $dir = $svc.Dir }
    }
    if (-not $dir -and $name -eq 'SMDR') {
      $web = $services | Where-Object Component -eq 'SMDR\web-node' | Select-Object -First 1
      if ($web) { $dir = Split-Path -Parent $web.Dir }
    }
    if (-not $dir) {
      $candidate = Join-Path $Root $name
      if (Test-Path -LiteralPath $candidate -PathType Container) { $dir = $candidate }
    }
    $dirs[$name] = $dir
  }
  return $dirs
}

# Путь файла из репозитория ('MESSENGER\server.js') -> путь на сервере.
function Get-TargetPath([string]$rel, $dirs) {
  $first = $rel.Split('\')[0]
  if ($dirs.ContainsKey($first)) {
    if (-not $dirs[$first]) { return $null }
    return Join-Path $dirs[$first] $rel.Substring($first.Length + 1)
  }
  return Join-Path $Root $rel
}

# Какой службе принадлежит файл: самый длинный совпавший рабочий каталог.
function Get-OwnerService([string]$target, $services) {
  $best = $null
  foreach ($s in $services) {
    $prefix = $s.Dir.TrimEnd('\') + '\'
    if ($target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      if (-not $best -or $s.Dir.Length -gt $best.Dir.Length) { $best = $s }
    }
  }
  return $best
}

function Get-ServicePort($svc) {
  if ($Config.Ports.ContainsKey($svc.Component)) { return [int]$Config.Ports[$svc.Component] }
  $c = $Components[$svc.Component]
  if ($c.EnvPort) {
    $envFile = Join-Path $svc.Dir $c.EnvPort
    if (Test-Path -LiteralPath $envFile) {
      $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)\s*$' } | Select-Object -First 1
      if ($line -and $line -match '(\d+)\s*$') { return [int]$Matches[1] }
    }
  }
  return $c.Port
}

# ---------------------------------------------------------------------------
#  Архив новой версии
# ---------------------------------------------------------------------------

# Системный прокси Windows — тот же, что у браузера, включая автонастройку (PAC). Вход на него —
# под учётной записью, от которой запущен скрипт: без этого прокси с проверкой по домену отвечает
# «407 Proxy Authentication Required», хотя браузер через него ходит.
$SystemProxy = [Net.WebRequest]::GetSystemWebProxy()
if ($Config.ProxyUseDefaultCredentials) { $SystemProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
[Net.WebRequest]::DefaultWebProxy = $SystemProxy
$script:ProxyEntered = $false

function Get-WebParams {
  $p = @{ UseBasicParsing = $true; Headers = @{ 'User-Agent' = 'adm-srv-updater' } }
  if ($Config.Proxy) {
    $p.Proxy = $Config.Proxy
    if ($Config.ProxyUseDefaultCredentials) { $p.ProxyUseDefaultCredentials = $true }
  }
  return $p
}

# Как пойдёт запрос — для вывода: человек должен видеть, через что скрипт ходит в интернет.
function Get-ProxyNote([string]$url) {
  if ($Config.Proxy) { return "через прокси из настроек: $($Config.Proxy)" }
  $px = $SystemProxy.GetProxy([Uri]$url)
  if ($px -and $px.AbsoluteUri -ne ([Uri]$url).AbsoluteUri) { return "через системный прокси Windows: $($px.Authority)" }
  return 'напрямую (системного прокси нет)'
}

# npm системные настройки прокси Windows не читает — адрес ему передаётся явно.
function Get-NpmProxy {
  if ($Config.Proxy) { return $Config.Proxy }
  $u = [Uri]'https://registry.npmjs.org/'
  $px = $SystemProxy.GetProxy($u)
  if ($px -and $px.AbsoluteUri -ne $u.AbsoluteUri) { return $px.AbsoluteUri.TrimEnd('/') }
  return $null
}

# Запомнить введённый прокси в update.config.psd1: остальные настройки файла не трогаются.
function Save-ProxyToConfig([string]$proxy) {
  $line = "  Proxy = '$($proxy.Replace("'", "''"))'"
  $old = $null
  if (Test-Path -LiteralPath $ConfigPath) {
    $old = [IO.File]::ReadAllText($ConfigPath)
    if ($old -match '(?m)^\s*Proxy\s*=.*$') { $new = [regex]::Replace($old, '(?m)^\s*Proxy\s*=.*$', $line) }
    # После вставленной строки — перевод строки: файл может быть записан в одну строку
    # (@{ InstallRoot = '...' }), и без него Proxy слипся бы со следующим параметром.
    else { $new = ([regex]'@\{').Replace($old, "@{`r`n$line`r`n", 1) }
  } else {
    $new = "# Настройки обновления adm-srv (образец со всеми параметрами — deploy\update.config.example.psd1).`r`n@{`r`n$line`r`n}`r`n"
  }
  [IO.File]::WriteAllText($ConfigPath, $new, [Text.UTF8Encoding]::new($true))
  try { Import-PowerShellDataFile -LiteralPath $ConfigPath | Out-Null }
  catch {
    # Файл перестал читаться — вернуть как было, настройки дороже удобства.
    if ($null -ne $old) { [IO.File]::WriteAllText($ConfigPath, $old, [Text.UTF8Encoding]::new($true)) } else { Remove-Item -LiteralPath $ConfigPath -Force }
    throw
  }
}

# Скачать файл. Не вышло и рядом человек — спросить адрес прокси и попробовать снова.
function Invoke-Download([string]$url, [string]$out) {
  while ($true) {
    Say "   $(Get-ProxyNote $url)"
    $wp = Get-WebParams
    try { Invoke-WebRequest @wp -Uri $url -OutFile $out; return }
    catch {
      $msg = $_.Exception.Message
      if ($Yes -or -not [Environment]::UserInteractive) {
        Fail "Не удалось скачать с GitHub: $msg. Укажите прокси в update.config.psd1 (Proxy = 'http://адрес:порт') или принесите архив и запустите с -SourceZip."
      }
      Say "   не удалось скачать: $msg" 'Yellow'
      Say '   Если на этом сервере интернет только через прокси — введите его адрес,'
      Say '   например http://proxy.rosstat.local:3128 (как в настройках браузера).'
      $answer = Read-Host '   Адрес прокси (пусто и Enter — отменить обновление)'
      if (-not $answer -or -not $answer.Trim()) { Fail 'Скачивание отменено, ничего не изменено.' }
      $answer = $answer.Trim()
      if ($answer -notmatch '^[a-z][a-z0-9+.-]*://') { $answer = "http://$answer" }
      $Config.Proxy = $answer
      $script:ProxyEntered = $true
    }
  }
}

# Архивы GitHub и git archive хранят идентификатор коммита в комментарии ZIP.
function Get-ZipComment([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $stop = [Math]::Max(0, $bytes.Length - 65557)
  for ($i = $bytes.Length - 22; $i -ge $stop; $i--) {
    if ($bytes[$i] -eq 0x50 -and $bytes[$i + 1] -eq 0x4B -and $bytes[$i + 2] -eq 5 -and $bytes[$i + 3] -eq 6) {
      $len = [BitConverter]::ToUInt16($bytes, $i + 20)
      return [Text.Encoding]::ASCII.GetString($bytes, $i + 22, $len).Trim()
    }
  }
  return ''
}

function Get-FileList([string]$root) {
  $base = $root.TrimEnd('\') + '\'
  Get-ChildItem -LiteralPath $root -Recurse -File -Force |
    ForEach-Object { $_.FullName.Substring($base.Length) } |
    Where-Object { -not (Test-Protected $_) } |
    Sort-Object
}

# Одинаковы ли файлы. Разница только в переводах строк (CRLF/LF) — не отличие:
# на сервер файлы могли попасть из git на Windows, а в архиве GitHub они с LF.
function Test-SameFile([string]$a, [string]$b) {
  if (-not (Test-Path -LiteralPath $b)) { return $false }
  $ia = Get-Item -LiteralPath $a; $ib = Get-Item -LiteralPath $b
  if ($ia.Length -eq $ib.Length -and
      (Get-FileHash -LiteralPath $a).Hash -eq (Get-FileHash -LiteralPath $b).Hash) { return $true }
  if ($ia.Length -gt 4MB -or $ib.Length -gt 4MB) { return $false }
  # Latin-1 переводит байт в символ один к одному — сравнение остаётся побайтовым,
  # просто без символов CR, и работает мгновенно даже на больших файлах.
  $latin1 = [Text.Encoding]::GetEncoding(28591)
  $ta = [IO.File]::ReadAllText($a, $latin1).Replace("`r", '')
  $tb = [IO.File]::ReadAllText($b, $latin1).Replace("`r", '')
  return [string]::Equals($ta, $tb, [StringComparison]::Ordinal)
}

# ---------------------------------------------------------------------------
#  Службы
# ---------------------------------------------------------------------------

function Stop-Services($list) {
  foreach ($s in $list) {
    Say "   останавливаю $($s.Name)"
    Stop-Service -Name $s.Name -Force -ErrorAction Stop
    (Get-Service -Name $s.Name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
  }
}

# Запустить и убедиться, что служба не только стартовала, но и не упала сразу, и
# слушает свой порт. NSSM показывает «Running» и у процесса, который тут же
# завершился и перезапускается, — поэтому порт и повторная проверка обязательны.
function Start-AndCheck($list) {
  $problems = @()
  foreach ($s in $list) {
    Say "   запускаю $($s.Name)"
    try {
      Start-Service -Name $s.Name -ErrorAction Stop
      (Get-Service -Name $s.Name).WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
    } catch { $problems += "$($s.Name): не запустилась ($($_.Exception.Message))"; continue }
  }
  foreach ($s in $list) {
    if ($problems -match [regex]::Escape($s.Name)) { continue }
    $port = Get-ServicePort $s
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      if ((Get-Service -Name $s.Name).Status -ne 'Running') { break }
      if (-not $port) { if ($i -ge 4) { $ok = $true; break } else { continue } }
      if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { $ok = $true; break }
    }
    if ($ok) {
      Start-Sleep -Seconds 3
      $ok = (Get-Service -Name $s.Name).Status -eq 'Running'
    }
    if ($ok) { Say "   $($s.Name) работает$(if ($port) { ", порт $port" })" 'Green' }
    else { $problems += "$($s.Name): не работает или не слушает порт $port — смотрите её *.err.log" }
  }
  return ,$problems
}

# ---------------------------------------------------------------------------
#  Основная работа
# ---------------------------------------------------------------------------

# Код выхода: 0 — готово (или нечего обновлять / отменено), 1 — ошибка до изменений,
# 2 — ошибка, откат выполнен, 3 — откат выполнен, но службы не поднялись.
$script:exitCode = 0
$script:work = $null
$lock = Join-Path $StateDir 'lock'

function Invoke-Update {
  if (Test-Path -LiteralPath $lock) {
    $otherPid = [int](Get-Content -LiteralPath $lock -Raw)
    if (Get-Process -Id $otherPid -ErrorAction SilentlyContinue) { Fail "Обновление уже идёт (процесс $otherPid)." }
  }
  Set-Content -LiteralPath $lock -Value $PID

  Say "Обновление adm-srv: $($Config.Repo), ветка $($Config.Branch)" 'White'
  Say "Каталог установки: $Root"

  # --- Где что стоит --------------------------------------------------------
  Step 'Службы и каталоги'
  $services = @()
  if (-not $SkipServices) { $services = Get-NssmServices }
  $dirs = Resolve-ComponentDirs $services
  foreach ($name in $dirs.Keys | Sort-Object) {
    $d = $dirs[$name]
    Say ("   {0,-18} {1}" -f $name, $(if ($d) { $d } else { 'НЕ НАЙДЕН — его файлы будут пропущены' })) $(if ($d) { 'Gray' } else { 'Yellow' })
  }
  foreach ($s in $services) { Say ("   служба {0,-20} -> {1}" -f $s.Name, $s.Component) }
  if (-not $SkipServices -and -not $services) {
    Fail 'Не найдено ни одной службы NSSM с файлами adm-srv. Проверьте, что скрипт запущен от администратора, или укажите пути в update.config.psd1.'
  }

  # --- Новая версия ---------------------------------------------------------
  Step 'Новая версия'
  $script:work = Join-Path $env:TEMP ("adm-srv-update-{0}" -f $PID)
  $work = $script:work
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $zip = Join-Path $work 'source.zip'
  if ($SourceZip) {
    Copy-Item -LiteralPath $SourceZip -Destination $zip
    Say "   архив из файла: $SourceZip"
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $url = "https://codeload.github.com/$($Config.Repo)/zip/refs/heads/$($Config.Branch)"
    Say "   скачиваю $url"
    Invoke-Download $url $zip
    if ($script:ProxyEntered) {
      $save = Read-Host "   Прокси сработал. Запомнить его в ${ConfigPath}? Введите Д (или Y) и Enter"
      if ($save -match '^\s*(д|да|y|yes)\s*$') { Save-ProxyToConfig $Config.Proxy; Say '   запомнено — в следующий раз спрашивать не буду' 'Green' }
    }
  }
  $newSha = Get-ZipComment $zip
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $extract = Join-Path $work 'src'
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
  $top = @(Get-ChildItem -LiteralPath $extract -Directory)
  if ($top.Count -ne 1) { Fail 'В архиве ожидалась одна папка с репозиторием.' }
  $src = $top[0].FullName
  if (-not (Test-Path -LiteralPath (Join-Path $src 'helpdesk-backend\app.js'))) { Fail 'Это не архив adm-srv: нет helpdesk-backend\app.js.' }

  $versionFile = Join-Path $StateDir 'version.txt'
  $manifestFile = Join-Path $StateDir 'manifest.txt'
  $oldSha = if (Test-Path -LiteralPath $versionFile) { (Get-Content -LiteralPath $versionFile -Raw).Trim() } else { '' }
  Say ("   установлено: {0}" -f $(if ($oldSha) { $oldSha.Substring(0, [Math]::Min(12, $oldSha.Length)) } else { 'неизвестно (первое обновление этим скриптом)' }))
  Say ("   новая:       {0}" -f $(if ($newSha) { $newSha.Substring(0, [Math]::Min(12, $newSha.Length)) } else { 'неизвестно' }))

  if ($oldSha -and $newSha -and $oldSha -ne $newSha -and -not $SourceZip) {
    try {
      $wp = Get-WebParams
      $cmp = Invoke-RestMethod @wp -Uri "https://api.github.com/repos/$($Config.Repo)/compare/$oldSha...$newSha"
      Say "   что вошло ($($cmp.total_commits) коммит.):"
      foreach ($c in @($cmp.commits) | Select-Object -Last 25) {
        Say ("     {0}  {1}" -f $c.sha.Substring(0, 7), ($c.commit.message -split "`n")[0])
      }
    } catch { Say "   (список коммитов получить не удалось: $($_.Exception.Message))" 'DarkGray' }
  }

  # --- Что изменится --------------------------------------------------------
  Step 'Что изменится'
  $newFiles = @(Get-FileList $src)
  $oldManifest = @()
  if (Test-Path -LiteralPath $manifestFile) { $oldManifest = @(Get-Content -LiteralPath $manifestFile) }

  $changes = @()      # { Rel; Source; Target; Kind = added|changed|deleted }
  $skipped = @()
  foreach ($rel in $newFiles) {
    $target = Get-TargetPath $rel $dirs
    if (-not $target) { $skipped += $rel; continue }
    $source = Join-Path $src $rel
    if (-not (Test-Path -LiteralPath $target)) { $changes += [pscustomobject]@{ Rel = $rel; Source = $source; Target = $target; Kind = 'added' } }
    elseif (-not (Test-SameFile $source $target)) { $changes += [pscustomobject]@{ Rel = $rel; Source = $source; Target = $target; Kind = 'changed' } }
  }
  # Удаляются только файлы, которые сами были частью прошлой версии (манифест). Всё
  # остальное в каталогах — данные и настройки — не наше, его не трогаем.
  $newSet = @{}; foreach ($r in $newFiles) { $newSet[$r] = $true }
  foreach ($rel in $oldManifest) {
    if (-not $rel -or $newSet.ContainsKey($rel) -or (Test-Protected $rel)) { continue }
    $target = Get-TargetPath $rel $dirs
    if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
      $changes += [pscustomobject]@{ Rel = $rel; Source = $null; Target = $target; Kind = 'deleted' }
    }
  }
  if (-not $oldManifest) { Say '   (прежнего списка файлов нет — удалённые из репозитория файлы в этот раз не удаляются)' 'DarkGray' }

  # Зависимости: сравниваем package-lock.json (или package.json) новой версии с установленным.
  $depPlans = @()
  foreach ($d in $DepDirs) {
    $first = $d.Split('\')[0]
    if (-not $dirs[$first]) { continue }
    $pkgRel = "$d\package.json"
    if (-not (Test-Path -LiteralPath (Join-Path $src $pkgRel))) { continue }
    $lockRel = "$d\package-lock.json"
    $cmpRel = if (Test-Path -LiteralPath (Join-Path $src $lockRel)) { $lockRel } else { $pkgRel }
    $targetDir = Split-Path -Parent (Get-TargetPath $pkgRel $dirs)
    $nm = Join-Path $targetDir 'node_modules'
    if (-not (Test-Path -LiteralPath $nm) -or -not (Test-SameFile (Join-Path $src $cmpRel) (Join-Path $targetDir (Split-Path -Leaf $cmpRel)))) {
      $depPlans += [pscustomobject]@{ Dir = $d; TargetDir = $targetDir; Staged = (Join-Path $work "deps\$d") }
    }
  }

  foreach ($kind in 'changed', 'added', 'deleted') {
    $list = @($changes | Where-Object Kind -eq $kind)
    if (-not $list) { continue }
    $label = @{ changed = 'изменится'; added = 'добавится'; deleted = 'удалится' }[$kind]
    Say "   ${label}: $($list.Count)" 'White'
    foreach ($c in $list | Select-Object -First 60) { Say "     $($c.Rel)" }
    if ($list.Count -gt 60) { Say "     ... и ещё $($list.Count - 60)" }
  }
  foreach ($p in $depPlans) { Say "   зависимости: $($p.Dir) — node_modules будут пересобраны" 'Yellow' }
  foreach ($r in $skipped | Select-Object -First 10) { Say "   пропущено (компонент не найден): $r" 'Yellow' }

  # Какие службы перезапустить.
  $restart = @()
  $restartNames = @{}
  foreach ($c in $changes) {
    $doc = $false; foreach ($p in $NoRestart) { if ($c.Rel -match $p) { $doc = $true } }
    if ($doc) { continue }
    $owner = Get-OwnerService $c.Target $services
    if ($owner -and -not $restartNames.ContainsKey($owner.Name)) { $restart += $owner; $restartNames[$owner.Name] = $true }
  }
  foreach ($p in $depPlans) {
    $owner = $services | Where-Object { $_.Dir -eq $p.TargetDir.TrimEnd('\') } | Select-Object -First 1
    if ($owner -and -not $restartNames.ContainsKey($owner.Name)) { $restart += $owner; $restartNames[$owner.Name] = $true }
  }
  if ($restart) { Say ("   будут перезапущены: {0}" -f (($restart | ForEach-Object Name) -join ', ')) 'White' }
  elseif (-not $SkipServices) { Say '   перезапуск служб не нужен' }

  if (-not $changes -and -not $depPlans) {
    Say ''; Say 'Уже установлена актуальная версия.' 'Green'
    if ($newSha) { Set-Content -LiteralPath $versionFile -Value $newSha }
    Set-Content -LiteralPath $manifestFile -Value $newFiles
    return
  }
  if ($CheckOnly) { Say ''; Say 'Режим проверки: ничего не изменено.' 'Green'; return }

  if (-not $Yes) {
    Say ''
    $answer = Read-Host 'Обновить? Введите Д (или Y) и Enter'
    if ($answer -notmatch '^\s*(д|да|y|yes)\s*$') { Say 'Отменено, ничего не изменено.' 'Yellow'; return }
  }

  # --- Зависимости — заранее, пока службы работают --------------------------
  if ($depPlans) {
    Step 'Сборка зависимостей'
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
    if (-not $npm) { Fail 'Зависимости изменились, а npm не найден. Соберите node_modules на машине с интернетом (DEPLOY.md, раздел 1).' }
    foreach ($p in $depPlans) {
      New-Item -ItemType Directory -Force -Path $p.Staged | Out-Null
      foreach ($f in 'package.json', 'package-lock.json') {
        $from = Join-Path $src "$($p.Dir)\$f"
        if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $p.Staged }
      }
      Say "   npm ci в $($p.Dir)"
      $saved = @{ HTTP_PROXY = $env:HTTP_PROXY; HTTPS_PROXY = $env:HTTPS_PROXY }
      $npmProxy = Get-NpmProxy
      if ($npmProxy) { $env:HTTP_PROXY = $npmProxy; $env:HTTPS_PROXY = $npmProxy; Say "   npm через прокси $npmProxy" }
      Push-Location $p.Staged
      try {
        $out = & $npm.Source ci --omit=dev --no-audit --no-fund 2>&1
        if ($LASTEXITCODE -ne 0) { Fail "npm ci в $($p.Dir) не удался (сервер не дотянулся до npm через прокси?):`n$($out | Select-Object -Last 15 | Out-String)" }
      } finally {
        Pop-Location
        $env:HTTP_PROXY = $saved.HTTP_PROXY; $env:HTTPS_PROXY = $saved.HTTPS_PROXY
      }
    }
  }

  # --- Замена ---------------------------------------------------------------
  $stamp = '{0:yyyyMMdd-HHmmss}' -f (Get-Date)
  $backup = Join-Path $StateDir "backup\$stamp"
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  $done = [System.Collections.ArrayList]::new()   # что уже сделано — для отката
  $stopped = @()
  try {
    if ($restart -and -not $SkipServices) { Step 'Остановка служб'; Stop-Services $restart; $stopped = $restart }

    Step 'Замена файлов'
    foreach ($c in $changes) {
      if ($c.Kind -ne 'added') {
        $bk = Join-Path $backup "files\$($c.Rel)"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bk) | Out-Null
        Copy-Item -LiteralPath $c.Target -Destination $bk -Force
      }
      if ($c.Kind -eq 'deleted') {
        Remove-Item -LiteralPath $c.Target -Force
      } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $c.Target) | Out-Null
        Copy-Item -LiteralPath $c.Source -Destination $c.Target -Force
      }
      [void]$done.Add([pscustomobject]@{ Type = 'file'; Change = $c; Backup = $(if ($c.Kind -ne 'added') { Join-Path $backup "files\$($c.Rel)" }) })
    }
    foreach ($p in $depPlans) {
      $nm = Join-Path $p.TargetDir 'node_modules'
      $bkNm = Join-Path $backup "node_modules\$($p.Dir)"
      if (Test-Path -LiteralPath $nm) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bkNm) | Out-Null
        Move-Item -LiteralPath $nm -Destination $bkNm
      }
      Move-Item -LiteralPath (Join-Path $p.Staged 'node_modules') -Destination $nm
      [void]$done.Add([pscustomobject]@{ Type = 'deps'; Target = $nm; Backup = $(if (Test-Path -LiteralPath $bkNm) { $bkNm }) })
    }
    Say "   файлов: $($changes.Count), резервная копия: $backup"
    if ($TestFailAfterCopy) { Fail 'Проверочный сбой после замены файлов (-TestFailAfterCopy).' }

    if ($stopped) {
      Step 'Запуск и проверка'
      $problems = Start-AndCheck $stopped
      if ($problems) { Fail ("Не все службы поднялись:`n   " + ($problems -join "`n   ")) }
    }
  } catch {
    $reason = $_.Exception.Message
    Say ''; Say "ОШИБКА: $reason" 'Red'
    Step 'Откат к прежней версии'
    if ($stopped) { try { Stop-Services $stopped } catch { Say "   $($_.Exception.Message)" 'Yellow' } }
    for ($i = $done.Count - 1; $i -ge 0; $i--) {
      $d = $done[$i]
      try {
        if ($d.Type -eq 'deps') {
          if (Test-Path -LiteralPath $d.Target) { Remove-Item -LiteralPath $d.Target -Recurse -Force }
          if ($d.Backup) { Move-Item -LiteralPath $d.Backup -Destination $d.Target }
        } elseif ($d.Change.Kind -eq 'added') {
          Remove-Item -LiteralPath $d.Change.Target -Force -ErrorAction SilentlyContinue
        } else {
          Copy-Item -LiteralPath $d.Backup -Destination $d.Change.Target -Force
        }
      } catch { Say "   не удалось вернуть $($d.Change.Rel): $($_.Exception.Message)" 'Red' }
    }
    Say "   файлы возвращены ($($done.Count))"
    if ($stopped) {
      $again = Start-AndCheck $stopped
      if ($again) { Say ("ОТКАТ ВЫПОЛНЕН, НО СЛУЖБЫ НЕ ПОДНЯЛИСЬ:`n   " + ($again -join "`n   ")) 'Red'; $script:exitCode = 3 }
      else { Say 'Откат выполнен: работает прежняя версия.' 'Yellow'; $script:exitCode = 2 }
    } else { Say 'Откат выполнен: файлы прежней версии на месте.' 'Yellow'; $script:exitCode = 2 }
    return
  }

  if ($newSha) { Set-Content -LiteralPath $versionFile -Value $newSha }
  Set-Content -LiteralPath $manifestFile -Value $newFiles

  # Старые резервные копии — только последние KeepBackups.
  Get-ChildItem -LiteralPath (Join-Path $StateDir 'backup') -Directory | Sort-Object Name -Descending |
    Select-Object -Skip ([int]$Config.KeepBackups) | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Say ''; Say "Готово: обновлено до $(if ($newSha) { $newSha.Substring(0, [Math]::Min(12, $newSha.Length)) } else { 'новой версии' })." 'Green'
}

New-Item -ItemType Directory -Force -Path $StateDir, (Join-Path $StateDir 'logs') | Out-Null
$logFile = Join-Path $StateDir ("logs\update-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
Start-Transcript -LiteralPath $logFile | Out-Null
try {
  Invoke-Update
} catch {
  Say ''; Say "ОШИБКА: $($_.Exception.Message)" 'Red'
  Say 'Ничего не изменено.' 'Yellow'
  $script:exitCode = 1
} finally {
  # Замок снимаем, только если он наш: чужой (идёт другое обновление) не трогаем.
  if ((Test-Path -LiteralPath $lock) -and ((Get-Content -LiteralPath $lock -Raw).Trim() -eq "$PID")) {
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
  }
  if ($script:work) { Remove-Item -LiteralPath $script:work -Recurse -Force -ErrorAction SilentlyContinue }
  Say "Журнал: $logFile" 'DarkGray'
  Stop-Transcript | Out-Null
}
exit $script:exitCode
