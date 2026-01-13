import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
    artifacts?: { name: string; data: string }[]
}

interface Task {
    id: string
    description: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
    dependencies: string[]
    assignedAgentId?: string
    result?: any
    error?: string
}

interface Plan {
    id: string
    goal: string
    status: 'active' | 'completed' | 'pending'
    tasks: Task[]
    createdAt: number
}

interface AgentThought {
    agentId: string
    message: string
    timestamp: number
}

interface ChatContextType {
    messages: Message[]
    isLoading: boolean

    // Plan state
    currentPlan: Plan | null
    agentThoughts: AgentThought[]
    isPlanAwaitingApproval: boolean

    // Code preview state
    pendingCode: string | null
    pendingCodeStatus: string

    // Chat actions
    sendMessage: (content: string, file?: File) => Promise<void>
    clearChat: () => void

    // Plan approval actions
    approvePlan: () => Promise<void>
    revisePlan: (feedback: string) => Promise<void>

    // Page content access
    getPageContent: () => Promise<string | null>
    getPageText: () => Promise<string | null>
    getCurrentUrl: () => Promise<string | null>
}

const ChatContext = createContext<ChatContextType | null>(null)

export const useChat = () => {
    const context = useContext(ChatContext)
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider')
    }
    return context
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [messages, setMessages] = useState<Message[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [currentPlan, setCurrentPlan] = useState<Plan | null>(null)
    const [agentThoughts, setAgentThoughts] = useState<AgentThought[]>([])
    const [isPlanAwaitingApproval, setIsPlanAwaitingApproval] = useState(false)
    const [_isExecuting, setIsExecuting] = useState(false)
    const [pendingCode, setPendingCode] = useState<string | null>(null)
    const [pendingCodeStatus, setPendingCodeStatus] = useState<string>("Writing code for task...")

    // Load initial messages from main process
    useEffect(() => {
        const loadMessages = async () => {
            try {
                const storedMessages = await window.sidebarAPI.getMessages()
                if (storedMessages && storedMessages.length > 0) {
                    // Convert CoreMessage format to our frontend Message format
                    const convertedMessages = storedMessages.map((msg: any, index: number) => ({
                        id: `msg-${index}`,
                        role: msg.role,
                        content: typeof msg.content === 'string'
                            ? msg.content
                            : msg.content.find((p: any) => p.type === 'text')?.text || '',
                        timestamp: Date.now(),
                        isStreaming: false,
                        artifacts: msg.artifacts
                    }))
                    setMessages(convertedMessages)
                }
            } catch (error) {
                console.error('Failed to load messages:', error)
            }
        }
        loadMessages()
    }, [])

    const sendMessage = useCallback(async (content: string, file?: File) => {
        setIsLoading(true)

        try {
            const messageId = Date.now().toString()
            let fileData: { name: string; data: ArrayBuffer } | undefined;
            if (file) {
                const arrayBuffer = await file.arrayBuffer();
                fileData = {
                    name: file.name,
                    data: arrayBuffer
                };
            }

            // Send message to main process (agent handler)
            // The agent will process the message and send responses via chat-response events
            await window.sidebarAPI.sendChatMessage({
                message: content,
                messageId: messageId,
                file: fileData
            })

            // Note: isLoading will be set to false when chat-response event with isComplete: true is received
            // Messages will be updated via the chat-messages-updated event
        } catch (error) {
            console.error('Failed to send message:', error)
            setIsLoading(false)
        }
    }, [])

    const clearChat = useCallback(async () => {
        try {
            await window.sidebarAPI.clearChat()
            setMessages([])
            setCurrentPlan(null)
            setAgentThoughts([])
            setIsPlanAwaitingApproval(false)
            setIsExecuting(false)
        } catch (error) {
            console.error('Failed to clear chat:', error)
        }
    }, [])

    const approvePlan = useCallback(async () => {
        try {
            setIsPlanAwaitingApproval(false)
            setIsExecuting(true) // Mark execution as started
            const result = await window.sidebarAPI.approvePlan()
            if (!result.success) {
                console.error('Failed to approve plan:', result.error)
                setIsExecuting(false)
            }
        } catch (error) {
            console.error('Failed to approve plan:', error)
            setIsExecuting(false)
        }
    }, [])

    const revisePlan = useCallback(async (feedback: string) => {
        try {
            const result = await window.sidebarAPI.revisePlan(feedback)
            if (result.success && result.plan) {
                setCurrentPlan(result.plan)
                setIsPlanAwaitingApproval(true)
            } else {
                console.error('Failed to revise plan:', result.error)
            }
        } catch (error) {
            console.error('Failed to revise plan:', error)
        }
    }, [])

    const getPageContent = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageContent()
        } catch (error) {
            console.error('Failed to get page content:', error)
            return null
        }
    }, [])

    const getPageText = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageText()
        } catch (error) {
            console.error('Failed to get page text:', error)
            return null
        }
    }, [])

    const getCurrentUrl = useCallback(async () => {
        try {
            return await window.sidebarAPI.getCurrentUrl()
        } catch (error) {
            console.error('Failed to get current URL:', error)
            return null
        }
    }, [])

    // Set up message listeners
    useEffect(() => {
        // Listen for streaming response updates
        // Note: Agent events (result_stream, result, error) are converted to chat-response format
        // by the AgentMessageManager in the main process
        const handleChatResponse = (data: { messageId: string; content: string; isComplete: boolean }) => {
            if (data.isComplete) {
                setIsLoading(false)
                setPendingCode(null)
                setPendingCodeStatus("Writing code for task...")
            }

            // Update the streaming message in the UI
            setMessages(prev => {
                const newMessages = [...prev]
                const lastMsg = newMessages[newMessages.length - 1]

                // If the last message is from assistant and matches the streaming ID/flow, update it
                // Or if we need to append a new assistant message for the stream
                if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
                    lastMsg.content = data.content
                    if (data.isComplete) {
                        lastMsg.isStreaming = false
                    }
                    return newMessages
                } else if (!data.isComplete || (lastMsg?.role === 'user')) {
                    // Append new streaming message if it doesn't exist
                    newMessages.push({
                        id: data.messageId,
                        role: 'assistant',
                        content: data.content,
                        timestamp: Date.now(),
                        isStreaming: !data.isComplete
                    })
                    return newMessages
                }

                return prev
            })
        }

        // Listen for message updates from main process
        const handleMessagesUpdated = (updatedMessages: any[]) => {
            // Convert CoreMessage format to our frontend Message format
            const convertedMessages = updatedMessages.map((msg: any, index: number) => ({
                id: `msg-${index}`,
                role: msg.role,
                content: typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.find((p: any) => p.type === 'text')?.text || '',
                timestamp: Date.now(),
                isStreaming: false,
                artifacts: msg.artifacts
            }))
            setMessages(convertedMessages)
        }

        window.sidebarAPI.onChatResponse(handleChatResponse)
        window.sidebarAPI.onMessagesUpdated(handleMessagesUpdated)

        return () => {
            window.sidebarAPI.removeChatResponseListener()
            window.sidebarAPI.removeMessagesUpdatedListener()
        }
    }, [])

    // Set up agent plan and thought listeners
    useEffect(() => {
        // Listen for plan updates
        const handleAgentPlan = (plan: Plan) => {
            console.log('[ChatContext] Received plan:', plan)
            setCurrentPlan(plan)

            // Check if plan is completed
            if (plan.status === 'completed') {
                setIsExecuting(false)
                setIsPlanAwaitingApproval(false)
                return
            }

            // Determine if this is a NEW plan awaiting approval vs an execution update
            const allPending = plan.tasks.every(t => t.status === 'pending')
            const hasRunningOrCompleted = plan.tasks.some(t =>
                t.status === 'running' || t.status === 'completed' || t.status === 'failed'
            )

            // Only show approval UI if:
            // 1. Plan is active
            // 2. All tasks are still pending (no execution has started)
            // 3. No task has started running/completed/failed
            if (plan.status === 'active' && allPending && !hasRunningOrCompleted) {
                setIsExecuting(false) // Reset execution state for new plan
                setIsPlanAwaitingApproval(true)
            }
            // Don't set isPlanAwaitingApproval to false here - 
            // it's managed by approvePlan() when user approves
        }

        // Listen for agent thoughts
        const handleAgentThought = (thought: AgentThought) => {
            console.log('[ChatContext] Received thought:', thought.message)
            setAgentThoughts(prev => {
                // Keep only the last 10 thoughts to avoid memory issues
                const newThoughts = [...prev, thought]
                if (newThoughts.length > 10) {
                    return newThoughts.slice(-10)
                }
                return newThoughts
            })
        }

        // Listen for agent actions - clear code preview when action completes
        const handleAgentAction = (action: { agentId: string; message: string; data?: any; timestamp: number }) => {
            console.log('[ChatContext] Agent action:', action.message)
            if (action.message.includes('Result:') || action.message.includes('STDOUT') || action.message.includes('executed')) {
                setPendingCode(null)
                setPendingCodeStatus("Writing code for task...")
            }
        }

        const handleAgentCodePreview = (data: { agentId: string; code: string; timestamp: number; data?: { isComplete: boolean } }) => {
            console.log('[ChatContext] Code preview received')
            setPendingCode(data.code)

            if (data.data?.isComplete) {
                setPendingCodeStatus("Executing Python...")
            } else {
                setPendingCodeStatus("Writing code for task...")
            }
        }

        window.sidebarAPI.onAgentPlan(handleAgentPlan)
        window.sidebarAPI.onAgentThought(handleAgentThought)
        window.sidebarAPI.onAgentAction(handleAgentAction)
        window.sidebarAPI.onAgentCodePreview(handleAgentCodePreview)

        return () => {
            window.sidebarAPI.removeAgentPlanListener()
            window.sidebarAPI.removeAgentThoughtListener()
            window.sidebarAPI.removeAgentActionListener()
            window.sidebarAPI.removeAgentCodePreviewListener()
        }
    }, [])

    const value: ChatContextType = {
        messages,
        isLoading,
        currentPlan,
        agentThoughts,
        isPlanAwaitingApproval,
        pendingCode,
        pendingCodeStatus,
        sendMessage,
        clearChat,
        approvePlan,
        revisePlan,
        getPageContent,
        getPageText,
        getCurrentUrl
    }

    return (
        <ChatContext.Provider value={value}>
            {children}
        </ChatContext.Provider>
    )
}

