import type {
	ClineMessage,
	CloudOrganizationMembership,
	CloudUserInfo,
	Experiments,
	GlobalSettings,
	HistoryItem,
	MarketplaceItem,
	ModeConfig,
	OrganizationAllowList,
	PasteChipSerialized,
	ProviderSettings,
	ProviderSettingsEntry,
	QueuedMessage,
	ShareVisibility,
	TelemetrySetting,
	TodoItem,
} from "@roo-code/types"

import { GitCommit } from "../utils/git"

import { ModelRecord, RouterModels } from "./api"
import { McpDownloadResponse, McpMarketplaceCatalog } from "./kilocode/mcp"
import { McpServer } from "./mcp"
import { Mode } from "./modes"
// forked_change start
import {
	BalanceDataResponsePayload,
	BetaModelsResponsePayload,
	GitBranchResponsePayload,
	ProfileDataResponsePayload,
	WeeklyResetResponsePayload,
	TaskHistoryResponsePayload,
	TasksByIdResponsePayload,
	MemoryItem,
} from "./WebviewMessage"
import { ClineRulesToggles } from "./cline-rules"
import { KiloCodeWrapperProperties } from "./kilocode/wrapper"
// forked_change end

// Image attachment type shared between extension and webview
export interface ImageAttachment {
	dataUrl: string
	name: string
}

// Text extracted from a user-selected document in the extension host.
export interface DocumentAttachment {
	name: string
	text: string
	truncated?: boolean
}

// Helper to extract dataUrls from ImageAttachment array or string array
export function extractDataUrls(images: ImageAttachment[] | string[] | undefined): string[] {
	if (!images) return []
	if (images.length === 0) return []
	// Check if first element is a string (dataUrl) or ImageAttachment
	if (typeof images[0] === "string") {
		return images as string[]
	}
	return (images as ImageAttachment[]).map((img) => img.dataUrl)
}

// Helper to convert string[] (dataUrls) to ImageAttachment[]
export function stringsToImageAttachments(images: string[] | undefined): ImageAttachment[] {
	if (!images) return []
	return images.map((dataUrl, index) => ({ dataUrl, name: `image-${index}` }))
}

// Command interface for frontend/backend communication
export interface Command {
	name: string
	source: "global" | "project" | "built-in" | "plugin"
	filePath?: string
	description?: string
	argumentHint?: string
}

// Type for marketplace installed metadata
export interface MarketplaceInstalledMetadata {
	project: Record<string, { type: string; inventory?: MarketplacePluginInventory }>
	global: Record<string, { type: string; inventory?: MarketplacePluginInventory }>
}

export interface MarketplacePluginInventory {
	skills: number
	commands: number
	agents: number
	mcpServers: number
	hooks: number
}

// Indexing status types
export interface IndexingStatus {
	systemStatus: string
	message?: string
	processedItems: number
	totalItems: number
	currentItemUnit?: string
	workspacePath?: string
}

export interface IndexingStatusUpdateMessage {
	type: "indexingStatusUpdate"
	values: IndexingStatus
}

export interface LanguageModelChatSelector {
	vendor?: string
	family?: string
	version?: string
	id?: string
}

// Represents JSON data that is sent from extension to webview, called
// ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or
// 'settingsButtonClicked' or 'hello'. Webview will hold state.
/** forked_change: a running background shell, as listed above the chat input. */
export interface BackgroundCommandInfo {
	id: string
	command: string
	cwd: string
	pid: number | null
	startedAt: number
	/** Latest non-empty output line. */
	lastLine?: string
}

