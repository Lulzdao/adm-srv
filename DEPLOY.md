# Развёртывание на сервере: службы Windows через NSSM

Порядок установки платформы и трёх модулей на `C:\IT-services` с нуля.
Всё запускается как службы Windows: стартуют сами при загрузке, окон терминала
не требуют, падение переживают перезапуском.

**Кому это нужно.** Разворачиваете заново, переносите на другой сервер или
пересоздаёте службы после переезда каталогов.

---

## 0. Что где лежит

```
C:\IT-services\
├── helpdesk-backend\        платформа: заявки, вход, прокси модулей   :3000
├── CERTVIEWER\              реестр сертификатов и МЧД                 :3101
├── SMDR\
│   ├── Collector.Py           сборщик звонков с АТС                    —
│   ├── .env                   адрес и пароль SMDR
│   ├── smdr.db                база звонков (общая с веб-частью)
│   └── web-node\              журнал звонков                          :3102
├── MESSENGER\               мессенджер «Искра»                        :3103
└── logs\                    вывод служб (создать вручную)
```

Наружу смотрит только платформа. Сертвивер и журнал звонков слушают
`127.0.0.1` — доступ к ним даёт платформа, проверив вход и роль. «Искра»
слушает сеть отдельно: к ней подключаются настольные клиенты напрямую.

---

## 1. Перенести данные — до всего остального

Ничего из перечисленного в репозитории **нет** (`.gitignore`). Распакованный
проект — это только код: базы пустые, настроек нет, зависимостей нет.

### Базы и файлы

| Откуда (старая установка) | Куда |
|---|---|
| `smdr.db` | `C:\IT-services\SMDR\smdr.db` |
| `helpdesk.db` | `C:\IT-services\helpdesk-backend\data\helpdesk.db` |
| вложения заявок | `C:\IT-services\helpdesk-backend\uploads\` |
| `certificates.db` | `C:\IT-services\CERTVIEWER\certificates.db` |
| `messenger.db`, `uploads\`, `certs\`, `updates\` | `C:\IT-services\MESSENGER\` |

Базы копируйте **при остановленных службах** и вместе с файлами `-wal` и
`-shm`, если они есть: базы работают в режиме WAL, и свежие записи лежат в
`-wal`. Копия одного `.db` окажется неполной.

На живой системе безопаснее так:

```
sqlite3 smdr.db ".backup C:\backup\smdr.db"
```

### Файлы настроек `.env`

Нужны в четырёх местах. Образцы лежат рядом под именем `.env.example`:

```
C:\IT-services\helpdesk-backend\.env
C:\IT-services\CERTVIEWER\.env
C:\IT-services\SMDR\.env
C:\IT-services\SMDR\web-node\.env
```

В `.env` платформы поправьте путь к общему хранилищу сертификата:

```
SHARED_CERT_DIR=C:\IT-services\MESSENGER\certs
```

> **Осторожно с именем файла.** Блокнот дописывает `.txt`, если имя не взять в
> кавычки. Файл `.env.txt` выглядит настроенным, но не читается. Включите показ
> расширений в проводнике и проверьте.

### Зависимости Node (`node_modules`)

**`npm install` на сервере не сработает — сети нет.** Каталоги `node_modules`
переносятся готовыми из старой установки или с машины, где есть интернет:

```
C:\IT-services\helpdesk-backend\node_modules\
C:\IT-services\CERTVIEWER\node_modules\
C:\IT-services\SMDR\web-node\node_modules\
C:\IT-services\MESSENGER\node_modules\
```

`Collector.Py` не требует ничего: только стандартная библиотека Python,
виртуальное окружение ему не нужно.

> **Отдельно про журнал звонков.** `SMDR\web-node` зависит от
> `better-sqlite3` — это нативный модуль, он собирается компилятором под
> конкретную версию Node. На закрытом контуре собрать его негде, поэтому его
> `node_modules` нужно брать с машины **с той же версией Node**. Если после
> запуска в логе видно `NODE_MODULE_VERSION ... does not match`, значит версии
> разошлись.

---

## 2. Узнать пути к интерпретаторам

```
where.exe node
where.exe python
where.exe nssm
```

Подставьте полученное вместо путей в примерах ниже.

---

## 3. Снести старые службы

Посмотреть, что заведено сейчас:

```powershell
Get-CimInstance Win32_Service |
  Where-Object { $_.PathName -match 'node\.exe|python|nssm' } |
  Select-Object Name, State, PathName | Format-List
