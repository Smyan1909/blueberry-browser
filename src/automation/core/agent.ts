import { BrowserContext, Page } from 'playwright';
import { DomService } from '../dom';
import { ActionRegistry } from '../action';
import { LLMProvider, ToolDefinition } from './llm';
import { Planner } from './planner';
import { MemoryManager } from './memory';
import { AgentConfig, AgentEvent, Plan, Task } from '../types/agent';
import { createAgentWorkerPage, closeAgentWorkerPage } from '../../main/tab-cdp-bridge';

export class BrowserAgent {

    private context: BrowserContext;
    private page: Page;
    private llm: LLMProvider;
    private planner: Planner;
    private config: AgentConfig;

    private currentPlan: Plan | null = null;
    private memory: MemoryManager;
    private isRunning: boolean = false;
    private currentDom: DomService | null = null; // Track active DomService for overlay updates

    constructor(context: BrowserContext, page: Page, llm: LLMProvider, config: AgentConfig) {
        this.context = context;
        this.page = page;
        this.llm = llm;
        this.planner = new Planner(llm);
        this.config = config;
        this.memory = new MemoryManager(llm);
    }

    async plan(goal: string) {

        this.memory.add('user', `GOAL: ${goal}`);
        this.emit('thought', `Analyzing request: "${goal}"`);

        const history = await this.memory.getContext();
        const intent = await this.classifyIntent(history);

        if (!intent.needsBrowsing) {

            await this.streamDirectAnswer();

            this.currentPlan = {
                id: `plan-${Date.now()}`,
                goal,
                createdAt: Date.now(),
                status: 'completed', // Marked done!
                tasks: [{
                    id: '0',
                    description: 'Answer Question',
                    status: 'completed',
                    dependencies: []
                }]
            };

            return this.currentPlan;
        }

        const mainDom = new DomService(this.page);
        const state = await mainDom.getClickableState(false);

        this.emit('thought', `Generating execution strategy...`);
        const steps = await this.planner.makePlan(goal, state);

        this.currentPlan = {
            id: `plan-${Date.now()}`,
            goal,
            createdAt: Date.now(),
            status: 'active',
            tasks: steps.map((desc, i) => ({
                id: i.toString(),
                description: desc,
                status: 'pending',
                // Simple sequential dependency by default (0 -> 1 -> 2)
                // A smarter planner could output explicit dependencies.
                // For now, we assume step N depends on N-1 unless the LLM says "PARALLEL"
                dependencies: i > 0 ? [(i - 1).toString()] : []
            }))
        };

        this.emit('plan', 'Plan generated. Waiting for approval.', this.currentPlan);
        return this.currentPlan;
    }

