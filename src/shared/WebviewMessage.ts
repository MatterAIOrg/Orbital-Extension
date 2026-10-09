import { z } from "zod"

import {
	type ProviderSettings,
	type PromptComponent,
	type ModeConfig,
	type InstallMarketplaceItemOptions,
	type MarketplaceItem,
	type ShareVisibility,
	type QueuedMessage,
	type PasteChipSerialized,
	marketplaceItemSchema,
	// forked_change start
	CommitRange,
	HistoryItem,
	GlobalState,
	// forked_change end
} from "@roo-code/types"

import { Mode } from "./modes"
import { ImplementPlanPayload, OpenPlanFilePayload } from "./ExtensionMessage"

import { ImageAttachment } from "./ExtensionMessage"

export type ClineAskResponse =
	| "yesButtonClicked"
	| "noButtonClicked"
	| "messageResponse"
	| "objectResponse"
	| "retry_clicked" // kilocode_change: Added retry_clicked for payment required dialog

export type PromptMode = Mode | "enhance"

export type AudioType = "notification" | "celebration" | "progress_loop"

export interface UpdateTodoListPayload {
	todos: any[]
}

export type EditQueuedMessagePayload = Pick<QueuedMessage, "id" | "text" | "images" | "pasteChips">

// forked_change start: Type-safe global state update message
export type GlobalStateValue<K extends keyof GlobalState> = GlobalState[K]
export type UpdateGlobalStateMessage<K extends keyof GlobalState = keyof GlobalState> = {
	type: "updateGlobalState"
	stateKey: K
	stateValue: GlobalStateValue<K>
}
// forked_change end: Type-safe global state update message

