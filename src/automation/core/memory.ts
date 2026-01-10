
import { ChatMessage, LLMProvider } from './llm';

export class MemoryManager {
    private history: ChatMessage[] = [];
    private summary: string = '';
    private readonly MAX_TOKENS = 6000;
    private readonly SUMMARY_THRESHOLD = 4000;

    constructor(private llm: LLMProvider) {}

    public add(role: 'user' | 'assistant' | 'system', content: string) {
        this.history.push({ role, content });
    }

    public async getContext(): Promise<ChatMessage[]> {
        const currentUsage = this.estimateTokens(this.history);

        if (currentUsage > this.MAX_TOKENS){
            await this.summarizeOldest();
        }

        const context: ChatMessage[] = [...this.history];

        if (this.summary) {
            context.unshift({
                role: 'system',
                content: `PREVIOUS ACTIVITY SUMMARY: ${this.summary}`
            });
        }

        return context;
    }

    private async summarizeOldest() {
        const PRESERVE_COUNT = 10;

        if (this.history.length <= PRESERVE_COUNT) return;

        const toSummarize = this.history.slice(0, this.history.length - PRESERVE_COUNT);
        const recent = this.history.slice(this.history.length - PRESERVE_COUNT);

        const response = await this.llm.generate([
            { role: 'system', content: `Summarize the following interaction history concisely. Preserve key actions, errors, and facts. Keep the size max ${this.SUMMARY_THRESHOLD} characters.` },
            { role: 'user', content: JSON.stringify(toSummarize) },
            { role: 'user', content: `Current Summary: ${this.summary}` }
        ]);

        this.summary = response.content;
        this.history = recent;
    }

    private estimateTokens(messages: ChatMessage[]): number {
        return messages.reduce((acc, msg) => acc + (msg.content.length / 4), 0) + 100; // 100 for overhead
    }

}