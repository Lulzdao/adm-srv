@echo off
rem Сборка клиента «Искры» (установщики для компьютеров сотрудников) на сервере.
rem Ярлык на этот файл можно положить на рабочий стол сервера рядом с update.cmd.
rem Права администратора не нужны. Подробности — DEPLOY.md, раздел «Сборка клиента «Искры»».
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0build-iskra-client.ps1" %*
