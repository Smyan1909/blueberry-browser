import { BrowserContext, Page } from "playwright";

export type AgentEventType =
    | 'thought'
    | 'plan'
    | 'action'
    | 'dom_state'
    | 'call_worker'
    | 'error'
    | 'result'
    | 'result_stream'
    | 'code_preview';


export interface AgentEvent {
    agentId: string;
    type: AgentEventType;
    message: string;
    timestamp: number;
    data?: any;
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';

export interface Task {
    id: string;
    description: string;
    status: TaskStatus;

    dependencies: string[];

    assignedAgentId?: string;

    result?: any;
    error?: string;
}

export interface Plan {
    id: string;
    goal: string;
    status: 'active' | 'completed' | 'pending';
    tasks: Task[];
    createdAt: number;
}

export interface Interaction {
    role: 'user' | 'assistant' | 'system';
    content: string;

    relatedDomStateId?: string;
}

export interface AgentConfig {
    id: string;

    isRoot: boolean;

    browserContext: BrowserContext;

    activePage?: Page;

    onStream: (event: AgentEvent) => void;

    modelId?: string;
}

