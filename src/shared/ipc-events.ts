export const AGENT_EVENTS = {
    START: 'agent:start',
    STOP: 'agent:stop',
    STREAM: 'agent:event',
    APPROVE_PLAN: 'agent:approve-plan',
    REVISE_PLAN: 'agent:revise-plan',
}

// Export agent types for type safety
export type { AgentEvent, AgentEventType } from '../automation/types/agent';