export interface WebviewMessage {
	type:
		| "updateTodoList"
		| "deleteMultipleTasksWithIds"
		| "currentApiConfigName"
		| "saveApiConfiguration"
		| "upsertApiConfiguration"
		| "deleteApiConfiguration"
		| "loadApiConfiguration"
		| "loadApiConfigurationById"
		| "renameApiConfiguration"
		| "getListApiConfiguration"
		| "customInstructions"
		| "allowedCommands"
		| "deniedCommands"
		| "alwaysAllowReadOnly"
		| "alwaysAllowReadOnlyOutsideWorkspace"
		| "alwaysAllowWrite"
		| "alwaysAllowWriteOutsideWorkspace"
		| "alwaysAllowWriteProtected"
		| "alwaysAllowExecute"
		| "alwaysAllowFollowupQuestions"
		| "alwaysAllowUpdateTodoList"
		| "followupAutoApproveTimeoutMs"
		| "webviewDidLaunch"
		| "newTask"
		| "askResponse"
		| "terminalOperation"
		| "clearTask"
		| "didShowAnnouncement"
		| "selectImages"
		| "selectAttachments"
		| "exportCurrentTask"
		| "shareCurrentTask"
		| "showTaskWithId"
		| "deleteTaskWithId"
		| "closeTask"
		| "exportTaskWithId"
		| "importSettings"
		| "toggleToolAutoApprove"
		| "openExtensionSettings"
		| "openInBrowser"
		| "fetchOpenGraphData"
		| "checkIsImageUrl"
		| "exportSettings"
		| "resetState"
		| "flushRouterModels"
		| "requestRouterModels"
		| "requestOpenAiModels"
		| "requestOllamaModels"
		| "requestLmStudioModels"
		| "requestThirdPartyModels"
		| "openSettings"
		| "requestVsCodeLmModels"
		| "requestHuggingFaceModels"
		| "openImage"
		| "saveImage"
		| "openFile"
		| "viewFile"
		| "saveFile"
		| "openMention"
		| "cancelTask"
		| "updateVSCodeSetting"
		| "getVSCodeSetting"
		| "vsCodeSetting"
		| "alwaysAllowBrowser"
		| "alwaysAllowMcp"
		| "alwaysAllowModeSwitch"
		| "allowedMaxRequests"
		| "allowedMaxCost"
		| "alwaysAllowSubtasks"
		| "alwaysAllowUpdateTodoList"
		| "autoCondenseContext"
		| "autoCondenseContextPercent"
		| "condensingApiConfigId"
		| "updateCondensingPrompt"
		| "playSound"
		| "playTts"
		| "stopTts"
		| "soundEnabled"
		| "ttsEnabled"
		| "ttsSpeed"
		| "soundVolume"
		| "diffEnabled"
		| "enableCheckpoints"
		| "browserViewportSize"
		| "screenshotQuality"
		| "remoteBrowserHost"
		| "openKeyboardShortcuts"
		| "openMcpSettings"
		| "openProjectMcpSettings"
		| "restartMcpServer"
		| "refreshAllMcpServers"
		| "toggleToolAlwaysAllow"
		| "toggleToolEnabledForPrompt"
		| "toggleMcpServer"
		| "updateMcpTimeout"
		| "fuzzyMatchThreshold"
		| "morphApiKey" // kilocode_change: Morph fast apply - global setting
		| "fastApplyModel" // kilocode_change: Fast Apply model selection
		| "writeDelayMs"
		| "diagnosticsEnabled"
		| "enhancePrompt"
		| "enhancedPrompt"
		| "draggedImages"
		| "attachmentPathToAttachment" // kilocode_change: paste file path -> attachment
		| "pastedFileAttachment" // kilocode_change: paste file blob -> attachment
		| "deleteMessage"
		| "deleteMessageConfirm"
		| "submitEditedMessage"
		| "editMessageConfirm"
		| "terminalOutputLineLimit"
		| "terminalOutputCharacterLimit"
		| "terminalShellIntegrationTimeout"
		| "terminalShellIntegrationDisabled"
		| "terminalCommandDelay"
		| "terminalPowershellCounter"
		| "terminalZshClearEolMark"
		| "terminalZshOhMy"
		| "terminalZshP10k"
		| "terminalZdotdir"
		| "terminalCompressProgressBar"
		| "mcpEnabled"
		| "enableMcpServerCreation"
		| "remoteControlEnabled"
		| "taskSyncEnabled"
		| "searchCommits"
		| "alwaysApproveResubmit"
		| "requestDelaySeconds"
		| "setApiConfigPassword"
		| "mode"
		| "updatePrompt"
		| "updateSupportPrompt"
		| "getSystemPrompt"
		| "copySystemPrompt"
		| "refreshContextBreakdown"
		| "systemPrompt"
		| "enhancementApiConfigId"
		| "commitMessageApiConfigId" // kilocode_change
		| "terminalCommandApiConfigId" // kilocode_change
		| "includeTaskHistoryInEnhance"
		| "updateExperimental"
		| "autoApprovalEnabled"
		| "yoloMode" // kilocode_change
		| "updateCustomMode"
		| "deleteCustomMode"
		| "setopenAiCustomModelInfo"
		| "openCustomModesSettings"
		| "checkpointDiff"
		| "checkpointRestore"
		| "seeNewChanges" // kilocode_change
		| "fileEditReviewAcceptAll" // kilocode_change
		| "fileEditReviewRejectAll" // kilocode_change
		| "deleteMcpServer"
		| "maxOpenTabsContext"
		| "maxWorkspaceFiles"
		| "switchTask" // multi-chat
		| "closeTask" // multi-chat
		| "humanRelayResponse"
		| "updateTaskModel" // Task-local model update for isolation
		| "humanRelayCancel"
		| "insertTextToChatArea" // kilocode_change
		| "browserToolEnabled"
		| "codebaseIndexEnabled"
		| "telemetrySetting"
		| "showRooIgnoredFiles"
		| "testBrowserConnection"
		| "browserConnectionResult"
		| "remoteBrowserEnabled"
		| "language"
		| "maxReadFileLine"
		| "maxImageFileSize"
		| "maxTotalImageSize"
		| "maxConcurrentFileReads"
		| "allowVeryLargeReads" // kilocode_change
		| "includeDiagnosticMessages"
		| "maxDiagnosticMessages"
		| "searchFiles"
		| "setHistoryPreviewCollapsed"
		| "showFeedbackOptions" // kilocode_change
		| "toggleApiConfigPin"
		| "fetchMcpMarketplace" // kilocode_change
		| "silentlyRefreshMcpMarketplace" // kilocode_change
		| "fetchLatestMcpServersFromHub" // kilocode_change
		| "downloadMcp" // kilocode_change
		| "showSystemNotification" // kilocode_change
		| "showAutoApproveMenu" // kilocode_change
		| "reportBug" // kilocode_change
		| "autoApproveAllCommands" // kilocode_change: auto-approve all commands for current task
		| "commandApprovalMode" // forked_change: command approval mode selected from the chat textarea
		| "modelEffort" // forked_change: effort picked for a model in the chat's effort selector
		| "requestBackgroundCommands" // forked_change: list the current task's running background shells
		| "killBackgroundCommand" // forked_change: stop a background shell (text: its id)
		| "profileButtonClicked" // kilocode_change
		| "fetchProfileDataRequest" // kilocode_change
		| "profileDataResponse" // kilocode_change
		| "resetWeeklyUsageRequest"
		| "resetWeeklyUsageResponse"
		| "fetchGitBranchRequest" // kilocode_change
		| "gitBranchResponse" // kilocode_change
		| "fetchBalanceDataRequest" // kilocode_change
		| "shopBuyCredits" // kilocode_change
		| "balanceDataResponse" // kilocode_change
		| "updateProfileData" // kilocode_change
		| "fetchBetaModelsRequest" // kilocode_change
		| "betaModelsResponse" // kilocode_change
		| "condense" // kilocode_change
		| "toggleWorkflow" // kilocode_change
		| "refreshRules" // kilocode_change
		| "toggleRule" // kilocode_change
		| "createRuleFile" // kilocode_change
		| "deleteRuleFile" // kilocode_change
		| "hasOpenedModeSelector"
		| "cloudButtonClicked"
		| "rooCloudSignIn"
		| "cloudLandingPageSignIn"
		| "rooCloudSignOut"
		| "rooCloudManualUrl"
		| "switchOrganization"
		| "condenseTaskContextRequest"
		| "requestIndexingStatus"
		| "startIndexing"
		| "cancelIndexing" // kilocode_change
		| "clearIndexData"
		| "indexingStatusUpdate"
		| "indexCleared"
		| "focusPanelRequest"
		| "profileThresholds"
		| "setHistoryPreviewCollapsed"
		| "clearUsageData" // kilocode_change
		| "getUsageData" // kilocode_change
		| "usageDataResponse" // kilocode_change
		| "showTaskTimeline" // kilocode_change
		| "sendMessageOnEnter" // kilocode_change
		| "showTimestamps" // kilocode_change
		| "hideCostBelowThreshold" // kilocode_change
		| "toggleTaskFavorite" // kilocode_change
		| "fixMermaidSyntax" // kilocode_change
		| "mermaidFixResponse" // kilocode_change
		| "openGlobalKeybindings" // kilocode_change
		| "getKeybindings" // kilocode_change
		| "setReasoningBlockCollapsed"
		| "openExternal"
		| "filterMarketplaceItems"
		| "mcpButtonClicked"
		| "marketplaceButtonClicked"
		| "skillsMarketplaceButtonClicked" // kilocode_change: Skills marketplace
		| "fetchSkillsMarketplaceData" // kilocode_change: Skills marketplace
		| "installMarketplaceItem"
		| "installMarketplaceItemWithParameters"
		| "cancelMarketplaceInstall"
		| "mcpMigrateList"
		| "mcpMigrateApply"
		| "authenticateMcpServer"
		| "removeInstalledMarketplaceItem"
		| "marketplaceInstallResult"
		| "fetchMarketplaceData"
		| "installSuggestedPlugin"
		| "switchTab"
		| "kilocodeLogout" // kilocode_change: clear KiloCode credentials from the Account settings page
		| "profileThresholds"
		| "editMessage" // kilocode_change
		| "systemNotificationsEnabled" // kilocode_change
		| "dismissNotificationId" // kilocode_change
		| "tasksByIdRequest" // kilocode_change
		| "taskHistoryRequest" // kilocode_change
		| "updateGlobalState" // kilocode_change
		| "shareTaskSuccess"
		| "exportMode"
		| "exportModeResult"
		| "importMode"
		| "importModeResult"
		| "checkRulesDirectory"
		| "checkRulesDirectoryResult"
		| "saveCodeIndexSettingsAtomic"
		| "requestCodeIndexSecretStatus"
		| "fetchKilocodeNotifications"
		| "requestCommands"
		| "openCommandFile"
		| "deleteCommand"
		| "createCommand"
		| "insertTextIntoTextarea"
		| "showMdmAuthRequiredNotification"
		| "implementPlan" // kilocode_change: Plan mode implementation
		| "openPlanFile" // kilocode_change: Open plan file in editor
		| "imageGenerationSettings"
		| "openRouterImageApiKey"
		| "kiloCodeImageApiKey"
		| "openRouterImageGenerationSelectedModel"
		| "queueMessage"
		| "removeQueuedMessage"
		| "editQueuedMessage"
		| "forceSendQueuedMessage"
		| "dismissUpsell"
		| "getDismissedUpsells"
		| "checkForOrbitalUpdate"
		| "installOrbitalUpdate"
		// forked_change start
		| "getCommitChanges"
		| "commitChanges"
		| "getPendingFileEdits"
		| "pendingFileEdits"
		| "viewPendingFileDiffs"
		| "requestCodeReview"
		| "codeReviewResults"
		| "applyCodeReviewFix"
		| "applyAllCodeReviewFixes"
		| "getGitChangesForReview"
		| "gitChangesForReview"
		| "codeReviewSettings"
		| "showToast"
		| "get_memories"
		| "memories_response"
		| "delete_memory"
		| "memory_deleted"
		| "speechToTextRequest" // kilocode_change: audio transcription request
		| "speechToTextResponse" // kilocode_change: audio transcription response
		| "startSpeechRecording" // kilocode_change: start extension-host mic capture
		| "stopSpeechRecording" // kilocode_change: stop extension-host mic capture
		| "maximizeSideBar"
		| "minimizeSideBar"
		| "openSideBar"
		| "plusButtonClicked" // kilocode_change: Create a new chat tab
	// forked_change end
	text?: string
	editedMessageContent?: string
	tab?: "settings" | "history" | "mcp" | "modes" | "chat" | "marketplace" | "skillsMarketplace" | "cloud"
	disabled?: boolean
	context?: string
	dataUri?: string
	askResponse?: ClineAskResponse
	apiConfiguration?: ProviderSettings
	images?: string[]
	pasteChips?: PasteChipSerialized[]
	bool?: boolean
	value?: number
	commands?: string[]
	audioType?: AudioType
	// kilocode_change begin
	notificationOptions?: {
		title?: string
		subtitle?: string
		message: string
	}
	toastType?: "success" | "error" | "info" | "warning" // kilocode_change
	toastMessage?: string // kilocode_change
	mcpId?: string
	toolNames?: string[]
	autoApprove?: boolean
	workflowPath?: string // kilocode_change
	enabled?: boolean // kilocode_change
	rulePath?: string // kilocode_change
	isGlobal?: boolean // kilocode_change
	filename?: string // kilocode_change
	ruleType?: string // kilocode_change
	notificationId?: string // kilocode_change
	commandIds?: string[] // kilocode_change: For getKeybindings
	// forked_change end
	serverName?: string
	toolName?: string
	keys?: string[] // mcpMigrateApply: stable entry keys the user confirmed
	alwaysAllow?: boolean
	isEnabled?: boolean
	mode?: Mode
	promptMode?: PromptMode
	customPrompt?: PromptComponent
	dataUrls?: string[]
	imagePath?: string // kilocode_change: for attachmentPathToAttachment
	fileName?: string // kilocode_change: for pastedFileAttachment
	fileDataUrl?: string // kilocode_change: for pastedFileAttachment
	values?: Record<string, any>
	query?: string
	setting?: string
	slug?: string
	modeConfig?: ModeConfig
	timeout?: number
	payload?: WebViewMessagePayload
	source?: "global" | "project"
	requestId?: string
	ids?: string[]
	hasSystemPromptOverride?: boolean
	terminalOperation?: "continue" | "abort"
	messageTs?: number
	taskId?: string // For switchTask and closeTask
	restoreCheckpoint?: boolean
	historyPreviewCollapsed?: boolean
	filters?: { type?: string; search?: string; tags?: string[] }
	settings?: any
	url?: string // For openExternal
	mpItem?: MarketplaceItem
	mpInstallOptions?: InstallMarketplaceItemOptions
	config?: Record<string, any> // Add config to the payload
	pluginName?: string // For installSuggestedPlugin
	scope?: "project" | "global" // For installSuggestedPlugin
	visibility?: ShareVisibility // For share visibility
	hasContent?: boolean // For checkRulesDirectoryResult
	// Task-local model update for isolation
	apiProvider?: string // For updateTaskModel
	apiModelId?: string // For updateTaskModel
	checkOnly?: boolean // For deleteCustomMode check
	upsellId?: string // For dismissUpsells
	list?: string[] // For dismissedUpsells response
	organizationId?: string | null // For organization switching
	showAllWorkspaces?: boolean // kilocode_change: For get_memories
	memories?: MemoryItem[] // kilocode_change: For memories_response
	memoryId?: string // kilocode_change: For delete_memory
	provider?: string // For requestThirdPartyModels
	targetSection?: string // For openSettings
	thirdPartySelectedModel?: string // For updateTaskModel
	codeIndexSettings?: {
		// Global state settings
		codebaseIndexEnabled: boolean
		codebaseIndexQdrantUrl: string
		codebaseIndexEmbedderProvider:
			| "openai"
			| "ollama"
			| "openai-compatible"
			| "gemini"
			| "mistral"
			| "vercel-ai-gateway"
		codebaseIndexEmbedderBaseUrl?: string
		codebaseIndexEmbedderModelId: string
		codebaseIndexEmbedderModelDimension?: number // Generic dimension for all providers
		codebaseIndexOpenAiCompatibleBaseUrl?: string
		codebaseIndexSearchMaxResults?: number
		codebaseIndexSearchMinScore?: number

		// Secret settings
		codeIndexOpenAiKey?: string
		codeIndexQdrantApiKey?: string
		codebaseIndexOpenAiCompatibleApiKey?: string
		codebaseIndexGeminiApiKey?: string
		codebaseIndexMistralApiKey?: string
		codebaseIndexVercelAiGatewayApiKey?: string
	}
}

