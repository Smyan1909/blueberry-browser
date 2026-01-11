import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { ArrowUp, Square, Sparkles, Plus, CheckCircle2, Circle, Loader2, XCircle, Clock, Brain } from 'lucide-react'
import { useChat } from '../contexts/ChatContext'
import { cn } from '@common/lib/utils'
import { Button } from '@common/components/Button'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
}

// Auto-scroll hook
const useAutoScroll = (messages: Message[]) => {
    const scrollRef = useRef<HTMLDivElement>(null)
    const prevCount = useRef(0)

    useLayoutEffect(() => {
        if (messages.length > prevCount.current) {
            setTimeout(() => {
                scrollRef.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'end'
                })
            }, 100)
        }
        prevCount.current = messages.length
    }, [messages.length])

    return scrollRef
}

// User Message Component - appears on the right
const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <div className="relative max-w-[85%] ml-auto animate-fade-in">
        <div className="bg-muted dark:bg-muted/50 rounded-3xl px-6 py-4">
            <div className="text-foreground" style={{ whiteSpace: 'pre-wrap' }}>
                {content}
            </div>
        </div>
    </div>
)

// Streaming Text Component
const StreamingText: React.FC<{ content: string }> = ({ content }) => {
    const [displayedContent, setDisplayedContent] = useState('')
    const [currentIndex, setCurrentIndex] = useState(0)

    useEffect(() => {
        if (currentIndex < content.length) {
            const timer = setTimeout(() => {
                setDisplayedContent(content.slice(0, currentIndex + 1))
                setCurrentIndex(currentIndex + 1)
            }, 10)
            return () => clearTimeout(timer)
        }
    }, [content, currentIndex])

    return (
        <div className="whitespace-pre-wrap text-foreground">
            {displayedContent}
            {currentIndex < content.length && (
                <span className="inline-block w-2 h-5 bg-primary/60 dark:bg-primary/40 ml-0.5 animate-pulse" />
            )}
        </div>
    )
}

// Markdown Renderer Component
const Markdown: React.FC<{ content: string }> = ({ content }) => (
    <div className="prose prose-sm dark:prose-invert max-w-none 
                    prose-headings:text-foreground prose-p:text-foreground 
                    prose-strong:text-foreground prose-ul:text-foreground 
                    prose-ol:text-foreground prose-li:text-foreground
                    prose-a:text-primary hover:prose-a:underline
                    prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 
                    prose-code:rounded prose-code:text-sm prose-code:text-foreground
                    prose-pre:bg-muted dark:prose-pre:bg-muted/50 prose-pre:p-3 
                    prose-pre:rounded-lg prose-pre:overflow-x-auto">
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{
                // Custom code block styling
                code: ({ node, className, children, ...props }) => {
                    const inline = !className
                    return inline ? (
                        <code className="bg-muted dark:bg-muted/50 px-1 py-0.5 rounded text-sm text-foreground" {...props}>
                            {children}
                        </code>
                    ) : (
                        <code className={className} {...props}>
                            {children}
                        </code>
                    )
                },
                // Custom link styling
                a: ({ children, href }) => (
                    <a
                        href={href}
                        className="text-primary hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {children}
                    </a>
                ),
            }}
        >
            {content}
        </ReactMarkdown>
    </div>
)

// Assistant Message Component - appears on the left
const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean }> = ({
    content,
    isStreaming
}) => (
    <div className="relative w-full animate-fade-in">
        <div className="py-1">
            {isStreaming ? (
                <StreamingText content={content} />
            ) : (
                <Markdown content={content} />
            )}
        </div>
    </div>
)

// Loading Indicator with spinning star
const LoadingIndicator: React.FC = () => {
    const [isVisible, setIsVisible] = useState(false)

    useEffect(() => {
        setIsVisible(true)
    }, [])

    return (
        <div className={cn(
            "transition-transform duration-300 ease-in-out",
            isVisible ? "scale-100" : "scale-0"
        )}>
            ...
        </div>
    )
}

