const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

// Версия и трек сборки — синхронно, а не через IPC: они нужны в самый момент открытия соединения с
// сервером (см. connectWs в окнах), а ждать там асинхронный ответ значило бы задерживать
// подключение ради двух строк. В собранном приложении buildTrack проставлен при сборке
// (extraMetadata), при запуске из исходников его нет — тогда 'dev'.
const pkg = require('./package.json');

contextBridge.exposeInMainWorld('desktop', {
  hostname: os.hostname(),
  appVersion: pkg.version,
  buildTrack: pkg.buildTrack || 'dev',
  openChat: (payload) => ipcRenderer.send('open-chat', payload),
  openBroadcast: (payload) => ipcRenderer.send('open-broadcast', payload),
  showUserMenu: (payload) => ipcRenderer.send('show-user-menu', payload),
  // ПКМ по отделу в списке контактов — «Сообщение всему отделу».
  showDepartmentMenu: (payload) => ipcRenderer.send('show-department-menu', payload),
  showMessageMenu: (payload) => ipcRenderer.send('show-message-menu', payload),
  windowAction: (action) => ipcRenderer.send('window-action', action),
  notify: (payload) => ipcRenderer.send('notify', payload),
  logout: () => ipcRenderer.send('logout'),
  onIdleState: (cb) => ipcRenderer.on('idle-state', (event, payload) => cb(payload)),
  onFilesToSend: (cb) => ipcRenderer.on('files-to-send', (event, files) => cb(files)),
  onShowAlert: (cb) => ipcRenderer.on('show-alert', (event, payload) => cb(payload)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (event, settings) => cb(settings)),
  onWindowState: (cb) => ipcRenderer.on('window-state', (event, state) => cb(state)),
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  setServerUrl: (url) => ipcRenderer.invoke('set-server-url', url),
  getIdleState: () => ipcRenderer.invoke('get-idle-state'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (partial) => ipcRenderer.send('set-settings', partial),
  downloadFile: (url, downloadId) => ipcRenderer.send('download-file', url, downloadId),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (event, payload) => cb(payload)),
  onToast: (cb) => ipcRenderer.on('toast', (event, payload) => cb(payload)),
  pickDownloadFolder: () => ipcRenderer.invoke('pick-download-folder'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  // Индикатор шифрования и служебное окно смены адреса в ростере (Ctrl+Shift+S).
  getConnectionInfo: () => ipcRenderer.invoke('get-connection-info'),
  // Почему не удалось достучаться до сервера. Chromium не раскрывает окну причину сбоя fetch —
  // отвечает главный процесс, см. diagnoseServer в main.js.
  diagnoseServer: () => ipcRenderer.invoke('diagnose-server'),
  relaunch: () => ipcRenderer.send('relaunch'),
  // Обновление приложения — см. setupUpdater в main.js.
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  onUpdateState: (cb) => ipcRenderer.on('update-state', (event, state) => cb(state)),
  checkUpdates: () => ipcRenderer.send('check-updates'),
  // Обновление, запущенное администратором из веб-панели: качает и ставит без вопросов.
  forceUpdate: () => ipcRenderer.send('force-update'),
  readLocalLog: () => ipcRenderer.invoke('read-local-log'),
  // Событие главного процесса (сбой обновления, падение окна), которое ростер пересылает на сервер:
  // токен для обращения к серверу есть только у него. См. logLocal в main.js.
  onReportToServer: (cb) => ipcRenderer.on('report-to-server', (event, payload) => cb(payload)),
  downloadUpdate: () => ipcRenderer.send('download-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  getUnreadState: () => ipcRenderer.invoke('get-unread-state'),
  seedUnread: (payload) => ipcRenderer.invoke('seed-unread', payload),
  onUnreadState: (cb) => ipcRenderer.on('unread-state', (event, state) => cb(state)),
  // Приложение закрывается по сигналу Windows о завершении сеанса (см. beginShutdown в main.js).
  // Окну это нужно, чтобы перестать переподключать WebSocket и не показывать диалог о потере
  // связи: сеть на выключении отваливается раньше нас, и без этого каждое окно в последние
  // мгновения жизни успевает открыть новый сокет и нарисовать модалку — лишняя работа ровно
  // тогда, когда главный процесс уже сносит окна.
  onShuttingDown: (cb) => ipcRenderer.on('app-shutting-down', () => cb()),
});
