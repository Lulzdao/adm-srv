; Часть установщика сборки win7. Проверка версии Windows тут не нужна (эта сборка и рассчитана на
; Windows 7/8.1 и новее), но customInit нужен, чтобы до распаковки файлов остановить службу
; удалённого доступа — иначе при обновлении её winvnc.exe в папке «Искры» был бы занят.
;
; Путь через ${PROJECT_DIR}: electron-builder компилирует скрипт установщика не из этой папки.
!include "${PROJECT_DIR}\build-config\installer-common.nsh"

!macro customInit
  !insertmacro StopUvncForUpdate
!macroend