// Task status icon component
const TaskStatusIcon: React.FC<{ status: string }> = ({ status }) => {
    switch (status) {
        case 'completed':
            return <CheckCircle2 className="size-4 text-green-500" />
        case 'running':
            return <Loader2 className="size-4 text-blue-500 animate-spin" />
        case 'failed':
            return <XCircle className="size-4 text-red-500" />
        case 'blocked':
            return <Clock className="size-4 text-yellow-500" />
        case 'pending':
        default:
            return <Circle className="size-4 text-muted-foreground" />
    }
}

// Plan task item component
interface Task {
    id: string
    description: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
    dependencies: string[]
}

const PlanTaskItem: React.FC<{ task: Task; index: number }> = ({ task, index }) => (
    <div className={cn(
        "flex items-start gap-3 py-2 px-3 rounded-lg transition-colors",
        task.status === 'running' && "bg-blue-500/10",
        task.status === 'completed' && "opacity-70"
    )}>
        <div className="mt-0.5">
            <TaskStatusIcon status={task.status} />
        </div>
        <div className="flex-1 min-w-0">
            <p className={cn(
                "text-sm",
                task.status === 'completed' && "line-through text-muted-foreground",
                task.status === 'running' && "text-foreground font-medium"
            )}>
                {task.description}
            </p>
        </div>
    </div>
)

// Plan visualization component
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

