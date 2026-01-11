import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Tab } from './Tab';
import { getMainWindow } from './window-ref';

let cachedBrowser: Browser | null = null;
let cachedContext: BrowserContext | null = null;
const CDP_ENDPOINT = 'http://localhost:9222';

// Track agent worker tabs for cleanup
const agentWorkerTabs: Map<string, Tab> = new Map();

/**
 * Get or create a cached Playwright browser connection to the Electron app via CDP
 */
async function getBrowserConnection(): Promise<{ browser: Browser; context: BrowserContext }> {
  if (cachedBrowser && cachedContext) {
    // Check if connection is still alive
    try {
      await cachedBrowser.version();
      return { browser: cachedBrowser, context: cachedContext };
    } catch (error) {
      // Connection lost, reconnect
      cachedBrowser = null;
      cachedContext = null;
    }
  }

  try {
    cachedBrowser = await chromium.connectOverCDP(CDP_ENDPOINT);
    // Get the default context (CDP connections have only one context)
    const contexts = cachedBrowser.contexts();
    cachedContext = contexts[0] || await cachedBrowser.newContext();
    console.log('[CDP Bridge] Connected to Electron via CDP');
    return { browser: cachedBrowser, context: cachedContext };
  } catch (error) {
    console.error('[CDP Bridge] Failed to connect to CDP endpoint:', error);
    throw new Error(`Failed to connect to CDP endpoint at ${CDP_ENDPOINT}. Make sure --remote-debugging-port=9222 is enabled.`);
  }
}

/**
 * Get all Playwright pages from all browser contexts
 */
async function getAllPages(): Promise<Page[]> {
  const { browser } = await getBrowserConnection();
  const contexts = browser.contexts();
  const allPages: Page[] = [];
  
  for (const context of contexts) {
    const pages = context.pages();
    allPages.push(...pages);
  }
  
  return allPages;
}

/**
 * Match a Playwright Page to an Electron Tab by URL
 */
