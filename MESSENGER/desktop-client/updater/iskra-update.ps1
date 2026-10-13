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
if (-not $exe) { Write-Log "no program exe in $Root"; exit 1 }

# --- 1. узнать и скачать ---
$env:ELECTRON_RUN_AS_NODE = '1'
$lines = @(& $exe.FullName $updater 2>$null)
$prepareCode = $LASTEXITCODE
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$info = @{}
foreach ($line in $lines) {
	$text = [string]$line
	$at = $text.IndexOf('=')
	if ($at -gt 0) { $info[$text.Substring(0, $at)] = $text.Substring($at + 1) }
}
if ($info['update'] -ne '1') { exit $prepareCode }

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
