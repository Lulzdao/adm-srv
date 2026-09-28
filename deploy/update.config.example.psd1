# Настройки обновления. Скопируйте в корень установки как update.config.psd1
# (C:\IT-services\update.config.psd1) и поправьте то, что отличается.
# Файла может и не быть — тогда действуют значения по умолчанию, указанные здесь.
@{
  # Корень установки. По умолчанию — папка, в которой лежит deploy\update.ps1, на уровень выше.
  # InstallRoot = 'C:\IT-services'

  Repo   = 'Lulzdao/adm-srv'
  Branch = 'main'

  # Прокси для выхода на GitHub и npm. Пусто — системный прокси Windows (как у браузера, с PAC).
  # Если скачать не выйдет, update.ps1 сам спросит адрес и предложит записать его сюда.
  Proxy = ''
  # Входить на прокси под учётной записью, от которой запущен скрипт (NTLM/Kerberos).
  ProxyUseDefaultCredentials = $true

  # Компонент стоит не в <InstallRoot>\<имя> и службы NSSM на него не указывают:
  # Paths = @{ MESSENGER = 'C:\ISKRA\iskra-server' }
  Paths = @{}

  # Порт для проверки после запуска, если не 3000/3101/3102/3103 и не задан в .env модуля:
  # Ports = @{ MESSENGER = 3203 }
  Ports = @{}

  # Сколько резервных копий прошлых версий хранить (.update\backup).
  KeepBackups = 5
}
