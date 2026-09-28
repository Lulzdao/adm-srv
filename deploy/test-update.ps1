<#
.SYNOPSIS
  Проверка update.ps1 на копии «сервера» во временной папке.

.DESCRIPTION
  Запускать на машине разработчика из корня репозитория (нужны git и интернет —
  зависимости журнала звонков пересобираются по-настоящему):

      powershell -ExecutionPolicy Bypass -File deploy\test-update.ps1

  Службы не трогаются (-SkipServices): их остановку и запуск проверить можно только
  на сервере. Проверяется всё остальное: сравнение версий, замена и удаление файлов,
  неприкосновенность данных и настроек, пересборка node_modules, резервная копия,
  откат при сбое, повторный запуск.

  -Old — с какого коммита «сервер» стартует (по умолчанию первый коммит adm-srv).
#>
param([string]$Old = '3441f96')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$repo = Split-Path -Parent $PSScriptRoot
$update = Join-Path $PSScriptRoot 'update.ps1'
$T = Join-Path $env:TEMP ("adm-srv-updtest-{0}" -f $PID)
$failures = 0

function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Host "  OK    $what" -ForegroundColor Green }
  else { Write-Host "  FAIL  $what" -ForegroundColor Red; $script:failures++ }
}
function Run-Update([string]$zip, [string[]]$extra = @()) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $update, '-ConfigPath', $cfg,
               '-SourceZip', $zip, '-Yes', '-SkipServices') + $extra
  $out = & powershell.exe @argList 2>&1 | Out-String
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}
function Text([string]$rel) { [IO.File]::ReadAllText((Join-Path $T $rel)) }

