import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ArrowUp, Plus, CheckCircle2, Circle, Loader2, XCircle, Clock, Brain, Paperclip, X } from 'lucide-react'
import { useChat } from '../contexts/ChatContext'
import { cn } from '@common/lib/utils'
import { Button } from '@common/components/Button'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
    artifacts?: { name: string; data: string }[]
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
        return undefined
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
            remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
            rehypePlugins={[rehypeKatex]}
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

const ArtifactsDisplay: React.FC<{ artifacts?: { name: string; data: string }[] }> = ({ artifacts }) => {
    if (!artifacts || artifacts.length === 0) return null;
    return (
        <div className="flex flex-col gap-3 mt-3 animate-fade-in group-artifacts">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Generated Artifacts</h4>
            <div className="grid grid-cols-1 gap-2">
                {artifacts.map((art, i) => {
                    const ext = art.name.split('.').pop()?.toLowerCase();
                    let mime = 'application/octet-stream';
                    if (ext === 'png') mime = 'image/png';
                    else if (ext === 'jpg' || ext === 'jpeg') mime = 'image/jpeg';
                    else if (ext === 'svg') mime = 'image/svg+xml';

                    const isImage = mime.startsWith('image/');
                    const dataUri = `data:${mime};base64,${art.data}`;

                    if (isImage) {
                        return (
                            <div key={i} className="group relative rounded-xl overflow-hidden border border-border bg-background shadow-sm">
                                <img src={dataUri} alt={art.name} className="w-full h-auto max-h-[300px] object-contain bg-muted/20" />
                                <div className="bg-background/90 backdrop-blur-sm px-3 py-2 text-xs border-t border-border flex justify-between items-center">
                                    <span className="font-medium truncate">{art.name}</span>
                                    <button onClick={() => window.sidebarAPI.downloadArtifact(art)} className="text-primary hover:underline">Download</button>
                                </div>
                            </div>
                        );
                    } else {
                        return (
                            <button key={i} onClick={() => window.sidebarAPI.downloadArtifact(art)} className="flex items-center justify-between p-3 bg-muted/50 hover:bg-muted rounded-xl border border-border transition-all w-full text-left">
                                <div className="flex items-center gap-2">
                                    <Paperclip className="size-4 text-muted-foreground" />
                                    <span className="text-sm font-medium">{art.name}</span>
                                </div>
                                <span className="text-xs text-primary font-medium">Download</span>
                            </button>
                        );
                    }
                })}
            </div>
        </div>
    );
}

// Assistant Message Component - appears on the left
const AssistantMessage: React.FC<{ message: Message }> = ({ message }) => (
    <div className="relative w-full animate-fade-in">
        <div className="py-1">
            {message.isStreaming ? (
                <StreamingText content={message.content} />
            ) : (
                <Markdown content={message.content} />
            )}
            <ArtifactsDisplay artifacts={message.artifacts} />
        </div>
    </div>
)

// Code Preview Panel - shows Python code before execution
const CodePreviewPanel: React.FC<{ code: string; status?: string }> = ({ code, status = "Executing Python..." }) => {
    const preRef = useRef<HTMLPreElement>(null)

    useEffect(() => {
        if (preRef.current) {
            preRef.current.scrollTop = preRef.current.scrollHeight
        }
    }, [code])

    return (
        <div className="animate-fade-in rounded-xl border border-primary/30 bg-muted/30 overflow-hidden mb-4">
            <div className="flex items-center gap-2 px-4 py-2 bg-primary/10 border-b border-primary/20">
                <Loader2 className="size-4 text-primary animate-spin" />
                <span className="text-sm font-medium text-primary">{status}</span>
            </div>
            <pre ref={preRef} className="p-4 text-sm overflow-x-auto max-h-[300px] overflow-y-auto">
                <code className="text-foreground">{code}</code>
            </pre>
        </div>
    )
}

