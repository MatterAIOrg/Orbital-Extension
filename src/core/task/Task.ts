import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import EventEmitter from "events"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type PasteChipSerialized,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	RooCodeEventName,
	TelemetryEventName,
	TaskStatus,
	TodoItem,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	getApiProtocol,
	getModelId,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	QueuedMessage,
	getActiveToolUseStyle, // kilocode_change
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService, BridgeOrchestrator } from "@roo-code/cloud"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream, GroundingSource } from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { ClineApiReqCancelReason, ClineApiReqInfo, stringsToImageAttachments } from "../../shared/ExtensionMessage"
import { getApiMetrics, hasTokenUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug } from "../../shared/modes"
import { DiffStrategy, ToolUse } from "../../shared/tools"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { getModelMaxOutputTokens } from "../../shared/api"

// services
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher"
import { BrowserSession } from "../../services/browser/BrowserSession"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"
import {
	detectGitRepo,
	getGitHead,
	observeGitCommits,
	reportUsageEvent,
} from "../../services/usage-metrics/usageMetrics"
import { PlanMemoryManager } from "../kilocode/PlanMemoryManager"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { FileEditReviewController } from "../../integrations/editor/FileEditReviewController"
import { findToolName, formatContentBlockToMarkdown } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"

// utils
import { calculateApiCostAnthropic } from "../../shared/cost"
import { getWorkspacePath } from "../../utils/path"
import { getGitRepositoryInfo } from "../../utils/git"

// prompts
import { formatResponse } from "../prompts/responses"
import { getSystemPromptParts, SYSTEM_PROMPT, type SystemPromptParts } from "../prompts/system"
import {
	buildContextBreakdown,
	emptyContextBreakdown,
	type ContextBreakdown,
	type ContextBreakdownParts,
} from "../sliding-window/contextBreakdown"
import { getAllowedJSONToolsForMode } from "../prompts/tools/native-tools/getAllowedJSONToolsForMode" // kilocode_change
import type OpenAI from "openai" // forked_change: needed for MCP tool schema types

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask } from "../tools/updateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { AssistantMessageParser } from "../assistant-message/AssistantMessageParser"
import {
	allToolResultsCollected,
	reconcileAssistantToolUses,
	toolUseIdsRequiringResults,
} from "./toolCallResultPairing" // forked_change: keep assistant tool_calls and tool_results paired 1:1
import { truncateConversationIfNeeded } from "../sliding-window"
import { StaleToolResultPruner } from "../sliding-window/staleToolResults"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { MultiFileSearchReplaceDiffStrategy } from "../diff/strategies/multi-file-search-replace"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
	fetchTaskTitle, // kilocode_change
} from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processKiloUserContentMentions, stripTaskWrapperTags } from "../mentions/processKiloUserContentMentions" // kilocode_change
import { refreshWorkflowToggles } from "../context/instructions/workflows" // kilocode_change
import { parseMentions } from "../mentions" // kilocode_change
import { parseKiloSlashCommands } from "../slash-commands/kilo" // kilocode_change
import { GlobalFileNames } from "../../shared/globalFileNames" // kilocode_change
import { ensureLocalKilorulesDirExists } from "../context/instructions/kilo-rules" // kilocode_change
import {
	getMessagesSinceLastSummary,
	summarizeConversation,
	MIN_CONDENSE_THRESHOLD,
	MAX_CONDENSE_THRESHOLD,
} from "../condense"
import { Gpt5Metadata, ClineMessageWithMetadata } from "./types"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { isCompletionQueueBoundary, isTaskIdleForQueuedMessages } from "../message-queue/queueLifecycle"

import { AutoApprovalHandler } from "./AutoApprovalHandler"
import { isAnyRecognizedKiloCodeError, isPaymentRequiredError } from "../../shared/kilocode/errorUtils"
import { getAppUrl } from "@roo-code/types"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds
const FORCED_CONTEXT_REDUCTION_PERCENT = 75 // Keep 75% of context (remove 25%) on context window errors
const CONTEXT_WARNING_BAND_PERCENT = 10 // Warn the model this many percentage points below the condense threshold
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors

// kilocode_change: Idle timeout for stream consumption. If no chunk is received
// within this window, the stream is considered dead (network drop, socket close,
// etc.) and a timeout error is thrown so the existing catch block can persist it
// as a streaming failure and abort the task.
const STREAM_IDLE_TIMEOUT_MS = 180000 // 180 seconds

// forked_change: how many times to auto-retry a transient provider connection
// failure (socket closed by the network, idle timeout, DNS/TLS drop) before
// falling back to the manual retry prompt. Applies regardless of auto-approve.
const MAX_CONNECTION_RETRIES = 5
// Fixed delay between automatic connection retries.
const CONNECTION_RETRY_DELAY_MS = 10000 // 10 seconds
// forked_change: idle timeout for the final attempt after all automatic
// connection retries are exhausted. A silently stalled request (packets
// dropped, no error surfaced) must not hang for the full STREAM_IDLE_TIMEOUT_MS
// before the manual retry prompt appears.
const FINAL_ATTEMPT_IDLE_TIMEOUT_MS = 30000 // 30 seconds

/**
 * Race an async iterator's next() against an idle timeout.
 *
 * When the timeout fires before a chunk arrives, a descriptive error is thrown
 * so the caller's catch block can treat it as a stream disconnection. The
 * pending iterator.next() promise is abandoned (the underlying connection will
 * be cleaned up when the task aborts).
 */
async function nextWithIdleTimeout<T>(
	iterator: AsyncIterator<T>,
	timeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): Promise<IteratorResult<T>> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(
				new Error(
					`Stream idle timeout: no data received for ${timeoutMs}ms. The connection to the model may have been interrupted (network drop, socket closed, or server stopped responding).`,
				),
			)
		}, timeoutMs)
	})
	try {
		return (await Promise.race([iterator.next(), timeoutPromise])) as IteratorResult<T>
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle)
	}
}

// forked_change: distinguish a dropped/closed connection (typically the user's own
// machine — Wi-Fi drop, sleep/wake, VPN flip — or an in-transit socket reset) from a
// server-side HTTP error that carries a status code. Server errors have their own retry
// handling; connection closures should surface the retry button with a message that
// makes the local cause clear.
function isConnectionClosedError(error: any): boolean {
	if (!error) {
		return false
	}

	// A real HTTP response (>=400) means the server answered — not a socket closure.
	const status = Number(error.status ?? error.statusCode)
	if (Number.isFinite(status) && status >= 400) {
		return false
	}

	const connectionCodes = [
		"ECONNRESET",
		"ECONNREFUSED",
		"ECONNABORTED",
		"ETIMEDOUT",
		"EPIPE",
		"ENOTFOUND",
		"EAI_AGAIN",
		"ENETUNREACH",
		"ENETDOWN",
		"EHOSTUNREACH",
		"UND_ERR_SOCKET",
	]
	// The code can live on `code`/`cause.code`, or — because the OpenRouter provider
	// rethrows with `err.status = error.code` — on `status`/`statusCode` as a string.
	const codeCandidates = [error.code, error.cause?.code, error.status, error.statusCode].map((c) =>
		String(c ?? "").toUpperCase(),
	)
	if (codeCandidates.some((c) => connectionCodes.includes(c))) {
		return true
	}

	const message = `${error.message ?? ""} ${error.cause?.message ?? ""}`.toLowerCase()
	return (
		message.includes("socket hang up") ||
		message.includes("stream idle timeout") ||
		message.includes("terminated") ||
		message.includes("fetch failed") ||
		message.includes("network error") ||
		message.includes("connection closed") ||
		message.includes("econnreset")
	)
}

// forked_change: build the message shown on the api_req_failed retry prompt, calling out
// connection drops so the user understands the retry is safe (no server-side work was
// lost) and that the cause is most likely local.
function describeStreamFailure(error: any): string {
	const detail = error?.message ?? JSON.stringify(serializeError(error), null, 2)
	if (isConnectionClosedError(error)) {
		return (
			"Lost the connection to the model before the response finished. This usually means the " +
			"network on your machine dropped (Wi-Fi, VPN, or sleep/wake) rather than a server problem — " +
			`you can safely retry.\n\n${detail}`
		)
	}
	return detail
}

export interface TaskOptions extends CreateTaskOptions {
	context: vscode.ExtensionContext // kilocode_change
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableDiff?: boolean
	enableCheckpoints?: boolean
	enableBridge?: boolean
	fuzzyMatchThreshold?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
}

