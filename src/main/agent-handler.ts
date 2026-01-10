import { ipcMain, WebContents } from 'electron';
import { chromium } from 'playwright';
import { BrowserAgent } from '../automation';
import { UnifiedLLMProvider } from '../automation';
import { AGENT_EVENTS } from '../shared/ipc-events';

let activeAgent: BrowserAgent | null = null;

export function setupAgentHandler(sender: WebContents) {

    ipcMain.handle(AGENT_EVENTS.START, async (_event, goal: string) => {
        try {
            console.log('[Main] Starting agent with goal:', goal);

            const browser = await chromium.launch({ headless: false });
            const context = await browser.newContext();
            const page = await context.newPage();

            const llm = new UnifiedLLMProvider(
                'openai',
                process.env.OPENAI_API_KEY!
            );

            activeAgent = new BrowserAgent(context, page, llm, {
                id: 'agent-session-1',
                browserContext: context,

                onStream: (agentEvent) => {
                    if (!sender.isDestroyed()) {
                        sender.send(AGENT_EVENTS.STREAM, agentEvent);
                    }
                },
                isRoot: true
            });

            const plan = await activeAgent.plan(goal);

            if (plan.status !== 'completed') {
                await activeAgent.execute();
            }

            return { success: true };
        } catch (error: any) {
            console.error('[Main] Error starting agent:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(AGENT_EVENTS.STOP, async () => {
        if (activeAgent) {
            activeAgent = null;
        }
        return { success: true };
    });
}