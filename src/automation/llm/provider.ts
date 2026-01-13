import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText, tool, jsonSchema, type LanguageModel } from 'ai';
import { z } from 'zod';
import { LLMProvider, ChatMessage, LLMResponse, ToolDefinition, MessageContent } from '../core/llm';

export type LLMVendor = 'openai' | 'anthropic';

export class UnifiedLLMProvider implements LLMProvider {
  private model: LanguageModel;

  constructor(vendor: LLMVendor = 'openai', apiKey: string, modelName?: string) {
    if (vendor === 'anthropic') {
      const anthropic = createAnthropic({ apiKey });
      this.model = anthropic(modelName || 'claude-3-5-sonnet-20241022');
    } else {
      const openai = createOpenAI({ apiKey });
      this.model = openai(modelName || 'gpt-5.2');
    }
  }

  async generate(
    history: ChatMessage[],
    tools?: ToolDefinition[],
    _jsonMode: boolean = false
  ): Promise<LLMResponse> {

    // 1. Map Tools (Agent Schema -> Vercel Schema)
    // AI SDK v5 uses 'inputSchema' instead of 'parameters'
    let vercelTools: Record<string, any> | undefined = undefined;

    if (tools && tools.length > 0) {
      vercelTools = tools.reduce((acc, t) => {
        // Convert Zod schema to JSON Schema and remove $schema property for compatibility
        const jsonSchemaObj = z.toJSONSchema(t.parameters) as Record<string, any>;
        // Remove $schema as some providers don't support draft 2020-12
        delete jsonSchemaObj['$schema'];

        acc[t.name] = tool({
          description: t.description,
          // Use jsonSchema wrapper with inputSchema for AI SDK v5
          inputSchema: jsonSchema(jsonSchemaObj),
        });
        return acc;
      }, {} as Record<string, any>);
    }

    // 2. Call AI SDK
    const result = await generateText({
      model: this.model,
      messages: this.convertToCoreMessages(history),
      tools: vercelTools,
      toolChoice: vercelTools ? 'auto' : undefined,
    });

    // 3. Map Result back to Agent Schema
    // Debug: log raw tool calls to see actual structure
    if (result.toolCalls && result.toolCalls.length > 0) {
      console.log('[LLM Provider] Raw tool calls:', JSON.stringify(result.toolCalls, null, 2));
    }

    const toolCalls = result.toolCalls?.map(tc => {
      const tcAny = tc as any;
      // Try multiple possible property names for arguments
      const args = tcAny.args ?? tcAny.arguments ?? tcAny.input ?? {};

      console.log(`[LLM Provider] Tool ${tc.toolName}: args=${JSON.stringify(args)}`);

      return {
        id: tc.toolCallId,
        name: tc.toolName,
        arguments: args
      };
    });

    return {
      content: result.text || "",
      // Return '[]' instead of undefined to satisfy strict ToolCall[] type if needed
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : []
    };
  }

  async *stream(history: ChatMessage[]): AsyncGenerator<string, void, unknown> {
    const result = await streamText({
      model: this.model,
      messages: this.convertToCoreMessages(history),
    });

    for await (const chunk of result.textStream) {
      yield chunk;
    }
  }

  /**
   * Convert chat messages to Vercel AI SDK core message format.
   * Handles both simple string content and multimodal content (text + images).
   */
  private convertToCoreMessages(history: ChatMessage[]): any[] {
    return history.map(msg => {
      // Simple string content
      if (typeof msg.content === 'string') {
        return {
          role: msg.role,
          content: msg.content
        };
      }

      // Multimodal content (array of text/image parts)
      const contentParts = (msg.content as MessageContent[]).map(part => {
        if (part.type === 'text') {
          return { type: 'text', text: part.text };
        }
        if (part.type === 'image') {
          // Vercel AI SDK expects image as data URL or URL string
          return {
            type: 'image',
            image: `data:${part.image.mediaType};base64,${part.image.data}`
          };
        }
        return null;
      }).filter(Boolean);

      return {
        role: msg.role,
        content: contentParts
      };
    });
  }
}