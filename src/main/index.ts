import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { AppMenu } from './Menu';
import { EventManager } from './EventManager';
import { setupAgentHandler } from './agent-handler';

// 1. IMPORT YOUR CUSTOM WINDOW CLASS
import { Window } from './Window'; 

// 2. USE THE CUSTOM TYPE
let mainWindow: Window | null = null;
let eventManager: EventManager | null = null;
let menu: AppMenu | null = null;

function createWindow(): void {
  // 3. INSTANTIATE YOUR CUSTOM WINDOW
  mainWindow = new Window();

  // Set window size
  mainWindow.setBounds({
    width: 900,
    height: 670
  });

  // Show the window after creation
  mainWindow.show();

  // Handle HMR - load URL into the active tab
  const activeTab = mainWindow.activeTab;
  if (activeTab) {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      activeTab.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
      activeTab.loadURL(`file://${join(__dirname, '../renderer/index.html')}`);
    }
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  if (mainWindow) {
    // These now work because mainWindow is the correct 'Window' type
    eventManager = new EventManager(mainWindow);
    menu = new AppMenu(mainWindow);

    // 4. PASS WEBCONTENTS TO THE AGENT
    // Use the active tab's webContents for agent communication
    const activeTab = mainWindow.activeTab;
    if (activeTab) {
      setupAgentHandler(activeTab.webContents);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (eventManager) {
    eventManager.cleanup();
    eventManager = null;
  }
  if (mainWindow) {
    mainWindow = null;
  }
  if (menu) {
    menu = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});