// kilocode_change: Create discriminated union for type-safe messages
export type MaybeTypedWebviewMessage = WebviewMessage | UpdateGlobalStateMessage

// kilocode_change begin
export type OrganizationRole = "owner" | "admin" | "member"

export type UserOrganizationWithApiKey = {
	id: string
	name: string
	balance: number
	role: OrganizationRole
	apiKey: string
}

export type ProfileData = {
	email: string
	kilocodeToken: string
	user: {
		id: string
		name: string
		email: string
		image: string
	}
	organizations?: UserOrganizationWithApiKey[]
	// Additional fields from /axoncode/profile endpoint
	plan?: string
	remainingReviews?: number
	usagePercentage?: number
	creditsResetDate?: string
	// Tiered usage windows (weekly / monthly). Each window is expressed
	// as a fraction of the user's monthly plan limit.
	tieredUsage?: AxonCodeTieredUsage
	// Per-model usage for the tracked OSS models. Each entry attributes the
	// model's share of the shared plan pool as percentages of the same
	// weekly/monthly windows (no credit amounts are exposed).
	modelUsage?: AxonCodeModelUsage[]
	weeklyReset?: AxonCodeWeeklyResetAvailability
	// Overage lets the plan keep running on shared org API credits once the
	// plan windows hit 98%. `enabled` is true only when the org has turned
	// overage on AND this user is covered by the access selection.
	overage?: AxonCodeOverage
}

