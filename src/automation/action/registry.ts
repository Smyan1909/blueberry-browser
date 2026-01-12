import { z } from 'zod';
import { Page, ElementHandle } from 'playwright';
import { DomService } from '../dom';
import { E2BService } from '../sandbox/e2b-service';

const e2b = new E2BService();

export interface ActionTool<T = any> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  execute: (params: T, context: ActionContext) => Promise<ActionResult>;
}

export interface ActionContext {
  page: Page;
  selectorMap: Map<number, ElementHandle>;
  domService: DomService;
}

export interface ActionResult {
  success: boolean;
  output: string; // The text we feed back to the LLM
}

/**
 * Helper to wrap any action in a safety net.
 * This ensures the Agent always gets a clean string response, never a crash.
 */
async function safeExecute(
  operation: () => Promise<string>
): Promise<ActionResult> {
  try {
    const message = await operation();
    return { success: true, output: message };
  } catch (error: any) {
    // We purposefully catch the error and return it as text.
    // This allows the LLM to see "Error: Element not visible" and try again.
    return { success: false, output: `Action Failed: ${error.message}` };
  }
}

export const ActionRegistry = {

  // --- NAVIGATION ---

  navigate: {
    name: 'navigate',
    description: 'Go to a specific URL.',
    schema: z.object({
      url: z.string(),
    }),
    execute: async (params, { page }) => {
      return safeExecute(async () => {
        const { url } = params || {};
        if (!url) throw new Error(`Missing required parameter 'url'. Received: ${JSON.stringify(params)}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return `Navigated to ${url}`;
      });
    }
  } as ActionTool<{ url: string }>,

  refresh: {
    name: 'refresh',
    description: 'Refresh the current page.',
    schema: z.object({}),
    execute: async (_, { page }) => {
      return safeExecute(async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        return 'Page refreshed';
      });
    }
  } as ActionTool<{}>,

  go_back: {
    name: 'go_back',
    description: 'Navigate back in browser history.',
    schema: z.object({}),
    execute: async (_, { page }) => {
      return safeExecute(async () => {
        await page.goBack();
        return 'Navigated back';
      });
    }
  } as ActionTool<{}>,

  // --- INTERACTION ---

  click: {
    name: 'click_element',
    description: 'Click on an interactive element identified by its numeric ID. The ID is shown in the screenshot overlay.',
    schema: z.object({
      index: z.number().describe('The numeric ID of the element to click'),
      open_in_new_tab: z.boolean().optional().default(false).describe('If true, holds Control/Command to open in a new tab')
    }),
    execute: async (params, { selectorMap, domService }) => {
      return safeExecute(async () => {
        // Defensive: ensure params is an object and extract with defaults
        const { index, open_in_new_tab = false } = params || {};
        if (index === undefined || index === null) {
          throw new Error(`Missing required parameter 'index'. Received params: ${JSON.stringify(params)}`);
        }

        const element = selectorMap.get(index);
        if (!element) throw new Error(`Element #${index} not found (stale).`);

        // Scroll element into view if needed
        try { await element.scrollIntoViewIfNeeded(); } catch (e) { }

        // Small wait for scroll animation to complete
        await new Promise(r => setTimeout(r, 100));

        // Get FRESH bounding box AFTER scrolling (important!)
        const box = await element.boundingBox();
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;

          // Move the Fake Cursor there
          await domService.highlightClick(x, y);

          // Brief delay to let the user see the cursor
          await new Promise(r => setTimeout(r, 200));
        }

        const modifiers: ('Control' | 'Meta')[] = open_in_new_tab ? ['Control', 'Meta'] : [];

        try {
          // Use short timeout - if click takes too long, a popup is likely blocking
          if (open_in_new_tab) {
            await element.click({ modifiers: modifiers, timeout: 5000 });
            return `Ctrl+Clicked element #${index} (opened in new tab)`;
          } else {
            await element.click({ timeout: 5000 });
            return `Clicked element #${index}`;
          }
        } catch (clickError: any) {
          // Provide actionable error when click times out (usually means popup is blocking)
          if (clickError.message?.includes('timeout') || clickError.message?.includes('Timeout')) {
            throw new Error(`Click on #${index} timed out - a popup/modal is probably blocking it! Try press_key({ key: "Escape" }) first to dismiss any overlays.`);
          }
          throw clickError;
        }
      });
    }
  } as ActionTool<{ index: number; open_in_new_tab: boolean }>,

  type: {
    name: 'input_text',
    description: 'Type text into an input field.',
    schema: z.object({
      index: z.number(),
      text: z.string(), // We keep input as string, but the agent might send "20"
      clear: z.boolean().optional().default(true),
      submit: z.boolean().optional().default(false)
    }),
    execute: async (params, { selectorMap, page }) => {
      return safeExecute(async () => {
        // Defensive: ensure params is an object and extract with defaults
        const { index, text, clear = true, submit = false } = params || {};
        if (index === undefined || index === null) {
          throw new Error(`Missing required parameter 'index'. Received params: ${JSON.stringify(params)}`);
        }
        if (text === undefined || text === null) {
          throw new Error(`Missing required parameter 'text'. Received params: ${JSON.stringify(params)}`);
        }

        const element = selectorMap.get(index);
        if (!element) throw new Error(`Element #${index} not found.`);

        try { await element.scrollIntoViewIfNeeded(); } catch (e) { }

        // Safety: If the element is a <select>, typing might fail or select options.
        // We can add a check here, but standard typing usually works for search/comboboxes.

        if (clear) await element.fill('');
        await element.type(String(text), { delay: 50 });

        if (submit) {
          await page.keyboard.press('Enter');
          return `Typed "${text}" into #${index} and pressed Enter`;
        }
        return `Typed "${text}" into #${index}`;
      });
    }
  } as ActionTool<{ index: number; text: string; clear: boolean; submit: boolean }>,

  scroll: {
    name: 'scroll_page',
    description: 'Scroll the page to see more content.',
    schema: z.object({
      direction: z.enum(['up', 'down']).default('down'),
      amount: z.number().optional().default(500)
    }),
    execute: async (params, { page }) => {
      return safeExecute(async () => {
        const { direction = 'down', amount = 500 } = params || {};
        const pixels = direction === 'down' ? amount : -amount;
        await page.evaluate((y) => window.scrollBy(0, y), pixels);
        await page.waitForTimeout(500);
        return `Scrolled ${direction} by ${amount} pixels`;
      });
    }
  } as ActionTool<{ direction: 'up' | 'down'; amount: number }>,

  // Keyboard action - essential for dismissing popups and modals
  press_key: {
    name: 'press_key',
    description: 'Press a keyboard key. Use Escape to dismiss popups/modals, Enter to confirm, Tab to move focus.',
    schema: z.object({
      key: z.string().describe('The key to press (e.g., "Escape", "Enter", "Tab", "ArrowDown")')
    }),
    execute: async (params, { page }) => {
      return safeExecute(async () => {
        const { key } = params || {};
        if (!key) throw new Error('Missing required parameter "key"');
        await page.keyboard.press(key);
        await page.waitForTimeout(300); // Brief wait for modal animations
        return `Pressed ${key} key`;
      });
    }
  } as ActionTool<{ key: string }>,

  // --- TABS ---

  open_tab: {
    name: 'open_tab',
    description: 'Open a new browser tab with a specific URL.',
    schema: z.object({
      url: z.string()
    }),
    execute: async (params, { page }) => {
      return safeExecute(async () => {
        const { url } = params || {};
        if (!url) throw new Error(`Missing required parameter 'url'. Received: ${JSON.stringify(params)}`);
        const context = page.context();
        const newPage = await context.newPage();
        await newPage.goto(url);
        return `Opened new tab at ${url}`;
      });
    }
  } as ActionTool<{ url: string }>,

  // switch_to_tab - for agent's internal tab tracking (handled specially in agent.ts)
  switch_to_tab: {
    name: 'switch_to_tab',
    description: 'Switch to a different tab that was opened by clicking. Use tab indices shown in the OPEN TABS list.',
    schema: z.object({
      tab_index: z.number().describe('The tab index to switch to (shown in OPEN TABS list)')
    }),
    execute: async (_params) => {
      // This is handled specially in agent.ts, this execute won't be called
      return { success: true, output: 'Tab switch handled by agent' };
    }
  } as ActionTool<{ tab_index: number }>,

  close_tab: {
    name: 'close_tab',
    description: 'Close a specific tab. Use this when you are done with a tab to keep the workspace clean.',
    schema: z.object({
      tab_index: z.number().describe('The tab index to close (shown in OPEN TABS list)')
    }),
    execute: async (_params) => {
      // This is handled specially in agent.ts
      return { success: true, output: 'Tab close handled by agent' };
    }
  } as ActionTool<{ tab_index: number }>,

  // Legacy switch_tab kept for now but deprecated
  switch_tab: {
    name: 'switch_tab',
    description: 'DEPRECATED - Use switch_to_tab instead. Switch focus to a browser tab by context index.',
    schema: z.object({
      page_index: z.number()
    }),
    execute: async (params, { page }) => {
      return safeExecute(async () => {
        const { page_index } = params || {};
        if (page_index === undefined || page_index === null) {
          throw new Error(`Missing required parameter 'page_index'. Received: ${JSON.stringify(params)}`);
        }
        const context = page.context();
        const pages = context.pages();
        if (page_index < 0 || page_index >= pages.length) {
          throw new Error(`Invalid tab index ${page_index}. Open tabs: ${pages.length}`);
        }
        const targetPage = pages[page_index];
        await targetPage.bringToFront();
        return `Switched to tab ${page_index}`;
      });
    }
  } as ActionTool<{ page_index: number }>,

  // --- GENERAL ---

  extract: {
    name: 'extract_content',
    description: 'Extract text content from the current page. Use this when you need to read article text, paragraphs, or other non-interactive content.',
    schema: z.object({
      goal: z.string().describe('What information are you trying to extract (e.g., "main article text", "product description")')
    }),
    execute: async (params, { page }) => {
      return safeExecute(async () => {
        const { goal } = params || {};
        if (!goal) throw new Error(`Missing required parameter 'goal'. Received: ${JSON.stringify(params)}`);

        // Extract visible text from the page body
        const pageText = await page.evaluate(() => {
          // Get main content areas first, fall back to body
          const mainContent = document.querySelector('main, article, [role="main"], .content, #content') as HTMLElement | null;
          const element = mainContent || document.body;

          // Get text content
          const text = element.innerText || element.textContent || '';

          // Clean up whitespace
          return text.replace(/\s+/g, ' ').trim();
        });

        // Truncate to avoid context overflow (8000 chars ≈ 2000 tokens)
        const MAX_CONTENT = 8000;
        const truncated = pageText.length > MAX_CONTENT
          ? pageText.substring(0, MAX_CONTENT) + '...[truncated]'
          : pageText;

        return `Extracted page content for "${goal}":\n\n${truncated}`;
      });
    }
  } as ActionTool<{ goal: string }>,

  done: {
    name: 'task_complete',
    description: 'Call this when you have accomplished the user\'s goal.',
    schema: z.object({
      success: z.boolean(),
      summary: z.string()
    }),
    execute: async (params) => {
      const { success = false, summary = 'No summary provided' } = params || {};
      return { success, output: summary };
    }
  } as ActionTool<{ success: boolean; summary: string }>

  ,

  // --- DATA ANALYSIS ---

  analyze_data: {
    name: 'analyze_data',
    description: 'Run Python code in a secure sandbox to analyze data, manipulate files, or perform calculations. You can verify the output via stdout/stderr which is returned.',
    schema: z.object({
      code: z.string().describe('The Python code to execute.'),
      files: z.array(z.object({
        name: z.string(),
        content: z.string().describe('Text content of the file. valid utf-8.')
      })).optional().describe('Virtual files to create in the sandbox before running the code.')
    }),
    execute: async (params) => {
      const { code, files = [] } = params || {};
      if (!code) throw new Error("Missing 'code' parameter.");

      try {
        const result = await e2b.executeCode(code, files);
        let output = "";
        if (result.stdout) output += `STDOUT:\n${result.stdout}\n`;
        if (result.stderr) output += `STDERR:\n${result.stderr}\n`;
        if (result.error) output += `ERROR:\n${result.error}\n`;
        if (result.artifacts && result.artifacts.length > 0) {
          output += `ARTIFACTS GENERATED:\n${result.artifacts.map(a => a.name).join(', ')}`;
        }
        if (!output) output = "Code executed successfully with no output.";

        return { success: true, output };
      } catch (error: any) {
        return { success: false, output: `Execution failed: ${error.message}` };
      }
    }
  } as ActionTool<{ code: string; files?: { name: string; content: string }[] }>

};

export function getToolDefinitions() {
  return Object.values(ActionRegistry).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema
  }));
}