try {
  New-Item -ItemType Directory -Force -Path $T | Out-Null
  $root = Join-Path $T 'IT-services'
  $cfg = Join-Path $T 'update.config.psd1'
  Set-Content -LiteralPath $cfg -Value "@{ InstallRoot = '$root' }" -Encoding UTF8

  $oldSha = (& git -C $repo rev-parse $Old).Trim()
  $newSha = (& git -C $repo rev-parse HEAD).Trim()
  $zipOld = Join-Path $T 'old.zip'; $zipNew = Join-Path $T 'new.zip'
  & git -C $repo archive --format=zip --prefix=adm-srv-main/ -o $zipOld $oldSha
  & git -C $repo archive --format=zip --prefix=adm-srv-main/ -o $zipNew $newSha
  Write-Host "Старая версия $($oldSha.Substring(0,7)), новая $($newSha.Substring(0,7)); стенд: $root"

  # --- «Сервер» на старой версии, с данными и настройками --------------------
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zipOld, $T)
  Rename-Item -LiteralPath (Join-Path $T 'adm-srv-main') -NewName 'IT-services'
  # Эталон новой версии — прямо из архива, чтобы сравнивать байт в байт.
  [IO.Compression.ZipFile]::ExtractToDirectory($zipNew, (Join-Path $T 'expected'))
  $data = @{
    'helpdesk-backend\.env'            = "PORT=3000`nSESSION_SECRET=настоящий-секрет"
    'helpdesk-backend\data\helpdesk.db' = 'БАЗА ЗАЯВОК'
    'helpdesk-backend\uploads\tickets\1\файл.pdf' = 'ВЛОЖЕНИЕ'
    'MESSENGER\bootstrap-admin.js'     = "module.exports = { username: 'admin', password: 'x' };"
    'MESSENGER\messenger.db'           = 'БАЗА ИСКРЫ'
    'MESSENGER\certs\server.pfx'       = 'СЕРТИФИКАТ'
    'SMDR\smdr.db'                     = 'БАЗА ЗВОНКОВ'
    'SMDR\.env'                        = 'SMDR_PASSWORD=секрет'
    'SMDR\collector-2026-09.log'       = 'ЖУРНАЛ'
  }
  foreach ($k in $data.Keys) {
    $p = Join-Path $root $k
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
    [IO.File]::WriteAllText($p, $data[$k])
  }
  foreach ($d in 'helpdesk-backend', 'CERTVIEWER', 'SMDR\web-node', 'MESSENGER') {
    New-Item -ItemType Directory -Force -Path (Join-Path $root "$d\node_modules\метка") | Out-Null
  }
  # Файл, скопированный когда-то из git на Windows: тот же, но с CRLF — не «изменение».
  $crlf = Join-Path $root 'CERTVIEWER\mchd.js'
  [IO.File]::WriteAllText($crlf, ([IO.File]::ReadAllText($crlf) -replace "`r?`n", "`r`n"))

  # --- 1. Первый запуск на той же версии: только запомнить, что стоит ----------
  Write-Host "`n1. Первый запуск на установленной версии"
  $r = Run-Update $zipOld
  Check ($r.Code -eq 0) "код выхода 0 (получен $($r.Code))"
  Check ($r.Out -match 'Уже установлена актуальная версия') 'CRLF не считается изменением, обновлять нечего'
  Check ((Get-Content (Join-Path $root '.update\version.txt') -Raw).Trim() -eq $oldSha) 'версия запомнена'

  # Файл прошлой версии, которого в новой нет, — должен удалиться (по манифесту).
  $obsolete = 'helpdesk-backend\obsolete.js'
  [IO.File]::WriteAllText((Join-Path $root $obsolete), 'старый файл')
  Add-Content -LiteralPath (Join-Path $root '.update\manifest.txt') -Value $obsolete

  $snapshot = @{}
  foreach ($k in $data.Keys) { $snapshot[$k] = Text "IT-services\$k" }
  $ticketsOld = Text 'IT-services\helpdesk-backend\routes\tickets.js'

  # --- 2. Сбой посреди обновления: всё должно вернуться -----------------------
  Write-Host "`n2. Сбой после замены файлов — откат"
  $r = Run-Update $zipNew @('-TestFailAfterCopy')
  Check ($r.Code -eq 2) "код выхода 2 — откат (получен $($r.Code))"
  Check ((Text 'IT-services\helpdesk-backend\routes\tickets.js') -eq $ticketsOld) 'изменённый файл вернулся к прежнему'
  Check (Test-Path (Join-Path $root $obsolete)) 'удалённый файл вернулся'
  Check (-not (Test-Path (Join-Path $root 'MESSENGER\test\files.test.js'))) 'добавленный файл убран'
  Check (Test-Path (Join-Path $root 'SMDR\web-node\node_modules\метка')) 'прежние node_modules на месте'
  Check ((Get-Content (Join-Path $root '.update\version.txt') -Raw).Trim() -eq $oldSha) 'версия осталась прежней'

  # --- 3. Обычное обновление --------------------------------------------------
  Write-Host "`n3. Обновление до новой версии"
  $r = Run-Update $zipNew
  Check ($r.Code -eq 0) "код выхода 0 (получен $($r.Code))"
  if ($r.Code -ne 0) { Write-Host $r.Out }
  Check ((Text 'IT-services\helpdesk-backend\routes\tickets.js') -eq (Text 'expected\adm-srv-main\helpdesk-backend\routes\tickets.js')) 'файл заменён новой версией'
  Check (-not (Test-Path (Join-Path $root $obsolete))) 'файл, которого нет в новой версии, удалён'
  Check (Test-Path (Join-Path $root 'MESSENGER\test\files.test.js')) 'новый файл добавлен'
  Check (Test-Path (Join-Path $root 'deploy\update.ps1')) 'скрипт обновления приехал вместе с версией'
  $untouched = $true
  foreach ($k in $data.Keys) { if ((Text "IT-services\$k") -ne $snapshot[$k]) { $untouched = $false; Write-Host "     изменён: $k" } }
  Check $untouched 'настройки, базы, вложения, сертификат, журнал — не тронуты'
  Check ((Get-Content (Join-Path $root 'CERTVIEWER\mchd.js') -Raw) -match "`r`n") 'неизменный файл с CRLF не переписан'
  Check (Test-Path (Join-Path $root 'SMDR\web-node\node_modules\express')) 'зависимости журнала звонков пересобраны'
  Check (Test-Path (Join-Path $root 'helpdesk-backend\node_modules\метка')) 'node_modules без изменений зависимостей не тронуты'
  Check ((Get-Content (Join-Path $root '.update\version.txt') -Raw).Trim() -eq $newSha) 'версия обновлена'
  $bk = @(Get-ChildItem (Join-Path $root '.update\backup') -Directory)
  Check ($bk.Count -ge 1 -and (Test-Path (Join-Path $bk[-1].FullName "files\$obsolete"))) 'удалённый файл лежит в резервной копии'

  # --- 4. Повторный запуск -----------------------------------------------------
  Write-Host "`n4. Повторный запуск"
  $r = Run-Update $zipNew
  Check ($r.Code -eq 0 -and $r.Out -match 'Уже установлена актуальная версия') 'обновлять нечего'

  # --- 5. Только проверка ------------------------------------------------------
  Write-Host "`n5. -CheckOnly ничего не меняет"
  [IO.File]::WriteAllText((Join-Path $root 'helpdesk-backend\app.js'), 'правка на сервере')
  $r = Run-Update $zipNew @('-CheckOnly')
  Check ($r.Out -match 'helpdesk-backend\\app\.js' -and (Text 'IT-services\helpdesk-backend\app.js') -eq 'правка на сервере') 'план показан, файл не тронут'
} finally {
  Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures) { Write-Host "Провалено проверок: $failures" -ForegroundColor Red; exit 1 }
Write-Host 'Все проверки пройдены.' -ForegroundColor Green
