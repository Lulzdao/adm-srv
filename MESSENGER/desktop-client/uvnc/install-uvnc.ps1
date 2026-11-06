# Установка средства удалённого доступа (UltraVNC) в составе «Искры».
#
# Запускает установщик «Искры» (installer-common.nsh) с правами администратора, а также задание
# обновления Iskra\Update от имени системы — поэтому здесь есть права завести службу, записать в
# HKLM и в брандмауэр. Своего окна не показывает, работает молча, пишет в журнал.
#
# Что делает (идемпотентно — повторный запуск при обновлении ничего лишнего не меняет):
#   * заводит службу uvnc_service из папки «Искры» (…\resources\uvnc), заменяя прежнюю из uvnc_s;
#   * пишет ultravnc.ini из шаблона: порт 5995, SecureVNC, вход по учётной записи Windows, запрос
#     сотруднику с автосогласием, значок в трее виден; метка ultravnc.portable — чтобы служба читала
#     именно его, а не копию в C:\ProgramData\UltraVNC;
#   * задаёт случайный пароль VNC (без него сервер не отвечает), только если его ещё нет;
#   * включает SoftwareSASGeneration — Ctrl+Alt+Del без лишнего вопроса сотруднику;
#   * группа доступа (MS-Logon) — по умолчанию p48_g_support, машинная политика может подменить;
#     плюс локальные администраторы ПК — резервный вход, когда домен недоступен;
#   * правило брандмауэра на порт 5995 — без ограничений по адресам (политика vncAllowFrom сужает);
#   * после проверки, что новая служба слушает 5995, удаляет прежнюю папку uvnc_s (из Program Files
#     и из Program Files (x86)). Папку администратора uvnc_support не трогает: службы в ней нет.
#
# Настройки берутся из машинной политики C:\ProgramData\Iskra\config.json (пишут туда только
# администраторы). Ключи: vncAccessGroup (строка «ДОМЕН\группа» — подменяет группу доступа,
# по умолчанию p48_g_support), vncAllowFrom (адреса/подсети через запятую — с них разрешить
# подключение, по умолчанию без ограничений), vncQueryAccept (true — спрашивать сотрудника без
# автосогласия), vncLocalAdmins (false — без резервного входа локальными администраторами ПК, см.
# шаг 5). Настройку пользователя (Ctrl+S в клиенте) НЕ читаем.
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
# Где на рабочих ПК стоит прежняя UltraVNC, точно не известно: 32-битный установщик на 64-битной
# Windows кладёт её в Program Files (x86). Проверяем оба места.
$oldDirs = @('C:\Program Files\uvnc_s', 'C:\Program Files (x86)\uvnc_s')
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

function Run([string]$exe, [string]$argLine) {
	# Запуск без окна, ждём завершения, код возврата — в $LASTEXITCODE. Вывод — во временный файл:
	# читать stdout и stderr процесса через ReadToEnd по очереди в PowerShell 2.0 опасно (если дочерний
	# процесс заполнит один буфер, пока мы ждём другой, — взаимная блокировка). Через файл этого нет.
	# ВАЖНО: параметр называется $argLine, а не $args. $args — зарезервированная автоматическая
	# переменная PowerShell: параметр с таким именем молча остаётся пустым, Start-Process падает
	# с исключением, а catch его глушит. 2026-10-22 из-за этого сценарий «отработал успешно»,
	# не запустив ни одной внешней программы (net start, netsh, setpasswd, reg add).
	$tmp = [System.IO.Path]::GetTempFileName()
	try {
		$proc = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -Wait -PassThru -RedirectStandardOutput $tmp -RedirectStandardError ($tmp + '.err')
		$global:LASTEXITCODE = $proc.ExitCode
		$out = ''
		if (Test-Path $tmp) { $out = [System.IO.File]::ReadAllText($tmp) }
		return $out
	} catch {
		Log ('не удалось запустить ' + $exe + ': ' + $_.Exception.Message)
		$global:LASTEXITCODE = 1
		return ''
	} finally {
		Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
		Remove-Item -LiteralPath ($tmp + '.err') -Force -ErrorAction SilentlyContinue
	}
}