export interface AxonCodeOverageUsage {
	spent: number
	budget: number | null
	remaining: number | null
	percentage: number | null
	periodStart: string
	resetsAt: string
}

export interface AxonCodeOverage {
	enabled: boolean
	usage?: AxonCodeOverageUsage | null
}

export interface AxonCodeWeeklyResetAvailability {
	eligible: boolean
	available: boolean
	lastResetAt: string | null
	nextAvailableAt: string | null
}

export interface AxonCodeWindowUsage {
	used: number
	limit: number
	remaining: number
	percentage: number
	resetsAt: string
	windowStart: string
}

export interface AxonCodeTieredUsage {
	plan: string
	monthlyLimit: number
	weekly: AxonCodeWindowUsage
	monthly: AxonCodeWindowUsage
}

export interface AxonCodeModelUsage {
	// OSS catalog model id (e.g. "zai/glm-5.3").
	model: string
	// Plan-cost multiplier applied to this model's charges (e.g. 5 for
	// deepseek, 1 for untracked/axon models).
	multiplier: number
	// Share of the shared weekly / monthly plan windows, as percentages.
	weeklyPercentage: number
	monthlyPercentage: number
	// Provider logo URL (SVG) from the agent model catalog, rendered on a
	// white circular background.
	iconUrl?: string
}