const PlanVisualization: React.FC<{ 
    plan: Plan; 
    thoughts: AgentThought[];
    isAwaitingApproval?: boolean;
    onApprove?: () => void;
    onRevise?: (feedback: string) => void;
}> = ({ plan, thoughts, isAwaitingApproval, onApprove, onRevise }) => {
    const [revisionFeedback, setRevisionFeedback] = useState('')
    const [showRevisionInput, setShowRevisionInput] = useState(false)
    const latestThought = thoughts[thoughts.length - 1]
    const completedCount = plan.tasks.filter(t => t.status === 'completed').length
    const totalCount = plan.tasks.length
    const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0

    const handleReviseSubmit = () => {
        if (revisionFeedback.trim() && onRevise) {
            onRevise(revisionFeedback.trim())
            setRevisionFeedback('')
            setShowRevisionInput(false)
        }
    }

    return (
        <div className="animate-fade-in rounded-2xl border border-border bg-muted/30 dark:bg-muted/20 overflow-hidden">
            {/* Plan Header */}
            <div className="px-4 py-3 border-b border-border bg-muted/50">
                <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold text-foreground">Execution Plan</h4>
                    <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full",
                        isAwaitingApproval && "bg-yellow-500/20 text-yellow-500",
                        !isAwaitingApproval && plan.status === 'active' && "bg-blue-500/20 text-blue-500",
                        plan.status === 'completed' && "bg-green-500/20 text-green-500"
                    )}>
                        {isAwaitingApproval ? 'Awaiting Approval' : plan.status}
                    </span>
                </div>
                {/* Progress bar */}
                <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                    <div 
                        className="h-full bg-primary transition-all duration-500 ease-out rounded-full"
                        style={{ width: `${progress}%` }}
                    />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                    {completedCount} of {totalCount} tasks completed
                </p>
            </div>

            {/* Tasks List */}
            <div className="divide-y divide-border/50">
                {plan.tasks.map((task, index) => (
                    <PlanTaskItem key={task.id} task={task} index={index} />
                ))}
            </div>

            {/* Approval Buttons - shown when plan is awaiting approval */}
            {isAwaitingApproval && (
                <div className="px-4 py-3 border-t border-border bg-muted/50">
                    {showRevisionInput ? (
                        <div className="space-y-2">
                            <textarea
                                value={revisionFeedback}
                                onChange={(e) => setRevisionFeedback(e.target.value)}
                                placeholder="Describe how you'd like to modify the plan..."
                                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                                rows={2}
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={handleReviseSubmit}
                                    disabled={!revisionFeedback.trim()}
                                    className="flex-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50"
                                >
                                    Submit Revision
                                </button>
                                <button
                                    onClick={() => setShowRevisionInput(false)}
                                    className="px-3 py-1.5 text-sm bg-muted text-foreground rounded-lg hover:bg-muted/80"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex gap-2">
                            <button
                                onClick={onApprove}
                                className="flex-1 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium flex items-center justify-center gap-2"
                            >
                                <CheckCircle2 className="size-4" />
                                Approve & Execute
                            </button>
                            <button
                                onClick={() => setShowRevisionInput(true)}
                                className="flex-1 px-4 py-2 text-sm bg-muted text-foreground rounded-lg hover:bg-muted/80 font-medium"
                            >
                                Revise Plan
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Latest Thought - only show when not awaiting approval */}
            {!isAwaitingApproval && latestThought && (
                <div className="px-4 py-3 border-t border-border bg-muted/30">
                    <div className="flex items-start gap-2">
                        <Brain className="size-4 text-primary mt-0.5 flex-shrink-0" />
                        <p className="text-xs text-muted-foreground italic line-clamp-2">
                            {latestThought.message}
                        </p>
                    </div>
                </div>
            )}
        </div>
    )
}

// Chat Input Component with pill design
const ChatInput: React.FC<{
    onSend: (message: string) => void
    disabled: boolean
}> = ({ onSend, disabled }) => {
    const [value, setValue] = useState('')
    const [isFocused, setIsFocused] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
            const scrollHeight = textareaRef.current.scrollHeight
            const newHeight = Math.min(scrollHeight, 200) // Max 200px
            textareaRef.current.style.height = `${newHeight}px`
        }
    }, [value])

    const handleSubmit = () => {
        if (value.trim() && !disabled) {
            onSend(value.trim())
            setValue('')
            // Reset textarea height
            if (textareaRef.current) {
                textareaRef.current.style.height = '24px'
            }
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
        }
    }

    return (
        <div className={cn(
            "w-full border p-3 rounded-3xl bg-background dark:bg-secondary",
            "shadow-chat animate-spring-scale outline-none transition-all duration-200",
            isFocused ? "border-primary/20 dark:border-primary/30" : "border-border"
        )}>
            {/* Input Area */}
            <div className="w-full px-3 py-2">
                <div className="w-full flex items-start gap-3">
                    <div className="relative flex-1 overflow-hidden">
                        <textarea
                            ref={textareaRef}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onFocus={() => setIsFocused(true)}
                            onBlur={() => setIsFocused(false)}
                            onKeyDown={handleKeyDown}
                            placeholder="Send a message..."
                            className="w-full resize-none outline-none bg-transparent 
                                     text-foreground placeholder:text-muted-foreground
                                     min-h-[24px] max-h-[200px]"
                            rows={1}
                            style={{ lineHeight: '24px' }}
                        />
                    </div>
                </div>
            </div>

            {/* Send Button */}
            <div className="w-full flex items-center gap-1.5 px-1 mt-2 mb-1">
                <div className="flex-1" />
                <button
                    onClick={handleSubmit}
                    disabled={disabled || !value.trim()}
                    className={cn(
                        "size-9 rounded-full flex items-center justify-center",
                        "transition-all duration-200",
                        "bg-primary text-primary-foreground",
                        "hover:opacity-80 disabled:opacity-50"
                    )}
                >
                    <ArrowUp className="size-5" />
                </button>
            </div>
        </div>
    )
}

// Conversation Turn Component
interface ConversationTurn {
    user?: Message
    assistant?: Message
}

