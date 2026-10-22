; Общая часть установщика для обеих сборок (win7 и win10).
;
; Здесь лежит только то, что одинаково для обоих треков. Версионная проверка Windows живёт
; в installer-win10.nsh — она нужна ровно одной сборке.
;
; customInstall вызывается electron-builder'ом после того, как файлы уже разложены по $INSTDIR,
; и выполняется с правами администратора (perMachine: true в base.js), поэтому запись в
; машинное хранилище сертификатов здесь возможна.

; ---------------------------------------------------------------------------
;  Корневой сертификат организации
;
;  Без него Windows не доверяет серверу «Искры», и клиент показывает отказ на входе. Раньше это
;  лечили руками на каждом рабочем месте; теперь установщик ставит корень сам, если его ещё нет.
;
;  Проверяем по отпечатку, а не по имени: имя УЦ может совпасть с чужим, отпечаток — нет.
;  Отпечаток относится к файлу rosstat-root-ca.crt рядом с main.js. Если корень меняется,
;  пересчитайте его вместе с заменой файла:
;      certutil -hashfile rosstat-root-ca.crt SHA1
;  Ошибиться здесь не страшно: при несовпадении сертификат просто будет ставиться каждый раз
;  заново (certutil -addstore -f идемпотентен), лишнего вреда от этого нет.
!define ORG_CA_THUMBPRINT "1a50a3d446b4b531dfbc94814151842d479f2941"
!define ORG_CA_FILE "$INSTDIR\resources\rosstat-root-ca.crt"

; Остановить службу удалённого доступа до замены файлов. При обновлении «Искры» служба uvnc_service
; работает из $INSTDIR\resources\uvnc, и её winvnc.exe был бы занят — новый файл не записался бы.
; Вызывается из customInit обеих сборок (до распаковки файлов). На первой установке службы ещё нет
; в этой папке (она из старой uvnc_s) — остановка просто ничего не делает.
!macro StopUvncForUpdate
  nsExec::ExecToStack '"$SYSDIR\sc.exe" stop uvnc_service'
  Pop $0
  Pop $1
  Sleep 1500
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /IM winvnc.exe'
  Pop $0
  Pop $1
  Sleep 500
!macroend

!macro customInstall
  IfFileExists "${ORG_CA_FILE}" 0 caDone
    ; -verifystore возвращает 0, только если сертификат с таким отпечатком в хранилище есть.
    nsExec::ExecToStack '"$SYSDIR\certutil.exe" -verifystore Root ${ORG_CA_THUMBPRINT}'
    Pop $0
    Pop $1 ; вывод certutil нам не нужен, но стек за собой надо убрать
    ${If} $0 == 0
      DetailPrint "Корневой сертификат организации уже установлен."
    ${Else}
      DetailPrint "Устанавливаем корневой сертификат организации..."
      nsExec::ExecToStack '"$SYSDIR\certutil.exe" -addstore -f Root "${ORG_CA_FILE}"'
      Pop $0
      Pop $1
      ${If} $0 == 0
        DetailPrint "Корневой сертификат установлен."
      ${Else}
        ; Не повод срывать установку: клиент запустится и без этого — у него есть свой запасной
        ; список корней (см. collectTrustAnchors в main.js). Пострадает только браузерная часть
        ; окна, о чём человек и увидит внятное сообщение на экране входа.
        DetailPrint "Не удалось установить корневой сертификат (код $0). Обратитесь к администратору."
      ${EndIf}
    ${EndIf}
  caDone:

  ; -------------------------------------------------------------------------
  ;  Задания планировщика: обновление без прав сотрудника
  ;
  ;  Установщик требует прав администратора, и у сотрудника без них клиент обновиться сам не
  ;  может. Поэтому здесь, пока права есть, заводятся два задания (updater\register-tasks.ps1):
  ;  Iskra\Update — от имени системы, дважды в день проверяет и ставит новую версию;
  ;  Iskra\Relaunch — открывает «Искру» сотруднику обратно после установки.
  ;  Что и откуда ставится и почему это безопасно — в шапке updater.js.
  ;
  ;  Не получилось — не повод срывать установку: программа работает, обновляться будет по-старому.
  ;
  ;  -InputFormat None обязателен. nsExec отдаёт PowerShell трубы вместо консоли, и PowerShell 2.0
  ;  (Windows 7) с -File ждёт ввода из этой трубы бесконечно: задания не заводились, установщик
  ;  висел до перезагрузки, а вместе с ним и сценарий политики, который его запустил (2026-10-14).
  IfFileExists "$INSTDIR\resources\updater\register-tasks.ps1" 0 tasksDone
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\updater\register-tasks.ps1"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      DetailPrint "Задания обновления заведены."
    ${Else}
      DetailPrint "Не удалось завести задания обновления (код $0): $1"
    ${EndIf}
  tasksDone:

  ; -------------------------------------------------------------------------
  ;  Средство удалённого доступа (UltraVNC)
  ;
  ;  install-uvnc.ps1 заводит службу из $INSTDIR\resources\uvnc, настраивает её (порт, шифрование,
  ;  вход по учётной записи Windows, пароль, Ctrl+Alt+Del, брандмауэр) и убирает прежнюю установку
  ;  из C:\Program Files\uvnc_s. Подробности и настройки из машинной политики — в шапке сценария.
  ;
  ;  Не получилось — не повод срывать установку: «Искра» работает и без удалённого доступа.
  ;  -InputFormat None — как и у заданий обновления, иначе PowerShell 2.0 на Windows 7 ждёт ввод.
  IfFileExists "$INSTDIR\resources\uvnc\install-uvnc.ps1" 0 uvncDone
    DetailPrint "Настраиваем средство удалённого доступа..."
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uvnc\install-uvnc.ps1"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      DetailPrint "Средство удалённого доступа настроено."
    ${Else}
      DetailPrint "Не удалось настроить средство удалённого доступа (код $0): $1"
    ${EndIf}
  uvncDone:
!macroend

; Задания убираются только при настоящем удалении программы. При установке новой версии поверх
; старой деинсталлятор тоже вызывается (с ключом --updated) — и вызывает его в том числе само
; задание Iskra\Update, которое в этот момент выполняется: удалять его из-под себя нельзя, а новая
; версия всё равно тут же заведёт задания заново.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    nsExec::ExecToStack '"$SYSDIR\schtasks.exe" /Delete /TN "Iskra\Update" /F'
    Pop $0
    Pop $1
    nsExec::ExecToStack '"$SYSDIR\schtasks.exe" /Delete /TN "Iskra\Relaunch" /F'
    Pop $0
    Pop $1
    ; Средство удалённого доступа снимаем только при настоящем удалении «Искры», не при обновлении.
    IfFileExists "$INSTDIR\resources\uvnc\install-uvnc.ps1" 0 uvncRemoved
      nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -InputFormat None -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uvnc\install-uvnc.ps1" -Uninstall'
      Pop $0
      Pop $1
    uvncRemoved:
  ${EndIf}
!macroend
