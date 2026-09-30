@echo off
rem Сценарий запуска компьютера для групповой политики: ставит «Искру», если её ещё нет.
rem Дальше клиент обновляется сам, через сервер, - этот сценарий его не трогает.
rem
rem В путях и командах НЕТ кириллицы намеренно: cmd читает .bat в кодировке консоли (866), и
rem «Искра.exe», сохранённое в UTF-8, превращалось в мусор - проверка «уже стоит» не срабатывала,
rem и установщик 1.0.0 запускался при каждой загрузке, откатывая обновлённый клиент назад.
rem Установлено ли, узнаём по resources\app.asar - он есть у любой версии.
rem
rem Какой установщик: сначала для Windows 10+. На Windows 7/8.1 он молча завершается с кодом 3
rem (build-config/installer-win10.nsh) - тогда ставим сборку для Windows 7.

set SHARE=\\p48-srv-adm01\iskra
if exist "%ProgramFiles%\iskra-desktop\resources\app.asar" exit /b 0

"%SHARE%\iskra-setup-win10-1.0.0.exe" /S
if errorlevel 3 if not errorlevel 4 "%SHARE%\iskra-setup-win7-1.0.0.exe" /S
exit /b 0