function RunApp([string]$exe, [string]$argLine) {
	# Для winvnc.exe (GUI-приложение): запуск без перенаправления вывода. С перенаправлением
	# (как в Run) регистрация службы через -install у GUI-приложения не срабатывала.
	# Параметр не $args по той же причине, что и в Run.
	try {
		$proc = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -Wait -PassThru
		$global:LASTEXITCODE = $proc.ExitCode
	} catch {
		Log ('не удалось запустить ' + $exe + ': ' + $_.Exception.Message)
		$global:LASTEXITCODE = 1
	}
}

function Stop-Service-If-Any {
	Run $sc ('stop ' + $svc) | Out-Null
	# В русской выдаче sc локализованы МЕТКИ («Состояние»), а значения (RUNNING/STOP_PENDING)
	# остаются английскими — потому ждём, пока исчезнут RUNNING и *PENDING, а не ищем метку STATE.
	for ($i = 0; $i -lt 10; $i++) {
		$q = Run $sc ('query ' + $svc)
		if ($q -notmatch 'RUNNING' -and $q -notmatch 'PENDING') { break }
		Start-Sleep -Milliseconds 500
	}
	# winvnc мог остаться как процесс в сеансе пользователя — снять, иначе файлы заняты.
	Get-Process winvnc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
	Start-Sleep -Milliseconds 500
}