export interface ProfileDataResponsePayload {
	success: boolean
	data?: ProfileData
	error?: string
}

export interface WeeklyResetResponsePayload {
	success: boolean
	data?: {
		weeklyReset: AxonCodeWeeklyResetAvailability
		tieredUsage: AxonCodeTieredUsage
	}
	error?: string
}

export interface BalanceDataResponsePayload {
	// New: Payload for balance data
	success: boolean
	data?: any // Replace 'any' with a more specific type if known for balance
	error?: string
}

export interface BetaModelsResponsePayload {
	// Payload for beta models availability
	success: boolean
	enabled?: boolean
	error?: string
}

export interface GitBranchResponsePayload {
	// Payload for git branch response
	success: boolean
	branch?: string | null
	error?: string
}

export interface SeeNewChangesPayload {
	commitRange: CommitRange
}

export interface TasksByIdRequestPayload {
	requestId: string
	taskIds: string[]
}

export interface TaskHistoryRequestPayload {
	requestId: string
	workspace: "current" | "all"
	sort: "newest" | "oldest" | "mostExpensive" | "mostTokens" | "mostRelevant"
	favoritesOnly: boolean
	pageIndex: number
	search?: string
}

export interface TasksByIdResponsePayload {
	requestId: string
	tasks: HistoryItem[]
}

