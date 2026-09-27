@echo off
rem Обновление adm-srv до актуальной версии с GitHub.
rem Ярлык на этот файл кладётся на рабочий стол сервера. Права администратора
rem нужны для остановки и запуска служб — окно их запросит само.
rem Подробности — DEPLOY.md, раздел «Обновление одной кнопкой».
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File ""%~dp0update.ps1""'"