```

Для каждой найденной:

```
nssm stop   ИмяСлужбы
nssm remove ИмяСлужбы confirm
```

Убедиться, что ничего не осталось работать само по себе:

```powershell
Get-Process node, python -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, Path
```

> **Про сборщик звонков это критично.** АТС Panasonic держит только **одну**
> SMDR-сессию: новое подключение выкидывает прежнего клиента. Две запущенные
> копии `Collector.Py` начинают выталкивать друг друга каждые несколько секунд,
> и при каждом подключении АТС заново выдаёт свой буфер. Если увидите в
> `collector.log` подсказку «к АТС подключён ЕЩЁ ОДИН сборщик» — ищите вторую
> копию.

---

## 4. Создать службы

```
mkdir C:\IT-services\logs
```

NSSM каталог сам не создаёт: без него служба не запустится.

### Платформа — порт 3000

```
nssm install ITS-Platform "C:\Program Files\nodejs\node.exe" "--use-system-ca server.js"
nssm set ITS-Platform AppDirectory "C:\IT-services\helpdesk-backend"
nssm set ITS-Platform DisplayName "ИТ-сервисы: платформа"
nssm set ITS-Platform Description "Заявки, вход через домен, прокси модулей, оповещения"
nssm set ITS-Platform Start SERVICE_AUTO_START
nssm set ITS-Platform AppStdout "C:\IT-services\logs\platform.out.log"
nssm set ITS-Platform AppStderr "C:\IT-services\logs\platform.err.log"
nssm set ITS-Platform AppRotateFiles 1
nssm set ITS-Platform AppRotateOnline 1
nssm set ITS-Platform AppRotateBytes 10485760
nssm set ITS-Platform AppThrottle 10000
nssm set ITS-Platform AppRestartDelay 5000
```

### Сертвивер — порт 3101

```
nssm install ITS-CertViewer "C:\Program Files\nodejs\node.exe" "server.js"
nssm set ITS-CertViewer AppDirectory "C:\IT-services\CERTVIEWER"
nssm set ITS-CertViewer DisplayName "ИТ-сервисы: реестр сертификатов и МЧД"
nssm set ITS-CertViewer Description "Сроки сертификатов и машиночитаемых доверенностей"
nssm set ITS-CertViewer Start SERVICE_AUTO_START
nssm set ITS-CertViewer AppStdout "C:\IT-services\logs\certviewer.out.log"
nssm set ITS-CertViewer AppStderr "C:\IT-services\logs\certviewer.err.log"
nssm set ITS-CertViewer AppRotateFiles 1
nssm set ITS-CertViewer AppRotateOnline 1
nssm set ITS-CertViewer AppRotateBytes 10485760
nssm set ITS-CertViewer AppThrottle 10000
nssm set ITS-CertViewer AppRestartDelay 5000
```

### Сборщик звонков

Рабочий каталог здесь важнее всего: пути к базе и логу внутри скрипта
**относительные**. При неверном `AppDirectory` сборщик молча заведёт пустую
базу в другом месте и будет писать в неё — с виду работая.

```
nssm install ITS-SmdrCollector "C:\Python311\python.exe" "Collector.Py"
nssm set ITS-SmdrCollector AppDirectory "C:\IT-services\SMDR"
nssm set ITS-SmdrCollector DisplayName "ИТ-сервисы: сборщик звонков с АТС"
nssm set ITS-SmdrCollector Description "Принимает записи SMDR с АТС и складывает в smdr.db"
nssm set ITS-SmdrCollector Start SERVICE_AUTO_START
nssm set ITS-SmdrCollector AppStdout "C:\IT-services\logs\collector.out.log"
nssm set ITS-SmdrCollector AppStderr "C:\IT-services\logs\collector.err.log"
nssm set ITS-SmdrCollector AppRotateFiles 1
nssm set ITS-SmdrCollector AppRotateOnline 1
nssm set ITS-SmdrCollector AppRotateBytes 10485760
nssm set ITS-SmdrCollector AppThrottle 10000
nssm set ITS-SmdrCollector AppRestartDelay 5000
nssm set ITS-SmdrCollector AppStopMethodConsole 5000
```

### Журнал звонков — порт 3102

```
nssm install ITS-SmdrWeb "C:\Program Files\nodejs\node.exe" "server.js"
nssm set ITS-SmdrWeb AppDirectory "C:\IT-services\SMDR\web-node"
nssm set ITS-SmdrWeb DisplayName "ИТ-сервисы: журнал звонков"
nssm set ITS-SmdrWeb Description "Журнал, статистика и справочник добавочных"
nssm set ITS-SmdrWeb Start SERVICE_AUTO_START
nssm set ITS-SmdrWeb AppStdout "C:\IT-services\logs\smdrweb.out.log"
nssm set ITS-SmdrWeb AppStderr "C:\IT-services\logs\smdrweb.err.log"
nssm set ITS-SmdrWeb AppRotateFiles 1
nssm set ITS-SmdrWeb AppRotateOnline 1
nssm set ITS-SmdrWeb AppRotateBytes 10485760
nssm set ITS-SmdrWeb AppThrottle 10000
nssm set ITS-SmdrWeb AppRestartDelay 5000
```

### Искра — порт 3103

```
nssm install ITS-Iskra "C:\Program Files\nodejs\node.exe" "server.js"
nssm set ITS-Iskra AppDirectory "C:\IT-services\MESSENGER"
nssm set ITS-Iskra DisplayName "ИТ-сервисы: мессенджер Искра"
nssm set ITS-Iskra Description "Сервер обмена сообщениями и раздача обновлений клиента"
nssm set ITS-Iskra Start SERVICE_AUTO_START
nssm set ITS-Iskra AppStdout "C:\IT-services\logs\iskra.out.log"
nssm set ITS-Iskra AppStderr "C:\IT-services\logs\iskra.err.log"
nssm set ITS-Iskra AppRotateFiles 1
nssm set ITS-Iskra AppRotateOnline 1
nssm set ITS-Iskra AppRotateBytes 10485760
nssm set ITS-Iskra AppThrottle 10000
nssm set ITS-Iskra AppRestartDelay 5000
```

---

## 5. Запуск и проверка

Сборщик первым: он создаёт таблицу `calls`, по которой веб-часть заводит
индексы. Порядок остальных не важен.

```
nssm start ITS-SmdrCollector
nssm start ITS-SmdrWeb
nssm start ITS-CertViewer
nssm start ITS-Iskra
nssm start ITS-Platform
```

```powershell
Get-Service ITS-* | Select-Object Name, Status, StartType

