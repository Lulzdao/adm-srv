# Обновление «Искры» от имени системы — то, что запускает задание планировщика Iskra\Update
# (заводит его установщик, см. register-tasks.ps1).
#
# Порядок:
#   1. Сама «Искра» в режиме без окон (updater.js) узнаёт у сервера выложенную версию и, если она
#      новее установленной, скачивает установщик и сверяет контрольную сумму. В обычный день на
#      этом всё и кончается — за секунду.
#   2. Когда тот процесс вышел, отсюда запускается установщик. Именно отсюда, а не из updater.js:
#      установщик закрывает работающую «Искру», а updater.js — это тот же .exe.
#   3. Установка прошла — заданием Iskra\Relaunch «Искра» открывается у вошедшего сотрудника снова.
#
# Сценарий умеет только это. Что и откуда ставить, решает updater.js (там же — про безопасность);
# здесь проверяется лишь, что установщик лежит там, куда его положил updater.js.
#
# Журнал — C:\ProgramData\Iskra\updater.log (общий с updater.js).
#
# Написан под PowerShell 2.0 (Windows 7). Файл — в UTF-8 с меткой BOM.

param(
	# Папка установки и папка заданий — другие только для проверки на машине разработчика.
	[string]$Root = '',
	[string]$TaskFolder = 'Iskra'
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $here) }

$programData = $env:ProgramData
if (-not $programData) { $programData = 'C:\ProgramData' }
$log = Join-Path $programData 'Iskra\updater.log'
function Write-Log([string]$text) {
	try {
		$dir = Split-Path -Parent $log
		if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
		Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $text)
	} catch { }
}

# Сама программа — самый большой .exe в папке установки. Имя у неё кириллическое, по имени не ищем.
$exe = @(Get-ChildItem -LiteralPath $Root -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object Length -Descending)[0]
$updater = Join-Path $Root 'resources\app.asar\updater.js'