const ConversationTurnComponent: React.FC<{
    turn: ConversationTurn
    isLoading?: boolean
    plan?: Plan | null
    thoughts?: AgentThought[]
    isAwaitingApproval?: boolean
    onApprove?: () => void
    onRevise?: (feedback: string) => void
}> = ({ turn, isLoading, plan, thoughts = [], isAwaitingApproval, onApprove, onRevise }) => (
    <div className="pt-12 flex flex-col gap-8">
        {turn.user && <UserMessage content={turn.user.content} />}
        
        {/* Show plan visualization when there's an active plan */}
        {plan && (plan.status === 'active' || isAwaitingApproval) && (
            <PlanVisualization 
                plan={plan} 
                thoughts={thoughts} 
                isAwaitingApproval={isAwaitingApproval}
                onApprove={onApprove}
                onRevise={onRevise}
            />
        )}
        
        {turn.assistant && (
            <AssistantMessage
                content={turn.assistant.content}
                isStreaming={turn.assistant.isStreaming}
            />
        )}
        {isLoading && !plan && (
            <div className="flex justify-start">
                <LoadingIndicator />
            </div>
        )}
    </div>
)

// Main Chat Component
export const Chat: React.FC = () => {
    const { messages, isLoading, sendMessage, clearChat, currentPlan, agentThoughts, isPlanAwaitingApproval, approvePlan, revisePlan } = useChat()
    const scrollRef = useAutoScroll(messages)

    // Group messages into conversation turns
    const conversationTurns: ConversationTurn[] = []
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') {
            const turn: ConversationTurn = { user: messages[i] }
            if (messages[i + 1]?.role === 'assistant') {
                turn.assistant = messages[i + 1]
                i++ // Skip next message since we've paired it
            }
            conversationTurns.push(turn)
        } else if (messages[i].role === 'assistant' &&
            (i === 0 || messages[i - 1]?.role !== 'user')) {
            // Handle standalone assistant messages
            conversationTurns.push({ assistant: messages[i] })
        }
    }

    // Check if we need to show loading after the last turn
    const showLoadingAfterLastTurn = isLoading &&
        messages[messages.length - 1]?.role === 'user'

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto">
                <div className="h-8 max-w-3xl mx-auto px-4">
                    {/* New Chat Button - Floating */}
                    {messages.length > 0 && (
                        <Button
                            onClick={clearChat}
                            title="Start new chat"
                            variant="ghost"
                        >
                            <Plus className="size-4" />
                            New Chat
                        </Button>
                    )}
                </div>

                <div className="pb-4 relative max-w-3xl mx-auto px-4">

                    {messages.length === 0 ? (
                        // Empty State
                        <div className="flex items-center justify-center h-full min-h-[400px]">
                            <div className="text-center animate-fade-in max-w-md mx-auto gap-2 flex flex-col">
                                <h3 className="text-2xl font-bold">🫐</h3>
                                <p className="text-muted-foreground text-sm">
                                    Press ⌘E to toggle the sidebar
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>

                            {/* Render conversation turns */}
                            {conversationTurns.map((turn, index) => (
                                <ConversationTurnComponent
                                    key={`turn-${index}`}
                                    turn={turn}
                                    isLoading={
                                        showLoadingAfterLastTurn &&
                                        index === conversationTurns.length - 1
                                    }
                                    plan={
                                        index === conversationTurns.length - 1
                                            ? currentPlan
                                            : null
                                    }
                                    thoughts={
                                        index === conversationTurns.length - 1
                                            ? agentThoughts
                                            : []
                                    }
                                    isAwaitingApproval={
                                        index === conversationTurns.length - 1 &&
                                        isPlanAwaitingApproval
                                    }
                                    onApprove={approvePlan}
                                    onRevise={revisePlan}
                                />
                            ))}
                        </>
                    )}

                    {/* Scroll anchor */}
                    <div ref={scrollRef} />
                </div>
            </div>

            {/* Input Area */}
            <div className="p-4">
                <ChatInput onSend={sendMessage} disabled={isLoading} />
            </div>
        </div>
    )
}