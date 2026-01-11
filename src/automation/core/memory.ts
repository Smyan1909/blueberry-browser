
import { ChatMessage, LLMProvider } from './llm';

export class MemoryManager {
    private history: ChatMessage[] = [];
    private summary: string = '';
    private readonly MAX_TOKENS = 4000; // Reduced from 6000 - be more aggressive
    private readonly SUMMARY_THRESHOLD = 2000; // Reduced from 4000
    private readonly MAX_MESSAGE_LENGTH = 5000; // Truncate long messages

    constructor(private llm: LLMProvider) { }

    public add(role: 'user' | 'assistant' | 'system', content: string | any[]) {
        // For multimodal content (arrays with images), only store text parts
        // to avoid context window overflow from base64 screenshots
        if (Array.isArray(content)) {
            // Extract only text content, skip images
            const textParts = content.filter(part => part.type === 'text').map(part => part.text);
            if (textParts.length > 0) {
                let text = textParts.join('\n');
                // Truncate if too long (likely DOM tree data)
                if (text.length > this.MAX_MESSAGE_LENGTH) {
                    text = text.substring(0, this.MAX_MESSAGE_LENGTH) + '...[message truncated]';
                }
                this.history.push({ role, content: text });
            }
        } else {
            // Truncate long string messages
            let text = content;
            if (text.length > this.MAX_MESSAGE_LENGTH) {
                text = text.substring(0, this.MAX_MESSAGE_LENGTH) + '...[message truncated]';
            }
            this.history.push({ role, content: text });
        }
    }

    public async getContext(): Promise<ChatMessage[]> {
        const currentUsage = this.estimateTokens(this.history);

        if (currentUsage > this.MAX_TOKENS) {
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
        const PRESERVE_COUNT = 6; // Reduced from 10 - keep fewer messages

        if (this.history.length <= PRESERVE_COUNT) return;

        const toSummarize = this.history.slice(0, this.history.length - PRESERVE_COUNT);
        const recent = this.history.slice(this.history.length - PRESERVE_COUNT);

        try {
            const response = await this.llm.generate([
                { role: 'system', content: `Summarize the following interaction history concisely. Preserve key actions, errors, and important facts. Maximum ${this.SUMMARY_THRESHOLD} characters.` },
                { role: 'user', content: JSON.stringify(toSummarize).substring(0, 10000) }, // Limit input size
                { role: 'user', content: `Current Summary: ${this.summary}` }
            ]);

            this.summary = response.content.substring(0, this.SUMMARY_THRESHOLD);
            this.history = recent;
            console.log('[MemoryManager] Summarized history, kept', recent.length, 'messages');
        } catch (error) {
            console.error('[MemoryManager] Failed to summarize, clearing old messages instead');
            // If summarization fails, just drop old messages
            this.history = recent;
        }
    }

    private estimateTokens(messages: ChatMessage[]): number {
        // More accurate estimation: ~4 chars per token, plus overhead
        const charCount = messages.reduce((acc, msg) => {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            return acc + content.length;
        }, 0);
        return Math.ceil(charCount / 4) + 100; // 100 for message overhead
    }

}
