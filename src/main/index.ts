import { app, BrowserWindow } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import * as dotenv from 'dotenv';
import { AppMenu } from './Menu';
import { EventManager } from './EventManager';
import { setupAgentHandler } from './agent-handler';
import { setMainWindow } from './window-ref';

// Load environment variables from .env file
// Try multiple paths to find .env file (dev vs production)
const possibleEnvPaths = [
  join(__dirname, '../../.env'),        // Development: out/main -> root
  join(__dirname, '../../../.env'),     // Production alternative
  join(process.cwd(), '.env'),          // Current working directory (most reliable)
];

// Try each path until one works
let envLoaded = false;
for (const envPath of possibleEnvPaths) {
  const result = dotenv.config({ path: envPath });
  if (!result.error) {
    envLoaded = true;
    console.log(`[Main] Loaded .env from: ${envPath}`);
    break;
  }
}

if (!envLoaded) {
  console.warn('[Main] Warning: Could not load .env file from any expected location');
}

// 1. IMPORT YOUR CUSTOM WINDOW CLASS
import { Window } from './Window'; 

// 2. USE THE CUSTOM TYPE
let mainWindow: Window | null = null;
let eventManager: EventManager | null = null;
let menu: AppMenu | null = null;

function createWindow(): void {
  // 3. INSTANTIATE YOUR CUSTOM WINDOW
  mainWindow = new Window();

  // Set the window reference for other modules (e.g., tab-cdp-bridge)
  setMainWindow(mainWindow);

  // Show the window after creation
  mainWindow.show();

  // Note: Window size is set in the Window constructor via BaseWindow options
  // If we need to resize, we can do it here, but BaseWindow.setBounds may have timing issues
  // For now, the initial size is set in the constructor (1000x800)
}

// Enable remote debugging port for CDP connection
app.commandLine.appendSwitch('--remote-debugging-port', '9222');

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  if (mainWindow) {
    // Initialize EventManager IMMEDIATELY after window creation
    // This ensures IPC handlers are registered before renderer processes try to use them
    eventManager = new EventManager(mainWindow);
    menu = new AppMenu(mainWindow);

    // Setup agent handler with window and sidebar webContents
    const sidebarWebContents = mainWindow.sidebar.view.webContents;
    setupAgentHandler(mainWindow, sidebarWebContents);

    // Note: The active tab already loads Google by default (set in Tab constructor)
    // No need to override it here
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      // Re-initialize EventManager for new window
      if (mainWindow) {
        eventManager?.cleanup();
        eventManager = new EventManager(mainWindow);
      }
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
    setMainWindow(null);
  }
  if (menu) {
    menu = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});