    private async classifyIntent(history: any[]): Promise<{ needsBrowsing: boolean }> {
        const response = await this.llm.generate([
            {
                role: 'system',
                content: `You are a Router. Analyze the user query.
    Return JSON ONLY: { "needsBrowsing": boolean }
    - true: if the user asks to perform an action on the web, find current real-time data, or interact with a site.
    - false: if the user asks a general knowledge question, a calculation, or code generation that doesn't need external data.`
            },
            ...history
        ], [], true); // Force JSON mode

        try {
            const cleanJson = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanJson);
        } catch (e) {
            // Default to safe option: Browse if unsure
            return { needsBrowsing: true };
        }
    }

    async revisePlan(userFeedback: string): Promise<Plan> {
        if (!this.currentPlan) throw new Error('No plan to revise');
        if (this.currentPlan.status === 'completed') throw new Error("Cannot revise a completed plan.");

        this.emit('thought', `Revising plan based on feedback: "${userFeedback}"...`);

        const currentSteps = this.currentPlan.tasks.map(t => t.description);
        const newSteps = await this.planner.rePlan(this.currentPlan.goal, currentSteps, userFeedback);

        this.currentPlan.tasks = newSteps.map((desc, i) => ({
            id: i.toString(),
            description: desc,
            status: 'pending',
            dependencies: i > 0 ? [(i - 1).toString()] : []
        }));

        this.emit('plan', 'Plan revised. Waiting for approval.', this.currentPlan);
        return this.currentPlan;
    }

    private findExecutionPaths(): Task[][] {
        // Find leaf nodes (tasks with no dependents)
        const leaves = this.currentPlan!.tasks.filter(task => {
            return !this.currentPlan!.tasks.some(t => t.dependencies.includes(task.id));
        });

        // For each leaf, trace back to root(s) to create a path
        const paths: Task[][] = [];
        for (const leaf of leaves) {
            const path = this.tracePathToRoot(leaf);
            paths.push(path);
        }

        return paths;
    }

    private tracePathToRoot(leaf: Task): Task[] {
        const path: Task[] = [leaf];
        let current = leaf;

        while (current.dependencies.length > 0) {
            // Follow the dependency chain (take first/primary dependency)
            const depId = current.dependencies[0];
            const parent = this.currentPlan!.tasks.find(t => t.id === depId)!;
            path.unshift(parent); // Add to front
            current = parent;
        }

        return path;
    }

    private async executePathInAgent(path: Task[], pathIndex: number) {
        this.emit('thought', `[Agent ${pathIndex}] Starting path with ${path.length} tasks`);

        let workerPage: Page | null = null;
        let tabId: string | null = null;

        try {
            // Create ONE tab for this entire path
            const result = await createAgentWorkerPage('about:blank');
            if (!result) throw new Error('Failed to create agent tab');

            workerPage = result.page;
            tabId = result.tabId;

            const workerDom = new DomService(workerPage);
            await workerDom.enableSpectatorMode(`Agent-${pathIndex}`);
            this.currentDom = workerDom; // Store reference for overlay updates

            // Execute each task in sequence on this ONE tab
            for (const task of path) {
                task.status = 'running';
                this.emit('thought', `[Agent ${pathIndex}] Executing task ${task.id}: "${task.description}"`);
                this.emit('plan', 'Task running', this.currentPlan);

                const result = await this.runThinkActObserveLoop(
                    workerPage,
                    workerDom,
                    task.description
                );

                task.status = result.success ? 'completed' : 'failed';
                // Store the result summary on the task for final summary generation
                (task as any).result = result.summary;
                this.emit('thought', `[Agent ${pathIndex}] Task ${task.id} ${result.success ? 'completed' : 'failed'}`);
                this.emit('plan', 'Task updated', this.currentPlan);

                if (!result.success) {
                    // Mark remaining tasks in this path as failed
                    const remainingIndex = path.indexOf(task) + 1;
                    path.slice(remainingIndex).forEach(t => t.status = 'failed');
                    break;
                }
            }

            await workerDom.disableSpectatorMode();
            this.currentDom = null;

        } catch (error: any) {
            this.emit('error', `[Agent ${pathIndex}] Error: ${error.message}`);
            path.forEach(t => { if (t.status === 'pending' || t.status === 'running') t.status = 'failed'; });
        } finally {
            // Close the agent's tab
            if (tabId) {
                await closeAgentWorkerPage(tabId);
            }
        }
    }

    async execute() {
        if (!this.currentPlan) throw new Error('No plan to execute');
        if (this.currentPlan.status === 'completed') {
            this.emit('thought', 'Plan already completed.');
            return;
        }

        this.isRunning = true;
        this.emit('thought', 'Plan approved. Starting execution...');

        try {
            // Find all execution paths through the DAG
            const paths = this.findExecutionPaths();
            this.emit('thought', `Identified ${paths.length} execution path(s)`);

            // Execute all paths in parallel (each in its own agent/tab)
            const pathPromises = paths.map((path, index) =>
                this.executePathInAgent(path, index)
            );

            await Promise.all(pathPromises);

            // Generate final summary
            const summary = await this.generateFinalSummary(
                this.currentPlan.goal,
                this.currentPlan.tasks
            );
            this.emit('result', summary);
            this.currentPlan.status = 'completed';
            this.emit('plan', 'Plan completed', this.currentPlan);

        } catch (error: any) {
            this.emit('error', `Orchestrator Error: ${error.message}`);
        } finally {
            this.isRunning = false;
        }
    }

    private async runThinkActObserveLoop(page: Page, dom: DomService, subGoal: string): Promise<{ success: boolean; summary: string }> {
        const workerMem = new MemoryManager(this.llm);
        workerMem.add('system', `You are a browser automation agent executing a sequence of related tasks.
Your current task: "${subGoal}"

You are working in a persistent browser tab. Previous tasks may have already navigated to pages or completed actions. Continue from the current state.

## IMPORTANT LIMITATIONS
- You can ONLY interact with elements INSIDE the webpage (the DOM)
- You CANNOT interact with browser chrome (address bar, tabs, bookmarks, etc.)
- The numbered elements you see are ONLY page content elements

## AVAILABLE TOOLS

### Navigation Tools
1. **navigate** - Go directly to any URL
   - Use this to visit websites! Don't try to click an address bar.
   - Example: navigate({ url: "https://google.com" })
   - Example: navigate({ url: "https://amazon.com/search?q=laptop" })

2. **go_back** - Go back in browser history
   - No parameters needed
   - Example: go_back({})

3. **refresh** - Reload the current page
   - No parameters needed
   - Example: refresh({})

### Interaction Tools
4. **click_element** - Click on a numbered element
   - index: The element number from the screenshot (required)
   - open_in_new_tab: Set true to Ctrl+click (optional, default: false)
   - Example: click_element({ index: 5 })
   - Example: click_element({ index: 12, open_in_new_tab: true })

5. **input_text** - Type text into an input field
   - index: The element number (required)
   - text: What to type (required)
   - clear: Clear field first (optional, default: true)
   - submit: Press Enter after typing (optional, default: false)
   - Example: input_text({ index: 3, text: "search query", submit: true })

6. **scroll_page** - Scroll to see more content
   - direction: "up" or "down" (default: "down")
   - amount: Pixels to scroll (default: 500)
   - Example: scroll_page({ direction: "down", amount: 800 })

### Content Extraction
7. **extract_content** - Extract specific information from the current page
   - goal: Description of what information to extract
   - Example: extract_content({ goal: "Get the main article text" })

### Task Completion
8. **task_complete** - Signal task is done
   - success: true if goal achieved, false if impossible
   - summary: Brief description of what happened
   - Example: task_complete({ success: true, summary: "Successfully searched for laptops" })
   - Example: task_complete({ success: false, summary: "Login required but no credentials available" })

## WORKFLOW
1. Analyze the screenshot and DOM tree
2. Identify which numbered element to interact with, OR use navigate for URLs
3. Execute ONE action at a time
4. Observe the result and repeat until done
5. Call task_complete when finished or stuck

## COMMON SCENARIOS
- "Go to google.com" → Use navigate({ url: "https://google.com" })
- "Search for X" → Find search input, use input_text with submit: true
- "Click the login button" → Find the button number, use click_element
- "Go back to previous page" → Use go_back({})

## WHAT TO DO WHEN STUCK
- If you can't find an element: scroll_page to reveal more content
- If page hasn't loaded: wait and observe the new screenshot
- If task is impossible (e.g., needs login): call task_complete with success: false

Remember: You're interacting with PAGE CONTENT only. Use navigate() for URLs!`);

        let stepCount = 0;
        const MAX_STEPS = 50;

        while (stepCount < MAX_STEPS) {
            stepCount++;

            // Use Set-of-Mark prompting: capture screenshot with highlights, then remove them
            // Retry once if context is destroyed due to navigation
            let state;
            try {
                state = await dom.captureStateWithScreenshot();
            } catch (error: any) {
                if (error.message?.includes('context was destroyed') || error.message?.includes('navigation')) {
                    // Wait for navigation to complete and retry
                    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                    state = await dom.captureStateWithScreenshot();
                } else {
                    throw error;
                }
            }

            const history = await workerMem.getContext();

            // Extract only INTERACTIVE elements from DOM tree
            // This dramatically reduces context size while preserving what the agent needs
            const interactiveElements = this.extractInteractiveElements(state.tree);
            const elementsText = interactiveElements.length > 0
                ? interactiveElements.map(e => {
                    let desc = `[${e.id}] ${e.tag}`;
                    if (e.text) desc += `: "${e.text.substring(0, 80)}${e.text.length > 80 ? '...' : ''}"`;
                    if (e.href) desc += ` → ${e.href.substring(0, 60)}`;
                    if (e.placeholder) desc += ` (placeholder: "${e.placeholder}")`;
                    if (e.type) desc += ` [type=${e.type}]`;
                    if (e.role) desc += ` [role=${e.role}]`;
                    return desc;
                }).join('\n')
                : 'No interactive elements found';

            const context = [
                ...history,
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            image: {
                                data: state.screenshot,
                                mediaType: 'image/jpeg' as const
                            }
                        },
                        {
                            type: 'text',
                            text: `Screenshot shows numbered elements (Set-of-Mark). Use these IDs to interact.

Interactive Elements (${interactiveElements.length} total):
${elementsText}

What action should I take next to achieve: "${subGoal}"?`
                        }
                    ]
                }
            ] as any;

            const tools = this.getToolsForLLM();
            const response = await this.llm.generate(context, tools);

            this.emit('thought', `[${subGoal}] ${response.content}`);
            await dom.updateSpectatorThought(response.content);
            workerMemoryAdd(workerMem, 'assistant', response.content);

            if (response.toolCalls && response.toolCalls.length > 0) {
                let taskCompleted = false;
                let taskSuccess = false;
                let taskSummary = '';

                for (const call of response.toolCalls) {
                    // Ensure arguments is always an object (defensive handling)
                    const toolArgs = call.arguments ?? {};

                    this.emit('action', `[${subGoal}] Executing ${call.name}`, toolArgs);
                    console.log(`[Agent] Tool call: ${call.name}, args:`, JSON.stringify(toolArgs));

                    const tool = Object.values(ActionRegistry).find(t => t.name === call.name);
                    if (tool) {
                        const result = await tool.execute(toolArgs, {
                            page: page,
                            selectorMap: state.selectorMap,
                            domService: dom
                        });

                        this.emit('action', `[${subGoal}] Result: ${result.output}`);
                        workerMemoryAdd(workerMem, 'user', `Tool(${call.name}): ${result.output}`);

                        // Wait for navigation to settle after actions that might navigate
                        // (e.g., input_text with submit, click, navigate)
                        if (['input_text', 'click_element', 'navigate', 'go_back', 'refresh'].includes(call.name)) {
                            try {
                                await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
                            } catch {
                                // Timeout is fine - page might not have navigated
                            }
                        }

                        // When task_complete is called, exit the loop regardless of success/failure
                        // The agent has decided the task is done (either completed or impossible)
                        if (call.name === 'task_complete') {
                            taskCompleted = true;
                            taskSuccess = result.success;
                            taskSummary = result.output; // Capture the summary from task_complete
                        }
                    }
                }

                // Exit if agent called task_complete (success OR failure)
                if (taskCompleted) return { success: taskSuccess, summary: taskSummary };
            } else {
                workerMemoryAdd(workerMem, 'user', 'No tool used. If done (or stuck), call "task_complete".');
            }

        }
        return { success: false, summary: 'Max steps reached without completion' };
    }

    private getToolsForLLM(): ToolDefinition[] {
        return Object.values(ActionRegistry).map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.schema
        }));
    }

    private async generateFinalSummary(goal: string, tasks: Task[]) {
        // Build a log that includes actual task results
        const logs = tasks.filter(t => t.status === 'completed')
            .map(t => {
                const result = (t as any).result || 'Completed';
                return `Task: ${t.description}\nResult: ${result}`;
            }).join('\n\n');

        const prompt = `GOAL: ${goal}\n\nCOMPLETED TASKS AND RESULTS:\n${logs}\n\nBased on these results, provide a comprehensive answer to the user's original goal. Use the extracted information from the task results above.`;
        const context = [{ role: 'user', content: prompt }] as any;

        return this.streamToUI(context);
    }

    // New helper to handle streaming for both simple and complex paths
    private async streamDirectAnswer() {
        const context = await this.memory.getContext();
        // Inject system prompt if not present
        if (context[0].role !== 'system') {
            context.unshift({ role: 'system', content: 'You are a helpful assistant.' });
        }

        const stream = this.llm.stream(context);
        let fullText = '';

        for await (const chunk of stream) {
            fullText += chunk;
            this.emit('result_stream', chunk);
        }

        // Add the ASSISTANT'S response to memory so we remember what we said!
        this.memory.add('assistant', fullText);

        this.emit('result', fullText);
        return fullText;
    }

    private async streamToUI(context: any[]) {
        const stream = this.llm.stream(context);
        let fullText = '';
        for await (const chunk of stream) {
            fullText += chunk;
            this.emit('result_stream', chunk);
        }
        this.emit('result', fullText);
        return fullText;
    }

    private emit(type: AgentEvent['type'], message: string, data?: any) {
        if (this.config.onStream) {
            this.config.onStream({
                agentId: this.config.id,
                type,
                message,
                timestamp: Date.now(),
                data
            });
        }

        // Also update the in-page spectator overlay for thought/action events
        if ((type === 'thought' || type === 'action') && this.currentDom) {
            // Fire and forget - don't await to avoid blocking
            this.currentDom.updateSpectatorThought(message).catch(() => {
                // Ignore errors - page might have navigated
            });
        }
    }

    /**
     * Extract only interactive elements from DOM tree as a flat list.
     * This dramatically reduces context size while preserving what the agent needs.
     */
    private extractInteractiveElements(node: any, result: any[] = []): any[] {
        if (!node) return result;

        // If this node is interactive, add it to results
        if (node.isInteractive && node.nodeId) {
            const elem: any = {
                id: node.nodeId,
                tag: node.tagName,
            };

            // Add text if available (truncate for context savings)
            if (node.text) {
                elem.text = node.text.trim().substring(0, 150);
            }

            // Add key attributes
            if (node.attributes) {
                if (node.attributes.href) elem.href = node.attributes.href;
                if (node.attributes.placeholder) elem.placeholder = node.attributes.placeholder;
                if (node.attributes.type) elem.type = node.attributes.type;
                if (node.attributes.role) elem.role = node.attributes.role;
                if (node.attributes.name) elem.name = node.attributes.name;
                if (node.attributes['aria-label']) elem.ariaLabel = node.attributes['aria-label'];
            }

            result.push(elem);
        }

        // Recurse into children
        if (node.children && Array.isArray(node.children)) {
            for (const child of node.children) {
                this.extractInteractiveElements(child, result);
            }
        }

        return result;
    }
}

function workerMemoryAdd(mem: MemoryManager, role: 'user' | 'assistant', content: string) {
    mem.add(role, content);
}
