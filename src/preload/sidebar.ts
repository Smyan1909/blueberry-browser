import { contextBridge } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

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

// Sidebar specific APIs
const sidebarAPI = {
  // Chat functionality
  sendChatMessage: (request: Partial<ChatRequest>) =>
    electronAPI.ipcRenderer.invoke("sidebar-chat-message", request),

  clearChat: () => electronAPI.ipcRenderer.invoke("sidebar-clear-chat"),

  getMessages: () => electronAPI.ipcRenderer.invoke("sidebar-get-messages"),

  onChatResponse: (callback: (data: ChatResponse) => void) => {
    electronAPI.ipcRenderer.on("chat-response", (_, data) => callback(data));
  },

  onMessagesUpdated: (callback: (messages: any[]) => void) => {
    electronAPI.ipcRenderer.on("chat-messages-updated", (_, messages) =>
      callback(messages)
    );
  },

  removeChatResponseListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-response");
  },

  removeMessagesUpdatedListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("chat-messages-updated");
  },

  // Agent events (for direct agent event handling)
  onAgentEvent: (callback: (event: any) => void) => {
    electronAPI.ipcRenderer.on("agent:event", (_, event) => callback(event));
  },

  removeAgentEventListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent:event");
  },

  // Agent plan events
  onAgentPlan: (callback: (plan: any) => void) => {
    electronAPI.ipcRenderer.on("agent-plan", (_, plan) => callback(plan));
  },

  removeAgentPlanListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent-plan");
  },

  // Agent thought events
  onAgentThought: (callback: (thought: { agentId: string; message: string; timestamp: number }) => void) => {
    electronAPI.ipcRenderer.on("agent-thought", (_, thought) => callback(thought));
  },

  removeAgentThoughtListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent-thought");
  },

  // Agent action events
  onAgentAction: (callback: (action: { agentId: string; message: string; data?: any; timestamp: number }) => void) => {
    electronAPI.ipcRenderer.on("agent-action", (_, action) => callback(action));
  },

  removeAgentActionListener: () => {
    electronAPI.ipcRenderer.removeAllListeners("agent-action");
  },

  // Plan approval/revision
  approvePlan: () => electronAPI.ipcRenderer.invoke("agent:approve-plan"),

  revisePlan: (feedback: string) =>
    electronAPI.ipcRenderer.invoke("agent:revise-plan", feedback),

  // Page content access
  getPageContent: () => electronAPI.ipcRenderer.invoke("get-page-content"),
  getPageText: () => electronAPI.ipcRenderer.invoke("get-page-text"),
  getCurrentUrl: () => electronAPI.ipcRenderer.invoke("get-current-url"),

  // Artifacts
  downloadArtifact: (artifact: { name: string; data: string }) =>
    electronAPI.ipcRenderer.invoke("download-artifact", artifact),

  // Tab information
  getActiveTabInfo: () => electronAPI.ipcRenderer.invoke("get-active-tab-info"),
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("sidebarAPI", sidebarAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI;
  // @ts-ignore (define in dts)
  window.sidebarAPI = sidebarAPI;
}
