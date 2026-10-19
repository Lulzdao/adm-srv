# Установка средства удалённого доступа (UltraVNC) в составе «Искры».
#
# Запускает установщик «Искры» (installer-common.nsh) с правами администратора, а также задание
# обновления Iskra\Update от имени системы — поэтому здесь есть права завести службу, записать в
# HKLM и в брандмауэр. Своего окна не показывает, работает молча, пишет в журнал.
#
# Что делает (идемпотентно — повторный запуск при обновлении ничего лишнего не меняет):
#   * заводит службу uvnc_service из папки «Искры» (…\resources\uvnc), заменяя прежнюю из uvnc_s;
#   * пишет ultravnc.ini из шаблона: порт 5995, SecureVNC, вход по учётной записи Windows, запрос
#     сотруднику с автосогласием, значок в трее виден;
#   * задаёт случайный пароль VNC (без него сервер не отвечает), только если его ещё нет;
#   * включает SoftwareSASGeneration — Ctrl+Alt+Del без лишнего вопроса сотруднику;
#   * группа доступа (MS-Logon) и правило брандмауэра на порт 5995 — из машинной политики, если задана;
#   * после проверки, что новая служба слушает 5995, удаляет прежнюю папку uvnc_s.
#
# Настройки берутся из машинной политики C:\ProgramData\Iskra\config.json (пишут туда только
# администраторы). Ключи: vncAccessGroup (строка «ДОМЕН\группа»), vncAllowFrom (адреса/подсети через
# запятую — с них разрешить подключение), vncQueryAccept (true — спрашивать сотрудника без
# автосогласия). Настройку пользователя (Ctrl+S в клиенте) НЕ читаем.
#
# PowerShell 2.0 (Windows 7). Файл — UTF-8 с BOM.

param(
	[string]$Root = '',
	[switch]$Uninstall
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = $here }

$svc = 'uvnc_service'
$port = 5995
$oldDir = 'C:\Program Files\uvnc_s'
$programData = Join-Path $env:ProgramData 'Iskra'
$log = Join-Path $programData 'uvnc-setup.log'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'
$netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
$reg = Join-Path $env:SystemRoot 'System32\reg.exe'

function Log([string]$text) {
	try {
		if (-not (Test-Path $programData)) { New-Item -ItemType Directory -Path $programData -Force | Out-Null }
		$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
		Add-Content -LiteralPath $log -Value ("{0} {1}" -f $stamp, $text)
	} catch { }
}

function Run([string]$exe, [string]$args) {
	# Запуск без окна, ждём завершения, код возврата — в $LASTEXITCODE.
	$p = New-Object System.Diagnostics.ProcessStartInfo
	$p.FileName = $exe
	$p.Arguments = $args
	$p.UseShellExecute = $false
	$p.CreateNoWindow = $true
	$p.RedirectStandardOutput = $true
	$p.RedirectStandardError = $true
	$proc = [System.Diagnostics.Process]::Start($p)
	$out = $proc.StandardOutput.ReadToEnd()
	$proc.StandardError.ReadToEnd() | Out-Null
	$proc.WaitForExit()
	$global:LASTEXITCODE = $proc.ExitCode
	return $out
}

function Stop-Service-If-Any {
	Run $sc ('stop ' + $svc) | Out-Null
	for ($i = 0; $i -lt 10; $i++) {
		$q = Run $sc ('query ' + $svc)
		if ($q -match 'STOPPED' -or $q -notmatch 'STATE') { break }
		Start-Sleep -Milliseconds 500
	}
	# winvnc мог остаться как процесс в сеансе пользователя — снять, иначе файлы заняты.
	Get-Process winvnc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
	Start-Sleep -Milliseconds 500
}

function Policy([string]$key) {
	# Грубый разбор плоского config.json (в PS 2.0 нет ConvertFrom-Json).
	$cfg = Join-Path $programData 'config.json'
	if (-not (Test-Path $cfg)) { return '' }
	$text = [System.IO.File]::ReadAllText($cfg)
	$m = [System.Text.RegularExpressions.Regex]::Match($text, '"' + $key + '"\s*:\s*"([^"]*)"')
	if ($m.Success) { return $m.Groups[1].Value }
	$mb = [System.Text.RegularExpressions.Regex]::Match($text, '"' + $key + '"\s*:\s*(true|false)')
	if ($mb.Success) { return $mb.Groups[1].Value }
	return ''
}

# ----------------------------- удаление -----------------------------
if ($Uninstall) {
	Log 'uninstall: удаляем службу и правило'
	Stop-Service-If-Any
	$winvnc = Join-Path $Root 'winvnc.exe'
	if (Test-Path $winvnc) { Run $winvnc '-uninstall' | Out-Null }
	Run $sc ('delete ' + $svc) | Out-Null
	Run $netsh 'advfirewall firewall delete rule name="Iskra Remote Access"' | Out-Null
	Log 'uninstall: готово'
	exit 0
}

# ----------------------------- установка -----------------------------
Log ('install: Root=' + $Root)
$winvnc = Join-Path $Root 'winvnc.exe'
if (-not (Test-Path $winvnc)) { Log 'нет winvnc.exe — выходим'; exit 1 }

# 1. Остановить прежнюю службу (и из uvnc_s, и нашу) — одно имя службы на машину.
Stop-Service-If-Any

