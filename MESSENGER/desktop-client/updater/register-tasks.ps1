# Заводит два задания планировщика Windows для обновления «Искры» без прав сотрудника.
# Запускает установщик (installer-common.nsh) — в этот момент права администратора у него есть.
#
#   Iskra\Update     от имени СИСТЕМЫ, каждый день в 8:30 и в 13:00: проверяет, не вышла ли версия
#                    новее, и ставит её (iskra-update.ps1). Если компьютер в это время был выключен —
#                    выполняется при первой возможности. Начало сдвигается на случайное время до
#                    25 минут, чтобы все компьютеры не пошли на сервер за установщиком в одну секунду.
#   Iskra\Relaunch   от имени вошедшего пользователя, без расписания: открывает «Искру» обратно
#                    после установки. Системное задание работает в служебном сеансе без рабочего
#                    стола и само показать окно сотруднику не может.
#
# Задание Update разрешено ЗАПУСКАТЬ обычным пользователям (не менять): так клиент сотрудника без
# прав может начать обновление по команде из панели, не дожидаясь расписания. Запустить его — значит
# лишь проверить версию на сервере раньше времени; ничего другого задание не умеет.
#
# Написан под PowerShell 2.0 (Windows 7). Файл — в UTF-8 с меткой BOM.

param(
	# Папка заданий в планировщике. Другая — только для проверки на машине разработчика.
	[string]$TaskFolder = 'Iskra',
	# Папка установки. По умолчанию — на два уровня выше этого файла (…\resources\updater).
	[string]$Root = ''
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $here) }

# Сама программа — самый большой .exe в папке установки. Имя у неё кириллическое, по имени не ищем.
$exe = @(Get-ChildItem -LiteralPath $Root -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object Length -Descending)[0]
if (-not $exe) { Write-Output "no program exe in $Root"; exit 1 }

$updateScript = Join-Path $here 'iskra-update.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'

function Escape-Xml([string]$text) {
	return $text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
}

# Права на само задание: система и администраторы — всё, пользователи — читать и запускать.
$runByUsers = 'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)'

function Update-TaskXml([bool]$withSecurity) {
	$security = ''
	if ($withSecurity) { $security = "<SecurityDescriptor>$runByUsers</SecurityDescriptor>" }
	$arguments = Escape-Xml ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $updateScript + '"')
	return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Iskra: checks the server for a newer version and installs it (no user rights needed).</Description>
    $security
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T08:30:00</StartBoundary>
      <Enabled>true</Enabled>
      <RandomDelay>PT25M</RandomDelay>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T13:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <RandomDelay>PT25M</RandomDelay>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(Escape-Xml $powershell)</Command>
      <Arguments>$arguments</Arguments>
    </Exec>
  </Actions>
</Task>
"@
}

# Группа «Пользователи» — задание выполняется в сеансе того, кто вошёл, с его правами.
# Без ограничения по времени: запущенная им «Искра» работает, пока её не закроют.
$relaunchXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Iskra: reopens the messenger for the logged-on user after an update.</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(Escape-Xml $exe.FullName)</Command>
      <WorkingDirectory>$(Escape-Xml $Root)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

# schtasks читает описание из файла в UTF-16 — так в него без потерь попадает кириллическое имя программы.
function Register-Task([string]$name, [string]$xml) {
	$file = Join-Path $env:TEMP ("iskra-task-" + [Guid]::NewGuid().ToString('N') + ".xml")
	[IO.File]::WriteAllText($file, $xml, [Text.Encoding]::Unicode)
	$output = & $schtasks /Create /TN "$TaskFolder\$name" /XML $file /F 2>&1
	$code = $LASTEXITCODE
	Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
	if ($code -ne 0) { Write-Output ("{0}: schtasks exit code {1}: {2}" -f $name, $code, ($output -join ' ')) }
	return $code
}

$failed = 0
$code = Register-Task 'Update' (Update-TaskXml $true)
if ($code -ne 0) {
	# Не приняло описание с правами для пользователей — заводим без них: по расписанию задание
	# работать будет, не сработает только запуск по команде из панели.
	$code = Register-Task 'Update' (Update-TaskXml $false)
}
if ($code -ne 0) { $failed = 1 }
if ((Register-Task 'Relaunch' $relaunchXml) -ne 0) { $failed = 1 }
exit $failed
