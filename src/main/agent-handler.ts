import { ipcMain } from 'electron';
import { BrowserAgent } from '../automation';
import { UnifiedLLMProvider } from '../automation';
import { AGENT_EVENTS } from '../shared/ipc-events';
import { getPlaywrightPageForTab } from './tab-cdp-bridge';
import { AgentMessageManager } from './agent-message-manager';
import { handleFileTask } from '../automation/action/file-processor';
import type { Window } from './Window';

let activeAgent: BrowserAgent | null = null;
let activeAgentId: string | null = null;
let messageManager: AgentMessageManager | null = null;
let windowInstance: Window | null = null;

export function setupAgentHandler(window: Window, sidebarWebContents: Electron.WebContents): void {
  windowInstance = window;
  messageManager = new AgentMessageManager(sidebarWebContents);

  ipcMain.handle(AGENT_EVENTS.START, async (_event, payload: { goal: string, file?: { name: string, data: ArrayBuffer } }) => {
    try {

      const goal = typeof payload === 'string' ? payload : payload.goal;
      // const attachedFile = typeof payload === 'object' ? payload.file : undefined;

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
export async function handleChatMessage(goal: string, file?: { name: string, data: ArrayBuffer }): Promise<void> {
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

  // Setup basic agent info
  const sidebarWebContents = windowInstance.sidebar.view.webContents;
  const agentId = 'agent-session-1';
  activeAgentId = agentId;

  // Handle file task if file is provided
  if (file) {
    if (messageManager) {
      messageManager.addUserMessage({
        message: goal + `\n\n[Attached File: ${file.name}]`,
        messageId: Date.now().toString()
      });
      messageManager.setActiveAgent(agentId);

      messageManager.handleAgentEvent({
        type: 'thought',
        agentId: 'file-processor',
        message: "Processing file with Python code interpreter...",
        timestamp: Date.now()
      });
    }

    try {
      const result = await handleFileTask(file.data, file.name, goal, llm, (code, isComplete) => {
        if (messageManager) {
          messageManager.handleAgentEvent({
            type: 'code_preview',
            agentId: 'file-processor',
            message: code,
            timestamp: Date.now(),
            data: { isComplete }
          });
        }
      });

      if (messageManager) {
        messageManager.handleAgentEvent({
          type: 'result_stream',
          agentId: 'file-processor',
          message: "File processed successfully.\n",
          timestamp: Date.now()
        });
      }

      // Clear the code preview now that execution is done
      if (messageManager) {
        messageManager.handleAgentEvent({
          type: 'code_preview',
          agentId: 'file-processor',
          message: '', // Clear the preview
          timestamp: Date.now(),
          data: { isComplete: true }
        });
      }

      // Use LLM to summarize the output if there is any stdout/stderr
      if (result.stdout || result.stderr) {
        try {
          console.log('[Agent Handler] Streaming summary with LLM...');
          const stream = await llm.stream([
            {
              role: 'system',
              content: `You are a helpful data analyst assistant. The user asked to analyze a file. 
Python code was executed to handle this request.
Your task is to summarize the execution output (STDOUT/STDERR) into a clear, concise natural language response.

Guidelines:
1. **Focus on the Answer**: Address the user's request directly. What did the data show?
2. **Interpret Results**: Don't just list numbers; explain what they mean in context.
3. **Skip Boilerplate**: Do NOT mention "File loaded successfully", "Sheet1 detected", or "Column types are...". Go straight to the insights.
4. **Ignore Warnings**: Do NOT mention Python warnings (e.g., deprecation warnings, pandas future warnings) unless they caused the code to fail.
5. **Concise**: Be brief but informative.
Format your response in Markdown.`
            },
            {
              role: 'user',
              content: `
User Request: ${goal}

Execution Output:
STDOUT:
${result.stdout}

STDERR:
${result.stderr}
`
            }
          ]);

          for await (const chunk of stream) {
            if (messageManager) {
              messageManager.handleAgentEvent({
                type: 'result_stream',
                agentId: 'file-processor',
                message: chunk,
                timestamp: Date.now()
              });
            }
          }

          if (messageManager) {
            messageManager.handleAgentEvent({
              type: 'result_stream',
              agentId: 'file-processor',
              message: '\n',
              timestamp: Date.now()
            });
          }

        } catch (err) {
          console.error('[Agent Handler] Failed to summarize output:', err);
          // Fallback to raw output if summarization fails
          let fallbackMsg = "";
          if (result.stdout) fallbackMsg += `\n**Stdout:**\n\`\`\`\n${result.stdout}\n\`\`\``;
          if (result.stderr) fallbackMsg += `\n**Stderr:**\n\`\`\`\n${result.stderr}\n\`\`\``;

          if (messageManager) {
            messageManager.handleAgentEvent({
              type: 'result_stream',
              agentId: 'file-processor',
              message: fallbackMsg,
              timestamp: Date.now()
            });
          }
        }
      }

      if (result.error) {
        if (messageManager) {
          messageManager.handleAgentEvent({
            type: 'result_stream',
            agentId: 'file-processor',
            message: `\n**Execution Error:**\n${result.error}`,
            timestamp: Date.now()
          });
        }
      }

      if (result.artifacts && result.artifacts.length > 0) {
        let artifactMsg = `\n\n**Artifacts generated:**\n`;
        result.artifacts.forEach(a => artifactMsg += `- ${a.name}\n`);
        if (messageManager) {
          messageManager.handleAgentEvent({
            type: 'result_stream',
            agentId: 'file-processor',
            message: artifactMsg,
            timestamp: Date.now()
          });
        }
      } else if (result.results && result.results.length > 0) {
        let resultMsg = "";
        result.results.forEach(res => {
          if (res.text) resultMsg += `\n${res.text}`;
        });
        if (messageManager && resultMsg) {
          messageManager.handleAgentEvent({
            type: 'result_stream',
            agentId: 'file-processor',
            message: resultMsg,
            timestamp: Date.now()
          });
        }
      }

      if (messageManager) {
        messageManager.handleAgentEvent({
          type: 'result',
          agentId: 'file-processor',
          message: '', // Empty message to preserve the streamed content
          timestamp: Date.now(),
          data: { artifacts: result.artifacts }
        });
      }
    } catch (error: any) {
      if (messageManager) {
        messageManager.handleAgentEvent({
          type: 'error',
          agentId: 'file-processor',
          message: `Error processing file: ${error.message}`,
          timestamp: Date.now()
        });
      }
    }
    return;
  }

  // Standard Agent Flow
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
  if (messageManager) {
    messageManager.addUserMessage({
      message: goal,
      messageId: Date.now().toString()
    });
    messageManager.setActiveAgent(agentId);
  }

  // Create plan and send to UI for approval
  await activeAgent.plan(goal);
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
