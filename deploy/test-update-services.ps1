<#
.SYNOPSIS
  Проверка update.ps1 на НАСТОЯЩИХ службах NSSM — то, чего не может test-update.ps1.

.DESCRIPTION
  Поднимает во временной папке копию установки с кода main и четыре службы NSSM
  (платформа, Сертвивер, журнал звонков, «Искра») с тестовыми именами TST-Adm-* и
  портами 4000/4101/4102/4103 — рабочим экземплярам на 3000-3103 не мешает. Затем:
    1. службы находятся по каталогам, хотя имена не из DEPLOY.md;
    2. обновление, меняющее платформу и «Искру», перезапускает ровно их, а Сертвивер
       и журнал звонков продолжают работать тем же процессом;
    2б. правка только клиента «Искры» (desktop-client) не перезапускает ни одной службы;
    3. сломанная версия платформы не поднимается — откат, платформа снова отвечает.
  Стенд и службы удаляются в конце в любом случае.

  Нужно: права администратора, git, python, интернет (npm ci), nssm.exe и Node той же
  версии, что на сервере (22) — так проверка ближе всего к нему. (Пока «Искра» в
  main была на better-sqlite3 11, на Node 24 она падала сама — «Assertion failed:
  (env) != nullptr» при сборке мусора.) Переносной Node 22: nodejs.org/dist/latest-v22.x.

      powershell -ExecutionPolicy Bypass -File deploy\test-update-services.ps1 `
          -Nssm C:\tools\nssm.exe -NodeDir C:\tools\node-v22-win-x64
#>
param(
  [Parameter(Mandatory)] [string]$Nssm,
  [Parameter(Mandatory)] [string]$NodeDir
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$sp = $PSScriptRoot
$T = Join-Path $env:TEMP 'adm-srv-svctest'
$root = Join-Path $T 'IT-services'
$nodeDir = $NodeDir
$node = Join-Path $nodeDir 'node.exe'
$fails = 0
function Check([bool]$ok, [string]$what) {
  if ($ok) { Write-Host "  OK    $what" -ForegroundColor Green } else { Write-Host "  FAIL  $what" -ForegroundColor Red; $script:fails++ }
}
function SvcPid([string]$name) { (Get-CimInstance Win32_Service -Filter "Name='$name'").ProcessId }
# Процесс node у службы — потомок nssm.exe; его PID меняется при каждом перезапуске приложения.
function AppPid([string]$name) {
  $p = SvcPid $name
  (Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | Where-Object Name -eq 'node.exe' | Select-Object -First 1).ProcessId
}
function Listening([int]$port) { [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) }
function Wait-Port([int]$port) { for ($i = 0; $i -lt 30; $i++) { if (Listening $port) { return $true }; Start-Sleep 1 }; return $false }

$services = @(
  @{ Name = 'TST-Adm-Platform';  Dir = 'helpdesk-backend'; Args = '--use-system-ca server.js'; Port = 4000 },
  @{ Name = 'TST-Adm-CertView';  Dir = 'CERTVIEWER';       Args = 'server.js';                 Port = 4101 },
  @{ Name = 'TST-Adm-SmdrWeb';   Dir = 'SMDR\web-node';    Args = 'server.js';                 Port = 4102 },
  @{ Name = 'TST-Adm-Iskra';     Dir = 'MESSENGER';        Args = 'server.js';                 Port = 4103 }
)

function Remove-Stand {
  foreach ($s in $services) {
    if (Get-Service $s.Name -ErrorAction SilentlyContinue) {
      & $Nssm stop $s.Name 2>&1 | Out-Null
      & $Nssm remove $s.Name confirm 2>&1 | Out-Null
    }
  }
  Start-Sleep 2
  if (Test-Path $T) { Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue }
}

try {
  Remove-Stand
  New-Item -ItemType Directory -Force -Path $T, (Join-Path $T 'logs') | Out-Null

  # --- Установка «сервера» на коде main ----------------------------------------
  $zipOld = Join-Path $T 'old.zip'
  $sha = (& git -C $repo rev-parse main).Trim()
  & git -C $repo archive --format=zip --prefix=adm-srv-main/ -o $zipOld $sha
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zipOld, $T)
  Rename-Item (Join-Path $T 'adm-srv-main') 'IT-services'
  foreach ($d in 'helpdesk-backend', 'CERTVIEWER', 'SMDR\web-node', 'MESSENGER') {
    # Зависимости ставит npm из Node 22 — как на сервере: нативные модули соберутся под его версию.
    Push-Location (Join-Path $root $d)
    $env:Path = "$nodeDir;$env:Path"
    cmd /c "npm ci --omit=dev --no-audit --no-fund >nul 2>&1"
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "npm ci в $d не удался" }
  }
  Write-Host "Node для служб: $(& $node -v)"
  (Get-Content "$repo\helpdesk-backend\.env") -replace '^PORT=.*', 'PORT=4000' | Set-Content "$root\helpdesk-backend\.env" -Encoding UTF8
  (Get-Content "$repo\CERTVIEWER\.env") -replace '^PORT=.*', 'PORT=4101' | Set-Content "$root\CERTVIEWER\.env" -Encoding UTF8
  Set-Content "$root\SMDR\web-node\.env" 'PORT=4102' -Encoding UTF8
  Copy-Item "$repo\SMDR\smdr.db" "$root\SMDR\smdr.db"
  Copy-Item "$repo\MESSENGER\bootstrap-admin.js" "$root\MESSENGER\bootstrap-admin.js"
  $cfg = Join-Path $T 'update.config.psd1'
  Set-Content $cfg "@{ InstallRoot = '$root'; Ports = @{ MESSENGER = 4103 } }" -Encoding UTF8

  foreach ($s in $services) {
    & $Nssm install $s.Name $node $s.Args | Out-Null
    & $Nssm set $s.Name AppDirectory (Join-Path $root $s.Dir) | Out-Null
    & $Nssm set $s.Name AppStdout (Join-Path $T "logs\$($s.Name).out.log") | Out-Null
    & $Nssm set $s.Name AppStderr (Join-Path $T "logs\$($s.Name).err.log") | Out-Null
    & $Nssm set $s.Name Start SERVICE_DEMAND_START | Out-Null
    if ($s.Name -eq 'TST-Adm-Iskra') { & $Nssm set $s.Name AppEnvironmentExtra 'PORT=4103' | Out-Null }
    & $Nssm start $s.Name | Out-Null
  }
  Write-Host "`nСтенд: $root"
  foreach ($s in $services) { Check (Wait-Port $s.Port) "служба $($s.Name) поднялась на $($s.Port)" }

  # Службы другой установки на этой машине (например, рабочая копия сервера ITS-*) — стенд их
  # трогать не должен. Раньше update.ps1 выбирал для компонента первую найденную службу и
  # обновлял файлы и перезапускал службы рабочей копии вместо тестовых.
  $foreign = @{}
  foreach ($svc in Get-CimInstance Win32_Service | Where-Object { $_.Name -notlike 'TST-Adm-*' -and $_.State -eq 'Running' }) {
    $params = "HKLM:\SYSTEM\CurrentControlSet\Services\$($svc.Name)\Parameters"
    if ((Test-Path $params) -and (Get-Item $params).GetValue('AppDirectory')) { $foreign[$svc.Name] = AppPid $svc.Name }
  }
  if ($foreign.Count) { Write-Host "   другие службы NSSM на машине: $($foreign.Keys -join ', ')" }

  $update = Join-Path $repo 'deploy\update.ps1'
  function Run([string]$zip, [string[]]$extra = @()) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $update, '-ConfigPath', $cfg, '-SourceZip', $zip, '-Yes') + $extra
    $out = & powershell.exe @a 2>&1 | Out-String
    [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
  }

  # --- 1. Базовый запуск: службы найдены по каталогам, обновлять нечего --------
  Write-Host "`n1. Первый запуск"
  $r = Run $zipOld @('-CheckOnly')
  foreach ($s in $services) { Check ($r.Out -match [regex]::Escape($s.Name)) "служба $($s.Name) найдена (имя не из DEPLOY.md)" }
  $r = Run $zipOld
  Check ($r.Code -eq 0 -and $r.Out -match 'Уже установлена актуальная версия') 'актуальная версия, ничего не делается'

  # --- 2. Обновление платформы и «Искры» ---------------------------------------
  Write-Host "`n2. Обновление: меняются платформа и «Искра»"
  $src = Join-Path $T 'src'; [IO.Compression.ZipFile]::ExtractToDirectory($zipOld, $src)
  $zipGood = Join-Path $T 'good.zip'
  & python "$sp\make_test_zip.py" "$src\adm-srv-main" $zipGood 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' `
      'helpdesk-backend/server.js=+// проверка обновления' 'MESSENGER/server.js=+// проверка обновления' | Out-Null
  $before = @{}; foreach ($s in $services) { $before[$s.Name] = AppPid $s.Name }
  $r = Run $zipGood
  Check ($r.Code -eq 0) "код выхода 0 (получен $($r.Code))"
  if ($r.Code -ne 0) { Write-Host $r.Out }
  Check ($r.Out -match 'будут перезапущены: TST-Adm-Platform, TST-Adm-Iskra|будут перезапущены: TST-Adm-Iskra, TST-Adm-Platform') 'в плане перезапуска ровно платформа и «Искра»'
  Check ((AppPid 'TST-Adm-Platform') -ne $before['TST-Adm-Platform']) 'платформа перезапущена'
  Check ((AppPid 'TST-Adm-Iskra') -ne $before['TST-Adm-Iskra']) '«Искра» перезапущена'
  Check ((AppPid 'TST-Adm-CertView') -eq $before['TST-Adm-CertView']) 'Сертвивер не тронут (тот же процесс)'
  Check ((AppPid 'TST-Adm-SmdrWeb') -eq $before['TST-Adm-SmdrWeb']) 'журнал звонков не тронут (тот же процесс)'
  foreach ($s in $services) { Check (Listening $s.Port) "$($s.Name) слушает $($s.Port)" }
  Check ([IO.File]::ReadAllText("$root\helpdesk-backend\server.js", [Text.Encoding]::UTF8) -match 'проверка обновления') 'файл платформы новый'
  $health = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4000/api/health).Content
  Check ($health -match '"ok":true') "платформа отвечает: $health"

  # --- 2б. Изменился только клиент «Искры» — служба не перезапускается ---------
  Write-Host "`n2б. Изменился только клиент «Искры» (desktop-client)"
  $zipClient = Join-Path $T 'client.zip'
  & python "$sp\make_test_zip.py" "$src\adm-srv-main" $zipClient 'cccccccccccccccccccccccccccccccccccccccc' `
      'helpdesk-backend/server.js=+// проверка обновления' 'MESSENGER/server.js=+// проверка обновления' `
      'MESSENGER/desktop-client/main.js=+// правка только клиента' | Out-Null
  $before = @{}; foreach ($s in $services) { $before[$s.Name] = AppPid $s.Name }
  $r = Run $zipClient
  Check ($r.Code -eq 0) "код выхода 0 (получен $($r.Code))"
  if ($r.Code -ne 0) { Write-Host $r.Out }
  Check ($r.Out -notmatch 'будут перезапущены') 'в плане перезапуска нет ни одной службы'
  Check ((AppPid 'TST-Adm-Iskra') -eq $before['TST-Adm-Iskra']) '«Искра» не перезапущена (тот же процесс)'
  Check ([IO.File]::ReadAllText("$root\MESSENGER\desktop-client\main.js", [Text.Encoding]::UTF8) -match 'правка только клиента') 'файл клиента обновлён'

  # --- 3. Сломанная версия: платформа не поднимается -> откат ------------------
  Write-Host "`n3. Сломанная версия платформы — откат"
  $zipBad = Join-Path $T 'bad.zip'
  & python "$sp\make_test_zip.py" "$src\adm-srv-main" $zipBad 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' `
      'helpdesk-backend/server.js=!throw new Error("broken build for rollback test");' | Out-Null
  $r = Run $zipBad
  Check ($r.Code -eq 2) "код выхода 2 — откат (получен $($r.Code))"
  if ($r.Code -ne 2) { Write-Host $r.Out }
  Check ($r.Out -match 'Откат выполнен: работает прежняя версия') 'в выводе — откат выполнен'
  Check ([IO.File]::ReadAllText("$root\helpdesk-backend\server.js", [Text.Encoding]::UTF8) -match 'проверка обновления') 'файл платформы вернулся к рабочей версии'
  Check (Wait-Port 4000) 'платформа снова слушает 4000'
  $health = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4000/api/health).Content
  Check ($health -match '"ok":true') "платформа снова отвечает: $health"
  Check ((Get-Content "$root\.update\version.txt" -Raw).Trim() -eq 'cccccccccccccccccccccccccccccccccccccccc') 'версия осталась прежней'

  foreach ($name in $foreign.Keys) {
    Check ((AppPid $name) -eq $foreign[$name]) "служба другой установки $name не перезапускалась"
  }
  if ($foreign.Count) { Check ($r.Out -match 'другая установка') 'в выводе update.ps1 — «другая установка, не трогаю»' }
} finally {
  foreach ($s in $services) {
    $err = Join-Path $T "logs\$($s.Name).err.log"
    if ((Test-Path $err) -and (Get-Item $err).Length) {
      Write-Host "`n--- $($s.Name).err.log (хвост) ---" -ForegroundColor DarkYellow
      Get-Content $err -Tail 25 | ForEach-Object { Write-Host "   $_" }
    }
  }
  Write-Host "`nУборка стенда"
  Remove-Stand
  Check (-not (Get-Service 'TST-Adm-*' -ErrorAction SilentlyContinue)) 'тестовые службы удалены'
  Check (-not (Test-Path $T)) 'стенд удалён'
}
if ($fails) { Write-Host "`nПровалено: $fails" -ForegroundColor Red; exit 1 }
Write-Host "`nВсе проверки на службах пройдены." -ForegroundColor Green
