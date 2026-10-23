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
#   * группа доступа (MS-Logon) — по умолчанию p48_g_support, на ПК домена in.local — администраторы
#     домена in.local (доверия между доменами нет); машинная политика может подменить;
#   * правило брандмауэра на порт 5995 — без ограничений по адресам (политика vncAllowFrom сужает);
#   * после проверки, что новая служба слушает 5995, удаляет прежнюю папку uvnc_s (из Program Files
#     и из Program Files (x86)). Папку администратора uvnc_support не трогает: службы в ней нет.
#
# Настройки берутся из машинной политики C:\ProgramData\Iskra\config.json (пишут туда только
# администраторы). Ключи: vncAccessGroup (строка «ДОМЕН\группа» — подменяет группу доступа,
# по умолчанию p48_g_support), vncAllowFrom (адреса/подсети через запятую — с них разрешить
# подключение, по умолчанию без ограничений), vncQueryAccept (true — спрашивать сотрудника без
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

function Policy([string]$key) {
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

function DefaultAccessGroup {
	# Группа доступа, когда политика её не задала. Обычно p48_g_support (домен rosstat.local).
	# ПК домена in.local (сеть 192.168.254.0/23): доверия с rosstat.local нет, p48_g_support там не
	# разрешится, и в UltraVNC не вошёл бы никто — пускаем администраторов домена in.local (решение
	# пользователя 2026-10-23). Имя этой группы на русском контроллере домена переведено
	# («Администраторы домена»), поэтому ищем её по SID: SID домена берём у учётной записи самого
	# компьютера, группе администраторов домена всегда соответствует RID 512.
	$domain = ''
	try { $domain = [string](Get-WmiObject Win32_ComputerSystem).Domain } catch { }
	if ($domain -ne 'in.local') { return 'p48_g_support' }
	try {
		$machine = New-Object System.Security.Principal.NTAccount(($env:COMPUTERNAME + '$'))
		$domainSid = $machine.Translate([System.Security.Principal.SecurityIdentifier]).AccountDomainSid
		$admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::AccountDomainAdminsSid, $domainSid)
		return $admins.Translate([System.Security.Principal.NTAccount]).Value
	} catch {
		Log ('группа администраторов домена in.local не найдена по SID: ' + $_.Exception.Message)
		return 'IN\Администраторы домена'
	}
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
	if ((Policy 'vncQueryAccept') -eq 'true') { $ini = $ini -replace '(?m)^QueryAccept=[^\r\n]*', 'QueryAccept=1' }
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

# 5. Группа доступа (MS-Logon): по умолчанию p48_g_support (решение пользователя 2026-10-22),
#    машинная политика vncAccessGroup подменяет («ДОМЕН\группа»). Имя группы домена, поэтому
#    вне домена оно не разрешится — MSLogonACL молча пропустит строку, ACL останется пустым
#    (никто не подключится) — проверка ниже честно пишет об этом в журнал.
$group = Policy 'vncAccessGroup'
if ($group -eq '') { $group = DefaultAccessGroup }
$aclFile = Join-Path $Root 'access.acl'
# Кодировка системная (ANSI): имя группы может быть с кириллицей, ASCII бы его потерял.
# Маска 3 = ViewOnly(1) + Interact(2) — всё управление, без передачи файлов.
# Имя группы — В КАВЫЧКАХ: токенизатор MSLogonACL режет строку по пробелам, и имя с пробелом
# («NT AUTHORITY\SYSTEM») без кавычек разваливается на три части и молча пропускается.
[System.IO.File]::WriteAllText($aclFile, "allow`t0x00000003`t`"" + $group + "`"`r`n", [System.Text.Encoding]::Default)
$mslogon = Join-Path $Root 'MSLogonACL.exe'
if (Test-Path $mslogon) {
	Run $mslogon ('/i /o "' + $aclFile + '"') | Out-Null
	# MSLogonACL возвращает 0 даже когда имя не разрешается (строку пропускает, код не портит),
	# поэтому «группа задана» по коду выхода не проверить. Единственная честная проверка:
	# экспортировать ACL обратно (SID разрешается в имя) и найти в нём имя группы.
	$expFile = [System.IO.Path]::GetTempFileName()
	Run $mslogon ('/e "' + $expFile + '"') | Out-Null
	$exp = ''
	if (Test-Path $expFile) { $exp = [System.IO.File]::ReadAllText($expFile, [System.Text.Encoding]::Default) }
	$grpName = $group
	$slash = $group.LastIndexOf('\')
	if ($slash -ge 0) { $grpName = $group.Substring($slash + 1) }
	if ($exp -ne '' -and $exp.Contains($grpName)) { Log ('группа доступа: ' + $group) }
	else { Log ('группа доступа НЕ применена: ' + $group + ' не разрешается на этой машине (вне домена?)') }
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
