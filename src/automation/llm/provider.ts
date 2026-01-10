import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, streamText, tool, type LanguageModel } from 'ai';
import { LLMProvider, ChatMessage, LLMResponse, ToolDefinition } from '../core/llm';

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
    jsonMode: boolean = false
  ): Promise<LLMResponse> {
    
    // 1. Map Tools (Agent Schema -> Vercel Schema)
    let vercelTools: Record<string, any> | undefined = undefined;

    if (tools && tools.length > 0) {
      vercelTools = tools.reduce((acc, t) => {
        acc[t.name] = tool({
          description: t.description,
          // FIX 1: Cast to 'any' to bypass strict Zod type inference issues in the loop
          parameters: t.parameters, 
        } as any);
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
    const toolCalls = result.toolCalls?.map(tc => ({
      id: tc.toolCallId,
      name: tc.toolName,
      // FIX 2: Cast to 'any' because TS might not infer 'args' exists on a dynamic tool call
      arguments: (tc as any).args
    }));

    return {
      content: result.text || "",
      // FIX 3: Return '[]' instead of undefined to satisfy strict ToolCall[] type if needed
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

  private convertToCoreMessages(history: ChatMessage[]) {
    return history.map(msg => ({
      role: msg.role as 'system' | 'user' | 'assistant',
      content: msg.content
    }));
  }
}