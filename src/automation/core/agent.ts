import { BrowserContext, Page } from 'playwright';
import { DomService } from '../dom';
import { ActionRegistry } from '../action';
import { LLMProvider, ToolDefinition } from './llm';
import { Planner } from './planner';
import { MemoryManager } from './memory';
import { AgentConfig, AgentEvent, Plan, Task } from '../types/agent';

export class BrowserAgent {

    private context: BrowserContext;
    private page: Page;
    private llm: LLMProvider;
    private planner: Planner;
    private config: AgentConfig;

    private currentPlan: Plan | null = null;
    private memory: MemoryManager;
    private isRunning: boolean = false;

    constructor(context: BrowserContext, page: Page, llm: LLMProvider, config: AgentConfig) {
        this.context = context;
        this.page = page;
        this.llm = llm;
        this.planner = new Planner(llm);
        this.config = config;
        this.memory = new MemoryManager(llm);
    }

    async plan(goal: string) {
        this.memory = new MemoryManager(this.llm);
        this.memory.add('user', `GOAL: ${goal}`);
        this.emit('thought', `Analyzing request: "${goal}"`);

        const intent = await this.classifyIntent(goal);

        if (!intent.needsBrowsing){

            await this.streamDirectAnswer(goal);

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

    private async classifyIntent(goal: string): Promise<{ needsBrowsing: boolean }> {
        const response = await this.llm.generate([
          { 
            role: 'system', 
            content: `You are a Router. Analyze the user query.
    Return JSON ONLY: { "needsBrowsing": boolean }
    - true: if the user asks to perform an action on the web, find current real-time data, or interact with a site.
    - false: if the user asks a general knowledge question, a calculation, or code generation that doesn't need external data.` 
          },
          { role: 'user', content: goal }
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

    async execute() {
        if (!this.currentPlan) throw new Error('No plan to execute');
        if (this.currentPlan.status === 'completed') {
            this.emit('thought', 'Plan already completed.');
            return;
        }

        this.isRunning = true;
        this.emit('thought', 'Plan approved. Starting execution...');

        try {
            while (true) {
                const runnableTasks = this.getRunnableTasks();

                if (runnableTasks.length === 0) {
                    const running = this.currentPlan.tasks.filter(t => t.status === 'running');
                    const pending = this.currentPlan.tasks.filter(t => t.status === 'pending');

                    if (running.length > 0) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                        continue;
                    }
                    if (pending.length > 0) {
                        throw new Error(`Deadlock: ${pending.length} tasks pending but blocked.`)
                    }
                    break;
                }

                this.emit('thought', `Dispatching ${runnableTasks.length} workers in parallel...`);

                const workerPromises = runnableTasks.map(task => this.runTaskInWorker(task));
                await Promise.all(workerPromises);
            }

            const summary = await this.generateFinalSummary(this.currentPlan.goal, this.currentPlan.tasks);
            this.emit('result', summary);
            this.currentPlan.status = 'completed';
        } catch (error: any) {
            this.emit('error', `Orchestrator Error: ${error.message}`);
        } finally {
            this.isRunning = false; 
        }
    }

    private async runTaskInWorker(task: Task) {
        task.status = 'running';
        this.emit('thought', `[Worker ${task.id}] Started: "${task.description}"`);

        let workerPage: Page | null = null;

        try {
            workerPage = await this.context.newPage();
            const workerDom = new DomService(workerPage);
            await workerDom.enableSpectatorMode(task.id);

            const success = await this.runThinkActObserveLoop(workerPage, workerDom, task.description);
            
            if (success) {
                task.status = 'completed';
                this.emit('thought', `[Worker ${task.id}] Completed: "${task.description}"`);
            } else {
                task.status = 'failed';
                this.emit('thought', `[Worker ${task.id}] Failed: "${task.description}"`);
            }
        } catch (error: any) {
            task.status = 'failed';
            this.emit('error', `[Worker ${task.id}] Error: "${error.message}"`);
        } finally {
            if (workerPage) await workerPage.close();
        }
    }

    private async runThinkActObserveLoop(page: Page, dom: DomService, subGoal: string): Promise<boolean> {
        const workerMem = new MemoryManager(this.llm);
        workerMem.add('system', `You are a worker. Goal: "${subGoal}". 
        Use the DOM IDs to interact. If done, call 'task_complete'.`);

        let stepCount = 0;
        const MAX_STEPS = 50;

        while (stepCount < MAX_STEPS) {
            stepCount++;

            const state = await dom.getClickableState(true);

            const history = await workerMem.getContext();

            const context = [
                ...history,
                { role: 'user', content: `CURRENT DOM:\n${JSON.stringify(state.tree)}\n\nNext action?` }
            ] as any;

            const tools = this.getToolsForLLM();
            const response = await this.llm.generate(context, tools);

            this.emit('thought', `[${subGoal}] ${response.content}`);
            await dom.updateSpectatorThought(response.content);
            workerMemoryAdd(workerMem, 'assistant', response.content);

            if (response.toolCalls && response.toolCalls.length > 0) {
                let taskCompleted = false;

                for (const call of response.toolCalls) {
                    this.emit('action', `[${subGoal}] Executing ${call.name}`, call.arguments);

                    const tool = Object.values(ActionRegistry).find(t => t.name === call.name);
                    if (tool) {
                        const result = await tool.execute(call.arguments, {
                            page: page,
                            selectorMap: state.selectorMap,
                            domService: dom
                        });

                        this.emit('action', `[${subGoal}] Result: ${result.output}`);
                        workerMemoryAdd(workerMem, 'user', `Tool(${call.name}): ${result.output}`);

                        if (call.name === 'task_complete' && result.success) taskCompleted = true;
                    }

                    
                }

                if (taskCompleted) return true;
            } else{
                workerMemoryAdd(workerMem, 'user', 'No tool used. If done (or stuck), call "task_complete".');
            }

        }
        return false;
    }

    private getRunnableTasks(): Task[] {
        if (!this.currentPlan) return [];
        return this.currentPlan!.tasks.filter(t => {
            if (t.status !== 'pending') return false;
            if (t.dependencies.length === 0) return true;
            const parents = this.currentPlan!.tasks.filter(p => t.dependencies.includes(p.id));
            return parents.every(p => p.status === 'completed');
        });
    }

    private getToolsForLLM(): ToolDefinition[] {
        return Object.values(ActionRegistry).map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.schema
        }));
    }

    private async generateFinalSummary(goal: string, tasks: Task[]) {
        const logs = tasks.filter(t => t.status === 'completed')
          .map(t => `Task: ${t.description}\nStatus: Completed`).join('\n\n');
    
        const prompt = `GOAL: ${goal}\n\nEXECUTION LOG:\n${logs}\n\nProvide a comprehensive answer/summary.`;
        const context = [{ role: 'user', content: prompt }] as any;
        
        return this.streamToUI(context);
    }

    // New helper to handle streaming for both simple and complex paths
    private async streamDirectAnswer(goal: string) {
        const context = [
            { role: 'system', content: 'You are a helpful assistant. Answer the user request directly.'},
            { role: 'user', content: goal}
        ] as any;
        return this.streamToUI(context);
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
    }
}

function workerMemoryAdd(mem: MemoryManager, role: 'user' | 'assistant', content: string) {
    mem.add(role, content);
}