export interface TaskHistoryResponsePayload {
	requestId: string
	historyItems: HistoryItem[]
	pageIndex: number
	pageCount: number
}

// kilocode_change: Chat memories
export interface MemoryItem {
	id: string
	workspace: string
	taskId: string
	taskTitle?: string
	content: string
	timestamp: string
	mode?: string
}
// forked_change end

export const checkoutDiffPayloadSchema = z.object({
	ts: z.number(),
	previousCommitHash: z.string().optional(),
	commitHash: z.string(),
	mode: z.enum(["full", "checkpoint"]),
})

export type CheckpointDiffPayload = z.infer<typeof checkoutDiffPayloadSchema>

export const checkoutRestorePayloadSchema = z.object({
	ts: z.number(),
	commitHash: z.string(),
	mode: z.enum(["preview", "restore"]),
})

export type CheckpointRestorePayload = z.infer<typeof checkoutRestorePayloadSchema>

export interface IndexingStatusPayload {
	state: "Standby" | "Indexing" | "Indexed" | "Error"
	message: string
}

export interface IndexClearedPayload {
	success: boolean
	error?: string
}

export const installMarketplaceItemWithParametersPayloadSchema = z.object({
	item: marketplaceItemSchema,
	parameters: z.record(z.string(), z.any()),
})

export type InstallMarketplaceItemWithParametersPayload = z.infer<
	typeof installMarketplaceItemWithParametersPayloadSchema
>

/** Webview → extension: list all MCP servers that can be migrated in from
 *  Cursor / Claude Code / Claude Desktop. */
export interface McpMigrateListRequest {
	type: "mcpMigrateList"
}

/** Webview → extension: apply a user-confirmed subset of migration entries
 *  to the global MCP settings file. */
export interface McpMigrateApplyRequest {
	type: "mcpMigrateApply"
	keys: string[]
}

/** Webview → extension: start the OAuth flow for a server that is in the
 *  `needs-auth` state. The extension opens the authorization URL in the
 *  external browser; the OAuth callback is handled by the URI handler. */
export interface AuthenticateMcpServerRequest {
	type: "authenticateMcpServer"
	serverName: string
	source?: "global" | "project"
}

// forked_change start
export interface GetCommitChangesPayload {
	commitRange: CommitRange
}
export interface CommitChangesPayload {
	// The response message type
	commitRange: CommitRange
	files: { relative: string; absolute: string; stat: { additions: number; deletions: number } }[]
}

export interface PendingFileEditsPayload {
	// The response message type - list of all pending file edits
	files: { relPath: string; absolutePath: string; stat: { additions: number; deletions: number } }[]
}

export interface CodeReviewComment {
	path: string
	body: string
	suggestion: string
	startLine: number
	endLine: number
}

export interface CodeReviewResultsPayload {
	reviewBody: string
	reviewComments: CodeReviewComment[]
}

export interface ApplyCodeReviewFixPayload {
	fixIndex: number
	comment: CodeReviewComment
}

export interface ApplyAllCodeReviewFixesPayload {
	fixIndices: number[]
	comments: CodeReviewComment[]
}
// forked_change end

export type WebViewMessagePayload =
	// forked_change start
	| ProfileDataResponsePayload
	| WeeklyResetResponsePayload
	| BalanceDataResponsePayload
	| BetaModelsResponsePayload
	| SeeNewChangesPayload
	| TasksByIdRequestPayload
	| TaskHistoryRequestPayload
	| GetCommitChangesPayload
	| CommitChangesPayload
	| PendingFileEditsPayload
	| ImplementPlanPayload
	| OpenPlanFilePayload
	| CodeReviewResultsPayload
	| ApplyCodeReviewFixPayload
	| ApplyAllCodeReviewFixesPayload
	// forked_change end
	| CheckpointDiffPayload
	| CheckpointRestorePayload
	| IndexingStatusPayload
	| IndexClearedPayload
	| InstallMarketplaceItemWithParametersPayload
	| UpdateTodoListPayload
	| EditQueuedMessagePayload