# Политике верим, только если её владелец — система или администраторы (так у файла, положенного
# администратором с повышенными правами или групповой политикой). До 1.1.33 обычный пользователь мог
# создать в C:\ProgramData\Iskra свой config.json и, например, выдать доступ к ПК своей группе —
# этот сценарий работает с правами администратора (найдено 2026-10-26). Чужой файл откладываем в
# сторону: его не прочтут ни задание обновления, ни сама программа. Та же проверка — в iskra-update.ps1.
function Test-TrustedPolicy([string]$path) {
	if (-not (Test-Path -LiteralPath $path)) { return $true }
	$owner = ''
	# Через .NET, а не Get-Acl: у Get-Acl в PowerShell 2.0 нет -LiteralPath — вызов падал, владелец
	# выходил пустым, и откладывалась даже политика администратора (поймано на Win7-ВМ).
	try { $owner = [System.IO.File]::GetAccessControl($path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value } catch { }
	if ($owner -eq 'S-1-5-18' -or $owner -eq 'S-1-5-32-544') { return $true }
	# Владельца узнать не удалось — в этот раз не верим, но и не трогаем: вдруг это сбой, а файл верный.
	if ($owner -eq '') { Log ('политика не принята: не удалось узнать владельца ' + $path); return $false }
	$aside = $path + '.untrusted-' + (Get-Date).ToString('yyyyMMdd-HHmmss')
	try { Move-Item -LiteralPath $path -Destination $aside -Force -ErrorAction Stop } catch { $aside = '(не перенесён: ' + $_.Exception.Message + ')' }
	Log ('политика не принята: владелец ' + $path + ' — ' + $owner + ', не система и не администраторы; файл: ' + $aside)
	return $false
}
$policyTrusted = Test-TrustedPolicy (Join-Path $programData 'config.json')

function Policy([string]$key) {
	if (-not $policyTrusted) { return '' }
	# Грубый разбор плоского config.json (в PS 2.0 нет ConvertFrom-Json). Клиент (policy.js)
	# разбирает этот файл настоящим JSON.parse, значит файл — валидный JSON, и обратная косая
	# черта в значении экранирована: «ДОМЕН\\группа» в файле есть «ДОМЕН\группа» в значении.
	# Регэксп захватывает сырое содержимое кавычек — разэкранируем двойную черту вручную.
	$cfg = Join-Path $programData 'config.json'
	if (-not (Test-Path $cfg)) { return '' }
	$text = [System.IO.File]::ReadAllText($cfg)
	$m = [System.Text.RegularExpressions.Regex]::Match($text, '"' + $key + '"\s*:\s*"([^"]*)"')
	if ($m.Success) { return $m.Groups[1].Value.Replace('\\', '\') }
	$mb = [System.Text.RegularExpressions.Regex]::Match($text, '"' + $key + '"\s*:\s*(true|false)')
	if ($mb.Success) { return $mb.Groups[1].Value }
	return ''
}

# ----------------------------- удаление -----------------------------
if ($Uninstall) {
	Log 'uninstall: удаляем службу и правило'
	Stop-Service-If-Any
	$winvnc = Join-Path $Root 'winvnc.exe'
	# -uninstall выполняет то же GUI-приложение winvnc: с перенаправленным выводом (Run) его
	# вызовы не срабатывают — как и с -install, поэтому RunApp.
	if (Test-Path $winvnc) { RunApp $winvnc '-uninstall' }
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
	# Окно запроса сотруднику. В UltraVNC 1.8 (vncserver.cpp, vncclient.cpp): QuerySetting=4 — окно
	# показывается, 2 — нет; QueryAccept — что сделать, когда за QueryTimeout секунд сотрудник ничего не
	# нажал: 1 — принять, 0 — отказать. Шаблон: окно с автосогласием через 10 с. До 2026-10-26 там стояли
	# значения из рабочего комплекта 1.4.3.1 (QuerySetting=1, QueryAccept=0) — для 1.8 это «без окна»:
	# подключались молча (найдено на Win7-ВМ). Политика vncQueryAccept=true — без автосогласия: не нажал
	# «Принять» — отказ (раньше здесь ставилось QueryAccept=1, то есть ровно обратное).
	if ((Policy 'vncQueryAccept') -eq 'true') { $ini = $ini -replace '(?m)^QueryAccept=[^\r\n]*', 'QueryAccept=0' }
	# Сохранить уже заданный пароль из существующего ini (его нет в шаблоне). Строки passwd/
	# passwd2 живут в секции [ultravnc] — туда их пишет сам UltraVNC, и winvnc ищет их именно
	# там, а не в конце файла (конец — это уже секция [poll]).
	# ini читаем и пишем в системной кодировке (ANSI): UltraVNC разбирает его до-Unicode
	# средствами, UTF-8 он прочтёт как мусор — русский текст запроса сотруднику исказился бы.
	$pw = ''; $pw2 = ''
	if (Test-Path $iniPath) {
		$cur = [System.IO.File]::ReadAllText($iniPath, [System.Text.Encoding]::Default)
		$mp = [System.Text.RegularExpressions.Regex]::Match($cur, '(?m)^passwd=([^\r\n]*)'); if ($mp.Success) { $pw = $mp.Groups[1].Value }
		$mp2 = [System.Text.RegularExpressions.Regex]::Match($cur, '(?m)^passwd2=([^\r\n]*)'); if ($mp2.Success) { $pw2 = $mp2.Groups[1].Value }
	}
	if ($pw -ne '') { $ini = $ini -replace '(?m)^\[ultravnc\]', ('[ultravnc]' + "`r`npasswd=" + $pw + "`r`npasswd2=" + $pw2) }
	$enc = [System.Text.Encoding]::Default
	$old = ''
	if (Test-Path $iniPath) { $old = [System.IO.File]::ReadAllText($iniPath, [System.Text.Encoding]::Default) }
	if ($old -ne $ini) { [System.IO.File]::WriteAllText($iniPath, $ini, $enc); Log 'ini записан' } else { Log 'ini без изменений' }
}

# 2а. Чтобы служба читала именно этот ultravnc.ini. UltraVNC 1.8 без метки ultravnc.portable рядом
#     с winvnc.exe берёт настройки из C:\ProgramData\UltraVNC\ultravnc.ini, а наш файл копирует
#     туда ОДИН раз — если там пусто (UltraVNCService.cpp, MigrateServiceIniToProgramData). Дальше
#     правки шаблона в новых версиях и политика vncQueryAccept до службы не доходили (найдено
#     2026-10-26: на ВМ служба читала копию от 22.10), а на ПК, где от другой UltraVNC в ProgramData
#     уже лежит свой ini, наши порт, шифрование и вход по Windows не применились бы вовсе. С меткой
#     служба и значок в трее читают ini из папки «Искры». Меню «Свойства» сотруднику по-прежнему
#     недоступно: AllowProperties=0 в шаблоне.
$marker = Join-Path $Root 'ultravnc.portable'
if (-not (Test-Path $marker)) {
	[System.IO.File]::WriteAllText($marker, "Метка для UltraVNC: настройки — ultravnc.ini в этой папке (см. install-uvnc.ps1).`r`n", [System.Text.Encoding]::Default)
	Log 'метка ultravnc.portable создана'
}
# Копию наших настроек, сделанную UltraVNC в ProgramData до метки, убираем — в ней устаревший
# пароль, и по ней легко ошибиться, какой файл действует. Только нашу: в ней путь к папке «Искры».
$pdIni = Join-Path $env:ProgramData 'UltraVNC\ultravnc.ini'
if (Test-Path $pdIni) {
	$pdText = [System.IO.File]::ReadAllText($pdIni, [System.Text.Encoding]::Default)
	if ($pdText.Contains('path=' + $Root)) {
		Remove-Item -LiteralPath $pdIni -Force -ErrorAction SilentlyContinue
		Log 'устаревшая копия ultravnc.ini в ProgramData удалена'
	}
}

# 3. Пароль VNC — случайный, только если его ещё нет (без пароля сервер не отвечает). Для входа он
#    не нужен: вход по учётной записи Windows. Знать его сотруднику незачем.
$hasPwd = $false
if (Test-Path $iniPath) { $hasPwd = ([System.IO.File]::ReadAllText($iniPath, [System.Text.Encoding]::Default) -match '(?m)^passwd=..') }
if (-not $hasPwd) {
	$chars = 'abcdefghijkmnpqrstuvwxyz23456789'.ToCharArray()
	$rng = New-Object byte[] 8
	(New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($rng)
	$pass = ''
	foreach ($b in $rng) { $pass += $chars[$b % $chars.Length] }
	$setpasswd = Join-Path $Root 'setpasswd.exe'
	if (Test-Path $setpasswd) {
		# setpasswd пишет passwd/passwd2 в ultravnc.ini текущего каталога — потому Push-Location.
		# Проверяем, что он действительно записал: иначе сервер не примет подключения,
		# а журнал будет врать, что всё хорошо.
		Push-Location $Root
		Run $setpasswd ($pass + ' ' + $pass) | Out-Null
		Pop-Location
		$done = ([System.IO.File]::ReadAllText($iniPath, [System.Text.Encoding]::Default) -match '(?m)^passwd=..')
		if ($done) { Log 'пароль VNC задан' } else { Log ('пароль VNC НЕ записан, код setpasswd: ' + $LASTEXITCODE) }
	}
}

# 4. Ctrl+Alt+Del без лишнего окна: разрешить программный ввод SAS.
Run $reg 'add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v SoftwareSASGeneration /t REG_DWORD /d 1 /f' | Out-Null

# 5. Кто может подключиться (MS-Logon): группа доступа и локальные администраторы ПК.
#    Группа — по умолчанию p48_g_support (решение пользователя 2026-10-22), машинная политика
#    vncAccessGroup подменяет («ДОМЕН\группа»). Это группа домена: вне домена она не разрешится —
#    MSLogonACL молча пропустит строку; проверка ниже честно пишет об этом в журнал.
#    Локальные администраторы (BUILTIN\Администраторы, SID S-1-5-32-544) — резервный вход, когда
#    домен недоступен (решение пользователя 2026-11-07): пароль локальной учётки проверяется на самом
#    ПК, без контроллера домена. Входить — «ИМЯ-ПК\учётка» локального администратора. Пока домен
#    работает, в эту группу входят и доменные администраторы — они тоже смогут подключиться.
#    Политика vncLocalAdmins=false — без резервного входа.
$group = Policy 'vncAccessGroup'
if ($group -eq '') { $group = 'p48_g_support' }
$entries = @($group)
if ((Policy 'vncLocalAdmins') -ne 'false') {
	# Имя группы в русской Windows переведено («Администраторы»), и MSLogonACL ищет по имени —
	# поэтому имя берём у самой Windows по SID, без префикса BUILTIN\.
	try {
		$admins = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value
		$entries += $admins.Substring($admins.IndexOf('\') + 1)
	} catch { Log ('не удалось узнать имя группы локальных администраторов: ' + $_.Exception.Message) }
}
$aclFile = Join-Path $Root 'access.acl'
# Кодировка системная (ANSI): имена групп с кириллицей, ASCII бы их потерял.
# Маска 3 = ViewOnly(1) + Interact(2) — всё управление, без передачи файлов.
# Имена — В КАВЫЧКАХ: токенизатор MSLogonACL режет строку по пробелам, и имя с пробелом
# («NT AUTHORITY\SYSTEM») без кавычек разваливается на три части и молча пропускается.
$aclText = ''
foreach ($e in $entries) { $aclText += "allow`t0x00000003`t`"" + $e + "`"`r`n" }
[System.IO.File]::WriteAllText($aclFile, $aclText, [System.Text.Encoding]::Default)
$mslogon = Join-Path $Root 'MSLogonACL.exe'
if (Test-Path $mslogon) {
	Run $mslogon ('/i /o "' + $aclFile + '"') | Out-Null
	# MSLogonACL возвращает 0 даже когда имя не разрешается (строку пропускает, код не портит),
	# поэтому «группа задана» по коду выхода не проверить. Единственная честная проверка:
	# экспортировать ACL обратно (SID разрешается в имя) и найти в нём каждое имя.
	$expFile = [System.IO.Path]::GetTempFileName()
	Run $mslogon ('/e "' + $expFile + '"') | Out-Null
	$exp = ''
	if (Test-Path $expFile) { $exp = [System.IO.File]::ReadAllText($expFile, [System.Text.Encoding]::Default) }
	foreach ($e in $entries) {
		$name = $e
		$slash = $e.LastIndexOf('\')
		if ($slash -ge 0) { $name = $e.Substring($slash + 1) }
		$what = 'группа доступа'
		if ($e -ne $group) { $what = 'резервный вход (локальные администраторы)' }
		if ($exp -ne '' -and $exp.Contains($name)) { Log ($what + ': ' + $e) }
		else { Log ($what + ' НЕ применена: ' + $e + ' не разрешается на этой машине (вне домена?)') }
	}
	Remove-Item -LiteralPath $expFile -Force -ErrorAction SilentlyContinue
}

# 6. Служба uvnc_service должна указывать на winvnc.exe из папки «Искры».
#    Прежде тут служба удалялась и создавалась заново через winvnc -install, но это ненадёжно:
#    удаление ЗАПУЩЕННОЙ службы уходит в состояние «помечена к удалению» (пока открыт хоть один
#    её хэндл), и новая служба с тем же именем в этот момент не создаётся — путь так и остаётся
#    прежним (на uvnc_s). Поэтому поступаем иначе: останавливаем службу и точечно переписываем её
#    путь (ImagePath) и тип запуска прямо в реестре — без удаления и без кавычечных мучений
#    sc config. Если службы ещё нет (чистая машина без прежней UltraVNC) — создаём её родным
#    winvnc -install, он сразу запишет верный путь.
$svcKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\' + $svc
Run $sc ('stop ' + $svc) | Out-Null
Get-Process winvnc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# Ждём, пока служба действительно остановится (иначе net start ниже упрётся в «ещё останавливается»).
# Условие по RUNNING/PENDING, не по метке STATE: в русской выдаче sc метки локализованы (см. выше).
for ($i = 0; $i -lt 20; $i++) {
	$q = Run $sc ('query ' + $svc)
	if ($q -notmatch 'RUNNING' -and $q -notmatch 'PENDING') { break }
	Start-Sleep -Milliseconds 500
}
if (-not (Test-Path $svcKey)) {
	RunApp $winvnc '-install'
	Start-Sleep -Milliseconds 1000
}
# Путь к exe службы требует кавычек (в пути есть пробелы), плюс аргумент -service.
$imagePath = '"' + $winvnc + '" -service'
Set-ItemProperty -Path $svcKey -Name 'ImagePath' -Value $imagePath -ErrorAction SilentlyContinue
Set-ItemProperty -Path $svcKey -Name 'Start' -Value 2 -ErrorAction SilentlyContinue
Log ('путь службы: ' + $imagePath)
# Запуск через net start, а не sc start: sc start возвращает управление сразу (служба ещё
# поднимается), и следующая за этим проверка порта могла увидеть службу ещё не слушающей.
# net start ждёт, пока служба действительно запустится, и возвращает ненулевой код при ошибке.
$net = Join-Path $env:SystemRoot 'System32\net.exe'
# Две попытки с паузой — страховка: сразу после принудительного снятия старого winvnc его
# мьютекс/порт могут быть ещё не освобождены, и первый запуск нового иногда срывается.
for ($i = 1; $i -le 2; $i++) {
	$netOut = Run $net ('start ' + $svc)
	if ((Run $sc ('query ' + $svc)) -match 'RUNNING') { break }
	Log ('запуск службы, попытка ' + $i + ': не RUNNING; net start: ' + (($netOut -replace "[\r\n]+", ' ').Trim()))
	Start-Sleep -Seconds 3
}

# 7. Правило брандмауэра на порт 5995 (при политике vncAllowFrom — только с этих адресов).
Run $netsh 'advfirewall firewall delete rule name="Iskra Remote Access"' | Out-Null
$allow = Policy 'vncAllowFrom'
$ruleArgs = 'advfirewall firewall add rule name="Iskra Remote Access" dir=in action=allow protocol=TCP localport=' + $port + ' profile=any'
if ($allow -ne '') { $ruleArgs += ' remoteip=' + $allow }
$fwOut = Run $netsh $ruleArgs
if ($LASTEXITCODE -ne 0) { Log ('правило брандмауэра не создано, код ' + $LASTEXITCODE + ': ' + (($fwOut -replace "[\r\n]+", ' ').Trim())) }

# 8. Проверить, что новая служба слушает 5995, и только тогда убрать прежнюю папку uvnc_s.
$listens = $false
for ($i = 0; $i -lt 12; $i++) {
	Start-Sleep -Milliseconds 800
	$ns = Run (Join-Path $env:SystemRoot 'System32\netstat.exe') '-an'
	if ($ns -match ('TCP\s+\S*:' + $port + '\s')) { $listens = $true; break }
}
Log ('служба слушает ' + $port + ': ' + $listens)
# Провал честно проваливает установку: без этого установщик молча рапортует успех,
# и машина остаётся без удалённого доступа, пока кто-нибудь не заметит.
if (-not $listens) { Log 'install: не завершена — служба не слушает порт'; exit 1 }
$running = Run $sc ('qc ' + $svc)
if ($running -match 'iskra-desktop') {
	foreach ($oldDir in $oldDirs) {
		if (-not (Test-Path $oldDir)) { continue }
		try { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction Stop; Log ('прежняя папка удалена: ' + $oldDir) }
		catch { Log ('не удалось удалить ' + $oldDir + ': ' + $_.Exception.Message) }
	}
}
Log 'install: готово'
exit 0