# --- 0. починка: самой программы нет ---
# «Искра» лишилась своего exe (или app.asar): установщик сняли посреди работы (так ломалось до 1.1.32
# при выключении ПК), файл унёс антивирус и т. п. Шаг 1 тогда невозможен — узнать о версии и скачать
# её умеет только сама программа (updater.js), — и задание при каждом запуске писало «no program exe»
# и выходило: такой ПК без человека не чинился никогда (найдено 2026-10-26 на Win7-ВМ). Здесь то же,
# что делает updater.js, средствами PowerShell 2.0: latest.yml с сервера, установщик в закрытую папку,
# сверка sha512 — и дальше обычная установка (шаг 2). Версию не сравниваем: ставим ту, что выложена.
# TLS — средствами .NET 3.5 и хранилищем корней Windows: на Windows 7 с обновлениями это TLS 1.2
# (проверено на ВМ); где их нет, скачать не выйдет — причина будет в журнале.
# Откуда качать — как у updater.js: сборка и адрес из resources\app-update.yml (его кладёт
# electron-builder, и он переживает такую поломку), адрес из машинной политики важнее.
function Get-RepairInstaller {
	$yml = Join-Path $Root 'resources\app-update.yml'
	$url = ''
	if (Test-Path -LiteralPath $yml) {
		$m = [regex]::Match([IO.File]::ReadAllText($yml), '(?m)^url:\s*[''"]?([^''"\r\n]+?)[''"]?\s*$')
		if ($m.Success) { $url = $m.Groups[1].Value }
	}
	$tm = [regex]::Match($url, '/updates/(win7|win10)/?$')
	if (-not $tm.Success) { Write-Log "repair: no update source in $yml"; return $null }
	$track = $tm.Groups[1].Value
	$server = $url.Substring(0, $tm.Index)
	$cfg = Join-Path $programData 'Iskra\config.json'
	if (Test-Path -LiteralPath $cfg) {
		$pm = [regex]::Match([IO.File]::ReadAllText($cfg), '"serverUrl"\s*:\s*"([^"]+)"')
		if ($pm.Success) { $server = $pm.Groups[1].Value.TrimEnd('/') }
	}
	if ($server -notmatch '^https://') { Write-Log "repair: server address is not https: $server"; return $null }
	$base = "$server/updates/$track"
	$wc = New-Object Net.WebClient
	$wc.Headers.Add('X-Iskra-Host', $env:COMPUTERNAME)
	try { $text = $wc.DownloadString("$base/latest.yml") }
	catch { Write-Log ("repair: latest.yml not downloaded from {0}: {1}" -f $base, $_.Exception.Message); return $null }
	$v = [regex]::Match($text, '(?m)^version:\s*[''"]?(\d+\.\d+\.\d+)')
	$f = [regex]::Match($text, '(?m)^path:\s*[''"]?([A-Za-z0-9][A-Za-z0-9._-]*\.exe)')
	$h = [regex]::Match($text, '(?m)^sha512:\s*[''"]?([A-Za-z0-9+/]{86}==)')
	if (-not ($v.Success -and $f.Success -and $h.Success)) { Write-Log "repair: latest.yml from $base not understood"; return $null }
	# Папка — та же, что у updater.js (шаг 2 проверяет путь): закрыта для всех, кроме системы и администраторов.
	$dir = Join-Path $env:SystemRoot ('Temp\iskra-update-' + [guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $dir -Force | Out-Null
	& (Join-Path $env:SystemRoot 'System32\icacls.exe') $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
	if ($LASTEXITCODE -ne 0) { Write-Log "repair: could not lock $dir"; Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue; return $null }
	$file = Join-Path $dir $f.Groups[1].Value
	try {
		$wc.DownloadFile("$base/" + $f.Groups[1].Value, $file)
		$stream = [IO.File]::OpenRead($file)
		try { $got = [Convert]::ToBase64String((New-Object Security.Cryptography.SHA512Managed).ComputeHash($stream)) } finally { $stream.Close() }
		if ($got -ne $h.Groups[1].Value) { throw 'sha512 does not match latest.yml' }
	} catch {
		Write-Log ("repair: installer not downloaded: {0}" -f $_.Exception.Message)
		Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
		return $null
	}
	# Та же строка, что у updater.js: панель «Клиенты» (updater-status.js) покажет «скачано».
	Write-Log ("download ok: missing -> {0}, {1} (repair: program files were missing)" -f $v.Groups[1].Value, $f.Groups[1].Value)
	return @{ update = '1'; installer = $file; dir = $dir; version = $v.Groups[1].Value }
}

$broken = (-not $exe) -or (-not (Test-Path -LiteralPath (Join-Path $Root 'resources\app.asar')))
if ($broken) {
	Write-Log "no program exe in $Root - repairing"
	$info = Get-RepairInstaller
	if (-not $info) { exit 1 }
} else {

# --- 1. узнать и скачать ---
# Через Start-Process с ожиданием и выводом в файл, а не «& программа»: «Искра» — оконная программа,
# и при вызове через & PowerShell её не дожидается и вывода не получает (проверено 2026-10-15 —
# 0 строк, код выхода пустой). Из-за этого задание до 1.0.30 скачивало установщик, но не ставило
# ни разу: сценарий решал «ставить нечего» и выходил. Start-Process есть и в PowerShell 2.0.
# -NoNewWindow, а не -WindowStyle Hidden: в PowerShell 2.0 (Windows 7) -WindowStyle вместе с
# -RedirectStandardOutput не принимается («Parameter set cannot be resolved»), и в 1.0.30 задание
# на всех Windows 7 падало, не начав (проверено 2026-10-21 через powershell -Version 2). Окна и так
# нет: задание работает от имени системы, а программа запущена как node (ELECTRON_RUN_AS_NODE).
$out = Join-Path $env:SystemRoot ('Temp\iskra-update-out-' + [guid]::NewGuid().ToString('N') + '.txt')
$lines = @()
$prepareCode = -1
$started = $false
$env:ELECTRON_RUN_AS_NODE = '1'
try {
	$p = Start-Process -FilePath $exe.FullName -ArgumentList ('"' + $updater + '"') -RedirectStandardOutput $out -Wait -PassThru -NoNewWindow
	$started = $true
	$prepareCode = $p.ExitCode
	$lines = @(Get-Content -LiteralPath $out -ErrorAction SilentlyContinue)
} catch {
	Write-Log ("could not start updater: {0}" -f $_.Exception.Message)
}
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue

$info = @{}
foreach ($line in $lines) {
	$text = [string]$line
	$at = $text.IndexOf('=')
	if ($at -gt 0) { $info[$text.Substring(0, $at)] = $text.Substring($at + 1) }
}
# Ответа нет вовсе — это не «ставить нечего», а сбой: пишем, иначе снова ничего не узнать.
# Не запустилась вовсе — причина уже в журнале строкой выше; вторая строка её бы заслонила
# в панели «Клиенты» (там видна последняя значимая строка).
if ($started -and -not $info.ContainsKey('update')) { Write-Log ("updater gave no answer, exit code {0}" -f $prepareCode) }
if ($info['update'] -ne '1') { exit $prepareCode }
} # конец шага 1 (при починке он пропущен — см. шаг 0)

$installer = $info['installer']
$dir = $info['dir']
$version = $info['version']

# Установщик обязан лежать в папке, которую создал updater.js: <Windows>\Temp\iskra-update-…
# Любой другой путь — не то, что мы скачивали; не запускаем.
$expected = (Join-Path $env:SystemRoot 'Temp\iskra-update-').ToLower()
$ok = $installer -and $dir -and $dir.ToLower().StartsWith($expected) -and
	((Split-Path -Parent $installer).ToLower() -eq $dir.ToLower()) -and
	($installer.ToLower().EndsWith('.exe')) -and (Test-Path -LiteralPath $installer)
if (-not $ok) { Write-Log "refused: unexpected installer path '$installer'"; exit 1 }

# --- 2. поставить ---
# /S — без окон; --updated — «это обновление»: установщик не трогает ярлыки, которые человек убрал.
# Без --force-run: запущенная отсюда «Искра» работала бы от имени системы, а не сотрудника.
$code = -1
try {
	$p = Start-Process -FilePath $installer -ArgumentList '/S', '--updated' -Wait -PassThru
	$code = $p.ExitCode
} catch {
	Write-Log ("install {0}: could not start installer: {1}" -f $version, $_.Exception.Message)
}
Write-Log ("install {0}: exit code {1}" -f $version, $code)
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue

# --- 3. вернуть «Искру» сотруднику ---
# И при неудаче тоже: установщик мог успеть закрыть работающую программу.
$schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'
$out = & $schtasks /Run /TN "$TaskFolder\Relaunch" 2>&1
if ($LASTEXITCODE -ne 0) { Write-Log ("relaunch: schtasks exit code {0}: {1}" -f $LASTEXITCODE, ($out -join ' ')) }

if ($code -eq 0) { exit 0 }
exit 1