type UserContent = Array<Anthropic.ContentBlockParam> // kilocode_change

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	private context: vscode.ExtensionContext // kilocode_change

	readonly taskId: string
	private taskIsFavorited?: boolean // kilocode_change
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined
	readonly parentTask: Task | undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	abort: boolean = false
	// AbortController for the active API stream. Aborted in dispose() so that
	// raceStreamNext() unblocks the streaming loop instantly when the user
	// presses stop, instead of waiting for the next chunk from the provider.
	private streamAbortController?: AbortController
	autoApproveAllCommands: boolean = false // kilocode_change: auto-approve all commands for current task
	// forked_change: danger flag for the command currently awaiting approval, set by
	// executeCommandTool from the model's `isDangerous` param. Read by the command
	// branch of askApproval so the "Approve for me" mode auto-approves only safe commands.
	pendingCommandIsDangerous: boolean = false
	// True when the pending command only observes the workspace (rg, ls, git diff, ...) and
	// so skips the approval prompt in every approval mode. See core/tools/readOnlyCommand.ts.
	pendingCommandIsReadOnly: boolean = false
	// Stubs old bulky tool results in the outgoing request once context is large.
	private readonly staleToolResultPruner = new StaleToolResultPruner()

	// TaskStatus
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false
	pausedModeSlug: string = defaultModeSlug
	private pauseInterval: NodeJS.Timeout | undefined

	// API
	readonly apiConfiguration: ProviderSettings
	api: ApiHandler
	private static lastGlobalApiRequestTime?: number
	// Serializes the complete lifetime of provider streams for this task. A task can
	// be entered through more than one async path, so `isStreaming` alone is not an
	// atomic concurrency guard.
	private apiRequestLock: Promise<void> = Promise.resolve()
	// Covers the full agent turn, including context preparation, tool execution,
	// and every provider request it produces. This prevents queue draining in the
	// brief `isStreaming === false` gaps between requests in the same turn.
	private taskRequestLock: Promise<void> = Promise.resolve()
	private taskRequestCount = 0
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		Task.lastGlobalApiRequestTime = undefined
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	urlContentFetcher: UrlContentFetcher
	terminalProcess?: RooTerminalProcess

	// Computer User
	browserSession: BrowserSession

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	diffEnabled: boolean = false
	fuzzyMatchThreshold: number
	didEditFile: boolean = false
	fileEditReviewController: FileEditReviewController

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Context Window Usage Tracking
	contextWindowUsage?: {
		currentTokens: number
		maxTokens: number
		breakdown?: ContextBreakdown
	}

	/**
	 * Cached per-category text fragments from the most recent system-prompt
	 * build, used to recompute `contextWindowUsage.breakdown` after each API
	 * call without re-running the (expensive) prompt builder.
	 */
	private lastSystemPromptParts?: ContextBreakdownParts

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private askResponsePasteChips?: PasteChipSerialized[]
	public isWaitingForAskResponse = false
	public lastMessageTs?: number
	// Pending user messages live in the visible `messageQueueService` (single
	// source of truth) so they stay shown in the UI until they are actually sent.
	// This flag just guards against reentrant draining of that queue.
	private isProcessingManualMessages = false
	private lastUsageGitHead?: string

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	toolUsage: ToolUsage = {}

	// Checkpoints
	enableCheckpoints: boolean
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Task Bridge
	enableBridge: boolean

	// Plan Memory
	planMemoryManager?: PlanMemoryManager

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService
	private messageQueueStateChangedHandler: (() => void) | undefined

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (
		| Anthropic.TextBlockParam
		| Anthropic.ImageBlockParam
		| Anthropic.ToolResultBlockParam // kilocode_change
	)[] = []
	userMessageContentReady = false
	didRejectTool = false
	didAlreadyUseTool = false
	didCompleteReadingStream = false
	toolRepetitionAutoRetry = false
	/** True only while independent read-only native tools are executing as a batch. */
	parallelToolExecution = false
	/** Auto-retry is useful once, but must never become an unbounded model loop. */
	toolRepetitionAutoRetryCount = 0
	// Track executed tool calls by their signature (name + args hash) to detect duplicates
	private executedToolCallSignatures: Set<string> = new Set()
	// forked_change: task-lifetime map of file regions already read (path|offset|limit → file
	// mtimeMs at read time). Unlike executedToolCallSignatures this survives across turns, so
	// readFileTool can short-circuit repeated reads of an unchanged region with a hint instead
	// of re-emitting identical content (a common model failure is re-reading the file head
	// after omitting `offset`).
	readonly readRegionHistory: Map<string, number> = new Map()
	assistantMessageParser: AssistantMessageParser
	private lastUsedInstructions?: string
	private skipPrevResponseIdOnce: boolean = false
	// forked_change: set once per context window when the context budget warning
	// fires; re-arms automatically when usage drops back below the warning band
	private contextBudgetWarningIssued: boolean = false

	// Token Usage Cache
	private tokenUsageSnapshot?: TokenUsage
	private tokenUsageSnapshotAt?: number

	constructor({
		context, // kilocode_change
		provider,
		apiConfiguration,
		enableDiff = false,
		enableCheckpoints = true,
		enableBridge = false,
		fuzzyMatchThreshold = 1.0,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		task,
		images,
		historyItem,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		pasteChips,
	}: TaskOptions) {
		super()
		this.context = context // kilocode_change

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.taskId = historyItem ? historyItem.id : crypto.randomUUID()
		this.taskIsFavorited = historyItem?.isFavorited // kilocode_change
		this.rootTaskId = historyItem ? historyItem.rootTaskId : rootTask?.taskId
		this.parentTaskId = historyItem ? historyItem.parentTaskId : parentTask?.taskId
		this.childTaskId = undefined

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: (workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Documents"))) // kilocode_change: use Documents instead of Desktop as default
		this.lastUsageGitHead = getGitHead(this.cwd)

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(apiConfiguration)
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.browserSession = new BrowserSession(provider.context)
		this.diffEnabled = enableDiff
		this.fuzzyMatchThreshold = fuzzyMatchThreshold
		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)

		// Create token and repo getters for FileEditReviewController metrics reporting
		const getToken = async () => {
			const state = await this.providerRef.deref()?.getState()
			return state?.apiConfiguration?.kilocodeToken
		}
		const getRepo = async () => {
			return detectGitRepo(this.cwd)
		}

		this.fileEditReviewController = new FileEditReviewController(
			this.cwd,
			getToken,
			getRepo,
			() => this.api.getModel().id,
		)
		this.fileEditReviewController.setTaskId(this.taskId)
		this.enableCheckpoints = enableCheckpoints
		this.enableBridge = enableBridge

		this.parentTask = parentTask
		this.taskNumber = taskNumber

		// Store the task's mode when it's created.
		// For history items, use the stored mode; for new tasks, we'll set it
		// after getting state.
		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this.taskModeReady = Promise.resolve()
			// Restore context window usage from history
			this.contextWindowUsage = historyItem.contextWindowUsage
			TelemetryService.instance.captureTaskRestarted(this.taskId)
		} else {
			// For new tasks, don't set the mode yet - wait for async initialization.
			this._taskMode = undefined
			this.taskModeReady = this.initializeTaskMode(provider)
			TelemetryService.instance.captureTaskCreated(this.taskId)
		}

		// Initialize the assistant message parser with MCP tool checker.
		// forked_change: Pass MCP tool checker to handle native MCP tool calls
		this.assistantMessageParser = new AssistantMessageParser((toolName: string) => {
			const mcpHub = provider.getMcpHub()
			if (!mcpHub) {
				return undefined
			}
			const servers = mcpHub.getAllServers()
			for (const server of servers) {
				if (server.tools) {
					const tool = server.tools.find((t) => t.name === toolName)
					if (tool) {
						return { isMcpTool: true, serverName: server.name }
					}
				}
			}
			return undefined
		})

		this.messageQueueService = new MessageQueueService()

		this.messageQueueStateChangedHandler = () => {
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.providerRef.deref()?.postStateToWebview()
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Only set up diff strategy if diff is enabled.
		if (this.diffEnabled) {
			// Default to old strategy, will be updated if experiment is enabled.
			this.diffStrategy = new MultiSearchReplaceDiffStrategy(this.fuzzyMatchThreshold)

			// Check experiment asynchronously and update strategy if needed.
			provider.getState().then((state) => {
				const isMultiFileApplyDiffEnabled = experiments.isEnabled(
					state.experiments ?? {},
					EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF,
				)

				if (isMultiFileApplyDiffEnabled) {
					this.diffStrategy = new MultiFileSearchReplaceDiffStrategy(this.fuzzyMatchThreshold)
				}
			})
		}

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		// Initialize plan memory manager
		this.planMemoryManager = new PlanMemoryManager(this.taskId, this.globalStoragePath)
		this.planMemoryManager.initialize().catch((error) => {
			console.error("Failed to initialize PlanMemoryManager:", error)
		})

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		onCreated?.(this)

		if (startTask) {
			if (task || images) {
				this.startTask(task, images, pasteChips)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	// forked_change start
	private getContext(): vscode.ExtensionContext {
		const context = this.context
		if (!context) {
			throw new Error("Unable to access extension context")
		}
		return context
	}
	// forked_change end
	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * ## Example usage
	 * ```typescript
	 * // Wait for mode initialization before mode-dependent operations
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Now safe to access synchronously
	 *
	 * // Or use with getTaskMode() for a one-liner
	 * const mode = await task.getTaskMode(); // Internally waits for initialization
	 * ```
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // Safe async access
	 * const mode = await task.getTaskMode();
	 * console.log(`Task is running in ${mode} mode`);
	 *
	 * // Use in conditional logic
	 * if (await task.getTaskMode() === 'architect') {
	 *   // Perform architect-specific operations
	 * }
	 * ```
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		await this.taskModeReady
		return this._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // After ensuring initialization
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Safe synchronous access
	 *
	 * // In an event handler after task is started
	 * task.on('taskStarted', () => {
	 *   console.log(`Task started in ${task.taskMode} mode`); // Safe here
	 * });
	 * ```
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}

		return this._taskMode
	}

	/**
	 * Generate a unique signature for a tool call based on its name and arguments.
	 * This is used to detect duplicate tool calls within the same streaming response.
	 * @param toolName The name of the tool
	 * @param params The tool parameters
	 * @returns A string signature that uniquely identifies this tool call
	 */
	public getToolCallSignature(toolName: string, params: Record<string, unknown>): string {
		// Ensure params is an object before sorting keys (defensive against null/undefined from LLM output)
		const safeParams = params || {}

		// Recursively sort object keys at all levels for deterministic serialization
		const sortObject = (obj: unknown): unknown => {
			if (obj === null || typeof obj !== "object") return obj
			if (Array.isArray(obj)) return obj.map(sortObject)
			return Object.keys(obj as Record<string, unknown>)
				.sort()
				.reduce(
					(acc, key) => {
						acc[key] = sortObject((obj as Record<string, unknown>)[key])
						return acc
					},
					{} as Record<string, unknown>,
				)
		}

		const sortedParams = JSON.stringify(sortObject(safeParams))
		return `${toolName}:${sortedParams}`
	}

	/**
	 * Check if a tool call with the given signature has already been executed.
	 * If not, register it as executed.
	 * @param signature The tool call signature to check
	 * @returns true if this is a duplicate (already executed), false if it's new
	 */
	public checkAndRegisterToolCall(signature: string): boolean {
		if (this.executedToolCallSignatures.has(signature)) {
			return true // Duplicate detected
		}
		this.executedToolCallSignatures.add(signature)
		return false // New tool call
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem, pasteChips } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images, pasteChips)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		const messageWithTs = { ...message, ts: Date.now() }
		this.apiConversationHistory.push(messageWithTs)
		await this.saveApiConversationHistory()
	}

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			await saveApiMessages({
				messages: this.apiConversationHistory,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
		} catch (error) {
			// In the off chance this fails, we don't want to stop the task.
			console.error("Failed to save API conversation history:", error)
		}
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		const provider = this.providerRef.deref()
		await provider?.postStateToWebview()
		this.emit(RooCodeEventName.Message, { action: "created", message })
		await this.saveClineMessages()

		// forked_change start: no cloud service
		// const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		// if (shouldCaptureMessage) {
		// 	CloudService.instance.captureEvent({
		// 		event: TelemetryEventName.TASK_MESSAGE,
		// 		properties: { taskId: this.taskId, message },
		// 	})
		// }
		// forked_change end
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages

		// If deletion or history truncation leaves a condense_context as the last message,
		// ensure the next API call suppresses previous_response_id so the condensed context is respected.
		try {
			const last = this.clineMessages.at(-1)
			if (last && last.type === "say" && last.say === "condense_context") {
				this.skipPrevResponseIdOnce = true
			}
		} catch {
			// non-fatal
		}

		restoreTodoListForTask(this)
		await this.saveClineMessages()
	}

	private async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		await provider?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.emit(RooCodeEventName.Message, { action: "updated", message })

		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		// forked_change start: no cloud service
		// if (shouldCaptureMessage) {
		// 	CloudService.instance.captureEvent({
		// 		event: TelemetryEventName.TASK_MESSAGE,
		// 		properties: { taskId: this.taskId, message },
		// 	})
		// }
		// forked_change end
	}

	private async saveClineMessages() {
		try {
			await saveTaskMessages({
				messages: this.clineMessages,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			const { historyItem, tokenUsage } = await taskMetadata({
				taskId: this.taskId,
				rootTaskId: this.rootTaskId,
				parentTaskId: this.parentTaskId,
				taskNumber: this.taskNumber,
				messages: this.clineMessages,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
				mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
				contextWindowUsage: this.contextWindowUsage, // Pass current context window usage
				apiConfiguration: this.apiConfiguration, // Pass task's API configuration for model isolation
			})

			if (hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)) {
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage)
				this.tokenUsageSnapshot = undefined
				this.tokenUsageSnapshotAt = undefined
			}

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
		} catch (error) {
			console.error("Failed to save messages:", error)
		}
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].ts === ts) {
				return this.clineMessages[i]
			}
		}

		return undefined
	}

	async nextClineMessageTimestamp_kilocode() {
		let ts = Date.now()
		while (ts <= (this.clineMessages?.at(-1)?.ts ?? 0)) {
			console.warn("nextClineMessageTimeStamp: timestamp already taken", ts)
			await new Promise<void>((resolve) => setTimeout(() => resolve(), 1))
			ts = Date.now()
		}
		return ts
	}

	// forked_change start
	/**
	 * Remove a stale partial "tool" ask message from clineMessages.
	 * During native tool call streaming, a partial ask("tool", ..., true)
	 * message is created to show a spinner. When the complete block arrives,
	 * tool handlers like file_edit use say("tool", ...) which doesn't check
	 * for partial ask messages, causing the spinner to persist alongside the
	 * complete message. This method removes the stale partial before the
	 * complete handler runs.
	 */
	async removeStalePartialToolAskMessage(): Promise<void> {
		let removed = false
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			const msg = this.clineMessages[i]
			if (msg.partial && msg.type === "ask" && msg.ask === "tool") {
				this.clineMessages.splice(i, 1)
				removed = true
			}
		}
		if (removed) {
			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebview()
		}
	}

	/**
	 * Change the latest tool row between its in-progress and settled states
	 * without creating another chat message or entering the ask/response flow.
	 * The timestamp stays stable so React updates the existing row in place.
	 */
	async setLastToolAskMessagePartial(text: string, partial: boolean): Promise<boolean> {
		const lastMessage = this.clineMessages.at(-1)

		if (!lastMessage || lastMessage.type !== "ask" || lastMessage.ask !== "tool") {
			return false
		}

		lastMessage.text = text
		lastMessage.partial = partial

		if (!partial) {
			await this.saveClineMessages()
		}

		this.updateClineMessage(lastMessage)
		return true
	}
	// forked_change end

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
		autoApproved?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[]; pasteChips?: PasteChipSerialized[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[KiloCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					lastMessage.autoApproved = autoApproved
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					throw new Error("Current ask promise was ignored (#1)")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = await this.nextClineMessageTimestamp_kilocode()
					this.lastMessageTs = askTs
					await this.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						partial,
						isProtected,
						autoApproved,
					})
					throw new Error("Current ask promise was ignored (#2)")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					this.askResponsePasteChips = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					lastMessage.autoApproved = autoApproved
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					this.askResponsePasteChips = undefined
					askTs = await this.nextClineMessageTimestamp_kilocode()
					this.lastMessageTs = askTs
					await this.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						isProtected,
						autoApproved,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			this.askResponsePasteChips = undefined
			askTs = await this.nextClineMessageTimestamp_kilocode()
			this.lastMessageTs = askTs
			await this.addToClineMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
				isProtected,
				autoApproved,
			})
		}

		// forked_change start: YOLO mode auto-answer for follow-up questions
		// Check if this is a follow-up question with suggestions in YOLO mode
		if (type === "followup" && text && !partial) {
			try {
				const state = await this.providerRef.deref()?.getState()
				if (state?.yoloMode) {
					// Parse the follow-up JSON to extract suggestions
					const followUpData = JSON.parse(text)
					if (
						followUpData.suggest &&
						Array.isArray(followUpData.suggest) &&
						followUpData.suggest.length > 0
					) {
						// Auto-select the first suggestion
						const firstSuggestion = followUpData.suggest[0]
						const autoAnswer = firstSuggestion.answer || firstSuggestion

						// Immediately set the response as if the user clicked the first suggestion
						this.handleWebviewAskResponse("messageResponse", autoAnswer, undefined, true)

						// Return immediately with the auto-selected answer
						const result = { response: this.askResponse!, text: autoAnswer, images: undefined }
						this.askResponse = undefined
						this.askResponseText = undefined
						this.askResponseImages = undefined
						return result
					}
				}
			} catch (error) {
				// If parsing fails or YOLO check fails, continue with normal flow
				console.warn("Failed to auto-answer follow-up question in YOLO mode:", error)
			}
		}
		// forked_change end

		// The state is mutable if the message is complete and the task will
		// block (via the `pWaitFor`).
		const isBlocking = !(this.askResponse !== undefined || this.lastMessageTs !== askTs)
		const isMessageQueued = !this.messageQueueService.isEmpty()
		// A queued message is user feedback for the next turn, not an implicit
		// response to whichever tool/API ask happens to finish first. Only the
		// final completion_result ask is a valid early dispatch boundary; all
		// other asks must leave the queue untouched until the whole agent turn is
		// idle and processManualMessageQueue can safely submit it.
		const shouldDispatchQueuedMessage = isCompletionQueueBoundary(type, partial) && isBlocking && isMessageQueued
		const isStatusMutable = !partial && isBlocking && !shouldDispatchQueuedMessage
		let statusMutationTimeouts: NodeJS.Timeout[] = []

		if (isStatusMutable) {
			console.log(`Task#ask will block -> type: ${type}`)

			if (isInteractiveAsk(type)) {
				statusMutationTimeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.interactiveAsk = message
							this.emit(RooCodeEventName.TaskInteractive, this.taskId)
						}
					}, 1_000),
				)
			} else if (isResumableAsk(type)) {
				statusMutationTimeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.resumableAsk = message
							this.emit(RooCodeEventName.TaskResumable, this.taskId)
						}
					}, 1_000),
				)
			} else if (isIdleAsk(type)) {
				statusMutationTimeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.idleAsk = message
							this.emit(RooCodeEventName.TaskIdle, this.taskId)
						}
					}, 1_000),
				)
			}
		} else if (shouldDispatchQueuedMessage) {
			console.log("Task#ask will process message queue at completion boundary")

			// Mark that we're waiting for an ask response *before* draining the
			// queue, so the dequeued message resolves this ask (via
			// handleWebviewAskResponse) instead of being routed back into the
			// queue by the !isWaitingForAskResponse guard there (which would make
			// the message reappear and never answer the ask).
			this.isWaitingForAskResponse = true

			const message = this.messageQueueService.dequeueMessage()

			if (message) {
				this.setMessageResponse(message.text, message.images)
			}
		}

		// Wait for askResponse to be set.
		this.isWaitingForAskResponse = true
		try {
			await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
		} finally {
			this.isWaitingForAskResponse = false
		}

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new Error("Current ask promise was ignored")
		}

		const result = {
			response: this.askResponse!,
			text: this.askResponseText,
			images: this.askResponseImages,
			pasteChips: this.askResponsePasteChips,
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		this.askResponsePasteChips = undefined

		// Cancel the timeouts if they are still running.
		statusMutationTimeouts.forEach((timeout) => clearTimeout(timeout))

		// Switch back to an active state.
		if (this.idleAsk || this.resumableAsk || this.interactiveAsk) {
			this.idleAsk = undefined
			this.resumableAsk = undefined
			this.interactiveAsk = undefined
			this.emit(RooCodeEventName.TaskActive, this.taskId)
		}

		this.emit(RooCodeEventName.TaskAskResponded)
		void this.processManualMessageQueue()
		return result
	}

	public setMessageResponse(text: string, images?: string[]) {
		this.handleWebviewAskResponse("messageResponse", text, images)
	}

	handleWebviewAskResponse(
		askResponse: ClineAskResponse,
		text?: string,
		images?: string[],
		isAutomatic = false,
		pasteChips?: PasteChipSerialized[],
	) {
		if (!this.isWaitingForAskResponse && askResponse === "messageResponse" && !isAutomatic) {
			void this.enqueueManualUserMessage(text, images, pasteChips)
			return
		}

		if (askResponse === "messageResponse" && !isAutomatic) {
			this.reportUserMessageUsage()
		}

		// If user rejects a tool/command with feedback text, enqueue it as a new message
		// so the user's message is not lost
		if (askResponse === "noButtonClicked") {
			this.askResponseText = text
			this.askResponseImages = images
			this.askResponse = askResponse
			// If user provided text/images with the rejection, enqueue it as a new message
			const trimmedText = text?.trim() ?? ""
			const hasImages = Array.isArray(images) && images.length > 0
			if (trimmedText || hasImages) {
				void this.enqueueManualUserMessage(text, images, pasteChips)
			}
			return
		}

		// this.askResponse = askResponse kilocode_change
		this.askResponseText = text
		this.askResponseImages = images
		this.askResponsePasteChips = pasteChips

		// forked_change start
		// the askResponse assignment needs to happen last to avoid the async
		// callbacks triggering before we assign the data above
		this.askResponse = askResponse // this triggers async callbacks
		// forked_change end

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.checkpointSave(false, true)
		}

		// Mark the last follow-up question as answered
		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			// Find the last unanswered follow-up message using findLastIndex
			const lastFollowUpIndex = findLastIndex(
				this.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)

			if (lastFollowUpIndex !== -1) {
				// Mark this follow-up as answered
				this.clineMessages[lastFollowUpIndex].isAnswered = true
				// Save the updated messages
				this.saveClineMessages().catch((error) => {
					console.error("Failed to save answered follow-up state:", error)
				})
			}
		}
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	private async enqueueManualUserMessage(
		text?: string,
		images?: string[],
		pasteChips?: PasteChipSerialized[],
	): Promise<void> {
		const trimmedText = text?.trim() ?? ""
		const hasImages = Array.isArray(images) && images.length > 0

		if (!trimmedText && !hasImages) {
			return
		}

		// Add to the visible queue (single source of truth) so the message stays
		// shown in the UI until it is actually sent by processManualMessageQueue.
		this.messageQueueService.addMessage(trimmedText, hasImages ? [...(images as string[])] : undefined, pasteChips)

		try {
			await this.processManualMessageQueue()
		} catch (error) {
			console.error("Failed to process manual user message queue:", error)
		}
	}

	private async processManualMessageQueue(): Promise<void> {
		if (this.isProcessingManualMessages) {
			return
		}

		if (this.messageQueueService.isEmpty()) {
			return
		}

		if (!this.isIdleForQueuedMessages()) {
			return
		}

		this.isProcessingManualMessages = true

		try {
			while (!this.messageQueueService.isEmpty()) {
				if (!this.isIdleForQueuedMessages()) {
					break
				}

				// Only remove the message from the visible queue at the moment we
				// send it, so it remains shown in the UI while still pending.
				const nextMessage = this.messageQueueService.dequeueMessage()

				if (!nextMessage) {
					break
				}

				await this.handleManualUserMessage({
					text: nextMessage.text,
					images: nextMessage.images,
					pasteChips: nextMessage.pasteChips,
				})
			}
		} finally {
			this.isProcessingManualMessages = false
		}

		if (this.isIdleForQueuedMessages() && !this.messageQueueService.isEmpty()) {
			void this.processManualMessageQueue()
		}
	}

	private isIdleForQueuedMessages(): boolean {
		return isTaskIdleForQueuedMessages({
			taskRequestCount: this.taskRequestCount,
			isStreaming: this.isStreaming,
			isWaitingForAskResponse: this.isWaitingForAskResponse,
		})
	}

	private async handleManualUserMessage(message: {
		text: string
		images?: string[]
		pasteChips?: PasteChipSerialized[]
	}): Promise<void> {
		const { text, images, pasteChips } = message

		try {
			await this.checkpointSave(false, true)
		} catch (error) {
			console.error("Failed to checkpoint before manual user message:", error)
		}

		try {
			await this.say(
				"user_feedback",
				text,
				images,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				pasteChips,
			)
		} catch (error) {
			console.error("Failed to append manual user message to conversation:", error)
		}
		this.reportUserMessageUsage()

		this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

		const userContent: Anthropic.Messages.ContentBlockParam[] = []

		if (text.length > 0) {
			userContent.push({
				type: "text",
				text: `<user_message>\n${text}\n</user_message>`,
			})
		} else if (images && images.length > 0) {
			userContent.push({
				type: "text",
				text: "[User provided images]",
			})
		}

		if (images && images.length > 0) {
			userContent.push(...formatResponse.imageBlocks(images))
		}

		this.userMessageContent = []
		this.userMessageContentReady = false

		try {
			await this.recursivelyMakeClineRequests(userContent, false)
		} catch (error) {
			console.error("Failed to process manual user follow-up message:", error)
		}
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
		pasteChips?: PasteChipSerialized[],
	): Promise<void> {
		try {
			text = (text ?? "").trim()
			images = images ?? []

			if (text.length === 0 && images.length === 0) {
				return
			}

			const provider = this.providerRef.deref()

			if (provider) {
				if (mode) {
					await provider.setMode(mode)
				}

				if (providerProfile) {
					await provider.setProviderProfile(providerProfile)
				}

				this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

				provider.postMessageToWebview({
					type: "invoke",
					invoke: "sendMessage",
					text,
					images: stringsToImageAttachments(images),
					pasteChips: pasteChips && pasteChips.length > 0 ? pasteChips : undefined,
				})
			} else {
				console.error("[Task#submitUserMessage] Provider reference lost")
			}
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	public async condenseContext(): Promise<void> {
		const systemPrompt = await this.getSystemPrompt()

		// Get condensing configuration
		const state = await this.providerRef.deref()?.getState()
		// These properties may not exist in the state type yet, but are used for condensing configuration
		const customCondensingPrompt = state?.customCondensingPrompt
		const condensingApiConfigId = state?.condensingApiConfigId
		const listApiConfigMeta = state?.listApiConfigMeta

		// Determine API handler to use
		let condensingApiHandler: ApiHandler | undefined
		if (condensingApiConfigId && listApiConfigMeta && Array.isArray(listApiConfigMeta)) {
			// Find matching config by ID
			const matchingConfig = listApiConfigMeta.find((config) => config.id === condensingApiConfigId)
			if (matchingConfig) {
				const profile = await this.providerRef.deref()?.providerSettingsManager.getProfile({
					id: condensingApiConfigId,
				})
				// Ensure profile and apiProvider exist before trying to build handler
				if (profile && profile.apiProvider) {
					condensingApiHandler = buildApiHandler(profile)
				}
			}
		}

		const { contextTokens: prevContextTokens } = this.getTokenUsage()

		// Show an in-progress indicator while the summarization call runs
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			true /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
		)

		const {
			messages,
			summary,
			cost,
			newContextTokens = 0,
			error,
		} = await summarizeConversation(
			this.apiConversationHistory,
			this.api, // Main API handler (fallback)
			systemPrompt, // Default summarization prompt (fallback)
			this.taskId,
			prevContextTokens,
			false, // manual trigger
			customCondensingPrompt, // User's custom prompt
			condensingApiHandler, // Specific handler for condensing
		)
		if (error) {
			// Finalize the in-progress row (renders nothing since there is no result)
			await this.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
			)
			this.say(
				"condense_context_error",
				error,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
			)
			return
		}
		await this.overwriteApiConversationHistory(messages)

		// Set flag to skip previous_response_id on the next API call after manual condense
		this.skipPrevResponseIdOnce = true

		const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
			contextCondense,
		)
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
			metadata?: Record<string, unknown>
		} = {},
		contextCondense?: ContextCondense,
		pasteChips?: PasteChipSerialized[],
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[Orbital#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = await this.nextClineMessageTimestamp_kilocode()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						metadata: options.metadata,
						pasteChips: pasteChips && pasteChips.length > 0 ? pasteChips : undefined,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					if (options.metadata) {
						// Add metadata to the message
						const messageWithMetadata = lastMessage as ClineMessage & ClineMessageWithMetadata
						if (!messageWithMetadata.metadata) {
							messageWithMetadata.metadata = {}
						}
						Object.assign(messageWithMetadata.metadata, options.metadata)
					}

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = await this.nextClineMessageTimestamp_kilocode()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						metadata: options.metadata,
						pasteChips: pasteChips && pasteChips.length > 0 ? pasteChips : undefined,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = await this.nextClineMessageTimestamp_kilocode()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
				pasteChips: pasteChips && pasteChips.length > 0 ? pasteChips : undefined,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Orbital tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(
			formatResponse.missingToolParameterError(
				paramName,
				getActiveToolUseStyle(this.apiConfiguration), // kilocode_change
			),
		)
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	private reportUserMessageUsage(): void {
		void (async () => {
			try {
				await this.reportCommittedCodeUsage()
				const state = await this.providerRef.deref()?.getState()
				const token = state?.apiConfiguration?.kilocodeToken
				await reportUsageEvent(token, this.cwd, {
					eventType: "user_message",
					taskId: this.taskId,
					model: this.api.getModel().id,
				})
			} catch {
				// Usage reporting is best-effort and must not affect the task.
			}
		})()
	}

	private async reportCommittedCodeUsage(): Promise<void> {
		const observed = observeGitCommits(this.cwd, this.lastUsageGitHead)
		this.lastUsageGitHead = observed.head
		if (observed.commits.length === 0) return

		const state = await this.providerRef.deref()?.getState()
		const token = state?.apiConfiguration?.kilocodeToken
		if (!token) return
		const repo = await detectGitRepo(this.cwd)
		const model = this.api.getModel().id

		await Promise.all(
			observed.commits.map((commit) =>
				reportUsageEvent(token, this.cwd, {
					eventId: `commit:${commit.hash}:${repo}`,
					eventType: "committed_code",
					taskId: this.taskId,
					model,
					repo,
					linesAdded: commit.linesAdded,
					linesDeleted: commit.linesDeleted,
					commitHash: commit.hash,
					timestamp: commit.timestamp,
				}),
			),
		)
	}

	public captureCommittedCodeUsage(): void {
		void this.reportCommittedCodeUsage().catch(() => {})
	}

	private async startTask(task?: string, images?: string[], pasteChips?: PasteChipSerialized[]): Promise<void> {
		if (this.enableBridge) {
			try {
				await BridgeOrchestrator.subscribeToTask(this)
			} catch (error) {
				console.error(
					`[Task#startTask] BridgeOrchestrator.subscribeToTask() failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// `conversationHistory` (for API) and `clineMessages` (for webview)
		// need to be in sync.
		// If the extension process were killed, then on restart the
		// `clineMessages` might not be empty, so we need to set it to [] when
		// we create a new Cline client (otherwise webview would show stale
		// messages from previous session).
		this.clineMessages = []
		this.apiConversationHistory = []

		// The todo list is already set in the constructor if initialTodos were provided
		// No need to add any messages - the todoList property is already set

		await this.providerRef.deref()?.postStateToWebview()

		await this.say("text", task, images, undefined, undefined, undefined, undefined, undefined, pasteChips)
		if (!this.parentTask) this.reportUserMessageUsage()
		this.isInitialized = true

		let imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

		// Task starting

		await this.initiateTaskLoop([
			{
				type: "text",
				// The <task> wrapper is only an internal marker for mention and
				// slash-command parsing; it is stripped via stripTaskWrapperTags
				// before the message is sent to the model.
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		])
	}

	private async resumeTaskFromHistory() {
		if (this.enableBridge) {
			try {
				await BridgeOrchestrator.subscribeToTask(this)
			} catch (error) {
				console.error(
					`[Task#resumeTaskFromHistory] BridgeOrchestrator.subscribeToTask() failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		const modifiedClineMessages = await this.getSavedClineMessages()

		// Check for any stored GPT-5 response IDs in the message history.
		const gpt5Messages = modifiedClineMessages.filter(
			(m): m is ClineMessage & ClineMessageWithMetadata =>
				m.type === "say" &&
				m.say === "text" &&
				!!(m as ClineMessageWithMetadata).metadata?.gpt5?.previous_response_id,
		)

		if (gpt5Messages.length > 0) {
			const lastGpt5Message = gpt5Messages[gpt5Messages.length - 1]
			// The lastGpt5Message contains the previous_response_id that can be
			// used for continuity.
		}

		// Remove any resume messages that may have been added before.
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)

		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
		while (modifiedClineMessages.length > 0) {
			const last = modifiedClineMessages[modifiedClineMessages.length - 1]
			if (last.type === "say" && last.say === "reasoning") {
				modifiedClineMessages.pop()
			} else {
				break
			}
		}

		// Since we don't use `api_req_finished` anymore, we need to check if the
		// last `api_req_started` has a cost value, if it doesn't and no
		// cancellation reason to present, then we remove it since it indicates
		// an api request without any partial content streamed.
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)

		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.overwriteClineMessages(modifiedClineMessages)
		this.clineMessages = await this.getSavedClineMessages()

		// Now present the cline messages to the user and ask if they want to
		// resume (NOTE: we ran into a bug before where the
		// apiConversationHistory wouldn't be initialized when opening a old
		// task, and it was because we were waiting for resume).
		// This is important in case the user deletes messages without resuming
		// the task first.
		this.apiConversationHistory = await this.getSavedApiConversationHistory()

		const lastClineMessage = this.clineMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task")) // Could be multiple resume tasks.

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.isInitialized = true

		const { response, text, images, pasteChips } = await this.ask(askType) // Calls `postStateToWebview`.

		let responseText: string | undefined
		let responseImages: string[] | undefined

		if (response === "messageResponse") {
			await this.say(
				"user_feedback",
				text,
				images,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				pasteChips,
			)
			responseText = text
			responseImages = images
		}

		// Make sure that the api conversation history can be resumed by the API,
		// even if it goes out of sync with cline messages.
		let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

		// FIXME: remove tool use blocks altogether

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message
		// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: ApiMessage | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result",
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id),
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

		const agoText = ((): string => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		if (responseText) {
			newUserContent.push({
				type: "text",
				text: `\n\nNew instructions for task continuation:\n<user_message>\n${responseText}\n</user_message>`,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		// Ensure we have at least some content to send to the API.
		// If newUserContent is empty, add a minimal resumption message.
		if (newUserContent.length === 0) {
			newUserContent.push({
				type: "text",
				text: "[TASK RESUMPTION] Resuming task...",
			})
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

		// Task resuming from history item.
		await this.initiateTaskLoop(newUserContent)
	}

	public async abortTask(isAbandoned = false) {
		// Aborting task

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true
		this.emit(RooCodeEventName.TaskAborted)

		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.saveClineMessages()
		} catch (error) {
			console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
		}
	}

	/**
	 * Races `iterator.next()` against the stream AbortController so that when
	 * the user presses stop, dispose() aborts the controller and this method
	 * resolves immediately with `{ done: true }` instead of blocking until the
	 * provider sends the next chunk. This makes the stop button feel instant.
	 */
	private async raceStreamNext<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
		const controller = this.streamAbortController
		if (!controller) {
			return iterator.next()
		}
		const signal = controller.signal
		if (signal.aborted) {
			return { done: true, value: undefined as unknown as T }
		}
		return Promise.race([
			iterator.next(),
			new Promise<IteratorResult<T>>((resolve) => {
				signal.addEventListener("abort", () => resolve({ done: true, value: undefined as unknown as T }), {
					once: true,
				})
			}),
		])
	}

	public dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.taskId}.${this.instanceId}`)
		this.captureCommittedCodeUsage()

		// Reset context window usage
		this.contextWindowUsage = undefined

		// Dispose message queue and remove event listeners.
		try {
			if (this.messageQueueStateChangedHandler) {
				this.messageQueueService.removeListener("stateChanged", this.messageQueueStateChangedHandler)
				this.messageQueueStateChangedHandler = undefined
			}

			this.messageQueueService.dispose()
		} catch (error) {
			console.error("Error disposing message queue:", error)
		}

		// Remove all event listeners to prevent memory leaks.
		try {
			this.removeAllListeners()
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}

		// Stop waiting for child task completion.
		if (this.pauseInterval) {
			clearInterval(this.pauseInterval)
			this.pauseInterval = undefined
		}

		if (this.enableBridge) {
			BridgeOrchestrator.getInstance()
				?.unsubscribeFromTask(this.taskId)
				.catch((error) =>
					console.error(
						`[Task#dispose] BridgeOrchestrator#unsubscribeFromTask() failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				)
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		// Abort the active stream so raceStreamNext() unblocks immediately.
		try {
			this.streamAbortController?.abort()
			this.streamAbortController = undefined
		} catch (error) {
			console.error("Error aborting stream controller:", error)
		}

		try {
			this.urlContentFetcher.closeBrowser()
		} catch (error) {
			console.error("Error closing URL content fetcher browser:", error)
		}

		try {
			this.browserSession.closeBrowser()
		} catch (error) {
			console.error("Error closing browser session:", error)
		}

		try {
			if (this.rooIgnoreController) {
				this.rooIgnoreController.dispose()
				this.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			this.fileEditReviewController.dispose()
		} catch (error) {
			console.error("Error disposing file edit review controller:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}

	// Subtasks
	// Spawn / Wait / Complete

	public async startSubtask(message: string, initialTodos: TodoItem[], mode: string) {
		const provider = this.providerRef.deref()

		if (!provider) {
			throw new Error("Provider not available")
		}

		const newTask = await provider.createTask(message, undefined, this, { initialTodos })

		if (newTask) {
			this.isPaused = true // Pause parent.
			this.childTaskId = newTask.taskId

			await provider.handleModeSwitch(mode) // Set child's mode.
			await delay(500) // Allow mode change to take effect.

			this.emit(RooCodeEventName.TaskPaused, this.taskId)
			this.emit(RooCodeEventName.TaskSpawned, newTask.taskId)
		}

		return newTask
	}

	// Used when a sub-task is launched and the parent task is waiting for it to
	// finish.
	// TBD: Add a timeout to prevent infinite waiting.
	public async waitForSubtask() {
		await new Promise<void>((resolve) => {
			this.pauseInterval = setInterval(() => {
				if (!this.isPaused) {
					clearInterval(this.pauseInterval)
					this.pauseInterval = undefined
					resolve()
				}
			}, 1000)
		})
	}

	public async completeSubtask(lastMessage: string) {
		this.isPaused = false
		this.childTaskId = undefined

		this.emit(RooCodeEventName.TaskUnpaused, this.taskId)

		// Fake an answer from the subtask that it has completed running and
		// this is the result of what it has done add the message to the chat
		// history and to the webview ui.
		try {
			await this.say("subtask_result", lastMessage)

			await this.addToApiConversationHistory({
				role: "user",
				content: [{ type: "text", text: `[new_task completed] Result: ${lastMessage}` }],
			})

			// Set skipPrevResponseIdOnce to ensure the next API call sends the full conversation
			// including the subtask result, not just from before the subtask was created
			this.skipPrevResponseIdOnce = true
		} catch (error) {
			this.providerRef
				.deref()
				?.log(`Error failed to add reply from subtask into conversation of parent task, error: ${error}`)

			throw error
		}
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit(RooCodeEventName.TaskStarted)

		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // We only need file details the first time.

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if
				// the user hits max requests and denies resetting the count.
				break
			} else {
				// nextUserContent = [
				// 	{
				// 		type: "text",
				// 		text: formatResponse.noToolsUsed(
				// 			getActiveToolUseStyle(this.apiConfiguration), // kilocode_change
				// 		),
				// 	},
				// ]
				// this.consecutiveMistakeCount++
			}
		}
	}

	private async acquireTaskRequestLock(): Promise<() => void> {
		const previousRequest = this.taskRequestLock
		let releaseLock!: () => void

		this.taskRequestLock = new Promise<void>((resolve) => {
			releaseLock = resolve
		})

		await previousRequest
		return releaseLock
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		this.taskRequestCount++
		const releaseLock = await this.acquireTaskRequestLock()

		try {
			return await this.makeClineRequestsUnlocked(userContent, includeFileDetails)
		} finally {
			this.taskRequestCount--
			releaseLock()
			if (this.taskRequestCount === 0 && !this.messageQueueService.isEmpty()) {
				void this.processManualMessageQueue()
			}
		}
	}

	private async makeClineRequestsUnlocked(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails }]

		while (stack.length > 0) {
			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails

			if (this.abort) {
				throw new Error(
					`[KiloCode#recursivelyMakeClineRequests] task ${this.taskId}.${this.instanceId} aborted`,
				)
			}

			// In this Cline request loop, we need to check if this task instance
			// has been asked to wait for a subtask to finish before continuing.
			const provider = this.providerRef.deref()

			if (this.isPaused && provider) {
				provider.log(`[subtasks] paused ${this.taskId}.${this.instanceId}`)
				await this.waitForSubtask()
				provider.log(`[subtasks] resumed ${this.taskId}.${this.instanceId}`)
				const currentMode = (await provider.getState())?.mode ?? defaultModeSlug

				if (currentMode !== this.pausedModeSlug) {
					// The mode has changed, we need to switch back to the paused mode.
					await provider.handleModeSwitch(this.pausedModeSlug)

					// Delay to allow mode change to take effect before next tool is executed.
					await delay(500)

					provider.log(
						`[subtasks] task ${this.taskId}.${this.instanceId} has switched back to '${this.pausedModeSlug}' from '${currentMode}'`,
					)
				}
			}

			// Getting verbose details is an expensive operation, it uses ripgrep to
			// top-down build file structure of project which for large projects can
			// take a few seconds. For the best UX we show a placeholder api_req_started
			// message with a loading spinner as this happens.

			// Determine API protocol based on provider and model
			const modelId = getModelId(this.apiConfiguration)
			const apiProtocol = getApiProtocol(this.apiConfiguration.apiProvider, modelId)

			await this.say(
				"api_req_started",
				JSON.stringify({
					apiProtocol,
				}),
			)

			const {
				showRooIgnoredFiles = false,
				includeDiagnosticMessages = true,
				maxDiagnosticMessages = 50,
				maxReadFileLine = -1,
			} = (await this.providerRef.deref()?.getState()) ?? {}

			// forked_change start
			const [parsedUserContent, needsRulesFileCheck, shouldCondense] = await processKiloUserContentMentions({
				context: this.getContext(),
				userContent: currentUserContent,
				cwd: this.cwd,
				urlContentFetcher: this.urlContentFetcher,
				fileContextTracker: this.fileContextTracker,
				rooIgnoreController: this.rooIgnoreController,
				showRooIgnoredFiles,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
				maxReadFileLine,
			})

			if (needsRulesFileCheck) {
				await this.say(
					"error",
					"Issue with processing the /newrule command. Double check that, if '.orbital/rules' already exists, it's a directory and not a file. Otherwise there was an issue referencing this file/directory",
				)
			}

			// Handle /compact command - trigger direct context condensation
			if (shouldCondense) {
				await this.condenseContext()
				// End the current request loop - condensation creates its own response
				// Return true to end the loop (similar to how tool use completion ends the loop)
				return true
			}
			// forked_change end

			// Check for files that were modified by the user after the assistant's last edit
			// and inject a notification to inform the LLM about these changes
			const recentlyModifiedFiles = this.fileContextTracker.getAndClearRecentlyModifiedFiles()
			let finalUserContent: Anthropic.Messages.ContentBlockParam[]
			if (recentlyModifiedFiles.length > 0) {
				// Build a notification message listing the modified files
				const fileList = recentlyModifiedFiles.map((f) => `  - ${f}`).join("\n")
				const notification = `The following file(s) have been modified by the user since your last edit:\n${fileList}\n\nPlease use read_file to get the latest content of these files before proceeding further to ensure you're working with the most up-to-date information.`
				// Inject the notification as a separate text block before the user content
				finalUserContent = [{ type: "text" as const, text: notification }, ...parsedUserContent]
			} else {
				finalUserContent = parsedUserContent
			}

			// Only add environment details on the first iteration (when includeFileDetails is true)
			// For subsequent iterations with tool results, don't add environment details to avoid duplication
			if (currentIncludeFileDetails) {
				const environmentDetails = await getEnvironmentDetails(this, currentIncludeFileDetails)
				// Add environment details as its own text block, separate from tool results
				finalUserContent = [...finalUserContent, { type: "text" as const, text: environmentDetails }]
			}

			await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
			TelemetryService.instance.captureConversationMessage(this.taskId, "user")

			// Since we sent off a placeholder api_req_started message to update the
			// webview while waiting to actually start the API request (to load
			// potential details for example), we need to update the text of that
			// message.
			const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

			this.clineMessages[lastApiReqIndex].text = JSON.stringify({
				apiProtocol,
			} satisfies ClineApiReqInfo)

			await this.saveClineMessages()
			await provider?.postStateToWebview()

			try {
				let cacheWriteTokens = 0
				let cacheReadTokens = 0
				let inputTokens = 0
				let outputTokens = 0
				let totalCost: number | undefined

				// forked_change start
				let inferenceProvider: string | undefined
				let usageMissing = false
				const apiRequestStartTime = performance.now()
				// forked_change end

				// We can't use `api_req_finished` anymore since it's a unique case
				// where it could come after a streaming message (i.e. in the middle
				// of being updated or executed).
				// Fortunately `api_req_finished` was always parsed out for the GUI
				// anyways, so it remains solely for legacy purposes to keep track
				// of prices in tasks from history (it's worth removing a few months
				// from now).
				const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (lastApiReqIndex < 0 || !this.clineMessages[lastApiReqIndex]) {
						return
					}

					const existingData = JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}")
					this.clineMessages[lastApiReqIndex].text = JSON.stringify({
						...existingData,
						tokensIn: inputTokens,
						tokensOut: outputTokens,
						cacheWrites: cacheWriteTokens,
						cacheReads: cacheReadTokens,
						cost:
							totalCost ??
							calculateApiCostAnthropic(
								this.api.getModel().info,
								inputTokens,
								outputTokens,
								cacheWriteTokens,
								cacheReadTokens,
							),
						// forked_change start
						usageMissing,
						inferenceProvider,
						// forked_change end
						cancelReason,
						streamingFailedMessage,
					} satisfies ClineApiReqInfo)
				}

				const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (this.diffViewProvider.isEditing) {
						await this.diffViewProvider.revertChanges() // closes diff view
					}

					// if last message is a partial we need to update and save it
					const lastMessage = this.clineMessages.at(-1)

					if (lastMessage && lastMessage.partial) {
						// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
						lastMessage.partial = false
						// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
						console.log("updating partial message", lastMessage)
					}

					// forked_change: finalize any partial reasoning messages so the
					// "Thinking..." indicator doesn't stay stuck after cancellation.
					await this.finalizeReasoningMessage()

					// Update `api_req_started` to have cancelled and cost, so that
					// we can display the cost of the partial stream and the cancellation reason
					updateApiReqMsg(cancelReason, streamingFailedMessage)
					await this.saveClineMessages()

					// Signals to provider that it can retrieve the saved messages
					// from disk, as abortTask can not be awaited on in nature.
					this.didFinishAbortingStream = true
				}

				// Reset streaming state for each new API request
				this.currentStreamingContentIndex = 0
				this.currentStreamingDidCheckpoint = false
				this.assistantMessageContent = []
				this.didCompleteReadingStream = false
				this.userMessageContent = []
				this.userMessageContentReady = false
				this.didRejectTool = false
				this.didAlreadyUseTool = false
				this.executedToolCallSignatures.clear()
				this.presentAssistantMessageLocked = false
				this.presentAssistantMessageHasPendingUpdates = false
				this.assistantMessageParser.reset()

				// Fresh AbortController for this stream so dispose() can unblock
				// raceStreamNext() instantly when the user presses stop.
				this.streamAbortController = new AbortController()

				await this.diffViewProvider.reset()

				// Yields only if the first chunk is successful, otherwise will
				// allow the user to retry the request (most likely due to rate
				// limit error, which gets thrown on the first chunk).
				const stream = this.attemptApiRequest()
				let assistantMessage = ""
				let assistantToolUses = new Array<Anthropic.Messages.ToolUseBlockParam>() // kilocode_change
				let reasoningMessage = ""
				// forked_change: tracks the current reasoning phase's text for UI
				// display, separate from the accumulated reasoningMessage used for
				// API history. Reset whenever a new reasoning phase begins.
				let currentReasoningText = ""
				// forked_change: finalize the streaming reasoning block exactly once,
				// as soon as visible assistant content (text or a tool call) begins.
				let reasoningFinalized = false
				let pendingGroundingSources: GroundingSource[] = []
				this.isStreaming = true

				// kilocode_change: Track if we've started fetching the title
				let hasStartedTitleFetch = false

				// forked_change: boundary in clineMessages just before this request streams
				// any output. On a "stream_restart" (auto-retry of a transient connection
				// failure), we truncate back to here to discard the failed attempt's partial
				// reasoning/text so the retried stream replaces it instead of appending.
				const streamOutputStart = this.clineMessages.length

				try {
					const iterator = stream[Symbol.asyncIterator]()
					// forked_change: handle each chunk as soon as it arrives, then advance.
					// The previous read-ahead pattern (fetch chunk N+1 before handling chunk
					// N) held the last chunk of a phase hostage until the next chunk arrived —
					// for reasoning the final "Thinking" text wasn't rendered until the model
					// began answering, often seconds later.
					//
					// We iterate with a plain next() here on purpose: the stream idle timeout
					// lives at the provider boundary in attemptApiRequest(), whose catch offers
					// the user a retry. Wrapping this loop in its own idle timeout too raced
					// that one and (usually winning) routed idle/socket-close to a hard abort
					// with no retry button.
					let item = await this.raceStreamNext(iterator)
					while (!item.done) {
						const chunk = item.value
						if (!chunk) {
							// Sometimes chunk is undefined, no idea that can cause
							// it, but this workaround seems to fix it.
							item = await this.raceStreamNext(iterator)
							continue
						}

						// kilocode_change: Fetch task title after first chunk is received
						if (!hasStartedTitleFetch) {
							hasStartedTitleFetch = true
							// Start title fetching in background without blocking the stream
							const state = await this.providerRef.deref()?.getState()
							const kilocodeToken = state?.apiConfiguration?.kilocodeToken
							if (kilocodeToken) {
								fetchTaskTitle(this.taskId, kilocodeToken, 3, 2000)
									.then(async (title: string | null) => {
										if (title && this.clineMessages.length > 0) {
											// Update the first message with the title
											const firstMessage = this.clineMessages[0]
											;(firstMessage as any).title = title
											await this.saveClineMessages()
										}
									})
									.catch((error: unknown) => {
										// Silently fail - title fetching is optional
										console.warn("Failed to fetch task title:", error)
									})
							}
						}

						switch (chunk.type) {
							case "keepalive":
								// forked_change: liveness-only signal (see provider keepalive). It
								// exists to keep the stream idle timeout from firing during quiet
								// periods; there is nothing to render.
								break
							case "stream_restart": {
								// forked_change: attemptApiRequest is auto-retrying a transient
								// connection failure. Discard everything streamed this attempt so
								// the fresh stream replaces it instead of appending — reset the
								// per-request accumulators and instance streaming state exactly
								// like a brand-new request, and roll back the partial UI output.
								assistantMessage = ""
								reasoningMessage = ""
								currentReasoningText = ""
								reasoningFinalized = false
								assistantToolUses = []
								pendingGroundingSources = []
								this.currentStreamingContentIndex = 0
								this.assistantMessageContent = []
								this.userMessageContent = []
								this.userMessageContentReady = false
								this.didRejectTool = false
								this.didAlreadyUseTool = false
								this.executedToolCallSignatures.clear()
								this.presentAssistantMessageLocked = false
								this.presentAssistantMessageHasPendingUpdates = false
								this.assistantMessageParser.reset()
								if (this.clineMessages.length > streamOutputStart) {
									this.clineMessages.splice(streamOutputStart)
									await this.saveClineMessages()
									await this.providerRef.deref()?.postStateToWebview()
								}
								break
							}
							case "reasoning": {
								// forked_change: if a new reasoning phase begins after a previous
								// one was finalized (e.g. reasoning → text → reasoning), reset
								// the flag so the new phase gets finalized when the next
								// text/tool chunk arrives. Also reset currentReasoningText so
								// the new reasoning message only contains this phase's text.
								if (reasoningFinalized) {
									reasoningFinalized = false
									currentReasoningText = ""
								}
								reasoningMessage += chunk.text
								currentReasoningText += chunk.text
								let formattedReasoning = currentReasoningText
								if (currentReasoningText.includes("**")) {
									formattedReasoning = currentReasoningText.replace(
										/([.!?])\*\*([^*\n]+)\*\*/g,
										"$1\n\n**$2**",
									)
								}
								formattedReasoning = formattedReasoning.replace(/<\/?think>/g, "")
								if (formattedReasoning.trim()) {
									// forked_change: mark reasoning streaming as non-interactive
									// so it does NOT update `lastMessageTs`. Otherwise, when
									// reasoning chunks arrive while a tool is awaiting approval
									// (e.g. execute_command), the new partial-reasoning say
									// supersedes the ask's `askTs` and `Task.ask`'s pWaitFor
									// throws "Current ask promise was ignored", surfacing as
									// "Error executing command: Current ask promise was ignored".
									await this.say(
										"reasoning",
										formattedReasoning,
										undefined,
										true,
										undefined,
										undefined,
										{ isNonInteractive: true },
									)
								}
								break
							}
							case "usage":
								inputTokens += chunk.inputTokens
								outputTokens += chunk.outputTokens
								cacheWriteTokens += chunk.cacheWriteTokens ?? 0
								cacheReadTokens += chunk.cacheReadTokens ?? 0
								totalCost = chunk.totalCost
								inferenceProvider = chunk.inferenceProvider // kilocode_change
								break
							case "grounding":
								// Handle grounding sources separately from regular content
								// to prevent state persistence issues - store them separately
								if (chunk.sources && chunk.sources.length > 0) {
									pendingGroundingSources.push(...chunk.sources)
								}
								break
							//forked_change start
							case "native_tool_calls": {
								// forked_change: a tool call also ends the reasoning phase.
								if (reasoningMessage && !reasoningFinalized) {
									reasoningFinalized = true
									await this.finalizeReasoningMessage()
								}
								// Handle native OpenAI-format tool calls
								// Process native tool calls through the parser
								let yieldedCount = 0
								for (const toolUse of this.assistantMessageParser.processNativeToolCalls(
									chunk.toolCalls,
								)) {
									// Deduplicate by ID - if same ID exists, replace it (keeps last/complete version)
									const existingIndex = assistantToolUses.findIndex((tu) => tu.id === toolUse.id)
									if (existingIndex !== -1) {
										assistantToolUses[existingIndex] = toolUse
									} else {
										assistantToolUses.push(toolUse)
									}
									yieldedCount++
								}
								// Update content blocks after processing native tool calls
								const prevLength = this.assistantMessageContent.length
								this.assistantMessageContent = this.assistantMessageParser.getContentBlocks()
								if (this.assistantMessageContent.length > prevLength) {
									// New content we need to present
									this.userMessageContentReady = false
								}

								// Present content to user
								presentAssistantMessage(this)
								break
							}
							//forked_change end
							case "text": {
								// forked_change: the reasoning phase is over once visible
								// assistant content starts — finalize the reasoning block so
								// it reads "Thought for Ns" instead of a stuck "Thinking...".
								if (reasoningMessage && !reasoningFinalized) {
									reasoningFinalized = true
									await this.finalizeReasoningMessage()
								}
								assistantMessage += chunk.text

								// Parse raw assistant message chunk into content blocks.
								const prevLength = this.assistantMessageContent.length
								this.assistantMessageContent = this.assistantMessageParser.processChunk(chunk.text)

								if (this.assistantMessageContent.length > prevLength) {
									// New content we need to present, reset to
									// false in case previous content set this to true.
									this.userMessageContentReady = false
								}

								// Present content to user.
								presentAssistantMessage(this)
								break
							}
						}

						if (this.abort) {
							console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

							if (!this.abandoned) {
								// Only need to gracefully abort if this instance
								// isn't abandoned (sometimes OpenRouter stream
								// hangs, in which case this would affect future
								// instances of Cline).
								await abortStream("user_cancelled")
							}

							break // Aborts the stream.
						}

						if (this.didRejectTool) {
							// `userContent` has a tool rejection, so interrupt the
							// assistant's response to present the user's feedback.
							assistantMessage += "\n\n[Response interrupted by user feedback]"
							// Instead of setting this preemptively, we allow the
							// present iterator to finish and set
							// userMessageContentReady when its ready.
							// this.userMessageContentReady = true
							break
						}

						// if (this.didAlreadyUseTool) {
						// 	assistantMessage +=
						// 		"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
						// 	break
						// }

						// forked_change: advance to the next chunk only AFTER handling the
						// current one, so streaming content (including the final reasoning
						// chunk) renders immediately instead of waiting for the chunk that
						// follows it. The break paths above skip this, leaving `item` on the
						// last handled chunk for the background usage drain to resume from.
						item = await this.raceStreamNext(iterator)
					}

					// Create a copy of current token values to avoid race conditions
					const currentTokens = {
						input: inputTokens,
						output: outputTokens,
						cacheWrite: cacheWriteTokens,
						cacheRead: cacheReadTokens,
						total: totalCost,
					}

					const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
						const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
						const startTime = Date.now()
						const modelId = getModelId(this.apiConfiguration)

						// Local variables to accumulate usage data without affecting the main flow
						let bgInputTokens = currentTokens.input
						let bgOutputTokens = currentTokens.output
						let bgCacheWriteTokens = currentTokens.cacheWrite
						let bgCacheReadTokens = currentTokens.cacheRead
						let bgTotalCost = currentTokens.total

						// forked_change start
						const refreshApiReqMsg = async (messageIndex: number) => {
							// Update the API request message with the latest usage data
							updateApiReqMsg()
							await this.saveClineMessages()

							// Update the specific message in the webview
							const apiReqMessage = this.clineMessages[messageIndex]
							if (apiReqMessage) {
								await this.updateClineMessage(apiReqMessage)
							}
						}
						// forked_change end

						// Helper function to capture telemetry and update messages
						const captureUsageData = async (
							tokens: {
								input: number
								output: number
								cacheWrite: number
								cacheRead: number
								total?: number
							},
							messageIndex: number = apiReqIndex,
						) => {
							if (
								tokens.input > 0 ||
								tokens.output > 0 ||
								tokens.cacheWrite > 0 ||
								tokens.cacheRead > 0
							) {
								// Update the shared variables atomically
								inputTokens = tokens.input
								outputTokens = tokens.output
								cacheWriteTokens = tokens.cacheWrite
								cacheReadTokens = tokens.cacheRead
								totalCost = tokens.total

								// Update context window usage tracking
								const modelInfo = this.api.getModel().info
								const maxTokens = modelInfo.contextWindow || 200000
								const currentTokens =
									tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead
								this.contextWindowUsage = {
									currentTokens,
									maxTokens,
								}
								this.updateContextWindowBreakdown(currentTokens, tokens.cacheRead)

								// Update the API request message with the latest usage data
								updateApiReqMsg()
								await this.saveClineMessages()

								// Update the specific message in the webview
								const apiReqMessage = this.clineMessages[messageIndex]
								if (apiReqMessage) {
									await this.updateClineMessage(apiReqMessage)
								}

								// Capture telemetry
								TelemetryService.instance.captureLlmCompletion(this.taskId, {
									inputTokens: tokens.input,
									outputTokens: tokens.output,
									cacheWriteTokens: tokens.cacheWrite,
									cacheReadTokens: tokens.cacheRead,
									cost:
										tokens.total ??
										calculateApiCostAnthropic(
											this.api.getModel().info,
											tokens.input,
											tokens.output,
											tokens.cacheWrite,
											tokens.cacheRead,
										),
									// forked_change start
									completionTime: performance.now() - apiRequestStartTime,
									inferenceProvider,
									// forked_change end
								})
							}
						}

						try {
							// Continue processing the original stream from where the main loop left off
							let usageFound = false
							let chunkCount = 0

							// Use the same iterator that the main loop was using
							while (!item.done) {
								// Check for timeout
								if (Date.now() - startTime > timeoutMs) {
									console.warn(
										`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
									)
									// Clean up the iterator before breaking
									if (iterator.return) {
										await iterator.return(undefined)
									}
									break
								}

								const chunk = item.value
								item = await iterator.next()
								chunkCount++

								if (chunk && chunk.type === "usage") {
									usageFound = true
									bgInputTokens += chunk.inputTokens
									bgOutputTokens += chunk.outputTokens
									bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
									bgCacheReadTokens += chunk.cacheReadTokens ?? 0
									bgTotalCost = chunk.totalCost
									inferenceProvider = chunk.inferenceProvider // kilocode_change
								}
							}

							if (
								usageFound ||
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								// We have usage data either from a usage chunk or accumulated tokens
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							} else {
								console.warn(
									`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
								)
								// forked_change start
								usageMissing = true
								await refreshApiReqMsg(apiReqIndex)
								// forked_change end
							}
						} catch (error) {
							console.error("Error draining stream for usage data:", error)
							// Still try to capture whatever usage data we have collected so far
							if (
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
								// forked_change start
							} else {
								usageMissing = true
								await refreshApiReqMsg(apiReqIndex)
								// forked_change end
							}
						}
					}

					// Start the background task and handle any errors
					drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
						console.error("Background usage collection failed:", error)
					})
				} catch (error) {
					// Abandoned happens when extension is no longer waiting for the
					// Cline instance to finish aborting (error is thrown here when
					// any function in the for loop throws due to this.abort).
					if (!this.abandoned) {
						// If the stream failed, there's various states the task
						// could be in (i.e. could have streamed some tools the user
						// may have executed), so we just resort to replicating a
						// cancel task.

						// Determine cancellation reason BEFORE aborting to ensure correct persistence
						const cancelReason: ClineApiReqCancelReason = this.abort ? "user_cancelled" : "streaming_failed"

						const streamingFailedMessage = this.abort
							? undefined
							: (error.message ?? JSON.stringify(serializeError(error), null, 2))

						// Persist interruption details first to both UI and API histories
						await abortStream(cancelReason, streamingFailedMessage)

						// Record reason for provider to decide rehydration path
						this.abortReason = cancelReason

						// Now abort (emits TaskAborted which provider listens to)
						await this.abortTask()

						// Do not rehydrate here; provider owns rehydration to avoid duplication races
					}
				} finally {
					this.isStreaming = false
					void this.processManualMessageQueue()
				}

				// Need to call here in case the stream was aborted.
				if (this.abort || this.abandoned) {
					throw new Error(
						`[KiloCode#recursivelyMakeClineRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}

				this.didCompleteReadingStream = true

				// Set any blocks to be complete to allow `presentAssistantMessage`
				// to finish and set `userMessageContentReady` to true.
				// (Could be a text block that had no subsequent tool uses, or a
				// text block at the very end, or an invalid tool use, etc. Whatever
				// the case, `presentAssistantMessage` relies on these blocks either
				// to be completed or the user to reject a block in order to proceed
				// and eventually set userMessageContentReady to true.)
				const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
				partialBlocks.forEach((block) => (block.partial = false))

				// Can't just do this b/c a tool could be in the middle of executing.
				// this.assistantMessageContent.forEach((e) => (e.partial = false))

				// Now that the stream is complete, finalize any remaining partial content blocks
				this.assistantMessageParser.finalizeContentBlocks()
				this.assistantMessageContent = this.assistantMessageParser.getContentBlocks()

				// forked_change start: Reconcile the assistant message's tool calls with the
				// finalized, executable content blocks.
				//
				// `this.assistantMessageContent` (after finalizeContentBlocks) is the exact set
				// of tool_use blocks that `presentAssistantMessage` will execute and produce a
				// tool_result for. The streaming-accumulated `assistantToolUses`, however, also
				// holds tool calls that were *yielded as partials* during streaming — and a
				// partial whose JSON never became valid is dropped from the content blocks at
				// finalization (see AssistantMessageParser.finalizeNativeToolCalls). If we kept
				// that partial in the assistant message it would be an orphan tool_call: the
				// assistant turn advertises a tool_call that is never executed, so no matching
				// tool_result is ever produced, and the next request violates the OpenAI spec
				// (assistant has N tool_calls, user turn has fewer tool_results).
				//
				// So the finalized content blocks are the source of truth: keep the streamed
				// entries that survived finalization (preserving their order), then append any
				// tool calls that only finalized at end-of-stream (e.g. native calls that
				// arrived in a single complete chunk). The result is that every tool_call in the
				// assistant message is guaranteed to be executed and to get a tool_result.
				const toolUsesFromFinalizedContent = this.assistantMessageContent
					.filter((block): block is ToolUse => block.type === "tool_use")
					.map(
						(toolUse): Anthropic.Messages.ToolUseBlockParam => ({
							type: "tool_use",
							name: toolUse.name,
							id: toolUse.toolUseId ?? "",
							input: toolUse.params,
						}),
					)

				assistantToolUses = reconcileAssistantToolUses(assistantToolUses, toolUsesFromFinalizedContent)
				// forked_change end

				// forked_change start: Fix native tool calls not being executed
				// Native tool calls are added with partial: false, so partialBlocks.length
				// may be 0 even when there are unprocessed content blocks (especially tool uses).
				// We need to call presentAssistantMessage if:
				// 1. There were partial blocks that we just marked as complete, OR
				// 2. There are content blocks that haven't been processed yet (currentStreamingContentIndex < content length)
				const hasUnprocessedContent = this.currentStreamingContentIndex < this.assistantMessageContent.length
				if (partialBlocks.length > 0 || hasUnprocessedContent) {
					// If there is content to update then it will complete and
					// update `this.userMessageContentReady` to true, which we
					// `pWaitFor` before making the next request. All this is really
					// doing is presenting the last partial message that we just set
					// to complete, or executing any unprocessed tool calls.
					presentAssistantMessage(this)
				}
				// forked_change end

				// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
				// to ensure usage data is captured even when the stream is interrupted. The background task
				// uses local variables to accumulate usage data before atomically updating the shared state.

				// Complete the reasoning message if it wasn't already finalized when
				// assistant content began (e.g. reasoning-only turns, or providers
				// that emit reasoning without any following text/tool content).
				if (reasoningMessage) {
					await this.finalizeReasoningMessage()
				}

				await this.persistGpt5Metadata(reasoningMessage)
				await this.saveClineMessages()
				await this.providerRef.deref()?.postStateToWebview()

				// forked_change start: Detect malformed tool calls that were dropped during
				// finalization (their JSON arguments never parsed). Instead of silently
				// stopping the agent, inject a corrective message and retry so the model
				// can re-issue the call with valid JSON.
				const droppedToolCalls = this.assistantMessageParser.getDroppedMalformedToolCalls()
				if (droppedToolCalls.length > 0) {
					this.consecutiveMistakeCount++

					if (this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
						await this.say(
							"error",
							`Reached consecutive mistake limit (${this.consecutiveMistakeLimit}) due to repeated malformed tool call JSON. Stopping.`,
						)
						return true
					}

					const toolNames = droppedToolCalls.map((tc) => tc.name).join(", ")
					const rawArgsPreview = droppedToolCalls
						.map((tc) => {
							const args = tc.rawArguments.trim()
							return args.length > 500 ? args.slice(0, 500) + "...(truncated)" : args
						})
						.join("\n---\n")

					await this.say(
						"error",
						`Malformed tool call JSON for ${toolNames}. The arguments could not be parsed. Retrying...`,
					)

					// Preserve any text the model produced before the malformed call
					// so it stays in the API conversation history for context.
					if (assistantMessage.length > 0) {
						await this.addToApiConversationHistory({
							role: "assistant",
							content: [{ type: "text", text: assistantMessage }],
						})
					}

					stack.push({
						userContent: [
							{
								type: "text",
								text: `Your previous tool call(s) for [${toolNames}] produced malformed JSON arguments and could not be executed. The raw arguments were:\n\n${rawArgsPreview}\n\nPlease re-issue the tool call with valid, complete JSON arguments.`,
							},
						],
						includeFileDetails: false,
					})

					await new Promise((resolve) => setImmediate(resolve))
					continue
				}
				// forked_change end

				// Reset parser after each complete conversation round
				this.assistantMessageParser.reset()

				// Now add to apiConversationHistory.
				// Need to save assistant responses to file before proceeding to
				// tool use since user can exit at any moment and we wouldn't be
				// able to save the assistant's response.
				let didEndLoop = false

				if (assistantMessage.length > 0 || assistantToolUses.length > 0 /* kilocode_change */) {
					// Display grounding sources to the user if they exist
					if (pendingGroundingSources.length > 0) {
						const citationLinks = pendingGroundingSources.map((source, i) => `[${i + 1}](${source.url})`)
						const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

						await this.say("text", sourcesText, undefined, false, undefined, undefined, {
							isNonInteractive: true,
						})
					}

					// forked_change start: also add tool calls to history
					const assistantMessageContent = new Array<Anthropic.Messages.ContentBlockParam>()
					if (assistantMessage) {
						assistantMessageContent.push({ type: "text", text: assistantMessage })
					}
					assistantMessageContent.push(...assistantToolUses)

					const assistantHistoryMessage: Anthropic.MessageParam & {
						reasoning?: string
						reasoning_content?: string
					} = {
						role: "assistant",
						content: assistantMessageContent,
					}

					// Add reasoning content if present
					if (reasoningMessage) {
						assistantHistoryMessage.reasoning = reasoningMessage
					}

					await this.addToApiConversationHistory(assistantHistoryMessage)
					// forked_change end

					TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")

					// NOTE: This comment is here for future reference - this was a
					// workaround for `userMessageContent` not getting set to true.
					// It was due to it not recursively calling for partial blocks
					// when `didRejectTool`, so it would get stuck waiting for a
					// partial block to complete before it could continue.
					// In case the content blocks finished it may be the api stream
					// finished after the last parsed content block was executed, so
					// we are able to detect out of bounds and set
					// `userMessageContentReady` to true (note you should not call
					// `presentAssistantMessage` since if the last block i
					//  completed it will be presented again).
					// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
					// if (this.currentStreamingContentIndex >= completeBlocks.length) {
					// 	this.userMessageContentReady = true
					// }

					// forked_change start: Don't fire the next request until EVERY tool_call in
					// the assistant message we just added has its matching tool_result collected.
					//
					// With parallel native tool calls, `userMessageContentReady` is flipped true
					// by a positional "this is the last content block" heuristic inside
					// presentAssistantMessage. Under interleaved streaming that flag can briefly
					// go true after only the first tool's result has been pushed onto
					// `userMessageContent`. If `pWaitFor` resolves on the flag alone we capture a
					// partial result set and send an assistant turn with N tool_calls followed by
					// fewer tool_results — which OpenAI-compatible providers reject outright.
					//
					// Gate on the actual data instead of the flag: every id in
					// `assistantToolUses` is, by the reconciliation above, an executable content
					// block, and presentAssistantMessage's finally-block guarantees each executed
					// tool_use produces a tool_result — so this wait is guaranteed to resolve and
					// cannot deadlock. (`this.abort` short-circuits so a cancel never hangs here.)
					const expectedToolResultIds = toolUseIdsRequiringResults(assistantToolUses)

					await pWaitFor(
						() =>
							this.userMessageContentReady &&
							(this.abort || allToolResultsCollected(expectedToolResultIds, this.userMessageContent)),
					)
					// forked_change end

					// If the model did not tool use, then we need to tell it to
					// either use a tool or attempt_completion.
					// const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")

					// if (!didToolUse) {
					// 	this.userMessageContent.push({
					// 		type: "text",
					// 		text: formatResponse.noToolsUsed(
					// 			getActiveToolUseStyle(this.apiConfiguration), // kilocode_change
					// 		),
					// 	})
					// 	this.consecutiveMistakeCount++
					// }

					// forked_change start: auto-retry on tool repetition detection.
					// When the model gets stuck in a loop, instead of stopping and
					// asking the user, we remove the last assistant tool call from
					// conversation history, inject a "try again" user message, and
					// continue the agent loop automatically.
					//
					// At this point in the flow, the apiConversationHistory contains:
					//   ... → [user: current request] → [assistant: looping tool call]
					// The tool results (userMessageContent) have NOT been committed
					// to history yet — they would become the next iteration's user
					// message. So we only need to pop the assistant message.
					if (this.toolRepetitionAutoRetry) {
						this.toolRepetitionAutoRetry = false

						// Remove the last entry from API history: the assistant
						// message containing the looping tool call.
						if (this.apiConversationHistory.length >= 1) {
							this.apiConversationHistory.pop() // assistant tool_call
							await this.saveApiConversationHistory()
						}

						// Inject "try again" as the next user message to nudge
						// the model out of the loop.
						stack.push({
							userContent: [
								{
									type: "text",
									text: "You were stuck in a loop, repeating the same tool call. The last tool call and response have been deleted. Try again with a different approach.",
								},
							],
							includeFileDetails: false,
						})

						await new Promise((resolve) => setImmediate(resolve))
						continue
					}
					// forked_change end

					if (this.userMessageContent.length > 0) {
						stack.push({
							userContent: [...this.userMessageContent], // Create a copy to avoid mutation issues
							includeFileDetails: false, // Subsequent iterations don't need file details
						})

						// Add periodic yielding to prevent blocking
						await new Promise((resolve) => setImmediate(resolve))

						// Continue to next iteration instead of setting didEndLoop from recursive call
						continue
					}

					// No tool results to process, end both inner and outer task loops
					// This prevents the outer loop from repeating with the same user message
					return true
				} else {
					// If there's no assistant_responses, that means we got no text
					// or tool_use content blocks from API which we should assume is
					// an error.
					await this.say(
						"error",
						t("kilocode:task.noAssistantMessages"), // kilocode_change
					)

					// forked_change start
					TelemetryService.instance.captureEvent(TelemetryEventName.NO_ASSISTANT_MESSAGES)
					// forked_change end

					await this.addToApiConversationHistory({
						role: "assistant",
						content: [{ type: "text", text: "Failure: I did not provide a response." }],
					})
				}

				// If we reach here without continuing, return false (will always be false for now)
				return false
			} catch (error) {
				// This should never happen since the only thing that can throw an
				// error is the attemptApiRequest, which is wrapped in a try catch
				// that sends an ask where if noButtonClicked, will clear current
				// task and destroy this instance. However to avoid unhandled
				// promise rejection, we will end this loop which will end execution
				// of this instance (see `startTask`).
				return true // Needs to be true so parent loop knows to end task.
			}
		}

		// If we exit the while loop normally (stack is empty), return false
		return false
	}

	// forked_change start
	async loadContext(
		userContent: UserContent,
		includeFileDetails: boolean = false,
	): Promise<[UserContent, string, boolean, boolean]> {
		// Track if we need to check clinerulesFile
		let needsClinerulesFileCheck = false
		// Track if we should trigger direct context condensation
		let shouldCondense = false

		// bookmark
		const { localWorkflowToggles, globalWorkflowToggles } = await refreshWorkflowToggles(
			this.getContext(),
			this.cwd,
		)

		const processUserContent = async () => {
			// This is a temporary solution to dynamically load context mentions from tool results. It checks for the presence of tags that indicate that the tool was rejected and feedback was provided (see formatToolDeniedFeedback, attemptCompletion, executeCommand, and consecutiveMistakeCount >= 3) or "<answer>" (see askFollowupQuestion), we place all user generated content in these tags so they can effectively be used as markers for when we should parse mentions). However if we allow multiple tools responses in the future, we will need to parse mentions specifically within the user content tags.
			// (Note: this caused the @/ import alias bug where file contents were being parsed as well, since v2 converted tool results to text blocks)
			return await Promise.all(
				userContent.map(async (block) => {
					if (block.type === "text") {
						// We need to ensure any user generated content is wrapped in one of these tags so that we know to parse mentions
						// FIXME: Only parse text in between these tags instead of the entire text block which may contain other tool results. This is part of a larger issue where we shouldn't be using regex to parse mentions in the first place (ie for cases where file paths have spaces)
						if (
							block.text.includes("<feedback>") ||
							block.text.includes("<answer>") ||
							block.text.includes("<task>") ||
							block.text.includes("<user_message>")
						) {
							const parsedText = await parseMentions(
								stripTaskWrapperTags(block.text),
								this.cwd,
								this.urlContentFetcher,
								this.fileContextTracker,
							)

							// when parsing slash commands, we still want to allow the user to provide their desired context
							const {
								processedText,
								needsRulesFileCheck: needsCheck,
								shouldCondense: commandRequestsCondense,
							} = await parseKiloSlashCommands(parsedText, localWorkflowToggles, globalWorkflowToggles)

							if (needsCheck) {
								needsClinerulesFileCheck = true
							}

							if (commandRequestsCondense) {
								shouldCondense = true
							}

							return {
								...block,
								text: processedText,
							}
						}
					}
					return block
				}),
			)
		}

		// Run initial promises in parallel
		const [processedUserContent, environmentDetails] = await Promise.all([
			processUserContent(),
			getEnvironmentDetails(this, includeFileDetails),
		])
		// const [parsedUserContent, environmentDetails, clinerulesError] = await this.loadContext(
		// 	userContent,
		// 	includeFileDetails,
		// )

		// After processing content, check clinerulesData if needed
		let clinerulesError = false
		if (needsClinerulesFileCheck) {
			clinerulesError = await ensureLocalKilorulesDirExists(this.cwd, GlobalFileNames.kiloRules)
		}

		// Return all results (including shouldCondense flag)
		return [processedUserContent, environmentDetails, clinerulesError, shouldCondense]
	}
	// forked_change end

	/*private kilocode_change*/ async getSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const state = await this.providerRef.deref()?.getState()

		const {
			browserViewportSize,
			mode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			enableMcpServerCreation,
			browserToolEnabled,
			language,
			maxConcurrentFileReads,
			maxReadFileLine,
			apiConfiguration,
		} = state ?? {}

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			return SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				// kilocode_change: supports images => supports browser
				(this.api.getModel().info.supportsImages ?? false) && (browserToolEnabled ?? true),
				mcpHub,
				this.diffStrategy,
				browserViewportSize,
				mode,
				customModePrompts,
				customModes,
				customInstructions,
				this.diffEnabled,
				experiments,
				enableMcpServerCreation,
				language,
				rooIgnoreInstructions,
				maxReadFileLine !== -1,
				{
					maxConcurrentFileReads: maxConcurrentFileReads ?? 5,
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules: vscode.workspace.getConfiguration("kilo-code").get<boolean>("useAgentRules") ?? true,
					newTaskRequireTodos: vscode.workspace
						.getConfiguration("kilo-code")
						.get<boolean>("newTaskRequireTodos", false),
				},
				undefined, // todoList
				this.api.getModel().id,
				// forked_change start
				getActiveToolUseStyle(apiConfiguration),
				state,
				// forked_change end
			)
		})()
	}

	/**
	 * Build the system prompt and return the per-category text fragments used
	 * to power the context-window usage breakdown in the UI.
	 *
	 * Side effect: caches the returned parts on `this.lastSystemPromptParts` so
	 * later `updateContextWindowBreakdown()` calls can rebuild the breakdown
	 * cheaply after each API response.
	 */
	async getSystemPromptParts(): Promise<SystemPromptParts> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()
			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}
			mcpHub = await McpServerManager.getInstance(provider.context, provider)
			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()
		const state = await this.providerRef.deref()?.getState()
		const {
			browserViewportSize,
			mode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			enableMcpServerCreation,
			browserToolEnabled,
			language,
			maxConcurrentFileReads,
			maxReadFileLine,
			apiConfiguration,
		} = state ?? {}

		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}

		const result = await getSystemPromptParts(
			provider.context,
			this.cwd,
			(this.api.getModel().info.supportsImages ?? false) && (browserToolEnabled ?? true),
			mcpHub,
			this.diffStrategy,
			browserViewportSize,
			mode,
			customModePrompts,
			customModes,
			customInstructions,
			this.diffEnabled,
			experiments,
			enableMcpServerCreation,
			language,
			rooIgnoreInstructions,
			maxReadFileLine !== -1,
			{
				maxConcurrentFileReads: maxConcurrentFileReads ?? 5,
				todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
				useAgentRules: vscode.workspace.getConfiguration("kilo-code").get<boolean>("useAgentRules") ?? true,
				newTaskRequireTodos: vscode.workspace
					.getConfiguration("kilo-code")
					.get<boolean>("newTaskRequireTodos", false),
			},
			undefined,
			this.api.getModel().id,
			getActiveToolUseStyle(apiConfiguration),
			state,
			undefined,
		)

		this.lastSystemPromptParts = result.parts
		return result
	}

	/**
	 * Rebuild the per-category token breakdown using the latest reported
	 * `currentTokens`. Cheap (no I/O) when `lastSystemPromptParts` is cached.
	 *
	 * `cacheReadTokens` should be the value reported by the LLM (e.g. from
	 * `prompt_tokens_details.cached_tokens`); it's shown as its own slice in
	 * the UI rather than folded into `conversation`.
	 */
	updateContextWindowBreakdown(currentTokens: number, cacheReadTokens?: number): void {
		const parts = this.lastSystemPromptParts
		if (!parts) {
			// No cached parts yet — store an empty breakdown so the UI can still
			// render the total. The next `getSystemPromptParts` call will fill
			// in the per-category numbers.
			if (this.contextWindowUsage) {
				this.contextWindowUsage = {
					...this.contextWindowUsage,
					breakdown: emptyContextBreakdown(),
				}
			}
			return
		}

		const breakdown = buildContextBreakdown({
			categoryText: parts,
			currentTokens,
			cacheReads: cacheReadTokens,
		})

		if (this.contextWindowUsage) {
			this.contextWindowUsage = {
				...this.contextWindowUsage,
				breakdown,
			}
		}
	}

	private getCurrentProfileId(state: any): string {
		return (
			state?.listApiConfigMeta?.find((profile: any) => profile.name === state?.currentApiConfigName)?.id ??
			"default"
		)
	}

	private async handleContextWindowExceededError(): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const { profileThresholds = {} } = state ?? {}

		const { contextTokens } = this.getTokenUsage()
		const modelInfo = this.api.getModel().info

		const maxTokens = getModelMaxOutputTokens({
			modelId: this.api.getModel().id,
			model: modelInfo,
			settings: this.apiConfiguration,
		})

		const contextWindow = modelInfo.contextWindow

		// Get the current profile ID using the helper method
		const currentProfileId = this.getCurrentProfileId(state)

		// Log the context window error for debugging
		console.warn(
			`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
				`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
				`Forcing truncation to ${FORCED_CONTEXT_REDUCTION_PERCENT}% of current context.`,
		)

		// Force aggressive truncation by keeping only 75% of the conversation history
		const truncateResult = await truncateConversationIfNeeded({
			messages: this.apiConversationHistory,
			totalTokens: contextTokens || 0,
			maxTokens,
			contextWindow,
			apiHandler: this.api,
			autoCondenseContext: true,
			autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
			systemPrompt: await this.getSystemPrompt(),
			taskId: this.taskId,
			profileThresholds,
			currentProfileId,
		})

		if (truncateResult.messages !== this.apiConversationHistory) {
			await this.overwriteApiConversationHistory(truncateResult.messages)
		}

		if (truncateResult.summary) {
			const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
			const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
			await this.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)
		}
	}

	/**
	 * Checks if context condensation is needed before executing a tool that may add significant content.
	 * This prevents context window overflow when the LLM requests to read files with a nearly full context.
	 * @returns true if condensation was performed, false otherwise
	 */
	public async checkAndCondenseContext(): Promise<boolean> {
		const state = await this.providerRef.deref()?.getState()
		const {
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
			customCondensingPrompt,
			condensingApiConfigId,
			listApiConfigMeta,
		} = state ?? {}

		// If auto-condense is disabled, skip
		if (!autoCondenseContext) {
			return false
		}

		const { contextTokens } = this.getTokenUsage()
		const modelInfo = this.api.getModel().info
		const contextWindow = modelInfo.contextWindow

		// Calculate context usage percentage
		const contextPercent = (100 * contextTokens) / contextWindow

		// Determine the effective threshold
		const currentProfileId = this.getCurrentProfileId(state)
		let effectiveThreshold = autoCondenseContextPercent
		const profileThreshold = profileThresholds[currentProfileId]
		if (
			profileThreshold !== undefined &&
			profileThreshold >= MIN_CONDENSE_THRESHOLD &&
			profileThreshold <= MAX_CONDENSE_THRESHOLD
		) {
			effectiveThreshold = profileThreshold
		}

		// Check if we're at or above the threshold
		if (contextPercent < effectiveThreshold) {
			// forked_change start: codex-style context budget warning.
			// When usage enters the band just below the condense threshold, warn
			// the model ONCE so it adapts before compaction discards raw tool
			// outputs: finish in-flight edits, stop broad exploration, keep the
			// todo list current. Re-arms when usage drops back below the band
			// (i.e. after a successful condensation), so each context window
			// gets at most one warning.
			if (contextWindow > 0) {
				const warningThreshold = Math.max(
					MIN_CONDENSE_THRESHOLD,
					effectiveThreshold - CONTEXT_WARNING_BAND_PERCENT,
				)
				if (contextPercent < warningThreshold) {
					this.contextBudgetWarningIssued = false
				} else if (!this.contextBudgetWarningIssued) {
					this.contextBudgetWarningIssued = true
					const tokensRemaining = Math.max(0, contextWindow - contextTokens)
					console.log(
						`[Task#${this.taskId}] Context budget warning: ${contextPercent.toFixed(1)}% used ` +
							`(~${tokensRemaining} of ${contextWindow} tokens remain), condense threshold ${effectiveThreshold}%.`,
					)
					this.userMessageContent.push({
						type: "text",
						text: `<context_window_warning>\nContext window nearly full: ${contextPercent.toFixed(0)}% used (~${tokensRemaining.toLocaleString()} of ${contextWindow.toLocaleString()} tokens remain). Auto-compaction triggers at ${effectiveThreshold}% and replaces raw tool outputs with a summary.\nAdapt now:\n- Finish in-flight edits before starting anything new.\n- No broad searches or large file reads; use targeted reads of specific regions only.\n- Do not re-read files whose contents are already in context.\n- Keep the todo list current so pending work survives compaction.\n</context_window_warning>`,
					})
				}
			}
			// forked_change end
			return false
		}

		console.log(
			`[Task#${this.taskId}] Pre-tool context check: ${contextTokens} tokens (${contextPercent.toFixed(1)}%) ` +
				`exceeds threshold ${effectiveThreshold}%. Triggering condensation.`,
		)

		// Determine API handler to use for condensing
		let condensingApiHandler: ApiHandler | undefined
		if (condensingApiConfigId && listApiConfigMeta && Array.isArray(listApiConfigMeta)) {
			const matchingConfig = listApiConfigMeta.find((config) => config.id === condensingApiConfigId)
			if (matchingConfig) {
				const profile = await this.providerRef.deref()?.providerSettingsManager.getProfile({
					id: condensingApiConfigId,
				})
				if (profile && profile.apiProvider) {
					condensingApiHandler = buildApiHandler(profile)
				}
			}
		}

		const maxTokens = getModelMaxOutputTokens({
			modelId: this.api.getModel().id,
			model: modelInfo,
			settings: this.apiConfiguration,
		})

		// Show an in-progress indicator while the condense/summarize call runs
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			true /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
		)

		const truncateResult = await truncateConversationIfNeeded({
			messages: this.apiConversationHistory,
			totalTokens: contextTokens || 0,
			maxTokens,
			contextWindow,
			apiHandler: this.api,
			autoCondenseContext,
			autoCondenseContextPercent,
			systemPrompt: await this.getSystemPrompt(),
			taskId: this.taskId,
			customCondensingPrompt,
			condensingApiHandler,
			profileThresholds,
			currentProfileId,
		})

		if (truncateResult.messages !== this.apiConversationHistory) {
			await this.overwriteApiConversationHistory(truncateResult.messages)
		}

		if (truncateResult.summary) {
			const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
			const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
			await this.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)
			// Set flag to skip previous_response_id on the next API call
			this.skipPrevResponseIdOnce = true
			return true
		}

		// Condensation did not produce a summary (e.g., too few messages or an
		// error). Finalize the in-progress row so the indicator clears.
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
		)

		return false
	}

	private async acquireApiRequestLock(): Promise<() => void> {
		const previousRequest = this.apiRequestLock
		let releaseLock!: () => void

		this.apiRequestLock = new Promise<void>((resolve) => {
			releaseLock = resolve
		})

		await previousRequest
		return releaseLock
	}

	public async *attemptApiRequest(retryAttempt: number = 0): ApiStream {
		const releaseLock = await this.acquireApiRequestLock()

		try {
			yield* this.attemptApiRequestUnlocked(retryAttempt)
		} finally {
			releaseLock()
		}
	}

	private async *attemptApiRequestUnlocked(retryAttempt: number = 0): ApiStream {
		const state = await this.providerRef.deref()?.getState()

		const {
			apiConfiguration,
			autoApprovalEnabled,
			alwaysApproveResubmit,
			requestDelaySeconds,
			mode,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
		} = state ?? {}

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customCondensingPrompt
		const condensingApiConfigId = state?.condensingApiConfigId
		const listApiConfigMeta = state?.listApiConfigMeta

		// Determine API handler to use for condensing.
		let condensingApiHandler: ApiHandler | undefined

		if (condensingApiConfigId && listApiConfigMeta && Array.isArray(listApiConfigMeta)) {
			// Find matching config by ID
			const matchingConfig = listApiConfigMeta.find((config) => config.id === condensingApiConfigId)

			if (matchingConfig) {
				const profile = await this.providerRef.deref()?.providerSettingsManager.getProfile({
					id: condensingApiConfigId,
				})

				// Ensure profile and apiProvider exist before trying to build handler.
				if (profile && profile.apiProvider) {
					condensingApiHandler = buildApiHandler(profile)
				}
			}
		}

		let rateLimitDelay = 0

		// Use the shared timestamp so that subtasks respect the same rate-limit
		// window as their parent tasks.
		if (Task.lastGlobalApiRequestTime) {
			const now = performance.now() // kilocode_change
			const timeSinceLastRequest = now - Task.lastGlobalApiRequestTime
			const rateLimit = apiConfiguration?.rateLimitSeconds || 0
			rateLimitDelay = Math.ceil(Math.max(0, rateLimit * 1000 - timeSinceLastRequest) / 1000)

			// forked_change start
			if (rateLimitDelay > rateLimit) {
				console.warn(
					`rateLimitDelay ${rateLimitDelay}s is larger than the configured rateLimit ${rateLimit}s; this makes no sense`,
				)
				rateLimitDelay = rateLimit
			}
			// forked_change end
		}

		// Only show rate limiting message if we're not retrying. If retrying, we'll include the delay there.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			// Show countdown timer
			for (let i = rateLimitDelay; i > 0; i--) {
				const delayMessage = `Rate limiting for ${i} seconds...`
				await this.say("api_req_retry_delayed", delayMessage, undefined, true)
				await delay(1000)
			}
		}

		// Update last request time before making the request so that subsequent
		// requests — even from new subtasks — will honour the provider's rate-limit.
		Task.lastGlobalApiRequestTime = performance.now() // kilocode_change

		const { text: systemPrompt } = await this.getSystemPromptParts()
		this.lastUsedInstructions = systemPrompt
		const { contextTokens } = this.getTokenUsage()

		if (contextTokens) {
			const modelInfo = this.api.getModel().info

			const maxTokens = getModelMaxOutputTokens({
				modelId: this.api.getModel().id,
				model: modelInfo,
				settings: this.apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			// Get the current profile ID using the helper method
			const currentProfileId = this.getCurrentProfileId(state)

			const truncateResult = await truncateConversationIfNeeded({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext,
				autoCondenseContextPercent,
				systemPrompt,
				taskId: this.taskId,
				customCondensingPrompt,
				condensingApiHandler,
				profileThresholds,
				currentProfileId,
			})
			if (truncateResult.messages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(truncateResult.messages)
			}
			if (truncateResult.error) {
				await this.say("condense_context_error", truncateResult.error)
			} else if (truncateResult.summary) {
				// A condense operation occurred; for the next GPT‑5 API call we should NOT
				// send previous_response_id so the request reflects the fresh condensed context.
				this.skipPrevResponseIdOnce = true

				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			}
		}

		const messagesSinceLastSummary = getMessagesSinceLastSummary(this.apiConversationHistory)
		let cleanConversationHistory = maybeRemoveImageBlocks(messagesSinceLastSummary, this.api).map((msg) => ({
			role: msg.role,
			content: msg.content,
			// kilocode_change: preserve reasoning
			...("reasoning" in msg ? { reasoning: (msg as any).reasoning } : {}),
		}))
		// Only the outgoing copy is pruned; apiConversationHistory keeps every result.
		cleanConversationHistory = this.staleToolResultPruner.apply(
			cleanConversationHistory,
			this.getTokenUsage().contextTokens ?? 0,
			this.api.getModel().info.contextWindow,
		)

		// forked_change start
		// Fetch project properties for KiloCode provider tracking
		const kiloConfig = this.providerRef.deref()?.getKiloConfig()

		// Get git repository URL or root folder name for X-AXON-REPO header
		let repo: string | undefined
		try {
			const gitInfo = await getGitRepositoryInfo(this.workspacePath)
			if (gitInfo.repositoryUrl) {
				repo = gitInfo.repositoryUrl
			} else {
				// Not a git repository, use root folder name
				repo = path.basename(this.workspacePath)
			}
		} catch (error) {
			// Fallback to root folder name if git info retrieval fails
			repo = path.basename(this.workspacePath)
		}
		// forked_change end

		// Check auto-approval limits
		const approvalResult = await this.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.combineMessages(this.clineMessages.slice(1)),
			async (type, data) => this.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Determine GPT‑5 previous_response_id from last persisted assistant turn (if available),
		// unless a condense just occurred (skip once after condense).
		let previousResponseId: string | undefined = undefined
		try {
			const modelId = this.api.getModel().id
			if (modelId && modelId.startsWith("gpt-5") && !this.skipPrevResponseIdOnce) {
				// Find the last assistant message that has a previous_response_id stored
				const idx = findLastIndex(
					this.clineMessages,
					(m): m is ClineMessage & ClineMessageWithMetadata =>
						m.type === "say" &&
						m.say === "text" &&
						!!(m as ClineMessageWithMetadata).metadata?.gpt5?.previous_response_id,
				)
				if (idx !== -1) {
					// Use the previous_response_id from the last assistant message for this request
					const message = this.clineMessages[idx] as ClineMessage & ClineMessageWithMetadata
					previousResponseId = message.metadata?.gpt5?.previous_response_id
				}
			} else if (this.skipPrevResponseIdOnce) {
				// Skipping previous_response_id due to recent condense operation - will send full conversation context
			}
		} catch (error) {
			console.error(`[Task#${this.taskId}] Error retrieving GPT-5 response ID:`, error)
			// non-fatal
		}

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.taskId,
			// Only include previousResponseId if we're NOT suppressing it
			...(previousResponseId && !this.skipPrevResponseIdOnce ? { previousResponseId } : {}),
			// If a condense just occurred, explicitly suppress continuity fallback for the next call
			...(this.skipPrevResponseIdOnce ? { suppressPreviousResponseId: true } : {}),
			// forked_change start
			// KiloCode-specific: pass projectId for backend tracking (ignored by other providers)
			projectId: (await kiloConfig)?.project?.id,
			// KiloCode-specific: pass git repository URL or root folder name for backend tracking
			repo,
			// forked_change end
		}

		// forked_change start
		// Add allowed tools for JSON tool style
		if (getActiveToolUseStyle(apiConfiguration) === "json" && mode) {
			try {
				const provider = this.providerRef.deref()
				const providerState = await provider?.getState()

				const allowedTools = getAllowedJSONToolsForMode(
					mode,
					undefined, // codeIndexManager is private, not accessible here
					providerState,
					this.diffEnabled,
					this.api?.getModel(),
				)

				// forked_change: Add MCP tools from connected servers as native tool schemas
				// This ensures the LLM has proper parameter schemas for MCP tools,
				// producing correct arguments instead of guessing from the system prompt.
				try {
					const mcpHub = provider?.getMcpHub()
					if (mcpHub) {
						const servers = mcpHub.getServers()
						for (const server of servers) {
							if (server.status === "connected" && server.tools) {
								for (const tool of server.tools) {
									if (tool.enabledForPrompt !== false) {
										const mcpToolSchema: OpenAI.Chat.ChatCompletionTool = {
											type: "function" as const,
											function: {
												name: tool.name,
												description: tool.description || `MCP tool from ${server.name}`,
												parameters: (tool.inputSchema as Record<string, unknown>) || {
													type: "object",
													properties: {},
												},
											},
										}
										allowedTools.push(mcpToolSchema)
									}
								}
							}
						}
					}
				} catch (mcpError) {
					console.error("[Task] Error adding MCP tools to allowedTools:", mcpError)
					// Continue without MCP tools - they can still be invoked via XML
				}

				metadata.allowedTools = allowedTools
			} catch (error) {
				console.error("[Task] Error getting allowed tools for mode:", error)
				// Continue without allowedTools - will fall back to default behavior
			}
		}
		// forked_change end

		// Reset skip flag after applying (it only affects the immediate next call)
		if (this.skipPrevResponseIdOnce) {
			this.skipPrevResponseIdOnce = false
		}

		const stream = this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)
		const iterator = stream[Symbol.asyncIterator]()

		try {
			// Awaiting first chunk to see if it will throw an error.
			this.isWaitingForFirstChunk = true
			// forked_change: on the final attempt (all automatic connection retries
			// exhausted) use a short idle timeout so a silently stalled request
			// surfaces the manual retry prompt instead of hanging for minutes.
			const firstChunk = await nextWithIdleTimeout(
				iterator,
				retryAttempt >= MAX_CONNECTION_RETRIES ? FINAL_ATTEMPT_IDLE_TIMEOUT_MS : undefined,
			)
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			this.isWaitingForFirstChunk = false
			// forked_change start
			if (apiConfiguration?.apiProvider === "kilocode" && isAnyRecognizedKiloCodeError(error)) {
				const { response } = await (isPaymentRequiredError(error)
					? this.ask(
							"payment_required_prompt",
							JSON.stringify({
								title: error.error?.title ?? t("kilocode:lowCreditWarning.title"),
								message: error.error?.message ?? t("kilocode:lowCreditWarning.message"),
								balance: error.error?.balance ?? "0.00",
								buyCreditsUrl: error.error?.buyCreditsUrl ?? getAppUrl("/profile"),
							}),
						)
					: this.ask(
							"invalid_model",
							JSON.stringify({
								modelId: apiConfiguration.kilocodeModel,
								error: {
									status: error.status,
									message: error.message,
								},
							}),
						))

				if (response === "retry_clicked") {
					yield* this.attemptApiRequestUnlocked(retryAttempt + 1)
				} else {
					// Handle other responses or cancellations if necessary
					// If the user cancels the dialog, we should probably abort.
					throw error // Rethrow to signal failure upwards
				}
				return
			}
			// forked_change end
			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.

			// forked_change: transient provider connection failures (socket closed by the
			// network, idle timeout, DNS/TLS drop) are almost always recoverable, so
			// auto-retry them a few times before falling back to the manual retry prompt —
			// regardless of the auto-approve setting. This is the first-chunk path, so
			// nothing has streamed yet and the retry is clean.
			if (isConnectionClosedError(error)) {
				console.warn(
					`[Task#${this.taskId}.${this.instanceId}] first-chunk connection error (retryAttempt=${retryAttempt}/${MAX_CONNECTION_RETRIES})`,
				)
			}

			if (isConnectionClosedError(error) && retryAttempt < MAX_CONNECTION_RETRIES) {
				await this.backoffBeforeConnectionRetry(error, retryAttempt)
				yield* this.attemptApiRequestUnlocked(retryAttempt + 1)
				return
			}

			// Check if this is a 5xx error - always show retry dialog for server errors
			const isServerError = error.status && error.status >= 500 && error.status < 600

			// forked_change: a connection-closed error reaching here means all automatic
			// connection retries are exhausted (the block above already handled the
			// retryAttempt < MAX_CONNECTION_RETRIES case). A dropped connection is a local
			// network issue, so exponential-backoff auto-retry is pointless — always show
			// the manual retry button instead, regardless of the auto-approve setting.
			if (autoApprovalEnabled && alwaysApproveResubmit && !isServerError && !isConnectionClosedError(error)) {
				let errorMsg

				if (error.error?.metadata?.raw) {
					errorMsg = JSON.stringify(error.error.metadata.raw, null, 2)
				} else if (error.message) {
					errorMsg = error.message
				} else {
					errorMsg = "Unknown error"
				}

				await this.ask("api_req_failed", errorMsg)

				// Wait for the delay before retrying
				const baseDelay = requestDelaySeconds || 0
				let exponentialDelay = Math.min(
					Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
					MAX_EXPONENTIAL_BACKOFF_SECONDS,
				)

				// If the error is a 429, and the error details contain a retry delay, use that delay instead of exponential backoff
				if (error.status === 429) {
					const geminiRetryDetails = error.errorDetails?.find(
						(detail: any) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
					)
					if (geminiRetryDetails) {
						const match = geminiRetryDetails?.retryDelay?.match(/^(\d+)s$/)
						if (match) {
							exponentialDelay = parseInt(match[1], 10)
						}
					}
				}

				for (let i = exponentialDelay; i > 0; i--) {
					await this.say(
						"api_req_retry_delayed",
						`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying in ${i} seconds...`,
						undefined,
					)
					await delay(1000)
				}

				await this.say(
					"api_req_retry_delayed",
					`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying now...`,
					undefined,
				)

				// Delegate generator output from the recursive call with
				// incremented retry count.
				yield* this.attemptApiRequestUnlocked(retryAttempt + 1)

				return
			} else {
				const response = await this.askApiReqFailed(error)

				if (response !== "yesButtonClicked") {
					// This will never happen since if noButtonClicked, we will
					// clear current task, aborting this instance.
					throw new Error("API request failed")
				}

				await this.say("api_req_retried")

				// Delegate generator output from the recursive call.
				yield* this.attemptApiRequestUnlocked()
				return
			}
		}

		// No error on first chunk, so we can continue to yield all remaining chunks.
		// Wrap in try/catch to handle mid-stream errors and allow retry.
		try {
			// forked_change: shortened idle timeout for the final (post-retry) attempt so
			// a stalled mid-stream response surfaces the manual retry prompt instead of
			// hanging for the full STREAM_IDLE_TIMEOUT_MS.
			const idleTimeout = retryAttempt >= MAX_CONNECTION_RETRIES ? FINAL_ATTEMPT_IDLE_TIMEOUT_MS : undefined
			let result = await nextWithIdleTimeout(iterator, idleTimeout)
			while (!result.done) {
				yield result.value
				result = await nextWithIdleTimeout(iterator, idleTimeout)
			}
		} catch (error) {
			// Reset streaming state since we encountered an error
			this.isStreaming = false

			// forked_change: track connection closures (often the user's own network
			// dropping) so mid-stream socket failures are visible and routed to retry.
			if (isConnectionClosedError(error)) {
				console.warn(
					`[Task#${this.taskId}.${this.instanceId}] stream connection closed mid-response (retryAttempt=${retryAttempt}); offering retry`,
				)
			}

			// forked_change start
			if (apiConfiguration?.apiProvider === "kilocode" && isAnyRecognizedKiloCodeError(error)) {
				const { response } = await (isPaymentRequiredError(error)
					? this.ask(
							"payment_required_prompt",
							JSON.stringify({
								title: error.error?.title ?? t("kilocode:lowCreditWarning.title"),
								message: error.error?.message ?? t("kilocode:lowCreditWarning.message"),
								balance: error.error?.balance ?? "0.00",
								buyCreditsUrl: error.error?.buyCreditsUrl ?? getAppUrl("/profile"),
							}),
						)
					: this.ask(
							"invalid_model",
							JSON.stringify({
								modelId: apiConfiguration.kilocodeModel,
								error: {
									status: error.status,
									message: error.message,
								},
							}),
						))

				if (response === "retry_clicked") {
					yield* this.attemptApiRequestUnlocked(retryAttempt + 1)
				} else {
					// Handle other responses or cancellations if necessary
					throw error // Rethrow to signal failure upwards
				}
				return
			}
			// forked_change end

			// forked_change: auto-retry transient connection failures mid-stream too (idle
			// timeout, socket closed, "streaming failed"). By this point chunks have been
			// streamed and appended, so a plain restart would duplicate them — instead we
			// emit a "stream_restart" chunk that tells the consumer to discard the partial
			// output before we re-request. Only safe while nothing irreversible has run: no
			// tool has executed and no file edit is open. Otherwise fall back to the prompt.
			const canRestartCleanly = this.executedToolCallSignatures.size === 0 && !this.diffViewProvider.isEditing
			if (
				isConnectionClosedError(error) &&
				retryAttempt < MAX_CONNECTION_RETRIES &&
				canRestartCleanly &&
				!this.abort
			) {
				yield { type: "stream_restart" }
				await this.backoffBeforeConnectionRetry(error, retryAttempt)
				yield* this.attemptApiRequestUnlocked(retryAttempt + 1)
				return
			}

			// Check if this is a 5xx error - always show retry dialog for server errors
			const isServerError = error.status && Number(error.status) >= 500 && Number(error.status) < 600

			// For mid-stream failures, show the retry dialog to allow user to retry
			// Always show retry dialog for 5xx server errors
			const response = await this.askApiReqFailed(error)

			if (response !== "yesButtonClicked") {
				// This will never happen since if noButtonClicked, we will
				// clear current task, aborting this instance.
				throw new Error("API request failed")
			}

			// The failed attempt already streamed output, so discard it before
			// re-requesting (same as the auto-retry path) — but only when nothing
			// irreversible has run; otherwise keep the streamed context intact.
			if (canRestartCleanly) {
				yield { type: "stream_restart" }
			}

			await this.say("api_req_retried")

			// Delegate generator output from the recursive call.
			yield* this.attemptApiRequestUnlocked()
			return
		}
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
		TelemetryService.instance.captureEvent(TelemetryEventName.TOOL_ERROR, { toolName, error }) // kilocode_change
	}

	/**
	 * forked_change: show a single short status line, then wait a fixed delay
	 * before the next automatic connection retry. No per-second countdown and no
	 * verbose error text — the full failure detail is reserved for the manual
	 * retry prompt shown only after all auto-retries are exhausted. Stops early
	 * if the task is aborted.
	 */
	private async backoffBeforeConnectionRetry(error: unknown, retryAttempt: number): Promise<void> {
		// An abort (user pressed Stop) must cancel the retry, not let it proceed:
		// the fixed delay below is not abort-aware, and returning silently would
		// let the caller fire a fresh provider request on an aborted task. say()
		// throws on abort, so re-check both before the wait and after it.
		if (this.abort) {
			throw new Error(`[Orbital#backoffBeforeConnectionRetry] task ${this.taskId}.${this.instanceId} aborted`)
		}
		console.warn(
			`[Task#${this.taskId}.${this.instanceId}] connection lost; retrying (${retryAttempt + 1}/${MAX_CONNECTION_RETRIES}) in ${
				CONNECTION_RETRY_DELAY_MS / 1000
			}s: ${error instanceof Error ? error.message : String(error)}`,
		)
		// Non-interactive so the status line can never supersede a pending ask
		// (e.g. a tool approval preview) and kill it with "ask was ignored".
		await this.say("api_req_retry_delayed", "Retrying connection", undefined, undefined, undefined, undefined, {
			isNonInteractive: true,
		})
		await delay(CONNECTION_RETRY_DELAY_MS)
		if (this.abort) {
			throw new Error(`[Orbital#backoffBeforeConnectionRetry] task ${this.taskId}.${this.instanceId} aborted`)
		}
	}

	/**
	 * forked_change: present the api_req_failed retry prompt, surviving background
	 * message activity that would otherwise supersede the ask (e.g. a late partial
	 * text finalization, a pending tool-approval preview, or a tool error row from
	 * presentAssistantMessage). A superseded ask rejects with "Current ask promise
	 * was ignored" and previously aborted the whole task, leaving the user with no
	 * retry button at all. We remove the orphaned ask row, wait for the background
	 * activity to settle, and re-present it so the retry button reliably appears.
	 */
	private async askApiReqFailed(error: unknown): Promise<string> {
		const message = describeStreamFailure(error)
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const { response } = await this.ask("api_req_failed", message)
				return response
			} catch (err) {
				if (this.abort) {
					throw err
				}
				if (!(err instanceof Error) || !err.message.includes("Current ask promise was ignored")) {
					throw err
				}
				console.error(
					`[Task#${this.taskId}.${this.instanceId}] api_req_failed ask was superseded by background activity (attempt ${attempt}/3); re-presenting`,
				)
				await this.removeOrphanedApiReqFailedAsk()
				await delay(1000)
			}
		}
		// Last resort: surface the failure visibly instead of aborting silently.
		try {
			await this.say(
				"error",
				`Orbital lost the connection to the model and could not keep a retry prompt visible.\n\n${message}`,
			)
		} catch {
			// best-effort; the task is about to abort anyway
		}
		throw new Error("Current ask promise was ignored")
	}

	private async removeOrphanedApiReqFailedAsk(): Promise<void> {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			const message = this.clineMessages[i]
			if (message.type === "ask" && message.ask === "api_req_failed" && message.partial !== true) {
				this.clineMessages.splice(i, 1)
				break
			}
		}
		await this.saveClineMessages()
		await this.providerRef.deref()?.postStateToWebview()
	}

	/**
	 * Finalize all streaming reasoning messages: flip each partial one to
	 * non-partial and record how long it took. Safe to call repeatedly — it
	 * no-ops on blocks that are already finalized. We can't use say() here
	 * because a reasoning message may not be the last message (text blocks or
	 * tool uses may have been appended after it during streaming).
	 *
	 * forked_change: a single stream may contain multiple reasoning phases
	 * (e.g. reasoning → text → reasoning → text), each creating a separate
	 * reasoning message. We finalize every one that is still partial so the
	 * "Thinking..." indicator doesn't stay stuck.
	 */
	private async finalizeReasoningMessage(): Promise<void> {
		for (let i = 0; i < this.clineMessages.length; i++) {
			const msg = this.clineMessages[i]
			if (msg.type === "say" && msg.say === "reasoning" && msg.partial) {
				msg.partial = false
				// Calculate and store reasoning duration in metadata
				const reasoningDuration = Date.now() - msg.ts
				msg.metadata = {
					...msg.metadata,
					kiloCode: {
						...msg.metadata?.kiloCode,
						reasoningDuration,
					},
				}
				await this.updateClineMessage(msg)
			}
		}
	}

	/**
	 * Persist GPT-5 per-turn metadata (previous_response_id, instructions, reasoning_summary)
	 * onto the last complete assistant say("text") message.
	 */
	private async persistGpt5Metadata(reasoningMessage?: string): Promise<void> {
		try {
			const modelId = this.api.getModel().id
			if (!modelId || !modelId.startsWith("gpt-5")) return

			// Check if the API handler has a getLastResponseId method (OpenAiNativeHandler specific)
			const handler = this.api as ApiHandler & { getLastResponseId?: () => string | undefined }
			const lastResponseId = handler.getLastResponseId?.()
			const idx = findLastIndex(
				this.clineMessages,
				(m) => m.type === "say" && m.say === "text" && m.partial !== true,
			)
			if (idx !== -1) {
				const msg = this.clineMessages[idx] as ClineMessage & ClineMessageWithMetadata
				if (!msg.metadata) {
					msg.metadata = {}
				}
				const gpt5Metadata: Gpt5Metadata = {
					...(msg.metadata.gpt5 ?? {}),
					previous_response_id: lastResponseId,
					instructions: this.lastUsedInstructions,
					reasoning_summary: (reasoningMessage ?? "").trim() || undefined,
				}
				msg.metadata.gpt5 = gpt5Metadata
			}
		} catch (error) {
			console.error(`[Task#${this.taskId}] Error persisting GPT-5 metadata:`, error)
			// Non-fatal error in metadata persistence
		}
	}

	// Getters

	public get taskStatus(): TaskStatus {
		if (this.interactiveAsk) {
			return TaskStatus.Interactive
		}

		if (this.resumableAsk) {
			return TaskStatus.Resumable
		}

		if (this.idleAsk) {
			return TaskStatus.Idle
		}

		return TaskStatus.Running
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts

		return this.tokenUsageSnapshot
	}

	public get cwd() {
		return this.workspacePath
	}

	/**
	 * Process any queued messages by dequeuing and submitting them.
	 * This ensures that queued user messages are sent when appropriate,
	 * preventing them from getting stuck in the queue.
	 *
	 * @param context - Context string for logging (e.g., the calling tool name)
	 */
	public processQueuedMessages(): void {
		try {
			// A message can be queued just after completion_result was rendered but
			// after ask() performed its initial queue check. Honor the same explicit
			// completion boundary while that ask is still pending.
			if (this.dispatchQueuedMessageToPendingCompletion()) {
				return
			}

			if (!this.messageQueueService.isEmpty()) {
				// Defer to the next tick so we don't reenter while a tool is still
				// finishing. The message stays visible in the queue until it is
				// actually sent: processManualMessageQueue no-ops while the stream
				// is still active, so nothing vanishes from the UI prematurely.
				setTimeout(() => {
					void this.processManualMessageQueue().catch((err) =>
						console.error(`[Task] Failed to process queued message:`, err),
					)
				}, 0)
			}
		} catch (e) {
			console.error(`[Task] Queue processing error:`, e)
		}
	}

	private dispatchQueuedMessageToPendingCompletion(): boolean {
		if (
			!this.isWaitingForAskResponse ||
			this.askResponse !== undefined ||
			this.messageQueueService.isEmpty() ||
			this.lastMessageTs === undefined
		) {
			return false
		}

		const pendingAsk = this.findMessageByTimestamp(this.lastMessageTs)
		if (
			pendingAsk?.type !== "ask" ||
			pendingAsk.ask === undefined ||
			!isCompletionQueueBoundary(pendingAsk.ask, pendingAsk.partial)
		) {
			return false
		}

		const message = this.messageQueueService.dequeueMessage()
		if (!message) {
			return false
		}

		this.setMessageResponse(message.text, message.images)
		return true
	}

	/**
	 * Update the model for this task without affecting global state.
	 * This enables task-local model isolation - each task can have its own model.
	 *
	 * @param apiProvider - The API provider (e.g., "anthropic", "openrouter")
	 * @param apiModelId - The model ID to use
	 * @param thirdPartySelectedModel - Optional third-party model selection (e.g., "ollama:llama3.2:latest")
	 */
	public updateModel(apiProvider: string, apiModelId: string, thirdPartySelectedModel?: string): void {
		// Map provider to its model ID field
		const modelFieldMap: Record<string, keyof ProviderSettings> = {
			anthropic: "apiModelId",
			"claude-code": "apiModelId",
			bedrock: "apiModelId",
			vertex: "apiModelId",
			gemini: "apiModelId",
			"gemini-cli": "apiModelId",
			mistral: "apiModelId",
			deepseek: "apiModelId",
			doubao: "apiModelId",
			moonshot: "apiModelId",
			xai: "apiModelId",
			groq: "apiModelId",
			chutes: "apiModelId",
			cerebras: "apiModelId",
			sambanova: "apiModelId",
			zai: "apiModelId",
			synthetic: "apiModelId",
			featherless: "apiModelId",
			"qwen-code": "apiModelId",
			roo: "apiModelId",
			"virtual-quota-fallback": "apiModelId",
			openrouter: "openRouterModelId",
			"kilocode-openrouter": "openRouterModelId",
			glama: "glamaModelId",
			openai: "openAiModelId",
			"openai-native": "openAiModelId",
			ollama: "ollamaModelId",
			lmstudio: "lmStudioModelId",
			unbound: "unboundModelId",
			requesty: "requestyModelId",
			litellm: "litellmModelId",
			huggingface: "huggingFaceModelId",
			"io-intelligence": "ioIntelligenceModelId",
			"vercel-ai-gateway": "vercelAiGatewayModelId",
			deepinfra: "deepInfraModelId",
			kilocode: "kilocodeModel",
			ovhcloud: "ovhCloudAiEndpointsModelId",
		}

		const field = modelFieldMap[apiProvider]
		if (!field) {
			console.error(`[Task#updateModel] Unknown provider: ${apiProvider}`)
			return
		}

		// Create a new configuration object with the updated model
		// We need to cast because TypeScript doesn't know the field is valid
		const updatedConfig = {
			...this.apiConfiguration,
			apiProvider,
			[field]: apiModelId,
			// Update or clear third-party model selection
			thirdPartySelectedModel,
		} as ProviderSettings

		// Update the task's configuration (this is task-local, not global)
		;(this as any).apiConfiguration = updatedConfig

		// Rebuild the API handler with the new configuration
		this.api = buildApiHandler(updatedConfig)

		console.log(`[Task#updateModel] Updated task ${this.taskId} to use ${apiProvider}/${apiModelId}`)
	}
}