// Loading Indicator with spinning blueberry logo
const LoadingIndicator: React.FC = () => {
    const [isVisible, setIsVisible] = useState(false)

    useEffect(() => {
        setIsVisible(true)
    }, [])

    return (
        <div className={cn(
            "transition-transform duration-300 ease-in-out flex items-center gap-2",
            isVisible ? "scale-100" : "scale-0"
        )}>
            {/* Spinning Blueberry Logo */}
            <svg
                className="size-6 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
            >
                {/* Blueberry body */}
                <circle cx="12" cy="13" r="9" fill="#6366F1" />
                <circle cx="12" cy="13" r="9" fill="url(#blueberry-gradient)" />
                {/* Highlight */}
                <ellipse cx="9" cy="10" rx="2.5" ry="1.5" fill="rgba(255,255,255,0.3)" transform="rotate(-20 9 10)" />
                {/* Stem top */}
                <path d="M11 4 C11 2, 13 2, 13 4 L13 6 C13 7, 11 7, 11 6 Z" fill="#22C55E" />
                {/* Leaf */}
                <path d="M13 5 Q16 3, 17 5 Q16 7, 13 6" fill="#22C55E" />
                <defs>
                    <radialGradient id="blueberry-gradient" cx="0.3" cy="0.3" r="0.7">
                        <stop offset="0%" stopColor="#818CF8" />
                        <stop offset="100%" stopColor="#4338CA" />
                    </radialGradient>
                </defs>
            </svg>
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

const PlanTaskItem: React.FC<{ task: Task; index: number }> = ({ task, index: _index }) => (
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
                    <div className="flex items-start gap-2 h-32">
                        <Brain className="size-4 text-primary mt-0.5 flex-shrink-0" />
                        <div className="text-xs text-muted-foreground h-full w-full overflow-y-auto scrollbar-thin pr-2">
                            <Markdown content={latestThought.message} />
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

// Chat Input Component with pill design
const ChatInput: React.FC<{
    onSend: (message: string, file?: File) => void
    disabled: boolean
}> = ({ onSend, disabled }) => {
    const [value, setValue] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [isFocused, setIsFocused] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

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
        if ((value.trim() || file) && !disabled) {
            onSend(value.trim(), file || undefined)
            setValue('')
            setFile(null)
            if (fileInputRef.current) fileInputRef.current.value = ''
            // Reset textarea height
            if (textareaRef.current) {
                textareaRef.current.style.height = '24px'
            }
        }
    }

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0])
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
                <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                />

                {/* Attachment Button */}
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={disabled}
                    className={cn(
                        "size-8 rounded-full flex items-center justify-center",
                        "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        "transition-colors"
                    )}
                    title="Attach file"
                >
                    <Paperclip className="size-5" />
                </button>

                {/* File Preview */}
                {file && (
                    <div className="flex items-center gap-2 max-w-[200px] bg-muted/50 px-3 py-1 rounded-full border border-border">
                        <span className="text-xs truncate max-w-[150px]">{file.name}</span>
                        <button
                            onClick={() => {
                                setFile(null)
                                if (fileInputRef.current) fileInputRef.current.value = ''
                            }}
                            className="hover:text-destructive"
                        >
                            <X className="size-3" />
                        </button>
                    </div>
                )}

                <div className="flex-1" />
                <button
                    onClick={handleSubmit}
                    disabled={disabled || (!value.trim() && !file)}
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
            <AssistantMessage message={turn.assistant} />
        )}
        {isLoading && (!plan || plan.status === 'completed') && (
            <div className="flex justify-start">
                <LoadingIndicator />
            </div>
        )}
    </div>
)

// Main Chat Component
export const Chat: React.FC = () => {
    const { messages, isLoading, sendMessage, clearChat, currentPlan, agentThoughts, isPlanAwaitingApproval, approvePlan, revisePlan, pendingCode, pendingCodeStatus } = useChat()
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

                            {/* Code Preview Panel */}
                            {pendingCode && <CodePreviewPanel code={pendingCode} status={pendingCodeStatus} />}
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