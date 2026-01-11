import { LLMProvider } from './llm';
import { DOMState } from '../types/dom';

export class Planner {
    constructor(private llm: LLMProvider) { }


    async makePlan(goal: string, domState: DOMState): Promise<string[]> {

        const simplifiedDom = JSON.stringify(domState.tree, (key, value) => {
            if (key === 'rect' || key === 'attributes') return undefined;
            if (key === 'children' && Array.isArray(value) && value.length === 0) return undefined;
            return value;
        });

        const response = await this.llm.generate([
            {
                role: 'system',
                content: `You are an expert Browser Automation Planner.
Your job is to break down a complex user goal into HIGH-LEVEL tasks.
You are strictly a PLANNER. You do not execute actions.

## CRITICAL: TASK GRANULARITY
Each task should describe a GOAL to achieve, NOT specific UI actions.
The execution agent is intelligent and will figure out HOW to accomplish each goal.

BAD (too atomic - causes loops):
- "Click on the featured article link"
- "Find the search box"
- "Click submit button"

GOOD (goal-oriented):
- "Navigate to Wikipedia's main page"
- "Read the Today's Featured Article section and note its topic"
- "Search for 'machine learning' and go to the first result"
- "Extract and summarize the article content"

## AVAILABLE TOOLS (that execution agents can use)
1. **navigate** - Go to any URL directly
2. **click_element** - Click on page elements
3. **input_text** - Type text into input fields (can submit)
4. **scroll_page** - Scroll to see more content
5. **extract_content** - Read and extract text from the page
6. **task_complete** - Mark task as done

## PLANNING GUIDELINES
- Describe WHAT to achieve, not HOW to click
- Each task should have a clear completion criteria
- Typically 2-4 high-level tasks is enough
- The agent will decide which elements to interact with
- Trust the agent to navigate, click, and type as needed

## Response Format
Return a valid JSON object with a "steps" array.
Example for "Go to Wikipedia and tell me about the featured article":
{
"steps": [
    "Navigate to Wikipedia's main page",
    "Find and read the Today's Featured Article section, extracting its content and main topic"
]
}`
            },
            {
                role: 'user',
                content: `GOAL: ${goal}\n\nCURRENT PAGE STATE:\n${simplifiedDom}`
            }
        ],
            [],
            true
        );


        try {

            const cleanJson = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
            const plan = JSON.parse(cleanJson);
            return plan.steps || [goal];
        } catch (e) {
            console.warn("Planner failed to parse JSON, falling back to raw goal");
            return [goal];
        }

    }


    async rePlan(originalGoal: string, currentSteps: string[], feedback: string): Promise<string[]> {
        const response = await this.llm.generate(
            [
                {
                    role: 'system',
                    content: `You are a Planner. The user wants to modify the current plan.
    Current Goal: "${originalGoal}"
    Current Plan:
    ${currentSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
    
    User Feedback: "${feedback}"
    
    Return a JSON object with the updated "steps" array.`
                },
                { role: 'user', content: "Please update the plan." }
            ],
            [],
            true // Force JSON
        );

        try {
            const cleanJson = response.content.replace(/```json/g, '').replace(/```/g, '').trim();
            const plan = JSON.parse(cleanJson);
            return plan.steps || currentSteps;
        } catch (e) {
            return currentSteps; // Fallback
        }
    }
}