export interface ExtensionMessage {
	type:
		| "action"
		| "state"
		| "selectedImages"
		| "selectedAttachments"
		| "theme"
		| "workspaceUpdated"
		| "invoke"
		| "messageUpdated"
		| "mcpServers"
		| "enhancedPrompt"
		| "commitSearchResults"
		| "listApiConfig"
		| "routerModels"
		| "openAiModels"
		| "ollamaModels"
		| "lmStudioModels"
		| "thirdPartyModels"
		| "vsCodeLmModels"
		| "huggingFaceModels"
		| "vsCodeLmApiAvailable"
		| "updatePrompt"
		| "systemPrompt"
		| "autoApprovalEnabled"
		| "yoloMode" // kilocode_change
		| "updateCustomMode"
		| "deleteCustomMode"
		| "exportModeResult"
		| "importModeResult"
		| "checkRulesDirectoryResult"
		| "deleteCustomModeCheck"
		| "currentCheckpointUpdated"
		| "showHumanRelayDialog"
		| "humanRelayResponse"
		| "humanRelayCancel"
		| "insertTextToChatArea" // kilocode_change
		| "browserToolEnabled"
		| "browserConnectionResult"
		| "remoteBrowserEnabled"
		| "ttsStart"
		| "ttsStop"
		| "maxReadFileLine"
		| "fileSearchResults"
		| "toggleApiConfigPin"
		| "mcpMarketplaceCatalog" // kilocode_change
		| "mcpDownloadDetails" // kilocode_change
		| "mcpMigrationEntries"
		| "mcpMigrationResult"
		| "mcpAuthResult"
		| "showSystemNotification" // kilocode_change
		| "openInBrowser" // kilocode_change
		| "acceptInput"
		| "focusChatInput" // kilocode_change
		| "setHistoryPreviewCollapsed"
		| "commandExecutionStatus"
		| "backgroundCommands" // forked_change: the current task's running background shells
		| "mcpExecutionStatus"
		| "vsCodeSetting"
		| "profileDataResponse" // kilocode_change
		| "resetWeeklyUsageResponse"
		| "gitBranchResponse" // kilocode_change
		| "balanceDataResponse" // kilocode_change
		| "updateProfileData" // kilocode_change
		| "betaModelsResponse" // kilocode_change
		| "authenticatedUser"
		| "condenseTaskContextResponse"
		| "singleRouterModelFetchResponse"
		| "indexingStatusUpdate"
		| "indexCleared"
		| "codebaseIndexConfig"
		| "rulesData" // kilocode_change
		| "marketplaceInstallResult"
		| "marketplaceRemoveResult"
		| "marketplaceData"
		| "skillsMarketplaceData" // kilocode_change: Skills marketplace data
		| "mermaidFixResponse" // kilocode_change
		| "tasksByIdResponse" // kilocode_change
		| "taskHistoryResponse" // kilocode_change
		| "shareTaskSuccess"
		| "codeIndexSettingsSaved"
		| "codeIndexSecretStatus"
		| "showDeleteMessageDialog"
		| "showEditMessageDialog"
		| "kilocodeNotificationsResponse" // kilocode_change
		| "usageDataResponse" // kilocode_change
		| "keybindingsResponse" // kilocode_change
		| "commands"
		| "insertTextIntoTextarea"
		| "dismissedUpsells"
		| "showTimestamps" // kilocode_change
		| "organizationSwitchResult"
		| "implementPlan"
		| "showToast"
		| "memories_response"
		| "memory_deleted"
		| "speechToTextResponse" // kilocode_change: audio transcription response
		| "orbitalUpdateStatus"
	text?: string
	// forked_change start
	payload?:
		| ProfileDataResponsePayload
		| WeeklyResetResponsePayload
		| GitBranchResponsePayload
		| BalanceDataResponsePayload
		| BetaModelsResponsePayload
		| TasksByIdResponsePayload
		| TaskHistoryResponsePayload
		| ImplementPlanPayload
		| OpenPlanFilePayload
	// forked_change end
	action?:
		| "chatButtonClicked"
		| "mcpButtonClicked"
		| "settingsButtonClicked"
		| "promptsButtonClicked"
		| "historyButtonClicked"
		| "profileButtonClicked" // kilocode_change
		| "marketplaceButtonClicked"
		| "skillsMarketplaceButtonClicked" // kilocode_change: Skills marketplace
		| "memoriesButtonClicked"
		| "cloudButtonClicked"
		| "didBecomeVisible"
		| "focusInput"
		| "switchTab"
		| "focusChatInput" // kilocode_change
		| "toggleAutoApprove"
		| "settingsFocus" // kilocode_change: Third-party providers settings
	invoke?: "newChat" | "sendMessage" | "primaryButtonClick" | "secondaryButtonClick" | "setChatBoxMessage"
	state?: ExtensionState
	images?: ImageAttachment[]
	documents?: DocumentAttachment[]
	pasteChips?: PasteChipSerialized[]
	attachmentErrors?: string[]
	filePaths?: string[]
	openedTabs?: Array<{
		label: string
		isActive: boolean
		path?: string
	}>
	clineMessage?: ClineMessage
	routerModels?: RouterModels
	openAiModels?: string[]
	ollamaModels?: ModelRecord
	lmStudioModels?: ModelRecord
	thirdPartyModels?: { provider: string; models: ModelRecord }
	vsCodeLmModels?: { vendor?: string; family?: string; version?: string; id?: string }[]
	huggingFaceModels?: Array<{
		id: string
		object: string
		created: number
		owned_by: string
		providers: Array<{
			provider: string
			status: "live" | "staging" | "error"
			supports_tools?: boolean
			supports_structured_output?: boolean
			context_length?: number
			pricing?: {
				input: number
				output: number
			}
		}>
	}>
	mcpServers?: McpServer[]
	commits?: GitCommit[]
	listApiConfig?: ProviderSettingsEntry[]
	mode?: Mode
	customMode?: ModeConfig
	slug?: string
	success?: boolean
	values?: Record<string, any>
	requestId?: string
	promptText?: string
	results?: { path: string; type: "file" | "folder"; label?: string }[]
	error?: string
	mcpMarketplaceCatalog?: McpMarketplaceCatalog // kilocode_change
	mcpDownloadDetails?: McpDownloadResponse // kilocode_change
	mcpMigrationEntries?: import("../services/mcp/mcpMigrate").MigrationEntry[]
	mcpMigrationResult?: {
		added: { name: string; source: string; sourceLabel: string }[]
		skipped: { name: string; source: string; sourceLabel: string; reason: string }[]
		destinationPath: string
	}
	mcpAuthResult?: {
		serverName: string
		success: boolean
		authUrl?: string
		error?: string
	}
	notificationOptions?: {
		title?: string
		subtitle?: string
		message: string
	} // kilocode_change
	toastType?: "success" | "error" | "info" | "warning" // kilocode_change
	toastMessage?: string // kilocode_change
	url?: string // kilocode_change
	keybindings?: Record<string, string> // kilocode_change
	setting?: string
	value?: any
	hasContent?: boolean // For checkRulesDirectoryResult
	items?: MarketplaceItem[]
	userInfo?: CloudUserInfo
	organizationAllowList?: OrganizationAllowList
	tab?: string
	targetSection?: string // kilocode_change: For settingsFocus action
	provider?: string // kilocode_change: For thirdPartyModels
	apiProvider?: string // kilocode_change: For showEditMessageDialog
	apiModelId?: string // kilocode_change: For showEditMessageDialog
	thirdPartySelectedModel?: string // kilocode_change: For showEditMessageDialog
	// kilocode_change: Rules data
	globalRules?: ClineRulesToggles
	localRules?: ClineRulesToggles
	globalWorkflows?: ClineRulesToggles
	localWorkflows?: ClineRulesToggles
	marketplaceItems?: MarketplaceItem[]
	organizationMcps?: MarketplaceItem[]
	marketplaceInstalledMetadata?: MarketplaceInstalledMetadata
	fixedCode?: string | null // For mermaidFixResponse // kilocode_change
	errors?: string[]
	visibility?: ShareVisibility
	rulesFolderPath?: string
	settings?: any
	messageTs?: number
	hasCheckpoint?: boolean
	context?: string
	// forked_change start: Notifications
	notifications?: Array<{
		id: string
		title: string
		message: string
		action?: {
			actionText: string
			actionURL: string
		}
	}>
	// forked_change end
	commands?: Command[]
	queuedMessages?: QueuedMessage[]
	list?: string[] // For dismissedUpsells
	organizationId?: string | null // For organizationSwitchResult
	memories?: MemoryItem[] // kilocode_change: For memories_response
	backgroundCommands?: BackgroundCommandInfo[] // forked_change: for backgroundCommands
}

