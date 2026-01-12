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
                // Emit as action so it doesn't overwrite the "Reasoning" thought in the UI
                this.emit('action', `[Agent ${pathIndex}] Executing task ${task.id}: "${task.description}"`);
                this.emit('plan', 'Task running', this.currentPlan);

                const result = await this.runThinkActObserveLoop(
                    workerPage,
                    workerDom,
                    task.description,
                    this.currentPlan!.goal
                );

                task.status = result.success ? 'completed' : 'failed';
                // Store the result summary on the task for final summary generation
                (task as any).result = result.summary;
                this.emit('action', `[Agent ${pathIndex}] Task ${task.id} ${result.success ? 'completed' : 'failed'}`);
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

            // Generate final summary (streamToUI already emits the result)
            await this.generateFinalSummary(
                this.currentPlan.goal,
                this.currentPlan.tasks
            );
            this.currentPlan.status = 'completed';
            this.emit('plan', 'Plan completed', this.currentPlan);

        } catch (error: any) {
            this.emit('error', `Orchestrator Error: ${error.message}`);
        } finally {
            this.isRunning = false;
        }
    }

    private async runThinkActObserveLoop(page: Page, dom: DomService, subGoal: string, mainGoal: string): Promise<{ success: boolean; summary: string }> {
        const workerMem = new MemoryManager(this.llm);
        workerMem.add('system', `You are a browser automation agent executing a sequence of related tasks.
OVERARCHING GOAL: "${mainGoal}"
Your current sub-task: "${subGoal}"

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

### Keyboard Shortcuts
7. **press_key** - Press a keyboard key (VERY USEFUL for popups!)
   - key: The key to press ("Escape", "Enter", "Tab", "ArrowDown", etc.)
   - Example: press_key({ key: "Escape" }) - DISMISSES MOST POPUPS/MODALS
   - Example: press_key({ key: "Enter" }) - Confirms dialogs

### Content Extraction
8. **extract_content** - Extract specific information from the current page
   - goal: Description of what information to extract
   - Example: extract_content({ goal: "Get the main article text" })

### Tab Management
9. **switch_to_tab** - Switch between open tabs (useful when clicks open new tabs)
   - tab_index: The tab number to switch to (shown in OPEN TABS list)
   - Example: switch_to_tab({ tab_index: 1 })
   - Note: When you click something that opens a new tab, you'll automatically switch to it

10. **close_tab** - Close a specific tab
   - tab_index: The tab number to close (shown in OPEN TABS list)
   - Example: close_tab({ tab_index: 1 })
   - Use this to keep your workspace clean when done with a tab

### Task Completion
11. **task_complete** - Signal task is done
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

## HANDLING OVERLAYS AND POPUPS
⚠️ IF CLICKS DON'T SEEM TO WORK, A POPUP/MODAL IS PROBABLY BLOCKING!
Common signs: "All Offers" dialogs, cookie banners, login prompts, newsletter signups

**FIRST TRY: press_key({ key: "Escape" })** - This dismisses MOST popups instantly!

If Escape doesn't work:
1. Look for "Close", "X", "Dismiss", "Accept", "Got it" buttons in the element list
2. These are usually small elements with just "X" or "Close" text
3. Click the close button, THEN retry your original action

**WARNING**: If you click the same element 2+ times and nothing changes, STOP and try:
1. press_key({ key: "Escape" }) first
2. Look for a different element to click
3. Scroll to see if there's a close button

## VIDEO SITES (YouTube, Netflix, etc.)
- Video thumbnails are clickable! Look for elements with "video", "thumbnail", or "watch" in their text/aria-label
- On YouTube, video titles are links (<a> tags) - click them to play the video
- The "first video" is usually the first <a> element with a title that sounds like a video name
- If you see ytd-video-renderer or ytd-thumbnail, the video title link inside is what you click
- Don't just click element 2 - that's often the logo! Look for elements with video descriptions

## WHAT TO DO WHEN STUCK
- **Clicks not working?** → press_key({ key: "Escape" }) to dismiss popups
- **Can't find element?** → scroll_page to reveal more content
- **Page not loaded?** → wait and observe the new screenshot
- **Same action failing repeatedly?** → TRY A DIFFERENT APPROACH
- **Task impossible (needs login)?** → call task_complete with success: false

Remember: You're interacting with PAGE CONTENT only. Use navigate() for URLs!`);

        // Track all actions for loop prevention
        interface ActionRecord {
            step: number;
            action: string;
            target?: number;
            result: string;
        }
        const actionsTaken: ActionRecord[] = [];

        // Multi-tab tracking: track all pages under agent control
        interface TrackedTab {
            page: Page;
            dom: DomService;
            url: string;
            title: string;
        }
        const agentTabs: Map<number, TrackedTab> = new Map();
        let activeTabIndex = 0;
        let nextTabIndex = 1;

        // Initialize with the primary tab
        agentTabs.set(0, { page, dom, url: page.url(), title: 'Initial Tab' });

        // Listen for popups (new tabs opened from clicks)
        const popupHandler = async (newPage: Page) => {
            // Check if we're already tracking this page
            const existingId = Array.from(agentTabs.entries()).find(([, t]) => t.page === newPage)?.[0];
            if (existingId !== undefined) return;

            const tabIndex = nextTabIndex++;
            console.log(`[Agent] New tab opened: ${newPage.url()}, assigning index ${tabIndex}`);

            // Recursively listen for popups on the new page too
            newPage.on('popup', popupHandler);

            // Listen for closure to remove from list
            newPage.on('close', () => {
                console.log(`[Agent] Tab ${tabIndex} closed externally`);
                agentTabs.delete(tabIndex);
                if (activeTabIndex === tabIndex) {
                    activeTabIndex = 0; // Fallback to main tab
                    this.emit('action', `[Agent] Tab ${tabIndex} closed, switching back to main tab`);
                }
            });

            // Wait for the page to be somewhat ready
            await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });

            // Create DomService for the new tab and enable spectator mode
            const newDom = new DomService(newPage);
            await newDom.enableSpectatorMode(`Tab-${tabIndex}`);

            const title = await newPage.title().catch(() => 'New Tab');
            agentTabs.set(tabIndex, {
                page: newPage,
                dom: newDom,
                url: newPage.url(),
                title
            });

            // Auto-switch to the new tab
            activeTabIndex = tabIndex;
            this.emit('action', `[Agent] Switched to new tab ${tabIndex}: ${newPage.url()}`);
        };

        // Attach popup listener to all tracked pages
        page.on('popup', popupHandler);
        // Also listen for main page closure just in case
        page.on('close', () => {
            console.log('[Agent] Main agent tab closed');
            // Loop will exit on next iteration due to error likely
        });

        // Helper to get current active tab
        const getActiveTab = (): TrackedTab => {
            const tab = agentTabs.get(activeTabIndex);
            if (!tab) {
                // Fallback to primary tab if active is somehow missing
                return agentTabs.get(0)!;
            }
            return tab;
        };

        // Helper to build tab list for LLM context
        const getTabListText = (): string => {
            if (agentTabs.size <= 1) return ''; // Don't show if only one tab

            const lines: string[] = ['## OPEN TABS'];
            for (const [idx, tab] of agentTabs) {
                const isActive = idx === activeTabIndex;
                const shortUrl = tab.url.length > 60 ? tab.url.substring(0, 60) + '...' : tab.url;
                lines.push(`[${idx}] ${shortUrl}${isActive ? ' ← ACTIVE' : ''}`);
            }
            lines.push('Use switch_to_tab({ tab_index: N }) to switch between tabs.\n');
            return lines.join('\n');
        };

        let stepCount = 0;
        const MAX_STEPS = 25; // Reduced from 50 to fail faster on loops

        while (stepCount < MAX_STEPS) {
            stepCount++;

            // Get the currently active tab (may have changed due to popups)
            const activeTab = getActiveTab();
            const activePage = activeTab.page;
            const activeDom = activeTab.dom;

            // Update URL tracking for tab list display
            activeTab.url = activePage.url();

            // Use Set-of-Mark prompting: capture screenshot with highlights, then remove them
            // Retry once if context is destroyed due to navigation
            let state;
            try {
                state = await activeDom.captureStateWithScreenshot();
            } catch (error: any) {
                if (error.message?.includes('context was destroyed') || error.message?.includes('navigation')) {
                    // Wait for navigation to complete and retry
                    await activePage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => { });
                    state = await activeDom.captureStateWithScreenshot();
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

            // Build action history text for context
            const actionHistoryText = actionsTaken.length > 0
                ? actionsTaken.map(a =>
                    `• Step ${a.step}: ${a.action}${a.target !== undefined ? ` #${a.target}` : ''} → ${a.result}`
                ).join('\n')
                : 'None yet';

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
                            text: `## GOALS (Always Keep In Mind)
🎯 MAIN GOAL: "${mainGoal}"
📌 CURRENT SUB-TASK: "${subGoal}"

## ACTIONS TAKEN (Do NOT Repeat These)
${actionHistoryText}

${getTabListText()}## CURRENT PAGE STATE
Interactive Elements (${interactiveElements.length}):
${elementsText}

## YOUR TASK
What is the NEXT action to achieve "${subGoal}"?
⚠️ CRITICAL: Do NOT repeat any action from the list above. If a previous action didn't work, try a DIFFERENT approach.`
                        }
                    ]
                }
            ] as any;

            const tools = this.getToolsForLLM();
            const response = await this.llm.generate(context, tools);

            this.emit('thought', `[${subGoal}] ${response.content}`);
            await activeDom.updateSpectatorThought(response.content);
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

                    // Handle switch_to_tab specially - it modifies activeTabIndex
                    if (call.name === 'switch_to_tab') {
                        const tabIndex = (toolArgs as any).tab_index;
                        if (agentTabs.has(tabIndex)) {
                            activeTabIndex = tabIndex;
                            const result = `Switched to tab ${tabIndex}: ${agentTabs.get(tabIndex)!.url}`;
                            this.emit('action', `[${subGoal}] ${result}`);
                            workerMemoryAdd(workerMem, 'user', `Tool ${call.name} result: ${result}`);
                            actionsTaken.push({ step: stepCount, action: call.name, target: tabIndex, result: 'Switched' });
                            continue;
                        } else {
                            const result = `Error: Tab ${tabIndex} not found. Available tabs: ${Array.from(agentTabs.keys()).join(', ')}`;
                            workerMemoryAdd(workerMem, 'user', `Tool ${call.name} result: ${result}`);
                            continue;
                        }
                    }

                    // Handle close_tab specially
                    if (call.name === 'close_tab') {
                        const tabIndex = (toolArgs as any).tab_index;
                        if (tabIndex === 0) {
                            const result = `Error: Cannot close the main tab (index 0).`;
                            workerMemoryAdd(workerMem, 'user', `Tool ${call.name} result: ${result}`);
                            continue;
                        }
                        if (agentTabs.has(tabIndex)) {
                            // Close the page - this triggers the 'close' listener we set up
                            try {
                                const tab = agentTabs.get(tabIndex)!;
                                await tab.dom.disableSpectatorMode().catch(() => { });
                                await tab.page.close();
                                const result = `Closed tab ${tabIndex}`;
                                this.emit('action', `[${subGoal}] ${result}`);
                                workerMemoryAdd(workerMem, 'user', `Tool ${call.name} result: ${result}`);
                                actionsTaken.push({ step: stepCount, action: call.name, target: tabIndex, result: 'Closed' });
                            } catch (err: any) {
                                const result = `Error closing tab ${tabIndex}: ${err.message}`;
                                workerMemoryAdd(workerMem, 'user', `Tool ${call.name} result: ${result}`);
                            }
                            continue;
                        } else {
                            const result = `Error: Tab ${tabIndex} not found or already closed.`;
                            workerMemoryAdd(workerMem, 'user', `Tool ${call.name} result: ${result}`);
                            continue;
                        }
                    }

                    const tool = Object.values(ActionRegistry).find(t => t.name === call.name);
                    if (tool) {
                        const result = await tool.execute(toolArgs, {
                            page: activePage,
                            selectorMap: state.selectorMap,
                            domService: activeDom
                        });

                        this.emit('action', `[${subGoal}] Result: ${result.output}`);
                        workerMemoryAdd(workerMem, 'user', `Tool(${call.name}): ${result.output}`);

                        // Track action for loop prevention
                        actionsTaken.push({
                            step: stepCount,
                            action: call.name,
                            target: toolArgs.index,
                            result: result.output.substring(0, 80)
                        });

                        // Detect and warn on duplicate actions
                        const duplicateCount = actionsTaken.filter(a =>
                            a.action === call.name && a.target === toolArgs.index && a.target !== undefined
                        ).length;

                        if (duplicateCount >= 2) {
                            console.warn(`[Agent] ⚠️ Duplicate action detected: ${call.name} on #${toolArgs.index} (${duplicateCount}x)`);
                            workerMemoryAdd(workerMem, 'user',
                                `⚠️ WARNING: You've performed ${call.name} on element #${toolArgs.index} ${duplicateCount} times. This action may not be working. Try a DIFFERENT element or approach!`
                            );
                        }

                        // Force exit if same action repeated 4+ times (definite loop)
                        if (duplicateCount >= 4) {
                            this.emit('thought', `🔄 Loop detected: ${call.name} on #${toolArgs.index} repeated ${duplicateCount} times. Forcing exit.`);
                            return { success: false, summary: `Stuck in loop: repeated ${call.name} on element #${toolArgs.index}` };
                        }

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
                if (taskCompleted) {
                    // Cleanup: remove popup listener and close extra tabs
                    page.off('popup', popupHandler);
                    for (const [idx, tab] of agentTabs) {
                        if (idx !== 0) { // Don't close the primary tab
                            await tab.dom.disableSpectatorMode().catch(() => { });
                            await tab.page.close().catch(() => { });
                        }
                    }
                    return { success: taskSuccess, summary: taskSummary };
                }
            } else {
                workerMemoryAdd(workerMem, 'user', 'No tool used. If done (or stuck), call "task_complete".');
            }

        }
        // Cleanup on max steps
        page.off('popup', popupHandler);
        for (const [idx, tab] of agentTabs) {
            if (idx !== 0) {
                await tab.dom.disableSpectatorMode().catch(() => { });
                await tab.page.close().catch(() => { });
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
