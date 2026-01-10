// Standardized interface for LLM clients

import { z } from 'zod';

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: z.ZodType<any>;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: any;
}

export interface LLMResponse {
    content: string; // Reasoning
    toolCalls: ToolCall[];
}

export interface LLMProvider {
    generate(
        history: ChatMessage[],
        tools?: ToolDefinition[],
        jsonMode?: boolean
    ): Promise<LLMResponse>;

    stream(history: ChatMessage[]): AsyncGenerator<string, void, unknown>;
}