function matchPageByUrl(playwrightPage: Page, tabUrl: string): boolean {
  try {
    const pageUrl = playwrightPage.url();
    
    // Exact match
    if (pageUrl === tabUrl) {
      return true;
    }
    
    // For file:// URLs, match by normalized path
    if (tabUrl.startsWith('file://') && pageUrl.startsWith('file://')) {
      const normalizeUrl = (url: string) => url.replace(/\\/g, '/').toLowerCase();
      return normalizeUrl(pageUrl) === normalizeUrl(tabUrl);
    }
    
    // For http/https URLs, try to match by hostname and path
    try {
      const tabUrlObj = new URL(tabUrl);
      const pageUrlObj = new URL(pageUrl);
      
      if (tabUrlObj.hostname === pageUrlObj.hostname && 
          tabUrlObj.pathname === pageUrlObj.pathname) {
        return true;
      }
    } catch {
      // Invalid URLs, skip
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the Playwright Page and BrowserContext for an Electron Tab
 * @param tab The Electron Tab to match
 * @returns Object containing the Playwright Page and BrowserContext, or null if not found
 */
export async function getPlaywrightPageForTab(tab: Tab): Promise<{ page: Page; context: BrowserContext } | null> {
  try {
    const allPages = await getAllPages();
    const tabUrl = tab.url;
    
    // First, try exact URL match
    let matchedPage = allPages.find(page => matchPageByUrl(page, tabUrl));
    
    // If no exact match and tab URL is not yet loaded, try matching by title
    if (!matchedPage && tab.title && tab.title !== 'New Tab') {
      for (const page of allPages) {
        try {
          const pageTitle = await page.title();
          if (pageTitle === tab.title) {
            matchedPage = page;
            break;
          }
        } catch {
          // Skip pages that can't be accessed
          continue;
        }
      }
    }
    
    // If still no match and there's only one non-devtools page, use it
    if (!matchedPage) {
      const nonDevtoolsPages = allPages.filter(page => {
        const url = page.url();
        return !url.includes('chrome-devtools://') && 
               !url.includes('devtools://');
      });
      
      if (nonDevtoolsPages.length === 1) {
        matchedPage = nonDevtoolsPages[0];
      }
    }
    
    if (!matchedPage) {
      console.warn(`[CDP Bridge] Could not find matching Playwright page for tab ${tab.id} with URL: ${tabUrl}`);
      return null;
    }
    
    // Get the context that owns this page
    const { browser } = await getBrowserConnection();
    const contexts = browser.contexts();
    
    for (const context of contexts) {
      const pages = context.pages();
      if (pages.includes(matchedPage)) {
        return { page: matchedPage, context };
      }
    }
    
    console.warn(`[CDP Bridge] Could not find browser context for matched page`);
    return null;
  } catch (error) {
    console.error('[CDP Bridge] Error getting Playwright page for tab:', error);
    return null;
  }
}

/**
 * Create a new agent worker page by requesting Electron to create a tab
 * and using context.waitForEvent('page') to capture it via CDP
 * @param url The initial URL for the worker page (default: about:blank)
 * @returns Object containing the Playwright Page, BrowserContext, and tabId, or null if creation failed
 */
export async function createAgentWorkerPage(url: string = 'about:blank'): Promise<{ page: Page; context: BrowserContext; tabId: string } | null> {
  console.log(`[CDP Bridge] createAgentWorkerPage called with url: ${url}`);
  
  try {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      console.error('[CDP Bridge] Cannot create agent worker page: mainWindow not available');
      return null;
    }
    console.log('[CDP Bridge] mainWindow is available');

    // Get the CDP context - in CDP mode there's only one context
    console.log('[CDP Bridge] Getting browser connection...');
    const { context } = await getBrowserConnection();
    console.log('[CDP Bridge] Got browser context');
    
    // Get current pages for comparison
    const pagesBefore = context.pages();
    const pageUrlsBefore = new Set(pagesBefore.map(p => p.url()));
    console.log(`[CDP Bridge] Pages before tab creation: ${pagesBefore.length}, URLs: ${Array.from(pageUrlsBefore).join(', ')}`);
    
    // Create a new tab in Electron
    console.log('[CDP Bridge] Creating new Electron tab...');
    const tab = mainWindow.createTab(url);
    const tabId = tab.id;
    
    console.log(`[CDP Bridge] Created agent worker tab ${tabId}`);

    // Track this tab for cleanup
    agentWorkerTabs.set(tabId, tab);

    // Try waitForEvent first with a short timeout, then fall back to polling
    let newPage: Page | null = null;
    
    // Method 1: Try waitForEvent with short timeout
    console.log('[CDP Bridge] Trying waitForEvent approach...');
    try {
      const pagePromise = context.waitForEvent('page', { timeout: 5000 });
      newPage = await pagePromise;
      console.log(`[CDP Bridge] Captured new page via waitForEvent: ${newPage.url()}`);
    } catch (eventError) {
      console.log('[CDP Bridge] waitForEvent timed out, falling back to polling...');
      
      // Method 2: Poll for new pages
      const maxAttempts = 20;
      const pollInterval = 250;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const pagesNow = context.pages();
        console.log(`[CDP Bridge] Polling attempt ${attempt + 1}: ${pagesNow.length} pages`);
        
        // Find a page that wasn't there before
        for (const page of pagesNow) {
          const pageUrl = page.url();
          if (!pageUrlsBefore.has(pageUrl) || 
              (pageUrl === 'about:blank' && pagesNow.length > pagesBefore.length)) {
            newPage = page;
            console.log(`[CDP Bridge] Found new page via polling: ${pageUrl}`);
            break;
          }
        }
        
        if (newPage) break;
        
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }
    
    if (!newPage) {
      throw new Error('Could not capture new page via CDP - neither waitForEvent nor polling worked');
    }
    
    console.log(`[CDP Bridge] Captured new page: ${newPage.url()}`);
    
    // Wait for the page to be ready
    await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {
      // Ignore timeout for about:blank
      if (url !== 'about:blank') {
        throw new Error('Page load timeout');
      }
    });

    // If we need to navigate to a specific URL (not about:blank)
    if (url !== 'about:blank' && newPage.url() !== url) {
      await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    
    console.log(`[CDP Bridge] Successfully connected to agent worker page for tab ${tabId}`);
    return { page: newPage, context, tabId };
    
  } catch (error: any) {
    console.error('[CDP Bridge] Error creating agent worker page:', error?.message || error);
    
    // Try to clean up the tab if we created it
    const mainWindow = getMainWindow();
    if (mainWindow) {
      const failedTabs = Array.from(agentWorkerTabs.keys());
      for (const failedTabId of failedTabs) {
        try {
          mainWindow.closeTab(failedTabId);
          agentWorkerTabs.delete(failedTabId);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
    
    return null;
  }
}

/**
 * Close an agent worker page/tab
 * @param tabId The ID of the tab to close
 */
export async function closeAgentWorkerPage(tabId: string): Promise<void> {
  try {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
      console.warn('[CDP Bridge] Cannot close agent worker page: mainWindow not available');
      return;
    }

    if (agentWorkerTabs.has(tabId)) {
      mainWindow.closeTab(tabId);
      agentWorkerTabs.delete(tabId);
      console.log(`[CDP Bridge] Closed agent worker tab ${tabId}`);
    } else {
      console.warn(`[CDP Bridge] Agent worker tab ${tabId} not found in tracking map`);
      // Try to close it anyway in case it exists
      mainWindow.closeTab(tabId);
    }
  } catch (error) {
    console.error(`[CDP Bridge] Error closing agent worker page ${tabId}:`, error);
  }
}

/**
 * Clean up all agent worker tabs
 */
export async function cleanupAgentWorkerTabs(): Promise<void> {
  const mainWindow = getMainWindow();
  if (mainWindow) {
    for (const tabId of agentWorkerTabs.keys()) {
      try {
        mainWindow.closeTab(tabId);
      } catch (error) {
        console.error(`[CDP Bridge] Error closing agent worker tab ${tabId}:`, error);
      }
    }
  }
  agentWorkerTabs.clear();
}

/**
 * Clean up the cached browser connection
 */
export async function closeBrowserConnection(): Promise<void> {
  // First clean up any agent worker tabs
  await cleanupAgentWorkerTabs();
  
  if (cachedBrowser) {
    try {
      await cachedBrowser.close();
    } catch (error) {
      console.error('[CDP Bridge] Error closing browser connection:', error);
    }
    cachedBrowser = null;
    cachedContext = null;
  }
}