# 2. ultravnc.ini из шаблона: путь + переключатели политики. Переписываем только при отличии,
#    чтобы при обновлении зря не дёргать службу.
$iniPath = Join-Path $Root 'ultravnc.ini'
$tpl = Join-Path $Root 'ultravnc.ini.template'
if (Test-Path $tpl) {
	$ini = [System.IO.File]::ReadAllText($tpl)
	$ini = $ini.Replace('__PATH__', $Root)
	if ((Policy 'vncQueryAccept') -eq 'true') { $ini = $ini -replace '(?m)^QueryAccept=.*', 'QueryAccept=1' }
	# Сохранить уже заданный пароль из существующего ini (его нет в шаблоне).
	$pw = ''; $pw2 = ''
	if (Test-Path $iniPath) {
		$cur = [System.IO.File]::ReadAllText($iniPath)
		$mp = [System.Text.RegularExpressions.Regex]::Match($cur, '(?m)^passwd=(.*)$'); if ($mp.Success) { $pw = $mp.Groups[1].Value }
		$mp2 = [System.Text.RegularExpressions.Regex]::Match($cur, '(?m)^passwd2=(.*)$'); if ($mp2.Success) { $pw2 = $mp2.Groups[1].Value }
	}
	if ($pw -ne '') { $ini = $ini.TrimEnd() + "`r`npasswd=" + $pw + "`r`npasswd2=" + $pw2 + "`r`n" }
	$enc = New-Object System.Text.UTF8Encoding $false
	$old = ''
	if (Test-Path $iniPath) { $old = [System.IO.File]::ReadAllText($iniPath) }
	if ($old -ne $ini) { [System.IO.File]::WriteAllText($iniPath, $ini, $enc); Log 'ini записан' } else { Log 'ini без изменений' }
}

# 3. Пароль VNC — случайный, только если его ещё нет (без пароля сервер не отвечает). Для входа он
#    не нужен: вход по учётной записи Windows. Знать его сотруднику незачем.
$hasPwd = $false
if (Test-Path $iniPath) { $hasPwd = ([System.IO.File]::ReadAllText($iniPath) -match '(?m)^passwd=..') }
if (-not $hasPwd) {
	$chars = 'abcdefghijkmnpqrstuvwxyz23456789'.ToCharArray()
	$rng = New-Object byte[] 8
	(New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($rng)
	$pass = ''
	foreach ($b in $rng) { $pass += $chars[$b % $chars.Length] }
	$setpasswd = Join-Path $Root 'setpasswd.exe'
	if (Test-Path $setpasswd) {
		Push-Location $Root
		Run $setpasswd ($pass + ' ' + $pass) | Out-Null
		Pop-Location
		Log 'пароль VNC задан'
	}
}

# 4. Ctrl+Alt+Del без лишнего окна: разрешить программный ввод SAS.
Run $reg 'add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v SoftwareSASGeneration /t REG_DWORD /d 1 /f' | Out-Null

# 5. Группа доступа (MS-Logon), если задана политикой.
$group = Policy 'vncAccessGroup'
if ($group -ne '') {
	$aclFile = Join-Path $Root 'access.acl'
	[System.IO.File]::WriteAllText($aclFile, "allow`t0x00000003`t" + $group + "`r`n", (New-Object System.Text.ASCIIEncoding))
	$mslogon = Join-Path $Root 'MSLogonACL.exe'
	if (Test-Path $mslogon) { Run $mslogon ('/i /o "' + $aclFile + '"') | Out-Null; Log ('группа доступа: ' + $group) }
}

# 6. Служба из папки «Искры».
Run $winvnc '-install' | Out-Null
Start-Sleep -Milliseconds 500
Run $sc ('config ' + $svc + ' start= auto') | Out-Null
Run $sc ('start ' + $svc) | Out-Null

# 7. Правило брандмауэра на порт 5995 (при политике vncAllowFrom — только с этих адресов).
Run $netsh 'advfirewall firewall delete rule name="Iskra Remote Access"' | Out-Null
$allow = Policy 'vncAllowFrom'
$ruleArgs = 'advfirewall firewall add rule name="Iskra Remote Access" dir=in action=allow protocol=TCP localport=' + $port + ' profile=any'
if ($allow -ne '') { $ruleArgs += ' remoteip=' + $allow }
Run $netsh $ruleArgs | Out-Null

# 8. Проверить, что новая служба слушает 5995, и только тогда убрать прежнюю папку uvnc_s.
$listens = $false
for ($i = 0; $i -lt 12; $i++) {
	Start-Sleep -Milliseconds 800
	$ns = Run (Join-Path $env:SystemRoot 'System32\netstat.exe') '-an'
	if ($ns -match ('TCP\s+\S*:' + $port + '\s')) { $listens = $true; break }
}
Log ('служба слушает ' + $port + ': ' + $listens)
if ($listens -and (Test-Path $oldDir)) {
	$running = Run $sc ('qc ' + $svc)
	if ($running -match 'iskra-desktop') {
		try { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction Stop; Log 'прежняя папка uvnc_s удалена' }
		catch { Log ('не удалось удалить uvnc_s: ' + $_.Exception.Message) }
	}
}
Log 'install: готово'
exit 0
