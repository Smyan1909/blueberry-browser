import { z } from 'zod';
import { Page, ElementHandle } from 'playwright';
import { DomService } from '../dom';

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
    execute: async ({ url }, { page }) => {
      return safeExecute(async () => {
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
    description: 'Click on an interactive element identified by its numeric ID.',
    schema: z.object({
      index: z.number().describe('The numeric ID of the element to click'),
      open_in_new_tab: z.boolean().optional().default(false).describe('If true, holds Control/Command to open in a new tab')
    }),
    execute: async ({ index, open_in_new_tab }, { selectorMap, domService }) => {
      return safeExecute(async () => {
        const element = selectorMap.get(index);
        if (!element) throw new Error(`Element #${index} not found (stale).`);

        try { await element.scrollIntoViewIfNeeded(); } catch (e) {}

        // --- VISUALIZATION MAGIC ---
        // 1. Get the center coordinates of the element
        const box = await element.boundingBox();
        if (box) {
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          
          // 2. Move the Fake Cursor there
          await domService.highlightClick(x, y);
          
          // 3. Human delay to let the user see the cursor arrive
          await new Promise(r => setTimeout(r, 500)); 
        }

        const modifiers: ('Control' | 'Meta')[] = open_in_new_tab ? ['Control', 'Meta'] : [];
        
        // We use the specific modifier for the OS (Meta for Mac, Ctrl for Win/Linux)
        // Playwright usually handles 'Control' well, but 'Meta' is safer for Mac agents.
        // Ideally we detect OS, but passing both is a safe fallback for "Command/Control".
        if (open_in_new_tab) {
             // For precision, we usually just need one modifier based on platform
             // But for simplicity in this snippet, we'll assume Control which works on most Linux/Windows
             // and usually maps to Command in headless Mac environments.
             await element.click({ modifiers: modifiers });
             return `Ctrl+Clicked element #${index} (opened in new tab)`;
        } else {
             await element.click();
             return `Clicked element #${index}`;
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
    execute: async ({ index, text, clear, submit }, { selectorMap, page }) => {
      return safeExecute(async () => {
        const element = selectorMap.get(index);
        if (!element) throw new Error(`Element #${index} not found.`);

        try { await element.scrollIntoViewIfNeeded(); } catch (e) {}

        // Safety: If the element is a <select>, typing might fail or select options.
        // We can add a check here, but standard typing usually works for search/comboboxes.
        
        if (clear) await element.fill('');
        await element.type(text, { delay: 50 });

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
    execute: async ({ direction, amount }, { page }) => {
      return safeExecute(async () => {
        const pixels = direction === 'down' ? amount : -amount;
        await page.evaluate((y) => window.scrollBy(0, y), pixels);
        await page.waitForTimeout(500);
        return `Scrolled ${direction} by ${amount} pixels`;
      });
    }
  } as ActionTool<{ direction: 'up' | 'down'; amount: number }>,

  // --- TABS ---

  open_tab: {
    name: 'open_tab',
    description: 'Open a new browser tab with a specific URL.',
    schema: z.object({
      url: z.string()
    }),
    execute: async ({ url }, { page }) => {
      return safeExecute(async () => {
        const context = page.context();
        const newPage = await context.newPage();
        await newPage.goto(url);
        return `Opened new tab at ${url}`;
      });
    }
  } as ActionTool<{ url: string }>,

  switch_tab: {
    name: 'switch_tab',
    description: 'Switch focus to a different browser tab.',
    schema: z.object({
      page_index: z.number()
    }),
    execute: async ({ page_index }, { page }) => {
      return safeExecute(async () => {
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
    description: 'Extract specific information from the current page text.',
    schema: z.object({
      goal: z.string()
    }),
    execute: async ({ goal }) => {
        return { 
            success: true, 
            output: `Intent to extract "${goal}" recorded.` 
        };
    }
  } as ActionTool<{ goal: string }>,

  done: {
    name: 'task_complete',
    description: 'Call this when you have accomplished the user\'s goal.',
    schema: z.object({
      success: z.boolean(),
      summary: z.string()
    }),
    execute: async ({ success, summary }) => {
      return { success, output: summary };
    }
  } as ActionTool<{ success: boolean; summary: string }>

};

export function getToolDefinitions() {
    return Object.values(ActionRegistry).map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema 
    }));
}