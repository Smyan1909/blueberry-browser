import { LLMProvider } from './llm';
import { DOMState } from '../types/dom';

export class Planner {
    constructor(private llm: LLMProvider) {}


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
Your job is to break down a complex user goal into a step-by-step list of actions (A To-do list of subgoals to reach the final goal).
You are strictly a PLANNER. You do not execute actions.

Response Format:
Return a valid JSON object with a "steps" array containing string descriptions.
Example:
{
"steps": [
    "Navigate to google.com",
    "Type 'latest tech news' into the search bar",
    "Click the first result",
    "Summarize the article"
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
    ${currentSteps.map((s, i) => `${i+1}. ${s}`).join('\n')}
    
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