export type ExtensionState = Pick<
	GlobalSettings,
	| "currentApiConfigName"
	| "listApiConfigMeta"
	| "pinnedApiConfigs"
	// | "lastShownAnnouncementId"
	| "customInstructions"
	// | "taskHistory" // Optional in GlobalSettings, required here.
	| "dismissedUpsells"
	| "autoApprovalEnabled"
	| "yoloMode" // kilocode_change
	| "commandApprovalMode" // forked_change
	| "modelEfforts" // forked_change
	| "alwaysAllowReadOnly"
	| "alwaysAllowReadOnlyOutsideWorkspace"
	| "alwaysAllowWrite"
	| "alwaysAllowWriteOutsideWorkspace"
	| "alwaysAllowWriteProtected"
	// | "writeDelayMs" // Optional in GlobalSettings, required here.
	| "alwaysAllowBrowser"
	| "alwaysApproveResubmit"
	// | "requestDelaySeconds" // Optional in GlobalSettings, required here.
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowFollowupQuestions"
	| "alwaysAllowExecute"
	| "alwaysAllowUpdateTodoList"
	| "followupAutoApproveTimeoutMs"
	| "allowedCommands"
	| "deniedCommands"
	| "allowedMaxRequests"
	| "allowedMaxCost"
	| "browserToolEnabled"
	| "browserViewportSize"
	| "showAutoApproveMenu" // kilocode_change
	| "hideCostBelowThreshold" // kilocode_change
	| "screenshotQuality"
	| "remoteBrowserEnabled"
	| "cachedChromeHostUrl"
	| "remoteBrowserHost"
	// | "enableCheckpoints" // Optional in GlobalSettings, required here.
	| "ttsEnabled"
	| "ttsSpeed"
	| "soundEnabled"
	| "soundVolume"
	// | "maxOpenTabsContext" // Optional in GlobalSettings, required here.
	// | "maxWorkspaceFiles" // Optional in GlobalSettings, required here.
	// | "showRooIgnoredFiles" // Optional in GlobalSettings, required here.
	// | "maxReadFileLine" // Optional in GlobalSettings, required here.
	| "maxConcurrentFileReads" // Optional in GlobalSettings, required here.
	| "allowVeryLargeReads" // kilocode_change
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
	| "diagnosticsEnabled"
	| "diffEnabled"
	| "fuzzyMatchThreshold"
	| "morphApiKey" // kilocode_change: Morph fast apply - global setting
	| "fastApplyModel" // kilocode_change: Fast Apply model selection
	// | "experiments" // Optional in GlobalSettings, required here.
	| "language"
	// | "telemetrySetting" // Optional in GlobalSettings, required here.
	// | "mcpEnabled" // Optional in GlobalSettings, required here.
	// | "enableMcpServerCreation" // Optional in GlobalSettings, required here.
	// | "mode" // Optional in GlobalSettings, required here.
	| "modeApiConfigs"
	// | "customModes" // Optional in GlobalSettings, required here.
	| "customModePrompts"
	| "customSupportPrompts"
	| "enhancementApiConfigId"
	| "localWorkflowToggles" // kilocode_change
	| "globalRulesToggles" // kilocode_change
	| "localRulesToggles" // kilocode_change
	| "globalWorkflowToggles" // kilocode_change
	| "commitMessageApiConfigId" // kilocode_change
	| "terminalCommandApiConfigId" // kilocode_change
	| "dismissedNotificationIds" // kilocode_change
	| "condensingApiConfigId"
	| "customCondensingPrompt"
	| "codebaseIndexConfig"
	| "codebaseIndexModels"
	| "profileThresholds"
	| "systemNotificationsEnabled" // kilocode_change
	| "includeDiagnosticMessages"
	| "maxDiagnosticMessages"
	| "openRouterImageGenerationSelectedModel"
	| "includeTaskHistoryInEnhance"
	| "reasoningBlockCollapsed"
	| "codeReviewSettings"
