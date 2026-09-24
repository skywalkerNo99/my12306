const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { isBackgroundLaunch, createWindowMode } = require('./window-mode.cjs');
app.setName('my12306 Light');
if (process.env.MY12306_LIGHT_TEST_DIR) app.setPath('userData', path.resolve(process.env.MY12306_LIGHT_TEST_DIR));
let window, settingsWindow, tray, quitting = false, settings = {}, authCallback;
const configPath = () => path.join(app.getPath('userData'), 'connection.json');
const setupPath = path.join(__dirname, 'settings.html');
const mode = createWindowMode({ app, getWindow: () => window, platform: process.platform });
function validUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('请输入不含账号和参数的 HTTPS 服务地址');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}
function allowed(value) { try { const u = new URL(value), base = new URL(settings.url); return u.origin === base.origin && u.pathname.startsWith(base.pathname); } catch { return false; } }
function loginOptions() { return process.platform === 'win32' ? { path: process.execPath, args: ['--autostart'] } : {}; }
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow.show();
  settingsWindow = new BrowserWindow({ width: 540, height: 490, resizable: false, title: '连接服务器', webPreferences: { preload: path.join(__dirname, 'settings-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', e => e.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = null; if (authCallback) { authCallback(); authCallback = null; } });
  void settingsWindow.loadFile(setupPath);
}
function menu() {
  const items = [
    { label: '打开 my12306 Light', click: mode.show },
    { label: '连接设置', click: openSettings },
    { label: '重新连接', click: () => void connect(false) },
    { label: '后台运行', click: mode.hide },
    { label: '开机自动后台运行', type: 'checkbox', checked: app.getLoginItemSettings(loginOptions()).openAtLogin, enabled: app.isPackaged, click: item => { app.setLoginItemSettings({ ...loginOptions(), openAtLogin: item.checked }); menu(); } },
    { label: '退出', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'my12306 Light', submenu: items }, { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: '窗口', submenu: [{ role: 'reload' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] }]));
}
async function connect(background) {
  if (!window) {
    window = new BrowserWindow({ width: 1220, height: 860, minWidth: 480, minHeight: 540, show: false, title: 'my12306 Light', webPreferences: { partition: 'persist:remote', contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
    window.webContents.session.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault(); });
    window.webContents.on('will-redirect', (e, url) => { if (!allowed(url)) e.preventDefault(); });
    window.on('close', e => { if (!quitting) { e.preventDefault(); mode.hide(); } });
  }
  try { await window.loadURL(settings.url); mode.loaded(background); }
  catch { mode.loaded(background); if (!background) { dialog.showErrorBox('连接失败', '请检查网络和服务器地址，然后在菜单中选择“重新连接”。'); openSettings(); } }
}
app.on('login', (event, wc, details, authInfo, callback) => {
  if (wc !== window?.webContents || !allowed(details.url) || authInfo.isProxy) return;
  event.preventDefault();
  // Prompt for the existing public gateway's Basic Auth. Never embed credentials in URLs.
  authCallback?.(); authCallback = callback; openSettings();
});
ipcMain.handle('connection:load', e => { if (e.sender !== settingsWindow?.webContents) throw new Error('Forbidden'); return { url: settings.url || 'https://etl-workflow.atominnolab.com:4200/my12306/', username: settings.username || '', authentication: !!authCallback }; });
ipcMain.handle('connection:save', async (e, input) => {
  if (e.sender !== settingsWindow?.webContents || e.senderFrame !== settingsWindow.webContents.mainFrame) throw new Error('Forbidden');
  const next = { url: validUrl(input.url), username: String(input.username || '') };
  if (authCallback && next.url !== settings.url) throw new Error('验证入口身份时不能更换服务器');
  settings = next;
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next), { mode: 0o600 });
  if (authCallback) { const cb = authCallback; authCallback = null; cb(next.username, String(input.password || '')); settingsWindow.close(); }
  else { settingsWindow.close(); void connect(false); }
  return true;
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, args) => mode.secondInstance(args));
  app.on('activate', () => { if (window) mode.activate(); else openSettings(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(() => {
    try { settings = JSON.parse(fs.readFileSync(configPath(), 'utf8')); settings.url = validUrl(settings.url); } catch { settings = {}; }
    const background = isBackgroundLaunch(process.argv, app.getLoginItemSettings(loginOptions()));
    if (background) mode.hide();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 22, height: 22 }));
    tray.setToolTip('my12306 Light · 任务由服务器执行'); tray.on('click', mode.show); menu();
    if (settings.url) void connect(background); else openSettings();
  });
}
