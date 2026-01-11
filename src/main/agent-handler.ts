import { ipcMain } from 'electron';
import { BrowserAgent } from '../automation';
import { UnifiedLLMProvider } from '../automation';
import { AGENT_EVENTS } from '../shared/ipc-events';
import { getPlaywrightPageForTab } from './tab-cdp-bridge';
import { AgentMessageManager } from './agent-message-manager';
import type { Window } from './Window';

let activeAgent: BrowserAgent | null = null;
let activeAgentId: string | null = null;
let messageManager: AgentMessageManager | null = null;
let windowInstance: Window | null = null;

export function setupAgentHandler(window: Window, sidebarWebContents: Electron.WebContents): void {
  windowInstance = window;
  messageManager = new AgentMessageManager(sidebarWebContents);

  ipcMain.handle(AGENT_EVENTS.START, async (_event, goal: string) => {
    try {
      console.log('[Agent Handler] Starting agent with goal:', goal);

      // Get active tab from window
      const activeTab = window.activeTab;
      if (!activeTab) {
        throw new Error('No active tab available');
      }

      // Get Playwright page for the active tab via CDP
      const playwrightConnection = await getPlaywrightPageForTab(activeTab);
      if (!playwrightConnection) {
        throw new Error('Failed to connect Playwright to active tab via CDP');
      }

      const { page, context } = playwrightConnection;

      // Initialize LLM provider
      const provider = process.env.LLM_PROVIDER?.toLowerCase() || 'openai';
      const apiKey = provider === 'anthropic' 
        ? process.env.ANTHROPIC_API_KEY 
        : process.env.OPENAI_API_KEY;

      if (!apiKey) {
        throw new Error(`API key not found for provider: ${provider}`);
      }

      const llm = new UnifiedLLMProvider(
        provider as 'openai' | 'anthropic',
        apiKey
      );

      // Create or reuse agent
      const agentId = 'agent-session-1';
      activeAgentId = agentId;
      
      if (!activeAgent) {
        activeAgent = new BrowserAgent(context, page, llm, {
          id: agentId,
          browserContext: context,
          onStream: (agentEvent) => {
            // Forward agent events to message manager
            if (messageManager) {
              messageManager.handleAgentEvent(agentEvent);
            }
            
            // Also send raw agent events for any direct listeners
            if (!sidebarWebContents.isDestroyed()) {
              sidebarWebContents.send(AGENT_EVENTS.STREAM, agentEvent);
            }
          },
          isRoot: true
        });
      } else {
        // Update agent's page if tab changed
        // Note: BrowserAgent currently doesn't support changing page/context
        // So we'll create a new agent for now if the tab changed
        activeAgent = new BrowserAgent(context, page, llm, {
          id: agentId,
          browserContext: context,
          onStream: (agentEvent) => {
            if (messageManager) {
              messageManager.handleAgentEvent(agentEvent);
            }
            if (!sidebarWebContents.isDestroyed()) {
              sidebarWebContents.send(AGENT_EVENTS.STREAM, agentEvent);
            }
          },
          isRoot: true
        });
      }

      // Add user message to conversation
      const messageId = Date.now().toString();
      if (messageManager) {
        messageManager.addUserMessage({
          message: goal,
          messageId
        });
        messageManager.setActiveAgent(agentId);
      }

      // Create plan and send to UI for approval
      // Execution happens only after user approves via APPROVE_PLAN event
      const plan = await activeAgent.plan(goal);

      // If plan was auto-completed (simple question), we're done
      if (plan.status === 'completed') {
        return { success: true, planCompleted: true };
      }

      // Otherwise, plan is waiting for user approval
      return { success: true, planCompleted: false, planId: plan.id };
    } catch (error: any) {
      console.error('[Agent Handler] Error starting agent:', error);
      
      // Send error to message manager
      if (messageManager) {
        messageManager.handleAgentEvent({
          agentId: activeAgentId || 'unknown',
          type: 'error',
          message: error.message || 'Unknown error occurred',
          timestamp: Date.now()
        });
      }
      
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(AGENT_EVENTS.STOP, async () => {
    if (activeAgent) {
      activeAgent = null;
    }
    activeAgentId = null;
    if (messageManager) {
      messageManager.setActiveAgent(null);
    }
    return { success: true };
  });

  // Handle plan approval - execute the current plan
  ipcMain.handle(AGENT_EVENTS.APPROVE_PLAN, async () => {
    try {
      if (!activeAgent) {
        throw new Error('No active agent to approve plan for');
      }

      console.log('[Agent Handler] Plan approved, starting execution...');
      await activeAgent.execute();
      return { success: true };
    } catch (error: any) {
      console.error('[Agent Handler] Error executing plan:', error);
      
      if (messageManager) {
        messageManager.handleAgentEvent({
          agentId: activeAgentId || 'unknown',
          type: 'error',
          message: error.message || 'Unknown error occurred',
          timestamp: Date.now()
        });
      }
      
      return { success: false, error: error.message };
    }
  });

  // Handle plan revision - revise the current plan with feedback
  ipcMain.handle(AGENT_EVENTS.REVISE_PLAN, async (_event, feedback: string) => {
    try {
      if (!activeAgent) {
        throw new Error('No active agent to revise plan for');
      }

      console.log('[Agent Handler] Revising plan with feedback:', feedback);
      const revisedPlan = await activeAgent.revisePlan(feedback);
      return { success: true, plan: revisedPlan };
    } catch (error: any) {
      console.error('[Agent Handler] Error revising plan:', error);
      
      if (messageManager) {
        messageManager.handleAgentEvent({
          agentId: activeAgentId || 'unknown',
          type: 'error',
          message: error.message || 'Unknown error occurred',
          timestamp: Date.now()
        });
      }
      
      return { success: false, error: error.message };
    }
  });
}

/**
 * Get the active message manager instance
 */
export function getMessageManager(): AgentMessageManager | null {
  return messageManager;
}

/**
 * Handle a chat message by sending it to the agent
 */
export async function handleChatMessage(goal: string): Promise<void> {
  if (!windowInstance || !messageManager) {
    throw new Error('Agent handler not initialized');
  }

  // Get active tab from window
  const activeTab = windowInstance.activeTab;
  if (!activeTab) {
    throw new Error('No active tab available');
  }

  // Get Playwright page for the active tab via CDP
  const playwrightConnection = await getPlaywrightPageForTab(activeTab);
  if (!playwrightConnection) {
    throw new Error('Failed to connect Playwright to active tab via CDP');
  }

  const { page, context } = playwrightConnection;

  // Initialize LLM provider
  const provider = process.env.LLM_PROVIDER?.toLowerCase() || 'openai';
  const apiKey = provider === 'anthropic' 
    ? process.env.ANTHROPIC_API_KEY 
    : process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(`API key not found for provider: ${provider}`);
  }

  const llm = new UnifiedLLMProvider(
    provider as 'openai' | 'anthropic',
    apiKey
  );

  // Create or update agent
  const sidebarWebContents = windowInstance.sidebar.view.webContents;
  const agentId = 'agent-session-1';
  activeAgentId = agentId;
  
  if (!activeAgent) {
    activeAgent = new BrowserAgent(context, page, llm, {
      id: agentId,
      browserContext: context,
      onStream: (agentEvent) => {
        if (messageManager) {
          messageManager.handleAgentEvent(agentEvent);
        }
        if (!sidebarWebContents.isDestroyed()) {
          sidebarWebContents.send(AGENT_EVENTS.STREAM, agentEvent);
        }
      },
      isRoot: true
    });
  }

  // Add user message to conversation
  const messageId = Date.now().toString();
  if (messageManager) {
    messageManager.addUserMessage({
      message: goal,
      messageId
    });
    messageManager.setActiveAgent(agentId);
  }

  // Create plan and send to UI for approval
  // Execution happens only after user approves via APPROVE_PLAN event
  const plan = await activeAgent.plan(goal);
  // Plan is now sent to UI via agent events - user must approve before execution
}

/**
 * Clear chat messages
 */
export function clearChatMessages(): void {
  if (messageManager) {
    messageManager.clearMessages();
  }
}

/**
 * Get chat messages
 */
export function getChatMessages() {
  if (messageManager) {
    return messageManager.getMessages();
  }
  return [];
}