> & {
	betaModelsEnabled?: boolean // kilocode_change: Beta models availability
	version: string
	clineMessages: ClineMessage[]
	currentTaskId?: string
	currentTaskItem?: HistoryItem
	taskTabs?: Array<{
		taskId: string
		taskLabel: string
		status?: "in_progress" | "completed"
	}>
	currentTaskTodos?: TodoItem[] // Initial todos for the current task
	apiConfiguration: ProviderSettings
	uriScheme?: string
	uiKind?: string // kilocode_change

	kiloCodeWrapperProperties?: KiloCodeWrapperProperties // kilocode_change: Wrapper information

	kilocodeDefaultModel: string
	shouldShowAnnouncement: boolean

	taskHistoryFullLength: number // kilocode_change
	taskHistoryVersion: number // kilocode_change

	writeDelayMs: number
	requestDelaySeconds: number

	contextWindowUsage?: {
		currentTokens: number
		maxTokens: number
		breakdown?: {
			systemPrompt: number
			toolDefinitions: number
			rules: number
			skills: number
			mcp: number
			subagentDefinitions: number
			cacheReads: number
			conversation: number
		}
	} // kilocode_change: Track context window usage

	enableCheckpoints: boolean
	maxOpenTabsContext: number // Maximum number of VSCode open tabs to include in context (0-500)
	maxWorkspaceFiles: number // Maximum number of files to include in current working directory details (0-500)
	showRooIgnoredFiles: boolean // Whether to show .orbitalignore'd files in listings
	maxReadFileLine: number // Maximum number of lines to read from a file before truncating
	showAutoApproveMenu: boolean // kilocode_change: Whether to show the auto-approve menu in the chat view
	maxImageFileSize: number // Maximum size of image files to process in MB
	maxTotalImageSize: number // Maximum total size for all images in a single read operation in MB

	experiments: Experiments // Map of experiment IDs to their enabled state

	mcpEnabled: boolean
	enableMcpServerCreation: boolean

	mode: Mode
	customModes: ModeConfig[]
	toolRequirements?: Record<string, boolean> // Map of tool names to their requirements (e.g. {"file_edit": true} if diffEnabled)

	cwd?: string // Current working directory
	telemetrySetting: TelemetrySetting
	telemetryKey?: string
	machineId?: string

	renderContext: "sidebar" | "editor"
	settingsImportedAt?: number
	historyPreviewCollapsed?: boolean
	showTaskTimeline?: boolean // kilocode_change
	sendMessageOnEnter?: boolean // kilocode_change
	hideCostBelowThreshold?: number // kilocode_change

	cloudUserInfo: CloudUserInfo | null
	cloudIsAuthenticated: boolean
	cloudApiUrl?: string
	cloudOrganizations?: CloudOrganizationMembership[]
	sharingEnabled: boolean
	organizationAllowList: OrganizationAllowList
	organizationSettingsVersion?: number

	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	marketplaceItems?: MarketplaceItem[]
	marketplaceInstalledMetadata?: { project: Record<string, any>; global: Record<string, any> }
	profileThresholds: Record<string, number>
	hasOpenedModeSelector: boolean
	openRouterImageApiKey?: string
	kiloCodeImageApiKey?: string
	openRouterUseMiddleOutTransform?: boolean
	messageQueue?: QueuedMessage[]
	lastShownAnnouncementId?: string
	apiModelId?: string
	mcpServers?: McpServer[]
	hasSystemPromptOverride?: boolean
	mdmCompliant?: boolean
	remoteControlEnabled: boolean
	taskSyncEnabled: boolean
	featureRoomoteControlEnabled: boolean
	showTimestamps?: boolean
	isOrbital?: boolean // kilocode_change: Orbital IDE detection for Agent Manager
}