foreach ($p in 3000,3101,3102,3103) {
  "{0} -> {1}" -f $p, (Test-NetConnection 127.0.0.1 -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded
}

curl.exe http://127.0.0.1:3000/api/health
```

Здоровая платформа отвечает `{"ok":true}`.

Дальше — в браузере на самом сервере: откройте платформу, войдите, проверьте,
что открываются пункты меню «Сертификаты», «МЧД» и «Журнал звонков». Если
модуль пишет «временно недоступен» — платформа не достучалась до его порта,
смотрите лог этого модуля в `C:\IT-services\logs\`.

---

## 6. Повседневное управление

```
nssm start   ITS-Platform
nssm stop    ITS-Platform
nssm restart ITS-Platform
nssm status  ITS-Platform
```

То же для `ITS-CertViewer`, `ITS-SmdrWeb`, `ITS-SmdrCollector`, `ITS-Iskra`.
Через графический интерфейс — `services.msc`.

### Когда нужен перезапуск

| Что поменяли | Перезапуск |
|---|---|
| `.env` любого компонента | да, того компонента |
| `server.js`, `db.js`, файлы в `routes\`, `services\`, `config\` | да |
| `Collector.Py` | да, `ITS-SmdrCollector` |
| `public\*` (стили, скрипты, разметка), `.ejs` | нет, достаточно обновить страницу |
| `node_modules` | да |
| сертификат сервера через панель платформы | платформе — нет, **«Искре» — да** |

Последняя строка не опечатка: платформа перечитывает сертификат из общего
хранилища на лету, «Искра» слежения за файлом не имеет и до перезапуска
предъявляет прежний.

### Куда смотреть, если что-то не так

| Файл | Что там |
|---|---|
| `C:\IT-services\logs\*.out.log`, `*.err.log` | вывод служб, ошибки запуска |
| `C:\IT-services\SMDR\collector.log` | подробности сборщика: вход на АТС, принятые строки, обрывы |

---

## 7. Чего делать не надо

**Не задавайте переменные окружения в NSSM** — ни платформе, ни Сертвиверу,
ни SMDR. У всех троих свой разбор `.env`, и **окружение процесса в нём
побеждает файл**. Задав, например, `SMDR_PASSWORD` во вкладке Environment, вы
получите ситуацию, в которой `.env` выглядит настроенным, а работает совсем
другое значение — и понять это по файлу невозможно.

Проверить, что откуда взялось, можно по первой строке `collector.log` после
запуска: там пишется источник и длина каждого значения (сам пароль — нет).

**У «Искры» правило обратное**: загрузчика `.env` у неё нет, всё берётся из
окружения. Обязательных переменных при этом тоже нет — ключ подписи она
генерирует сама при первом запуске и хранит в своей базе. Если вкладка
Environment у неё уже заполнена, **не очищайте её**: сотрёте `JWT_SECRET` —
у всех разом отвалятся выданные клиентам токены, придётся входить заново.

**Не запускайте вторую копию сборщика** — ни вручную «на посмотреть», ни
второй службой. Про одну SMDR-сессию сказано выше.

---

## 8. Если не поднимается

**Служба стартует и сразу останавливается.** Смотрите `*.err.log` в
`C:\IT-services\logs\`. Частые причины: нет каталога `logs`, не перенесли
`node_modules`, не создан `.env`, занят порт.

**Порт занят.** `netstat -ano | findstr :3000` покажет процесс, `tasklist /FI
"PID eq НОМЕР"` — кто это.

**Сборщик пишет «АТС НЕ ПРИНЯЛА ПАРОЛЬ».** Сверьте `SMDR_PASSWORD` в
`C:\IT-services\SMDR\.env` с тем, что задано на самой АТС (Maintenance Console
→ SMDR Options). Длина значения видна в строке «Настройки» в начале
`collector.log`.

**В журнале звонков одна и та же запись много раз.** Значит работает больше
одной копии сборщика либо старая версия без защиты от повторной выдачи буфера.
Убедитесь, что копия одна и код свежий. Уже накопившееся чистится так:

```sql
SELECT COUNT(*) - COUNT(DISTINCT raw_line) AS лишних FROM calls WHERE raw_line IS NOT NULL;

DELETE FROM calls
WHERE raw_line IS NOT NULL
  AND id NOT IN (SELECT MIN(id) FROM calls WHERE raw_line IS NOT NULL GROUP BY raw_line);
```

Оставляет самую раннюю копию каждой записи. Сделайте копию `smdr.db` перед
этим.

**Журнал звонков падает с `NODE_MODULE_VERSION`.** `better-sqlite3` собран под
другую версию Node. Возьмите `node_modules` с машины с той же версией.
