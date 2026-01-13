import { WebContents } from 'electron';
import type { CoreMessage } from 'ai';
import { AgentEvent } from '../automation/types/agent';

interface ChatRequest {
  message: string;
  messageId: string;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
  artifacts?: { name: string; data: string }[];
}

/**
 * Manages chat messages and converts agent events to chat format
 */
export class AgentMessageManager {
  private webContents: WebContents;
  private messages: CoreMessage[] = [];
  private currentMessageId: string | null = null;
  private currentResponseContent: string = '';
  private activeAgent: string | null = null;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
  }

  /**
   * Add a user message to the conversation
   */
  addUserMessage(request: ChatRequest): void {
    const userMessage: CoreMessage = {
      role: 'user',
      content: request.message,
    };

    this.messages.push(userMessage);
    this.currentMessageId = request.messageId;
    this.currentResponseContent = '';
    this.sendMessagesToRenderer();
  }

  /**
   * Handle agent events and convert them to chat responses
   */
  handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'plan':
        // Forward plan to sidebar for visualization
        if (!this.webContents.isDestroyed()) {
          this.webContents.send('agent-plan', event.data);
        }
        break;

      case 'thought':
        // Forward thoughts to sidebar for display
        if (!this.webContents.isDestroyed()) {
          this.webContents.send('agent-thought', {
            agentId: event.agentId,
            message: event.message,
            timestamp: event.timestamp,
          });
        }
        break;

      case 'action':
        // Forward actions to sidebar for display
        if (!this.webContents.isDestroyed()) {
          this.webContents.send('agent-action', {
            agentId: event.agentId,
            message: event.message,
            data: event.data,
            timestamp: event.timestamp,
          });
        }
        break;

      case 'code_preview':
        if (!this.webContents.isDestroyed()) {
          this.webContents.send('agent-code-preview', {
            agentId: event.agentId,
            code: event.message,
            timestamp: event.timestamp,
            data: event.data
          });
        }
        break;

      case 'result_stream':
        // Accumulate streaming chunks
        this.currentResponseContent += event.message;

        // Send streaming chunk to sidebar
        if (this.currentMessageId) {
          this.sendChatResponse({
            messageId: this.currentMessageId,
            content: this.currentResponseContent,
            isComplete: false,
          });
        }
        break;

      case 'result':
        // Final result - complete the response
        this.currentResponseContent = event.message || this.currentResponseContent;
        const artifacts = event.data?.artifacts;

        // Add assistant message to conversation
        const assistantMessage: any = {
          role: 'assistant',
          content: this.currentResponseContent,
          artifacts: artifacts
        };
        this.messages.push(assistantMessage);

        // Send final response to sidebar
        if (this.currentMessageId) {
          this.sendChatResponse({
            messageId: this.currentMessageId,
            content: this.currentResponseContent,
            isComplete: true,
            artifacts: artifacts
          });
        }

        // Update messages in renderer
        this.sendMessagesToRenderer();

        // Reset for next message
        this.currentMessageId = null;
        this.currentResponseContent = '';
        break;

      case 'error':
        // Handle error - send as complete response with error message
        const errorMessage: CoreMessage = {
          role: 'assistant',
          content: `Error: ${event.message}`,
        };
        this.messages.push(errorMessage);

        if (this.currentMessageId) {
          this.sendChatResponse({
            messageId: this.currentMessageId,
            content: `Error: ${event.message}`,
            isComplete: true,
          });
        }

        this.sendMessagesToRenderer();

        // Reset for next message
        this.currentMessageId = null;
        this.currentResponseContent = '';
        break;

      default:
        // Log unknown event types for debugging
        console.log(`[AgentMessageManager] Unhandled event type: ${event.type}`);
        break;
    }
  }

  /**
   * Clear all messages
   */
  clearMessages(): void {
    this.messages = [];
    this.currentMessageId = null;
    this.currentResponseContent = '';
    this.sendMessagesToRenderer();
  }

  /**
   * Get all messages
   */
  getMessages(): CoreMessage[] {
    return this.messages;
  }

  /**
   * Set active agent ID
   */
  setActiveAgent(agentId: string | null): void {
    this.activeAgent = agentId;
  }

  /**
   * Get active agent ID
   */
  getActiveAgent(): string | null {
    return this.activeAgent;
  }

  /**
   * Send chat response to renderer
   */
  private sendChatResponse(response: ChatResponse): void {
    if (!this.webContents.isDestroyed()) {
      this.webContents.send('chat-response', response);
    }
  }

  /**
   * Send all messages to renderer
   */
  private sendMessagesToRenderer(): void {
    if (!this.webContents.isDestroyed()) {
      this.webContents.send('chat-messages-updated', this.messages);
    }
  }
}
