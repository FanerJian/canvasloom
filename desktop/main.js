// ============================================================
// CanvasLoom 桌面壳（Electron）—— 双击即开独立应用窗口
//   职责边界：本地服务由「启动编辑器.vbs」负责拉起（保持既有架构：
//   服务常驻 + UI 客户端；关闭窗口不停止服务，停止用 停止编辑器.cmd）。
//   本壳只负责：连上 127.0.0.1:8520、记住窗口尺寸、应用图标与单实例。
// ============================================================
const { app, BrowserWindow, Menu, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
// 测试/验收可用 CANVASLOOM_DESKTOP_PORT 换端口；正式恒为 8520（与网页模式同源同数据）
const PORT = parseInt(process.env.CANVASLOOM_DESKTOP_PORT, 10) || 8520;
const BASE_URL = `http://127.0.0.1:${PORT}/`;

let win = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /api/hello 200 且 ok===true 才认定是 CanvasLoom 服务（防止连到别的程序占用的端口）
function probeServer(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}api/hello`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); }
        catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// VBS 启动器保证服务先就绪再开窗；这里轮询只为容错（服务重启中等几秒）
async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    if (await probeServer(400)) return true;
    await sleep(150);
  }
  return false;
}

function boundsFile() {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}

function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { return null; }
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds())); } catch { /* 磁盘异常时忽略 */ }
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    width: (b && b.width) || 1440,
    height: (b && b.height) || 900,
    x: b ? b.x : undefined,
    y: b ? b.y : undefined,
    minWidth: 980,
    minHeight: 620,
    title: '界面工坊 CanvasLoom',
    icon: path.join(ROOT, 'canvasloom.ico'),
    backgroundColor: '#f5f6f8', // 与 --bg 同源，避免启动白闪
    autoHideMenuBar: true,
    show: false,
    webPreferences: { spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', saveBounds);
  win.on('closed', () => { win = null; });
  // F12 = 开发者工具（排障用）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  win.loadURL(BASE_URL);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('canvasloom.desktop'); // 任务栏独立于其他 Electron 应用
  Menu.setApplicationMenu(null); // 顶部菜单栏收起，界面与网页版一致
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    const ok = await waitForServer();
    if (!ok) {
      dialog.showErrorBox('界面工坊', `没有连上本地服务 127.0.0.1:${PORT}。\n请从桌面快捷方式「界面工坊 CanvasLoom」启动；或先运行 启动编辑器.cmd 查看服务日志。`);
      app.quit();
      return;
    }
    createWindow();
    // 验收钩子：CANVASLOOM_DESKTOP_SHOT=绝对路径 → 加载完成后截图并退出（供自动验收）
    const shot = process.env.CANVASLOOM_DESKTOP_SHOT;
    if (shot && win) {
      win.webContents.once('did-finish-load', async () => {
        await sleep(1800); // 等编辑器初始化并自动打开最近项目
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shot, img.toPNG());
        } catch (e) {
          console.error('[CanvasLoom] 截图失败：', e);
        }
        app.exit(0);
      });
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    saveBounds();
  });
}
