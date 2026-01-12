import { ElectronAPI } from "@electron-toolkit/preload";

interface ChatRequest {
  message: string;
  context: {
    url: string | null;
    content: string | null;
    text: string | null;
  };
  file?: { name: string; data: ArrayBuffer };
  messageId: string;
}

interface ChatResponse {
  messageId: string;
  content: string;
  isComplete: boolean;
}

interface TabInfo {
  id: string;
  title: string;
  url: string;
  isActive: boolean;
}

interface AgentThought {
  agentId: string;
  message: string;
  timestamp: number;
}

interface AgentAction {
  agentId: string;
  message: string;
  data?: any;
  timestamp: number;
}

interface Plan {
  id: string;
  goal: string;
  status: 'active' | 'completed' | 'pending';
  tasks: Array<{
    id: string;
    description: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
    dependencies: string[];
    assignedAgentId?: string;
    result?: any;
    error?: string;
  }>;
  createdAt: number;
}

interface SidebarAPI {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) => Promise<void>;
  onChatResponse: (callback: (data: ChatResponse) => void) => void;
  removeChatResponseListener: () => void;
  onMessagesUpdated: (callback: (messages: any[]) => void) => void;
  removeMessagesUpdatedListener: () => void;
  clearChat: () => Promise<void>;
  getMessages: () => Promise<any[]>;

  // Agent events (for direct agent event handling)
  onAgentEvent: (callback: (event: any) => void) => void;
  removeAgentEventListener: () => void;

  // Agent plan events
  onAgentPlan: (callback: (plan: Plan) => void) => void;
  removeAgentPlanListener: () => void;

  // Agent thought events
  onAgentThought: (callback: (thought: AgentThought) => void) => void;
  removeAgentThoughtListener: () => void;

  // Agent action events
  onAgentAction: (callback: (action: AgentAction) => void) => void;
  removeAgentActionListener: () => void;

  // Plan approval/revision
  approvePlan: () => Promise<{ success: boolean; error?: string }>;
  revisePlan: (feedback: string) => Promise<{ success: boolean; plan?: Plan; error?: string }>;

  // Page content access
  getPageContent: () => Promise<string | null>;
  getPageText: () => Promise<string | null>;
  getCurrentUrl: () => Promise<string | null>;

  // Tab information
  getActiveTabInfo: () => Promise<TabInfo | null>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
    sidebarAPI: SidebarAPI;
  }
}