// kilocode_change: Plan mode implementation
export interface ImplementPlanPayload {
	planFile: string
	planContent: string
}

export interface OpenPlanFilePayload {
	planFile: string
}

export interface ClineSayTool {
	tool:
		| "editedExistingFile"
		| "newFileCreated"
		| "codebaseSearch"
		| "readFile"
		| "fetchInstructions"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "listCodeDefinitionNames"
		| "lsp"
		| "searchFiles"
		| "switchMode"
		| "newTask"
		| "finishTask"
		| "fileEdit"
		| "multiFileEdit"
		| "generateImage"
		| "imageGenerated"
		| "generateFile"
		| "runSlashCommand"
		| "codeReview" // kilocode_change: AI Code Review
		| "checkPastChatMemories" // Chat memories feature
		| "useSkill"
		| "webFetch"
		| "webSearch"
		| "figmaFetch"
		| "executeCommand"
		| "planFileEdit"
		| "checkBackground" // forked_change: background shells
		| "killBackground" // forked_change: background shells
	path?: string
	diff?: string
	content?: string
	regex?: string
	filePattern?: string
	mode?: string
	reason?: string
	isOutsideWorkspace?: boolean
	isProtected?: boolean
	workspace?: string
	additionalFileCount?: number // Number of additional files in same read_file request
	search?: string
	replace?: string
	useRegex?: boolean
	ignoreCase?: boolean
	replaceAll?: boolean
	startLine?: number
	endLine?: number
	lineNumber?: number
	query?: string
	offset?: number
	limit?: number
	// LSP tool properties
	operation?: string
	character?: number
	line?: number
	batchFiles?: Array<{
		path: string
		lineSnippet: string
		isOutsideWorkspace?: boolean
		key: string
		content?: string
		offset?: number
		limit?: number
	}>
	batchDiffs?: Array<{
		path: string
		changeCount: number
		key: string
		content: string
		diffs?: Array<{
			content: string
			startLine?: number
		}>
	}>
	question?: string
	imageData?: string // Base64 encoded image data for generated images
	// Properties for generate_file tool
	fileType?: string
	absolutePath?: string
	mimeType?: string
	bytes?: number
	fileData?: string // Base64-encoded file data, held in memory until user clicks View/Save
	// Properties for runSlashCommand tool
	command?: string
	args?: string
	source?: string
	description?: string
	// Properties for web search tool
	results?: Array<{
		url: string
		title: string
	}>
	// Properties for planFileEdit tool
	filename?: string
}

// Must keep in sync with system prompt.
export const browserActions = [
	"launch",
	"click",
	"hover",
	"type",
	"scroll_down",
	"scroll_up",
	"resize",
	"close",
] as const

export type BrowserAction = (typeof browserActions)[number]

export interface ClineSayBrowserAction {
	action: BrowserAction
	coordinate?: string
	size?: string
	text?: string
}

export type BrowserActionResult = {
	screenshot?: string
	logs?: string
	currentUrl?: string
	currentMousePosition?: string
}

export interface ClineAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
	response?: string
	executionId?: string
}

export interface ClineApiReqInfo {
	request?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	// kilocode_change
	usageMissing?: boolean
	inferenceProvider?: string
	// forked_change end
	cancelReason?: ClineApiReqCancelReason
	streamingFailedMessage?: string
	apiProtocol?: "anthropic" | "openai"
}

export type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled"
