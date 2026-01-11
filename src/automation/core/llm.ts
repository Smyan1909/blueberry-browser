// Standardized interface for LLM clients

import { z } from 'zod';

/**
 * Content part for multimodal messages
 */
export interface TextContent {
    type: 'text';
    text: string;
}

export interface ImageContent {
    type: 'image';
    image: {
        data: string;  // base64 encoded
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    };
}

export type MessageContent = TextContent | ImageContent;

/**
 * Chat message that supports both simple text and multimodal content
 */
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | MessageContent[];
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
