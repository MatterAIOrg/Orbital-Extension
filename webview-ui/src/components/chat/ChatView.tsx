import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import debounce from "debounce"
import { LRUCache } from "lru-cache"
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useDeepCompareEffect, useEvent, useMount } from "react-use"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import removeMd from "remove-markdown"
import useSound from "use-sound"

import { appendImages, normalizeImages } from "@src/utils/imageUtils"
import { useDebounceEffect } from "@src/utils/useDebounceEffect"

import { ImageAttachment } from "@src/components/common/Thumbnails"
import type { ClineAsk, ClineMessage, McpServerUse, PasteChipSerialized } from "@roo-code/types"

import { FollowUpData, SuggestionItem } from "@roo-code/types"

// forked_change start: Local type definitions for Source Control Panel
interface CodeReviewComment {
	path: string
	body: string
	suggestion: string
	startLine: number
	endLine: number
}
// forked_change end
import { findLast } from "@roo/array"
import { combineApiRequests } from "@roo/combineApiRequests"
import { combineCommandSequences } from "@roo/combineCommandSequences"
import { ClineApiReqInfo, ClineSayBrowserAction, ClineSayTool, DocumentAttachment } from "@roo/ExtensionMessage"
import { getApiMetrics } from "@roo/getApiMetrics"
import { McpServer, McpTool } from "@roo/mcp"
import { ProfileValidator } from "@roo/ProfileValidator"
import { safeJsonParse } from "@roo/safeJsonParse"
import { getLatestTodo } from "@roo/todo"
import { PinnedTodoList } from "./PinnedTodoList"
import { AudioType, ProfileData, WebviewMessage } from "@roo/WebviewMessage"

import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	CommandDecision,
	findLongestPrefixMatch,
	getCommandDecision,
	parseCommand,
} from "@src/utils/command-validation"
import { vscode } from "@src/utils/vscode"
// import RooHero from "@src/components/welcome/RooHero" // kilocode_change: unused
// import RooTips from "@src/components/welcome/RooTips" // kilocode_change: unused
import { useAutoApprovalState } from "@src/hooks/useAutoApprovalState"
import { useAutoApprovalToggles } from "@src/hooks/useAutoApprovalToggles"
// import { CloudUpsellDialog } from "@src/components/cloud/CloudUpsellDialog" // kilocode_change: unused

// import TelemetryBanner from "../common/TelemetryBanner" // kilocode_change: deactivated for now
// import VersionIndicator from "../common/VersionIndicator" // kilocode_change: unused
// import { useTaskSearch } from "../history/useTaskSearch" // kilocode_change: unused
import HistoryPreview from "../history/HistoryPreview"
import Announcement from "./Announcement"
import BrowserSessionRow from "./BrowserSessionRow"
import ChatRow from "./ChatRow"
import { ChatTextArea } from "./ChatTextArea"
import OrbitalUpdateBanner from "./OrbitalUpdateBanner"
import { formatMessageWithDocuments } from "../common/DocumentAttachments"
import { BackgroundShells } from "./BackgroundShells"
import ExplorationGroupRow, {
	ExplorationGroup,
	isExplorationRelatedMessage,
	isExplorationToolResult,
} from "./ExplorationGroupRow"
// import TaskHeader from "./TaskHeader"// kilocode_change
import { showSystemNotification } from "@/kilocode/helpers" // kilocode_change
import BottomControls from "../kilocode/BottomControls" // kilocode_change
import KiloTaskHeader from "../kilocode/KiloTaskHeader" // kilocode_change
import StickyUserMessage from "../kilocode/StickyUserMessage" // kilocode_change
import AutoApproveMenu from "./AutoApproveMenu"
import SystemPromptWarning from "./SystemPromptWarning"
// import ProfileViolationWarning from "./ProfileViolationWarning" kilocode_change: unused
import { useOptionalAgentFileViewer } from "../agent/AgentFileViewerContext" // kilocode_change: for agent manager file viewer
import { KilocodeNotifications } from "../kilocode/KilocodeNotifications" // kilocode_change
import { OutOfCreditsBanner } from "../kilocode/chat/OutOfCreditsBanner" // kilocode_change
import { OverageActiveBanner } from "../kilocode/chat/OverageActiveBanner" // kilocode_change
import { CheckpointWarning } from "./CheckpointWarning"
import { QueuedMessages } from "./QueuedMessages"
import { UsageDialog } from "./UsageDialog"
import { SourceControlPanel } from "./SourceControlPanel" // kilocode_change
import ChatTabs, { TabInfo } from "./ChatTabs" // kilocode_change: multi-chat tab bar
// import DismissibleUpsell from "../common/DismissibleUpsell" // kilocode_change: unused
// import { useCloudUpsell } from "@src/hooks/useCloudUpsell" // kilocode_change: unused
// import { Cloud } from "lucide-react" // kilocode_change: unused

export interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	isAgentManagerMode?: boolean
	inputValue: string
	setInputValue: React.Dispatch<React.SetStateAction<string>>
	selectedImages: ImageAttachment[]
	setSelectedImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>
}

export interface ChatViewRef {
	acceptInput: () => void
	focusInput: () => void // kilocode_change
}

export const MAX_IMAGES_PER_MESSAGE = 20 // This is the Anthropic limit.
const NEW_CHAT_TAB_ID = "__new_chat_tab__"

export const shouldEnableCommandApproval = (message: ClineMessage, isPartial: boolean): boolean =>
	!isPartial && message.autoApproved !== true

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0

const ChatViewComponent: React.ForwardRefRenderFunction<ChatViewRef, ChatViewProps> = (
	{
		isHidden,
		showAnnouncement,
		hideAnnouncement,
		isAgentManagerMode,
		inputValue,
		setInputValue,
		selectedImages,
		setSelectedImages,
	},
	ref,
) => {
	const isMountedRef = useRef(true)
	const [selectedDocuments, setSelectedDocuments] = useState<DocumentAttachment[]>([])

	const [audioBaseUri] = useState(() => {
		const w = window as any
		return w.AUDIO_BASE_URI || ""
	})

	const { t } = useAppTranslation()
	const { t: tSettings } = useTranslation("settings")
	const modeShortcutText = `${isMac ? "⌘" : "Ctrl"} + . ${t("chat:forNextMode")}, ${isMac ? "⌘" : "Ctrl"} + Shift + . ${t("chat:forPreviousMode")}`

	const {
		clineMessages: messages,
		currentTaskId,
		currentTaskItem,
		currentTaskTodos,
		taskHistoryFullLength, // kilocode_change
		taskHistoryVersion, // kilocode_change
		apiConfiguration,
		organizationAllowList,
		codeReviewSettings, // kilocode_change
		mcpServers,
		alwaysAllowBrowser,
		alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowExecute,
		alwaysAllowMcp,
		allowedCommands,
		deniedCommands,
		writeDelayMs,
		followupAutoApproveTimeoutMs,
		mode,
		setMode,
		autoApprovalEnabled,
		alwaysAllowModeSwitch,
		showAutoApproveMenu, // kilocode_change
		enableCheckpoints, // kilocode_change
		alwaysAllowSubtasks,
		alwaysAllowFollowupQuestions,
		alwaysAllowUpdateTodoList,
		// telemetrySetting,
		hasSystemPromptOverride,
		historyPreviewCollapsed, // Added historyPreviewCollapsed
		soundEnabled,
		soundVolume,
		// cloudIsAuthenticated, // kilocode_change
		messageQueue = [],
		sendMessageOnEnter, // kilocode_change
		taskTabs,
		cwd,
	} = useExtensionState()

	const isReviewOnlyMode = useMemo(() => {
		const hasEnterpriseHost = !!codeReviewSettings?.enterpriseHost
		const hasEnterpriseApiKey = !!codeReviewSettings?.enterpriseApiKey
		const hasKilocodeToken = !!apiConfiguration?.kilocodeToken

		// Auto-enable review only mode when enterprise credentials are set but no kilocode token
		if (hasEnterpriseHost && hasEnterpriseApiKey && !hasKilocodeToken) {
			return true
		}

		return codeReviewSettings?.reviewOnlyMode || false
	}, [codeReviewSettings, apiConfiguration])

	const messagesRef = useRef(messages)

	useEffect(() => {
		messagesRef.current = messages
	}, [messages])

	// const { tasks } = useTaskSearch() // kilocode_change

	// Initialize expanded state based on the persisted setting (default to expanded if undefined)
	const [isExpanded, setIsExpanded] = useState(
		historyPreviewCollapsed === undefined ? true : !historyPreviewCollapsed,
	)

	const _toggleExpanded = useCallback(() => {
		const newState = !isExpanded
		setIsExpanded(newState)
		// Send message to extension to persist the new collapsed state
		vscode.postMessage({ type: "setHistoryPreviewCollapsed", bool: !newState })
	}, [isExpanded])

	// Leaving this less safe version here since if the first message is not a
	// task, then the extension is in a bad state and needs to be debugged (see
	// Cline.abort).
	const task = useMemo(() => messages.at(0), [messages])

	const latestTodos = useMemo(() => {
		// First check if we have initial todos from the state (for new subtasks)
		if (currentTaskTodos && currentTaskTodos.length > 0) {
			// Check if there are any todo updates in messages
			const messageBasedTodos = getLatestTodo(messages)
			// If there are message-based todos, they take precedence (user has updated them)
			if (messageBasedTodos && messageBasedTodos.length > 0) {
				return messageBasedTodos
			}
			// Otherwise use the initial todos from state
			return currentTaskTodos
		}
		// Fall back to extracting from messages
		return getLatestTodo(messages)
	}, [messages, currentTaskTodos])

	const modifiedMessages = useMemo(() => combineApiRequests(combineCommandSequences(messages.slice(1))), [messages])
	const lastModifiedMessage = useMemo(() => modifiedMessages.at(-1), [modifiedMessages])

	// Has to be after api_req_finished are all reduced into api_req_started messages.
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	const inputValueRef = useRef(inputValue)
	const textAreaRef = useRef<HTMLDivElement>(null)
	const [sendingDisabled, setSendingDisabled] = useState(false)

	// we need to hold on to the ask because useEffect > lastMessage will always let us know when an ask comes in and handle it, but by the time handleMessage is called, the last message might not be the ask anymore (it could be a say that followed)
	const [clineAsk, setClineAsk] = useState<ClineAsk | undefined>(undefined)
	const [enableButtons, setEnableButtons] = useState<boolean>(false)
	const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>(undefined)
	const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>(undefined)
	const [_didClickCancel, setDidClickCancel] = useState(false)
	const virtuosoRef = useRef<VirtuosoHandle>(null)
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const prevExpandedRowsRef = useRef<Record<number, boolean>>()
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const disableAutoScrollRef = useRef(false)
	const [showScrollToBottom, _setShowScrollToBottom] = useState(true)
	const [isAtBottom, setIsAtBottom] = useState(false)
	const lastTtsRef = useRef<string>("")
	const [wasStreaming, setWasStreaming] = useState<boolean>(false)
	const [showCheckpointWarning, setShowCheckpointWarning] = useState<boolean>(false)
	const [isCondensing, setIsCondensing] = useState<boolean>(false)
	const [showAnnouncementModal, setShowAnnouncementModal] = useState(false)
	const [showUsageModal, setShowUsageModal] = useState(false)
	// forked_change start: AI Code Review state
	const [showSourceControl, setShowSourceControl] = useState(isReviewOnlyMode)
	const [codeReviewResults, setCodeReviewResults] = useState<{
		reviewBody: string
		reviewComments: CodeReviewComment[]
	} | null>(null)
	const [codeReviewError, setCodeReviewError] = useState<string | null>(null)
	const [_pendingFileEdits, setPendingFileEdits] = useState<any[]>([])
	const [_gitChangesForReview, setGitChangesForReview] = useState<any[]>([]) // Git changes for code review
	const [isCodeReviewLoading, setIsCodeReviewLoading] = useState(false)
	const [_hasUnreviewedChanges, setHasUnreviewedChanges] = useState(false)
	// Store code review results in memory for later access
	const [_storedCodeReviewResults, setStoredCodeReviewResults] = useState<{
		reviewBody: string
		reviewComments: CodeReviewComment[]
	} | null>(null)
	// forked_change end
	const everVisibleMessagesTsRef = useRef<LRUCache<number, boolean>>(
		new LRUCache({
			max: 100,
			ttl: 1000 * 60 * 5,
		}),
	)
	const autoApproveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const userRespondedRef = useRef<boolean>(false)
	const [currentFollowUpTs, setCurrentFollowUpTs] = useState<number | null>(null)
	// forked_change start: Sticky user message state
	const [stickyMessageIndex, setStickyMessageIndex] = useState<number | null>(null)
	const stickyMessageIndexRef = useRef<number | null>(null)
	const stickyHeaderRef = useRef<HTMLDivElement | null>(null)
	const virtuosoScrollerRef = useRef<HTMLElement | null>(null)
	const [stickyHeaderHeight, setStickyHeaderHeight] = useState(0)
	// forked_change end
	const [iconsBaseUri] = useState(() => {
		const w = window as any
		return w.ICONS_BASE_URI || ""
	})

	// Marketing card rotation state
	const [activeMarketingCard, setActiveMarketingCard] = useState(0)

	// kilocode_change: Profile data state for usage tracking
	const [profileData, setProfileData] = useState<ProfileData | null>(null)

	// kilocode_change: Agent file viewer state for conditional margin
	const optionalAgentFileViewer = useOptionalAgentFileViewer()
	const isAgentFileViewerOpen =
		isAgentManagerMode &&
		optionalAgentFileViewer &&
		(Boolean(optionalAgentFileViewer.fileViewerState) || optionalAgentFileViewer.pendingDiffFiles.length > 0)

	// Fetch profile data for usage tracking
	useEffect(() => {
		if (apiConfiguration?.kilocodeToken) {
			vscode.postMessage({ type: "fetchProfileDataRequest" })
		}
	}, [apiConfiguration?.kilocodeToken])

	// Listen for profile data response
	useEffect(() => {
		const handleMessage = (event: MessageEvent<WebviewMessage>) => {
			const message = event.data
			if (message.type === "profileDataResponse") {
				const payload = message.payload as any
				if (payload?.success && payload.data) {
					setProfileData(payload.data)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	// Rotate marketing cards every 10 seconds
	useEffect(() => {
		const interval = setInterval(() => {
			setActiveMarketingCard((prev) => (prev + 1) % 2)
		}, 10000)
		return () => clearInterval(interval)
	}, [])

	// Check if usage is over 98% (near exhaustion warning)
	const isUsageExhausted =
		profileData && typeof profileData.usagePercentage === "number" && profileData.usagePercentage >= 98

	const clineAskRef = useRef(clineAsk)
	useEffect(() => {
		clineAskRef.current = clineAsk
	}, [clineAsk])

	// forked_change start: unused
	// const {
	// 	isOpen: isUpsellOpen,
	// 	openUpsell,
	// 	closeUpsell,
	// 	handleConnect,
	// } = useCloudUpsell({
	// 	autoOpenOnAuth: false,
	// })
	// forked_change end

	// Keep inputValueRef in sync with inputValue state
	useEffect(() => {
		inputValueRef.current = inputValue
	}, [inputValue])

	useEffect(() => {
		isMountedRef.current = true
		return () => {
			isMountedRef.current = false
		}
	}, [])

	const isProfileDisabled = useMemo(
		() => !!apiConfiguration && !ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList),
		[apiConfiguration, organizationAllowList],
	)

	// UI layout depends on the last 2 messages
	// (since it relies on the content of these messages, we are deep comparing. i.e. the button state after hitting button sets enableButtons to false, and this effect otherwise would have to true again even if messages didn't change
	const lastMessage = useMemo(() => messages.at(-1), [messages])
	const secondLastMessage = useMemo(() => messages.at(-2), [messages])

	// Setup sound hooks with use-sound
	const volume = typeof soundVolume === "number" ? soundVolume : 0.5
	const soundConfig = {
		volume,
		// useSound expects 'disabled' property, not 'soundEnabled'
		soundEnabled,
	}

	const getAudioUrl = (path: string) => `${audioBaseUri}/${path}`

	// Use the getAudioUrl helper function
	const [playNotification] = useSound(getAudioUrl("notification.wav"), soundConfig)
	const [playCelebration] = useSound(getAudioUrl("celebration.wav"), soundConfig)
	const [playProgressLoop] = useSound(getAudioUrl("progress_loop.wav"), soundConfig)

	function playSound(audioType: AudioType) {
		// Play the appropriate sound based on type
		// The disabled state is handled by the useSound hook configuration
		switch (audioType) {
			case "notification":
				playNotification()
				break
			case "celebration":
				playCelebration()
				break
			case "progress_loop":
				playProgressLoop()
				break
			default:
				console.warn(`Unknown audio type: ${audioType}`)
		}
	}

	function playTts(text: string) {
		vscode.postMessage({ type: "playTts", text })
	}

	useEffect(() => {
		if (isReviewOnlyMode) {
			setShowSourceControl(true)
		}
	}, [isReviewOnlyMode])

	useDeepCompareEffect(() => {
		// if last message is an ask, show user ask UI
		// if user finished a task, then start a new task with a new conversation history since in this moment that the extension is waiting for user response, the user could close the extension and the conversation history would be lost.
		// basically as long as a task is active, the conversation history will be persisted
		if (lastMessage) {
			switch (lastMessage.type) {
				case "ask":
					// Reset user response flag when a new ask arrives to allow auto-approval
					userRespondedRef.current = false
					const isPartial = lastMessage.partial === true
					switch (lastMessage.ask) {
						case "api_req_failed":
							playSound("progress_loop")
							setSendingDisabled(true)
							setClineAsk("api_req_failed")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:retry.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "mistake_limit_reached":
							playSound("progress_loop")
							setSendingDisabled(false)
							setClineAsk("mistake_limit_reached")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:proceedAnyways.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "followup":
							if (!isPartial) {
								playSound("notification")
							}
							setSendingDisabled(isPartial)
							setClineAsk("followup")
							// setting enable buttons to `false` would trigger a focus grab when
							// the text area is enabled which is undesirable.
							// We have no buttons for this tool, so no problem having them "enabled"
							// to workaround this issue.  See #1358.
							setEnableButtons(true)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							break
						case "tool":
							if (!isAutoApproved(lastMessage) && !isPartial) {
								playSound("notification")
								showSystemNotification(t("kilocode:notifications.toolRequest")) // kilocode_change
							}
							setSendingDisabled(isPartial)
							setClineAsk("tool")
							setEnableButtons(!isPartial)
							const tool = JSON.parse(lastMessage.text || "{}") as ClineSayTool
							switch (tool.tool) {
								case "editedExistingFile":
								case "newFileCreated":
								case "generateImage":
								case "generateFile":
									setPrimaryButtonText(t("chat:save.title"))
									setSecondaryButtonText(t("chat:reject.title"))
									break
								case "finishTask":
									setPrimaryButtonText(t("chat:completeSubtaskAndReturn"))
									setSecondaryButtonText(undefined)
									break
								case "readFile":
									if (tool.batchFiles && Array.isArray(tool.batchFiles)) {
										setPrimaryButtonText(t("chat:read-batch.approve.title"))
										setSecondaryButtonText(t("chat:read-batch.deny.title"))
									} else {
										setPrimaryButtonText(t("chat:approve.title"))
										setSecondaryButtonText(t("chat:reject.title"))
									}
									break
								default:
									setPrimaryButtonText(t("chat:approve.title"))
									setSecondaryButtonText(t("chat:reject.title"))
									break
							}
							break
						case "browser_action_launch":
							if (!isAutoApproved(lastMessage) && !isPartial) {
								playSound("notification")
								showSystemNotification(t("kilocode:notifications.browserAction")) // kilocode_change
							}
							setSendingDisabled(isPartial)
							setClineAsk("browser_action_launch")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("chat:approve.title"))
							setSecondaryButtonText(t("chat:reject.title"))
							break
						case "command":
							if (!lastMessage.autoApproved && !isAutoApproved(lastMessage) && !isPartial) {
								playSound("notification")
								showSystemNotification(t("kilocode:notifications.command")) // kilocode_change
							}
							setSendingDisabled(isPartial)
							setClineAsk("command")
							// Auto-approved commands remain visible as compact execution rows, but must
							// never enter the approval UI. The extension sets this flag before posting
							// the message for both safe "Approve for me" commands and every command in
							// "Full access" mode, so this also prevents a one-frame approval flash.
							setEnableButtons(shouldEnableCommandApproval(lastMessage, isPartial))
							setPrimaryButtonText(t("chat:runCommand.title"))
							setSecondaryButtonText(t("chat:reject.title"))
							break
						case "command_output":
							// setSendingDisabled(false)
							setClineAsk("command_output")
							// setEnableButtons(false)
							// setPrimaryButtonText(t("chat:proceedWhileRunning.title"))
							// setSecondaryButtonText(t("chat:killCommand.title"))
							break
						case "use_mcp_server":
							if (!isAutoApproved(lastMessage) && !isPartial) {
								playSound("notification")
							}
							setSendingDisabled(isPartial)
							setClineAsk("use_mcp_server")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("chat:runCommand.title"))
							setSecondaryButtonText(t("chat:reject.title"))
							break
						case "completion_result":
							// extension waiting for feedback. but we can just present a new task button
							if (!isPartial) {
								playSound("celebration")
							}
							setSendingDisabled(isPartial)
							setClineAsk("completion_result")
							setEnableButtons(!isPartial)
							// setPrimaryButtonText(t("chat:startNewTask.title"))
							setSecondaryButtonText(undefined)
							break
						case "resume_task":
							setSendingDisabled(false)
							setClineAsk("resume_task")
							// setEnableButtons(true)
							// 	setPrimaryButtonText(t("chat:resumeTask.title"))
							// 	setSecondaryButtonText(t("chat:terminate.title"))
							// 	setDidClickCancel(false) // special case where we reset the cancel button state
							break
						case "resume_completed_task":
							setSendingDisabled(false)
							setClineAsk("resume_completed_task")
							// setEnableButtons(true)
							// 	setPrimaryButtonText(t("chat:startNewTask.title"))
							// 	setSecondaryButtonText(undefined)
							// 	setDidClickCancel(false)
							break
						// kilocode_change begin
						case "report_bug":
							if (!isPartial) {
								playSound("notification")
							}
							setSendingDisabled(isPartial)
							setClineAsk("report_bug")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("chat:reportBug.title"))
							break
						case "condense":
							setSendingDisabled(isPartial)
							setClineAsk("condense")
							setEnableButtons(!isPartial)
							setPrimaryButtonText(t("kilocode:chat.condense.condenseConversation"))
							setSecondaryButtonText(undefined)
							break
						// forked_change end
					}
					break
				case "say":
					// Don't want to reset since there could be a "say" after
					// an "ask" while ask is waiting for response.
					switch (lastMessage.say) {
						case "api_req_retry_delayed":
							setSendingDisabled(true)
							break
						case "api_req_started":
							if (secondLastMessage?.ask === "command_output") {
								setSendingDisabled(true)
								setSelectedImages([])
								setClineAsk(undefined)
								setEnableButtons(false)
							}
							break
						case "api_req_finished":
						case "error":
						case "text":
							setSendingDisabled(false)
							break
						case "browser_action":
						case "browser_action_result":
						case "command_output":
						case "mcp_server_request_started":
						case "mcp_server_response":
						case "completion_result":
							break
						default:
							setSendingDisabled(false)
							break
					}
					break
			}
		}
	}, [lastMessage, secondLastMessage])

	useEffect(() => {
		if (messages.length === 0) {
			setSendingDisabled(false)
			setClineAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
		}
	}, [messages.length])

	useEffect(() => {
		// Reset UI states
		setExpandedRows({})
		everVisibleMessagesTsRef.current.clear() // Clear for new task
		setCurrentFollowUpTs(null) // Clear follow-up answered state for new task
		setIsCondensing(false) // Reset condensing state when switching tasks
		// Note: sendingDisabled is not reset here as it's managed by message effects

		// Clear any pending auto-approval timeout from previous task
		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		// Reset user response flag for new task
		userRespondedRef.current = false
	}, [task?.ts])

	useEffect(() => {
		if (isHidden) {
			everVisibleMessagesTsRef.current.clear()
		}
	}, [isHidden])

	useEffect(() => {
		const cache = everVisibleMessagesTsRef.current
		return () => {
			cache.clear()
		}
	}, [])

	useEffect(() => {
		const prev = prevExpandedRowsRef.current
		let wasAnyRowExpandedByUser = false
		if (prev) {
			// Check if any row transitioned from false/undefined to true
			for (const [tsKey, isExpanded] of Object.entries(expandedRows)) {
				const ts = Number(tsKey)
				if (isExpanded && !(prev[ts] ?? false)) {
					wasAnyRowExpandedByUser = true
					break
				}
			}
		}

		if (wasAnyRowExpandedByUser) {
			disableAutoScrollRef.current = true
		}
		prevExpandedRowsRef.current = expandedRows // Store current state for next comparison
	}, [expandedRows])

	const isStreaming = useMemo(() => {
		// Checking clineAsk isn't enough since messages effect may be called
		// again for a tool for example, set clineAsk to its value, and if the
		// next message is not an ask then it doesn't reset. This is likely due
		// to how much more often we're updating messages as compared to before,
		// and should be resolved with optimizations as it's likely a rendering
		// bug. But as a final guard for now, the cancel button will show if the
		// last message is not an ask.
		const isLastAsk = !!modifiedMessages.at(-1)?.ask

		const isToolCurrentlyAsking =
			isLastAsk && clineAsk !== undefined && enableButtons && primaryButtonText !== undefined

		if (isToolCurrentlyAsking) {
			return false
		}

		const isLastMessagePartial = modifiedMessages.at(-1)?.partial === true

		if (isLastMessagePartial) {
			return true
		} else {
			const lastApiReqStarted = findLast(
				modifiedMessages,
				(message: ClineMessage) => message.say === "api_req_started",
			)

			if (
				lastApiReqStarted &&
				lastApiReqStarted.text !== null &&
				lastApiReqStarted.text !== undefined &&
				lastApiReqStarted.say === "api_req_started"
			) {
				const cost = JSON.parse(lastApiReqStarted.text).cost

				if (cost === undefined) {
					return true // API request has not finished yet.
				}
			}
		}

		return false
	}, [modifiedMessages, clineAsk, enableButtons, primaryButtonText])

	// kilocode_change: multi-chat tab bar — derive label for the active (foreground) tab
	const currentTabLabel = useMemo(() => {
		if (!task) return null
		const rawTitle = currentTaskItem?.title || (task as any)?.title
		if (rawTitle && typeof rawTitle === "string" && rawTitle.trim()) {
			const trimmed = rawTitle.trim()
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					const parsed = JSON.parse(trimmed)
					if (
						typeof parsed === "object" &&
						parsed !== null &&
						typeof (parsed as { title?: unknown }).title === "string"
					) {
						return (parsed as { title: string }).title
					}
				} catch {
					// fall through to raw title
				}
			}
			return trimmed
		}
		const firstUserMsg = messages.find((m) => m.type === "say" && m.say === "user_feedback")
		if (firstUserMsg?.text) return firstUserMsg.text
		return "New Agent"
	}, [task, currentTaskItem, messages])

	const currentTabId = currentTaskId ?? currentTaskItem?.id ?? null
	const [tabOrder, setTabOrder] = useState<string[]>([])
	const [pendingNewTabFromId, setPendingNewTabFromId] = useState<string | null | undefined>(undefined)

	const handleAddTab = useCallback(() => {
		setPendingNewTabFromId((previous) => (previous === undefined ? currentTabId : previous))
		setTabOrder((prev) => {
			const withCurrent = currentTabId && !prev.includes(currentTabId) ? [...prev, currentTabId] : [...prev]
			return withCurrent.includes(NEW_CHAT_TAB_ID) ? withCurrent : [...withCurrent, NEW_CHAT_TAB_ID]
		})
		vscode.postMessage({ type: "plusButtonClicked" })
	}, [currentTabId])

	const handleSelectTab = useCallback((taskId: string) => {
		if (taskId === NEW_CHAT_TAB_ID) {
			textAreaRef.current?.focus()
			return
		}

		setPendingNewTabFromId(undefined)
		setTabOrder((prev) => prev.filter((id) => id !== NEW_CHAT_TAB_ID))
		vscode.postMessage({ type: "switchTask", taskId })
	}, [])

	const handleCloseTab = useCallback((taskId: string) => {
		setTabOrder((prev) => prev.filter((id) => id !== taskId))
		if (taskId !== NEW_CHAT_TAB_ID) {
			vscode.postMessage({ type: "closeTask", taskId })
		} else {
			setPendingNewTabFromId(undefined)
		}
	}, [])

	useEffect(() => {
		const incomingIds = (taskTabs ?? []).map((tab) => tab.taskId)
		const incomingSet = new Set(incomingIds)

		setTabOrder((prev) => {
			let next = prev.filter(
				(id) => id === NEW_CHAT_TAB_ID || incomingSet.has(id) || (currentTabId !== null && id === currentTabId),
			)

			if (currentTabId !== null) {
				const hasNewChatTab = next.includes(NEW_CHAT_TAB_ID)
				const hasCurrentTab = next.includes(currentTabId)

				if (hasNewChatTab) {
					if (hasCurrentTab) {
						// Current task is already in tab order, remove the pending new chat tab
						next = next.filter((id) => id !== NEW_CHAT_TAB_ID)
					} else {
						// Replace the pending new chat tab with the current task
						const newTabIndex = next.indexOf(NEW_CHAT_TAB_ID)
						next[newTabIndex] = currentTabId
					}
				} else if (!hasCurrentTab) {
					next.push(currentTabId)
				}
			}

			for (const taskId of incomingIds) {
				if (!next.includes(taskId)) {
					next.push(taskId)
				}
			}

			return next
		})

		if (currentTabId !== null && pendingNewTabFromId !== undefined) {
			setPendingNewTabFromId(undefined)
		}
	}, [taskTabs, currentTabId, pendingNewTabFromId])

	// Build the unified tabs list: one entry per ID in tabOrder, with label/active/status.
	// Keep the local order stable while the extension updates task metadata.
	const unifiedTabs = useMemo<TabInfo[]>(() => {
		const taskById = new Map((taskTabs ?? []).map((tab) => [tab.taskId, tab]))
		return tabOrder.map((id) => {
			const isNewTab = id === NEW_CHAT_TAB_ID
			const isActive = id === currentTabId || (isNewTab && !currentTabId)
			if (isNewTab) {
				return { taskId: id, label: "New Agent", isActive: true }
			}
			if (isActive) {
				return {
					taskId: id,
					label: currentTabLabel ?? taskById.get(id)?.taskLabel ?? "New Agent",
					isActive: true,
					status: taskById.get(id)?.status,
				}
			}
			const taskTab = taskById.get(id)
			if (!taskTab) {
				return { taskId: id, label: "New Agent", isActive: false }
			}
			return {
				taskId: id,
				label: taskTab.taskLabel ?? "New Agent",
				isActive: false,
				status: taskTab.status,
			}
		})
	}, [tabOrder, currentTabId, currentTabLabel, taskTabs])

	const handleReorderTabs = useCallback((newOrder: string[]) => {
		setTabOrder(newOrder)
	}, [])

	const markFollowUpAsAnswered = useCallback(() => {
		const lastFollowUpMessage = messagesRef.current.findLast((msg: ClineMessage) => msg.ask === "followup")
		if (lastFollowUpMessage) {
			setCurrentFollowUpTs(lastFollowUpMessage.ts)
		}
	}, [])

	const handleChatReset = useCallback(() => {
		// Clear any pending auto-approval timeout
		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		// Reset user response flag for new message
		userRespondedRef.current = false

		// Only reset message-specific state, preserving mode.
		setInputValue("")
		setSendingDisabled(true)
		setSelectedImages([])
		setSelectedDocuments([])
		setClineAsk(undefined)
		setEnableButtons(false)
		// Do not reset mode here as it should persist.
		// setPrimaryButtonText(undefined)
		// setSecondaryButtonText(undefined)
		disableAutoScrollRef.current = false
	}, [setInputValue, setSelectedImages])

	/**
	 * Handles sending messages to the extension
	 * @param text - The message text to send
	 * @param images - Array of image data URLs to send with the message
	 * @param pasteChips - Optional paste chips captured by the composer that
	 * should be persisted on the outgoing message so the chat history can
	 * render them in user messages and the sticky user message.
	 */
	const handleSendMessage = useCallback(
		(text: string, images: ImageAttachment[], pasteChips?: PasteChipSerialized[]) => {
			if (text.trim() === "/usage" || text.trim().startsWith("/usage ")) {
				setShowUsageModal(true)
				setInputValue("")
				return
			}
			text = formatMessageWithDocuments(text, selectedDocuments)
			const imageDataUrls = images.map((img) => img.dataUrl)
			const payloadChips = pasteChips && pasteChips.length > 0 ? pasteChips : undefined
			if (text || imageDataUrls.length > 0) {
				if (sendingDisabled || isStreaming) {
					try {
						vscode.postMessage({
							type: "queueMessage",
							text,
							images: imageDataUrls,
							pasteChips: payloadChips,
						})
						setInputValue("")
						setSelectedImages([])
						setSelectedDocuments([])
					} catch (error) {
						console.error(
							`Failed to queue message: ${error instanceof Error ? error.message : String(error)}`,
						)
					}

					return
				}

				// Mark that user has responded - this prevents any pending auto-approvals.
				userRespondedRef.current = true

				if (messagesRef.current.length === 0) {
					vscode.postMessage({
						type: "newTask",
						text,
						images: imageDataUrls,
						pasteChips: payloadChips,
					})
				} else if (clineAskRef.current) {
					if (clineAskRef.current === "followup") {
						markFollowUpAsAnswered()
					}

					// Use clineAskRef.current
					switch (
						clineAskRef.current // Use clineAskRef.current
					) {
						case "followup":
						case "command_output": // User can send input to command stdin.
						case "completion_result": // If this happens then the user has feedback for the completion result.
						case "resume_task":
						case "resume_completed_task":
						case "mistake_limit_reached":
							vscode.postMessage({
								type: "askResponse",
								askResponse: "messageResponse",
								text,
								images: imageDataUrls,
								pasteChips: payloadChips,
							})
							break
						case "tool":
						case "browser_action_launch":
						case "command": // User can provide feedback to a tool or command use.
						case "use_mcp_server":
							vscode.postMessage({
								type: "askResponse",
								askResponse: "noButtonClicked",
								text,
								images: imageDataUrls,
								pasteChips: payloadChips,
							})
							break
						// There is no other case that a textfield should be enabled.
					}
				} else {
					// This is a new message in an ongoing task.
					vscode.postMessage({
						type: "askResponse",
						askResponse: "messageResponse",
						text,
						images: imageDataUrls,
						pasteChips: payloadChips,
					})
				}

				handleChatReset()
			}
		},
		[
			handleChatReset,
			markFollowUpAsAnswered,
			sendingDisabled,
			isStreaming,
			setInputValue,
			setSelectedImages,
			selectedDocuments,
		], // messagesRef and clineAskRef are stable
	)

	const handleSetChatBoxMessage = useCallback(
		(text: string, images: ImageAttachment[]) => {
			// Avoid nested template literals by breaking down the logic
			let newValue = text

			if (inputValue !== "") {
				newValue = inputValue + " " + text
			}

			// Add a space after the chip so cursor can be positioned after it
			if (!newValue.endsWith(" ")) {
				newValue += " "
			}

			setInputValue(newValue)
			setSelectedImages([...selectedImages, ...images])
		},
		[inputValue, selectedImages, setInputValue, setSelectedImages],
	)

	const startNewTask = useCallback(() => vscode.postMessage({ type: "clearTask" }), [])

	// This logic depends on the useEffect[messages] above to set clineAsk,
	// after which buttons are shown and we then send an askResponse to the
	// extension.
	const handlePrimaryButtonClick = useCallback(
		(text?: string, images?: ImageAttachment[], pasteChips?: PasteChipSerialized[]) => {
			// Mark that user has responded
			userRespondedRef.current = true

			const trimmedInput = formatMessageWithDocuments(text ?? "", selectedDocuments)
			const payloadChips = pasteChips && pasteChips.length > 0 ? pasteChips : undefined

			switch (clineAsk) {
				case "api_req_failed":
				case "command":
				case "tool":
				case "browser_action_launch":
				case "use_mcp_server":
				case "resume_task":
				case "mistake_limit_reached":
				case "report_bug":
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
							text: trimmedInput,
							images: images?.map((img) => img.dataUrl),
							pasteChips: payloadChips,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
						setSelectedDocuments([])
					} else {
						vscode.postMessage({ type: "askResponse", askResponse: "yesButtonClicked" })
					}
					break
				case "completion_result":
				case "resume_completed_task":
					// Waiting for feedback, but we can just present a new task button
					startNewTask()
					break
				case "command_output":
					vscode.postMessage({ type: "terminalOperation", terminalOperation: "continue" })
					break
				// forked_change start
				case "condense":
					vscode.postMessage({
						type: "condense",
						text: lastMessage?.text,
					})
					break
				// forked_change end
			}

			setSendingDisabled(true)
			setClineAsk(undefined)
			setEnableButtons(false)
		},
		[clineAsk, startNewTask, lastMessage?.text, setInputValue, setSelectedImages, selectedDocuments], // kilocode_change: add lastMessage?.text
	)

	const handleSecondaryButtonClick = useCallback(
		(text?: string, images?: ImageAttachment[], pasteChips?: PasteChipSerialized[]) => {
			// Mark that user has responded
			userRespondedRef.current = true

			const trimmedInput = formatMessageWithDocuments(text ?? "", selectedDocuments)
			const payloadChips = pasteChips && pasteChips.length > 0 ? pasteChips : undefined

			if (isStreaming) {
				vscode.postMessage({ type: "cancelTask" })
				setDidClickCancel(true)
				// Reset sendingDisabled so subsequent messages are sent directly instead of queued
				setSendingDisabled(false)
				return
			}

			switch (clineAsk) {
				case "api_req_failed":
				case "mistake_limit_reached":
				case "resume_task":
					startNewTask()
					break
				case "command":
				case "tool":
				case "browser_action_launch":
				case "use_mcp_server":
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							text: trimmedInput,
							images: images?.map((img) => img.dataUrl),
							pasteChips: payloadChips,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
						setSelectedDocuments([])
					} else {
						// Responds to the API with a "This operation failed" and lets it try again
						vscode.postMessage({ type: "askResponse", askResponse: "noButtonClicked" })
					}
					break
				case "command_output":
					vscode.postMessage({ type: "terminalOperation", terminalOperation: "abort" })
					// Reset sendingDisabled so subsequent messages are sent directly instead of queued
					setSendingDisabled(false)
					break
			}
			// Only set sendingDisabled to true for cases that need it (not for command_output abort or tool/command rejection)
			// When rejecting a tool/command, we don't want to block subsequent messages
			if (
				clineAsk !== "command_output" &&
				clineAsk !== "command" &&
				clineAsk !== "tool" &&
				clineAsk !== "browser_action_launch" &&
				clineAsk !== "use_mcp_server"
			) {
				setSendingDisabled(true)
			}
			setClineAsk(undefined)
			setEnableButtons(false)
		},
		[clineAsk, startNewTask, isStreaming, setInputValue, setSelectedImages, selectedDocuments],
	)

	const handleTaskCloseButtonClick = useCallback(() => startNewTask(), [startNewTask]) // kilocode_change

	const { info: model } = useSelectedModel(apiConfiguration)

	const selectAttachments = useCallback(() => vscode.postMessage({ type: "selectAttachments" }), [])

	const shouldDisableImages = !model?.supportsImages || selectedImages.length >= MAX_IMAGES_PER_MESSAGE

	// forked_change start: AI Code Review handlers
	const _handleRequestCodeReview = useCallback(() => {
		setIsCodeReviewLoading(true)
		vscode.postMessage({ type: "requestCodeReview" })
	}, [])

	const _handleRefreshPendingEdits = useCallback(() => {
		vscode.postMessage({ type: "getPendingFileEdits" })
	}, [])

	const handleRunCodeReview = useCallback(() => {
		setIsCodeReviewLoading(true)
		setCodeReviewError(null) // Clear previous errors
		vscode.postMessage({ type: "requestCodeReview" })
	}, [])

	const _handleApplyCodeReviewFix = useCallback(
		(fixIndex: number) => {
			if (!codeReviewResults || !codeReviewResults.reviewComments[fixIndex]) return
			const comment = codeReviewResults.reviewComments[fixIndex]
			vscode.postMessage({
				type: "applyCodeReviewFix",
				payload: { fixIndex, comment },
			})
			// Refresh pending edits to get updated state after applying fix
			setTimeout(() => {
				vscode.postMessage({ type: "getPendingFileEdits" })
			}, 500)
		},
		[codeReviewResults],
	)

	const _handleApplyAllCodeReviewFixes = useCallback(() => {
		if (!codeReviewResults) return
		vscode.postMessage({
			type: "applyAllCodeReviewFixes",
			payload: {
				fixIndices: codeReviewResults.reviewComments.map((_, i) => i),
				comments: codeReviewResults.reviewComments,
			},
		})
		setShowSourceControl(false)
		setCodeReviewResults(null)
		// Clear unreviewed changes flag since all fixes were applied
		setHasUnreviewedChanges(false)
	}, [codeReviewResults])

	const _handleCloseSourceControl = useCallback(() => {
		setShowSourceControl(false)
		// Don't clear code review results - keep them in memory for later access
	}, [])
	// forked_change end

	const handleMessage = useCallback(
		(e: MessageEvent) => {
			const message = e.data as any // kilocode_change: Type assertion for new message types

			switch (message.type) {
				case "action":
					switch (message.action!) {
						case "didBecomeVisible":
							// Only focus if the webview already has focus (user is interacting with it)
							// Don't steal focus from IDE editor
							if (!isHidden && !sendingDisabled && !enableButtons && document.hasFocus()) {
								textAreaRef.current?.focus()
							}
							break
						case "focusInput":
							textAreaRef.current?.focus()
							break
					}
					break
				case "selectedImages":
					// Only handle selectedImages if it's not for editing context
					// When context is "edit", ChatRow will handle the images
					if (message.context !== "edit") {
						setSelectedImages((prevImages: ImageAttachment[]) =>
							appendImages(prevImages, normalizeImages(message.images), MAX_IMAGES_PER_MESSAGE),
						)
					}
					break
				case "selectedAttachments":
					if (model?.supportsImages) {
						setSelectedImages((prevImages: ImageAttachment[]) =>
							appendImages(prevImages, normalizeImages(message.images), MAX_IMAGES_PER_MESSAGE),
						)
					} else if (message.images?.length) {
						vscode.postMessage({
							type: "showToast",
							toastType: "warning",
							toastMessage: t("kilocode:imageWarnings.modelNoImageSupport"),
						})
					}
					setSelectedDocuments((currentDocuments) => {
						const nextDocuments = [...currentDocuments]
						let characterCount = currentDocuments.reduce(
							(total, document) => total + document.text.length,
							0,
						)
						for (const document of (message.documents ?? []) as DocumentAttachment[]) {
							if (nextDocuments.length >= 10 || characterCount + document.text.length > 500_000) {
								break
							}
							nextDocuments.push(document)
							characterCount += document.text.length
						}
						return nextDocuments
					})
					break
				case "invoke":
					switch (message.invoke!) {
						case "newChat":
							handleChatReset()
							break
						case "sendMessage":
							handleSendMessage(message.text ?? "", normalizeImages(message.images), message.pasteChips)
							break
						case "setChatBoxMessage":
							handleSetChatBoxMessage(message.text ?? "", normalizeImages(message.images))
							break
						case "primaryButtonClick":
							handlePrimaryButtonClick(
								message.text ?? "",
								normalizeImages(message.images),
								message.pasteChips,
							)
							break
						case "secondaryButtonClick":
							handleSecondaryButtonClick(
								message.text ?? "",
								normalizeImages(message.images),
								message.pasteChips,
							)
							break
					}
					break
				case "condenseTaskContextResponse":
					if (message.text && message.text === currentTaskItem?.id) {
						if (isCondensing && sendingDisabled) {
							setSendingDisabled(false)
						}
						setIsCondensing(false)
					}
					break
				// forked_change start: AI Code Review message handling
				case "codeReviewResults":
					setIsCodeReviewLoading(false)
					if (message.payload) {
						// Check if the payload contains an error message
						const errorMessage = message.payload.reviewBody?.startsWith("Code review failed:")
							? message.payload.reviewBody
							: null

						if (errorMessage) {
							// This is an error, not a successful result
							setCodeReviewError(errorMessage)
							setCodeReviewResults(null)
						} else {
							// This is a successful result
							setCodeReviewResults(message.payload)
							setStoredCodeReviewResults(message.payload) // Store in memory
							setCodeReviewError(null) // Clear any previous errors
						}
						setShowSourceControl(true)
					}
					break
				case "pendingFileEdits":
					if (message.payload) {
						const files = message.payload.files || []
						setPendingFileEdits(files)
					}
					break
				case "gitChangesForReview":
					if (message.payload) {
						const files = message.payload.files || []
						setGitChangesForReview(files)
						// Set unreviewed changes flag if there are git changes
						setHasUnreviewedChanges(files.length > 0)
					}
					break
				// forked_change end
				case "workspaceUpdated":
					// kilocode_change: Refresh git changes for review when workspace changes
					vscode.postMessage({ type: "getGitChangesForReview" })
					break
				case "mode":
					// Reset sendingDisabled when mode changes to allow messages to be sent directly
					setSendingDisabled(false)
					break
			}
			// textAreaRef.current is not explicitly required here since React
			// guarantees that ref will be stable across re-renders, and we're
			// not using its value but its reference.
		},
		[
			isCondensing,
			isHidden,
			sendingDisabled,
			enableButtons,
			currentTaskItem,
			handleChatReset,
			handleSendMessage,
			handleSetChatBoxMessage,
			handlePrimaryButtonClick,
			handleSecondaryButtonClick,
			setSelectedImages,
			model?.supportsImages,
			t,
		],
	)

	useEvent("message", handleMessage)

	// Listen for mode changes to reset sendingDisabled
	useEffect(() => {
		const handleModeChanged = (_event: CustomEvent) => {
			// Reset sendingDisabled when mode changes to allow messages to be sent directly
			setSendingDisabled(false)
		}
		window.addEventListener("modeChanged", handleModeChanged as EventListener)
		return () => {
			window.removeEventListener("modeChanged", handleModeChanged as EventListener)
		}
	}, [])

	// forked_change start: Check for git changes on mount and periodically
	useEffect(() => {
		// Check for git changes when component mounts
		vscode.postMessage({ type: "getGitChangesForReview" })

		// Set up periodic checking for changes (every 5 seconds)
		const interval = setInterval(() => {
			vscode.postMessage({ type: "getGitChangesForReview" })
		}, 5000)

		return () => clearInterval(interval)
	}, [])

	// Listen for focus events to refresh git changes
	useEffect(() => {
		const handleFocus = () => {
			vscode.postMessage({ type: "getGitChangesForReview" })
		}

		window.addEventListener("focus", handleFocus)
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) {
				handleFocus()
			}
		})

		return () => {
			window.removeEventListener("focus", handleFocus)
		}
	}, [])
	// forked_change end

	// NOTE: the VSCode window needs to be focused for this to work.
	// Only focus on mount if webview has focus (e.g., opened via shortcut)
	// Don't steal focus if user is in IDE editor
	useMount(() => {
		if (document.hasFocus()) {
			textAreaRef.current?.focus()
		}
	})

	const visibleMessages = useMemo(() => {
		const shouldHideApiReqStartedMessage = (message: ClineMessage): boolean => {
			if (message.say !== "api_req_started" || message.text === null || message.text === undefined) {
				return false
			}

			const info = safeJsonParse<ClineApiReqInfo>(message.text)
			if (!info) {
				return false
			}

			return (
				info.cost !== undefined &&
				info.cost !== null &&
				info.cancelReason === undefined &&
				info.streamingFailedMessage === undefined
			)
		}

		// Pre-compute checkpoint hashes that have associated user messages for O(1) lookup
		const userMessageCheckpointHashes = new Set<string>()
		modifiedMessages.forEach((msg) => {
			if (
				msg.say === "user_feedback" &&
				msg.checkpoint &&
				(msg.checkpoint as any).type === "user_message" &&
				(msg.checkpoint as any).hash
			) {
				userMessageCheckpointHashes.add((msg.checkpoint as any).hash)
			}
		})

		// Remove the 500-message limit to prevent array index shifting
		// Virtuoso is designed to efficiently handle large lists through virtualization
		const newVisibleMessages = modifiedMessages.filter((message) => {
			// forked_change: thinking is live-only (as in OrbCode). Reasoning shows
			// while it streams and leaves nothing behind once it completes, in this
			// session or a resumed one.
			if (message.say === "reasoning" && message.partial !== true) {
				return false
			}

			if (shouldHideApiReqStartedMessage(message)) {
				everVisibleMessagesTsRef.current.delete(message.ts)
				return false
			}

			// Hide update_todo_list tool rows; the pinned todo list above the
			// chat input renders the latest state instead.
			if (
				((message.type === "ask" && message.ask === "tool") ||
					(message.type === "say" && (message.say as any) === "tool")) &&
				message.text?.includes('"tool":"updateTodoList"') &&
				safeJsonParse<any>(message.text)?.tool === "updateTodoList"
			) {
				return false
			}

			// Filter out checkpoint_saved messages that should be suppressed
			if (message.say === "checkpoint_saved") {
				// Check if this checkpoint has the suppressMessage flag set
				if (
					message.checkpoint &&
					typeof message.checkpoint === "object" &&
					"suppressMessage" in message.checkpoint &&
					message.checkpoint.suppressMessage
				) {
					return false
				}
				// Also filter out checkpoint messages associated with user messages (legacy behavior)
				if (message.text && userMessageCheckpointHashes.has(message.text)) {
					return false
				}
			}

			if (everVisibleMessagesTsRef.current.has(message.ts)) {
				const alwaysHiddenOnceProcessedAsk: ClineAsk[] = [
					"api_req_failed",
					"resume_task",
					"resume_completed_task",
				]
				const alwaysHiddenOnceProcessedSay = [
					"api_req_finished",
					"api_req_retried",
					"api_req_deleted",
					"mcp_server_request_started",
				]
				if (message.ask && alwaysHiddenOnceProcessedAsk.includes(message.ask)) return false
				if (message.say && alwaysHiddenOnceProcessedSay.includes(message.say)) return false
				if (
					message.say === "text" &&
					(message.text ?? "") === "" &&
					(message.images?.length ?? 0) === 0 &&
					(message.pasteChips?.length ?? 0) === 0
				) {
					return false
				}
				return true
			}

			switch (message.ask) {
				case "completion_result":
					if (message.text === "") return false
					break
				case "api_req_failed":
				case "resume_task":
				case "resume_completed_task":
					return false
			}
			switch (message.say) {
				case "api_req_finished":
				case "api_req_retried":
				case "api_req_deleted":
					return false
				case "api_req_retry_delayed":
					const last1 = modifiedMessages.at(-1)
					const last2 = modifiedMessages.at(-2)
					if (last1?.ask === "resume_task" && last2 === message) {
						return true
					} else if (message !== last1) {
						return false
					}
					break
				case "text":
					if (
						(message.text ?? "") === "" &&
						(message.images?.length ?? 0) === 0 &&
						(message.pasteChips?.length ?? 0) === 0
					) {
						return false
					}
					break
				case "mcp_server_request_started":
					return false
			}
			return true
		})

		const viewportStart = Math.max(0, newVisibleMessages.length - 100)
		newVisibleMessages
			.slice(viewportStart)
			.forEach((msg: ClineMessage) => everVisibleMessagesTsRef.current.set(msg.ts, true))

		return newVisibleMessages
	}, [modifiedMessages])

	useEffect(() => {
		const cleanupInterval = setInterval(() => {
			const cache = everVisibleMessagesTsRef.current
			const currentMessageIds = new Set(modifiedMessages.map((m: ClineMessage) => m.ts))
			const viewportMessages = visibleMessages.slice(Math.max(0, visibleMessages.length - 100))
			const viewportMessageIds = new Set(viewportMessages.map((m: ClineMessage) => m.ts))

			cache.forEach((_value: boolean, key: number) => {
				if (!currentMessageIds.has(key) && !viewportMessageIds.has(key)) {
					cache.delete(key)
				}
			})
		}, 60000)

		return () => clearInterval(cleanupInterval)
	}, [modifiedMessages, visibleMessages])

	useDebounceEffect(
		() => {
			// Only focus if the webview already has focus (user is interacting with it)
			// Don't steal focus from IDE editor
			if (!isHidden && !sendingDisabled && !enableButtons && document.hasFocus()) {
				textAreaRef.current?.focus()
			}
		},
		50,
		[isHidden, sendingDisabled, enableButtons],
	)

	const isReadOnlyToolAction = useCallback((message: ClineMessage | undefined) => {
		if (message?.type === "ask") {
			if (!message.text) {
				return true
			}

			const tool = JSON.parse(message.text)

			return [
				"readFile",
				"listFiles",
				"listFilesTopLevel",
				"listFilesRecursive",
				"listCodeDefinitionNames",
				"searchFiles",
				"codebaseSearch",
				"runSlashCommand",
			].includes(tool.tool)
		}

		return false
	}, [])

	const isWriteToolAction = useCallback((message: ClineMessage | undefined) => {
		if (message?.type === "ask") {
			if (!message.text) {
				return true
			}

			const tool = JSON.parse(message.text)

			return ["editedExistingFile", "newFileCreated", "generateImage", "generateFile"].includes(tool.tool)
		}

		return false
	}, [])

	const isMcpToolAlwaysAllowed = useCallback(
		(message: ClineMessage | undefined) => {
			if (message?.type === "ask" && message.ask === "use_mcp_server") {
				if (!message.text) {
					return true
				}

				const mcpServerUse = JSON.parse(message.text) as McpServerUse

				if (mcpServerUse.type === "use_mcp_tool" && mcpServerUse.toolName) {
					const server = mcpServers?.find((s: McpServer) => s.name === mcpServerUse.serverName)
					const tool = server?.tools?.find((t: McpTool) => t.name === mcpServerUse.toolName)
					return tool?.alwaysAllow || false
				}
			}

			return false
		},
		[mcpServers],
	)

	/**
	 * Extracts the actual command from the ask message text.
	 * The ask text may include:
	 * - MESSAGE prefix: "MESSAGE:custom message\n---\ncommand"
	 * - Output suffix: "command\nOutput:\noutput text"
	 */
	const extractCommandFromAskText = (text: string): string => {
		if (!text) return ""
		let command = text
		if (command.startsWith("MESSAGE:")) {
			const separatorIdx = command.indexOf("\n---\n")
			if (separatorIdx !== -1) {
				command = command.slice(separatorIdx + 5)
			}
		}
		const outputIdx = command.lastIndexOf("\nOutput:")
		if (outputIdx !== -1) {
			command = command.slice(0, outputIdx)
		}
		return command.trim()
	}

	// Get the command decision using unified validation logic
	const getCommandDecisionForMessage = useCallback(
		(message: ClineMessage | undefined): CommandDecision => {
			if (message?.type !== "ask") return "ask_user"
			const commandText = extractCommandFromAskText(message.text || "")
			return getCommandDecision(commandText, allowedCommands || [], deniedCommands || [])
		},
		[allowedCommands, deniedCommands],
	)

	// Check if a command message should be auto-approved.
	const isAllowedCommand = useCallback(
		(message: ClineMessage | undefined): boolean => {
			// forked_change start wrap in try/catch
			if (message?.type !== "ask") return false
			try {
				return getCommandDecisionForMessage(message) === "auto_approve"
			} catch (e) {
				// shell-quote sometimes throws a "Bad substitution" error
				console.error("Cannot validate command, auto-approve denied.", e)
				return false
			}
			// forked_change end
		},
		[getCommandDecisionForMessage],
	)

	// Check if a command message should be auto-denied.
	const isDeniedCommand = useCallback(
		(message: ClineMessage | undefined): boolean => {
			return getCommandDecisionForMessage(message) === "auto_deny"
		},
		[getCommandDecisionForMessage],
	)

	// Helper function to get the denied prefix for a command
	const getDeniedPrefix = useCallback(
		(command: string): string | null => {
			if (!command || !deniedCommands?.length) return null

			// Parse the command into sub-commands and check each one
			const actualCommand = extractCommandFromAskText(command)
			const subCommands = parseCommand(actualCommand)
			for (const cmd of subCommands) {
				const deniedMatch = findLongestPrefixMatch(cmd, deniedCommands)
				if (deniedMatch) {
					return deniedMatch
				}
			}
			return null
		},
		[deniedCommands],
	)

	// Create toggles object for useAutoApprovalState hook
	const autoApprovalToggles = useAutoApprovalToggles()

	const { hasEnabledOptions } = useAutoApprovalState(autoApprovalToggles, autoApprovalEnabled)

	const isAutoApproved = useCallback(
		(message: ClineMessage | undefined) => {
			// First check if auto-approval is enabled AND we have at least one permission
			if (!autoApprovalEnabled || !message || message.type !== "ask") {
				return false
			}

			// Use the hook's result instead of duplicating the logic
			if (!hasEnabledOptions) {
				return false
			}

			if (message.ask === "followup") {
				return alwaysAllowFollowupQuestions
			}

			if (message.ask === "browser_action_launch") {
				return alwaysAllowBrowser
			}

			if (message.ask === "use_mcp_server") {
				// Check if it's a tool or resource access
				if (!message.text) {
					return false
				}

				try {
					const mcpServerUse = JSON.parse(message.text) as McpServerUse

					if (mcpServerUse.type === "use_mcp_tool") {
						// For tools, check if the specific tool is always allowed
						return alwaysAllowMcp && isMcpToolAlwaysAllowed(message)
					} else if (mcpServerUse.type === "access_mcp_resource") {
						// For resources, auto-approve if MCP is always allowed
						// Resources don't have individual alwaysAllow settings like tools do
						return alwaysAllowMcp
					}
				} catch (error) {
					console.error("Failed to parse MCP server use message:", error)
					return false
				}
				return false
			}

			if (message.ask === "command") {
				return alwaysAllowExecute && isAllowedCommand(message)
			}

			// For read/write operations, check if it's outside workspace and if
			// we have permission for that.
			if (message.ask === "tool") {
				let tool: any = {}

				try {
					tool = JSON.parse(message.text || "{}")
				} catch (error) {
					console.error("Failed to parse tool:", error)
				}

				if (!tool) {
					return false
				}

				if (tool?.tool === "updateTodoList") {
					return alwaysAllowUpdateTodoList
				}

				if (tool?.tool === "fetchInstructions") {
					if (tool.content === "create_mode") {
						return alwaysAllowModeSwitch
					}

					if (tool.content === "create_mcp_server") {
						return alwaysAllowMcp
					}
				}

				if (tool?.tool === "switchMode") {
					return alwaysAllowModeSwitch
				}

				if (["newTask", "finishTask"].includes(tool?.tool)) {
					return alwaysAllowSubtasks
				}

				const isOutsideWorkspace = !!tool.isOutsideWorkspace

				if (isReadOnlyToolAction(message)) {
					return alwaysAllowReadOnly && (!isOutsideWorkspace || alwaysAllowReadOnlyOutsideWorkspace)
				}

				if (isWriteToolAction(message)) {
					// forked_change: file_write tool is always auto-approved
					return true
				}
			}

			return false
		},
		[
			autoApprovalEnabled,
			hasEnabledOptions,
			alwaysAllowBrowser,
			alwaysAllowReadOnly,
			alwaysAllowReadOnlyOutsideWorkspace,
			isReadOnlyToolAction,
			isWriteToolAction,
			alwaysAllowExecute,
			isAllowedCommand,
			alwaysAllowMcp,
			isMcpToolAlwaysAllowed,
			alwaysAllowModeSwitch,
			alwaysAllowFollowupQuestions,
			alwaysAllowSubtasks,
			alwaysAllowUpdateTodoList,
		],
	)

	useEffect(() => {
		// This ensures the first message is not read, future user messages are
		// labeled as `user_feedback`.
		if (lastMessage && messages.length > 1) {
			if (
				typeof lastMessage.text === "string" && // has text and is a string
				(lastMessage.say === "text" || lastMessage.say === "completion_result") && // is a text message
				!lastMessage.partial && // not a partial message
				!lastMessage.text.startsWith("{") // not a json object
			) {
				let text = lastMessage?.text || ""
				const mermaidRegex = /```mermaid[\s\S]*?```/g
				// remove mermaid diagrams from text
				text = text.replace(mermaidRegex, "")
				// remove markdown from text
				text = removeMd(text)

				// ensure message is not a duplicate of last read message
				if (text !== lastTtsRef.current) {
					try {
						playTts(text)
						lastTtsRef.current = text
					} catch (error) {
						console.error("Failed to execute text-to-speech:", error)
					}
				}
			}
		}

		// Update previous value.
		setWasStreaming(isStreaming)
	}, [isStreaming, lastMessage, wasStreaming, isAutoApproved, messages.length])

	const isBrowserSessionMessage = (message: ClineMessage): boolean => {
		// Which of visible messages are browser session messages, see above.
		if (message.type === "ask") {
			return ["browser_action_launch"].includes(message.ask!)
		}

		if (message.type === "say") {
			return ["api_req_started", "text", "browser_action", "browser_action_result"].includes(message.say!)
		}

		return false
	}

	const groupedMessages = useMemo(() => {
		const result: (ClineMessage | ClineMessage[])[] = []
		let currentGroup: ClineMessage[] = []
		let isInBrowserSession = false

		const endBrowserSession = () => {
			if (currentGroup.length > 0) {
				result.push([...currentGroup])
				currentGroup = []
				isInBrowserSession = false
			}
		}

		visibleMessages.forEach((message: ClineMessage) => {
			// forked_change start: upstream pr https://github.com/RooCodeInc/Roo-Code/pull/5452
			// Special handling for browser_action_result - ensure it's always in a browser session
			if (message.say === "browser_action_result" && !isInBrowserSession) {
				isInBrowserSession = true
				currentGroup = []
			}

			// Special handling for browser_action - ensure it's always in a browser session
			if (message.say === "browser_action" && !isInBrowserSession) {
				isInBrowserSession = true
				currentGroup = []
			}
			// forked_change end

			if (message.ask === "browser_action_launch") {
				// Complete existing browser session if any.
				endBrowserSession()
				// Start new.
				isInBrowserSession = true
				currentGroup.push(message)
			} else if (isInBrowserSession) {
				// End session if `api_req_started` is cancelled.

				if (message.say === "api_req_started") {
					// Get last `api_req_started` in currentGroup to check if
					// it's cancelled. If it is then this api req is not part
					// of the current browser session.
					const lastApiReqStarted = [...currentGroup].reverse().find((m) => m.say === "api_req_started")

					if (lastApiReqStarted?.text !== null && lastApiReqStarted?.text !== undefined) {
						const info = JSON.parse(lastApiReqStarted.text)
						const isCancelled = info.cancelReason !== null && info.cancelReason !== undefined

						if (isCancelled) {
							endBrowserSession()
							result.push(message)
							return
						}
					}
				}

				if (isBrowserSessionMessage(message)) {
					currentGroup.push(message)

					// forked_change start: upstream pr https://github.com/RooCodeInc/Roo-Code/pull/5452
					if (message.say === "browser_action_result") {
						// Check if the previous browser_action was a close action
						const lastBrowserAction = [...currentGroup].reverse().find((m) => m.say === "browser_action")
						if (lastBrowserAction) {
							const browserAction = JSON.parse(lastBrowserAction.text || "{}") as ClineSayBrowserAction
							if (browserAction.action === "close") {
								endBrowserSession()
							}
						}
					}
					// forked_change end
				} else {
					// complete existing browser session if any
					endBrowserSession()
					result.push(message)
				}
			} else {
				result.push(message)
			}
		})

		// Handle case where browser session is the last group
		if (currentGroup.length > 0) {
			result.push([...currentGroup])
		}

		// Second pass: Group consecutive exploration-related messages
		// Each tool invocation produces: ask:tool → api_req_started → say:tool
		// We group all these related messages together, then create an
		// ExplorationGroup once the run has at least one finished read-only call
		const explorationGroupedResult: (ClineMessage | ClineMessage[] | ExplorationGroup)[] = []
		let currentExplorationGroup: ClineMessage[] = []

		const endExplorationGroup = () => {
			if (currentExplorationGroup.length > 0) {
				// Count how many exploration tool RESULTS (say:tool) are in the group
				const resultCount = currentExplorationGroup.filter((m) => isExplorationToolResult(m)).length

				// forked_change: any run of read-only calls collapses into one row,
				// even a single call (OrbCode's grouped tool rows).
				if (resultCount >= 1) {
					const lastMsg = currentExplorationGroup[currentExplorationGroup.length - 1]
					explorationGroupedResult.push({
						_type: "explorationGroup",
						messages: [...currentExplorationGroup],
						isStreaming: lastMsg?.partial === true,
					})
				} else {
					// Not enough tools to group - emit as individual messages
					currentExplorationGroup.forEach((m) => explorationGroupedResult.push(m))
				}
				currentExplorationGroup = []
			}
		}

		result.forEach((item) => {
			// Browser session groups are already arrays - pass them through unchanged
			if (Array.isArray(item)) {
				// End any ongoing exploration group before a browser session
				endExplorationGroup()
				explorationGroupedResult.push(item)
				return
			}

			// Single message
			const message = item as ClineMessage

			// Check if this message is related to an exploration tool
			// (ask:tool, say:tool, or api_req_started between them)
			if (isExplorationRelatedMessage(message)) {
				currentExplorationGroup.push(message)
			} else {
				// End exploration group before non-exploration message
				endExplorationGroup()
				explorationGroupedResult.push(message)
			}
		})

		// Handle case where exploration group is last
		if (currentExplorationGroup.length > 0) {
			const resultCount = currentExplorationGroup.filter((m) => isExplorationToolResult(m)).length

			if (resultCount >= 1) {
				const lastMsg = currentExplorationGroup[currentExplorationGroup.length - 1]
				explorationGroupedResult.push({
					_type: "explorationGroup",
					messages: [...currentExplorationGroup],
					isStreaming: lastMsg?.partial === true,
				})
			} else {
				currentExplorationGroup.forEach((m) => explorationGroupedResult.push(m))
			}
		}

		if (isCondensing) {
			// Show indicator after clicking condense button
			explorationGroupedResult.push({
				type: "say",
				say: "condense_context",
				ts: Date.now(),
				partial: true,
			})
		}

		return explorationGroupedResult
	}, [isCondensing, visibleMessages])

	// Filtered groupedMessages for components that don't support ExplorationGroup
	const groupedMessagesWithoutExploration = useMemo(() => {
		return groupedMessages.filter((item) => !("_type" in item && item._type === "explorationGroup")) as (
			| ClineMessage
			| ClineMessage[]
		)[]
	}, [groupedMessages])

	// scrolling

	const scrollToBottomSmooth = useMemo(
		() =>
			debounce(() => virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" }), 10, {
				immediate: true,
			}),
		[],
	)

	useEffect(() => {
		return () => {
			if (scrollToBottomSmooth && typeof (scrollToBottomSmooth as any).cancel === "function") {
				;(scrollToBottomSmooth as any).cancel()
			}
		}
	}, [scrollToBottomSmooth])

	const scrollToBottomAuto = useCallback(() => {
		virtuosoRef.current?.scrollTo({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "auto", // Instant causes crash.
		})
	}, [])

	// forked_change start
	// Animated "blink" to highlight a specific message. Used by the TaskTimeline
	const highlightClearTimerRef = useRef<NodeJS.Timeout | undefined>()
	const [highlightedMessageIndex, setHighlightedMessageIndex] = useState<number | null>(null)
	const handleMessageClick = useCallback((index: number) => {
		setHighlightedMessageIndex(index)
		virtuosoRef.current?.scrollToIndex({ index, align: "end", behavior: "smooth" })

		// Clear existing timer if present
		if (highlightClearTimerRef.current) {
			clearTimeout(highlightClearTimerRef.current)
		}
		highlightClearTimerRef.current = setTimeout(() => {
			setHighlightedMessageIndex(null)
			highlightClearTimerRef.current = undefined
		}, 1000)
	}, [])

	// Cleanup highlight timer on unmount
	useEffect(() => {
		return () => {
			if (highlightClearTimerRef.current) {
				clearTimeout(highlightClearTimerRef.current)
			}
		}
	}, [])
	// forked_change end

	const handleSetExpandedRow = useCallback(
		(ts: number, expand?: boolean) => {
			setExpandedRows((prev: Record<number, boolean>) => ({
				...prev,
				[ts]: expand === undefined ? !prev[ts] : expand,
			}))
		},
		[setExpandedRows], // setExpandedRows is stable
	)

	// Scroll when user toggles certain rows.
	const toggleRowExpansion = useCallback(
		(ts: number) => {
			handleSetExpandedRow(ts)
			// The logic to set disableAutoScrollRef.current = true on expansion
			// is now handled by the useEffect hook that observes expandedRows.
		},
		[handleSetExpandedRow],
	)

	const handleRowHeightChange = useCallback(
		(isTaller: boolean) => {
			if (!disableAutoScrollRef.current) {
				if (isTaller) {
					scrollToBottomSmooth()
				} else {
					setTimeout(() => scrollToBottomAuto(), 0)
				}
			}
		},
		[scrollToBottomSmooth, scrollToBottomAuto],
	)

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined
		if (!disableAutoScrollRef.current) {
			timer = setTimeout(() => scrollToBottomSmooth(), 50)
		}
		return () => {
			if (timer) {
				clearTimeout(timer)
			}
		}
	}, [groupedMessages.length, scrollToBottomSmooth])

	const handleWheel = useCallback((event: Event) => {
		const wheelEvent = event as WheelEvent

		if (wheelEvent.deltaY && wheelEvent.deltaY < 0) {
			if (scrollContainerRef.current?.contains(wheelEvent.target as Node)) {
				// User scrolled up
				disableAutoScrollRef.current = true
			}
		}
	}, [])
	//kilocode_change

	// forked_change start: Pixel-perfect sticky user message tracking via scroll events
	// Pre-compute indices of user_feedback messages for the scroll handler
	const userFeedbackIndices = useMemo(() => {
		const indices: number[] = []
		groupedMessages.forEach((msg, i) => {
			// Skip exploration groups and arrays (browser sessions)
			if (Array.isArray(msg)) return
			if ("_type" in msg && msg._type === "explorationGroup") return
			// Now TypeScript knows msg is ClineMessage
			const message = msg as ClineMessage
			if (message.type === "say" && message.say === "user_feedback") {
				indices.push(i)
			}
		})
		return indices
	}, [groupedMessages])

	useEffect(() => {
		const scroller = virtuosoScrollerRef.current
		if (!scroller) return

		const handleScroll = () => {
			if (userFeedbackIndices.length === 0) {
				stickyMessageIndexRef.current = null
				setStickyMessageIndex(null)
				return
			}

			const stickyHeight = stickyHeaderRef.current?.offsetHeight ?? 40
			const scrollerRect = scroller.getBoundingClientRect()
			const threshold = scrollerRect.top + stickyHeight

			// Hysteresis margin: require a candidate to be past the threshold by this
			// amount before switching to it, and require the current sticky to be past
			// by this amount before dropping it. Prevents flicker between two adjacent
			// user_feedback messages when a new one streams in near the threshold.
			const HYSTERESIS_PX = 8

			// Find the first rendered item to determine our position relative to the virtual list
			const firstRenderedEl = scroller.querySelector("[data-item-index]")
			const firstRenderedIndex = firstRenderedEl
				? parseInt(firstRenderedEl.getAttribute("data-item-index") || "0", 10)
				: 0

			let bestIndex: number | null = null
			const currentIndex = stickyMessageIndexRef.current

			for (const idx of userFeedbackIndices) {
				const el = scroller.querySelector(`[data-item-index="${idx}"]`) as HTMLElement | null

				if (!el) {
					if (idx < firstRenderedIndex) {
						// Not in DOM and index is lower than first rendered -> Above viewport
						bestIndex = idx
						continue
					} else {
						// Not in DOM and index is higher -> Below viewport
						break
					}
				}

				const elTop = el.getBoundingClientRect().top
				// If this is the currently-sticky message, keep it sticky until it has
				// scrolled far enough past the threshold to be clearly out of view.
				if (idx === currentIndex) {
					if (elTop <= threshold + HYSTERESIS_PX) {
						bestIndex = idx
					} else {
						// Current sticky has scrolled well past; let a later candidate win.
					}
					continue
				}

				// For a new candidate, require it to be clearly above the threshold
				// (by the hysteresis margin) before adopting it, to avoid flicker.
				if (elTop <= threshold - HYSTERESIS_PX) {
					bestIndex = idx
				} else {
					// Below the threshold, everything after will be too
					break
				}
			}

			// Prefer keeping the current sticky index when no candidate clearly won,
			// to avoid dropping to null (task prompt) during transient reflows.
			if (bestIndex === null && currentIndex !== null && userFeedbackIndices.includes(currentIndex)) {
				const el = scroller.querySelector(`[data-item-index="${currentIndex}"]`) as HTMLElement | null
				if (!el || el.getBoundingClientRect().top <= threshold + HYSTERESIS_PX) {
					bestIndex = currentIndex
				}
			}

			if (bestIndex !== currentIndex) {
				stickyMessageIndexRef.current = bestIndex
				setStickyMessageIndex(bestIndex)
			}
		}

		scroller.addEventListener("scroll", handleScroll, { passive: true })
		handleScroll() // Initial check
		return () => scroller.removeEventListener("scroll", handleScroll)
	}, [userFeedbackIndices])

	// Track sticky header height with ResizeObserver so list items don't hide behind it
	useEffect(() => {
		const el = stickyHeaderRef.current
		if (!el) {
			setStickyHeaderHeight(0)
			return
		}

		const updateHeight = () => setStickyHeaderHeight(el.offsetHeight)
		updateHeight()

		const observer = new ResizeObserver(updateHeight)
		observer.observe(el)
		return () => observer.disconnect()
	}, [task?.ts]) // re-run when task mounts/changes
	// forked_change end

	// Effect to handle showing the checkpoint warning after a delay
	useEffect(() => {
		// Only show the warning when there's a task but no visible messages yet
		if (task && modifiedMessages.length === 0 && !isStreaming && !isHidden) {
			const timer = setTimeout(() => {
				setShowCheckpointWarning(true)
			}, 5000) // 5 seconds

			return () => clearTimeout(timer)
		} else {
			setShowCheckpointWarning(false)
		}
	}, [task, modifiedMessages.length, isStreaming, isHidden])

	// Effect to hide the checkpoint warning when messages appear
	useEffect(() => {
		if (modifiedMessages.length > 0 || isStreaming || isHidden) {
			setShowCheckpointWarning(false)
		}
	}, [modifiedMessages.length, isStreaming, isHidden])

	// 3-minute timeout for silent LLM failures
	const streamingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const STREAMING_TIMEOUT_MS = 2 * 60 * 1000 // 3 minutes

	useEffect(() => {
		// Clear any existing timeout
		if (streamingTimeoutRef.current) {
			clearTimeout(streamingTimeoutRef.current)
			streamingTimeoutRef.current = null
		}

		if (isStreaming) {
			streamingTimeoutRef.current = setTimeout(() => {
				// LLM has not responded for 3 minutes — show retry
				setSendingDisabled(false)
				setClineAsk("api_req_failed")
				setEnableButtons(true)
				setPrimaryButtonText(t("chat:retry.title"))
				setSecondaryButtonText(t("chat:terminate.title"))
			}, STREAMING_TIMEOUT_MS)
		}

		return () => {
			if (streamingTimeoutRef.current) {
				clearTimeout(streamingTimeoutRef.current)
				streamingTimeoutRef.current = null
			}
		}
	}, [isStreaming, messages.length, t, STREAMING_TIMEOUT_MS])

	const switchToMode = useCallback((_modeSlug: string): void => {
		// Mode switching is disabled. "agent" is the only mode; do nothing.
	}, [])

	const handleSuggestionClickInRow = useCallback(
		(suggestion: SuggestionItem, event?: React.MouseEvent) => {
			// Mark that user has responded if this is a manual click (not auto-approval)
			if (event) {
				userRespondedRef.current = true
			}

			// Mark the current follow-up question as answered when a suggestion is clicked
			if (clineAsk === "followup" && !event?.shiftKey) {
				markFollowUpAsAnswered()
			}

			// Check if we need to switch modes
			if (suggestion.mode) {
				// Only switch modes if it's a manual click (event exists) or auto-approval is allowed
				const isManualClick = !!event
				if (isManualClick || alwaysAllowModeSwitch) {
					// Switch mode without waiting
					switchToMode(suggestion.mode)
				}
			}

			if (event?.shiftKey) {
				// Always append to existing text, don't overwrite
				setInputValue((currentValue: string) => {
					return currentValue !== "" ? `${currentValue} \n${suggestion.answer}` : suggestion.answer
				})
			} else {
				// Don't clear the input value when sending a follow-up choice
				// The message should be sent but the text area should preserve what the user typed
				const preservedInput = inputValueRef.current
				handleSendMessage(suggestion.answer, [])
				// Restore the input value after sending
				setInputValue(preservedInput)
			}
		},
		[handleSendMessage, setInputValue, switchToMode, alwaysAllowModeSwitch, clineAsk, markFollowUpAsAnswered],
	)

	const handleBatchFileResponse = useCallback((response: { [key: string]: boolean }) => {
		// Handle batch file response, e.g., for file uploads
		vscode.postMessage({ type: "askResponse", askResponse: "objectResponse", text: JSON.stringify(response) })
	}, [])

	// Handler for when FollowUpSuggest component unmounts
	const handleFollowUpUnmount = useCallback(() => {
		// Mark that user has responded
		userRespondedRef.current = true
	}, [])

	const itemContent = useCallback(
		(index: number, messageOrGroup: ClineMessage | ClineMessage[] | ExplorationGroup) => {
			// exploration group - check by _type property
			if (
				messageOrGroup &&
				typeof messageOrGroup === "object" &&
				"_type" in messageOrGroup &&
				messageOrGroup._type === "explorationGroup"
			) {
				const explorationGroup = messageOrGroup as ExplorationGroup
				return (
					<ExplorationGroupRow
						messages={explorationGroup.messages}
						isLast={index === groupedMessages.length - 1}
						lastModifiedMessage={lastModifiedMessage}
						onHeightChange={handleRowHeightChange}
						isStreaming={isStreaming}
						isExpanded={expandedRows[explorationGroup.messages[0]?.ts] ?? false}
						onToggleExpand={(messageTs: number) => {
							setExpandedRows((prev: Record<number, boolean>) => ({
								...prev,
								[messageTs]: !prev[messageTs],
							}))
						}}
						expandedRows={expandedRows}
						toggleRowExpansion={toggleRowExpansion}
						handleSuggestionClickInRow={handleSuggestionClickInRow}
						handleBatchFileResponse={handleBatchFileResponse}
						highlightedMessageIndex={highlightedMessageIndex}
						enableCheckpoints={enableCheckpoints}
						handleFollowUpUnmount={handleFollowUpUnmount}
						currentFollowUpTs={currentFollowUpTs}
						enableButtons={enableButtons}
						handlePrimaryButtonClick={handlePrimaryButtonClick}
						handleSecondaryButtonClick={handleSecondaryButtonClick}
						isAgentManagerMode={isAgentManagerMode}
						profilePlan={profileData?.plan ?? profileData?.tieredUsage?.plan}
					/>
				)
			}

			// browser session group
			if (Array.isArray(messageOrGroup)) {
				return (
					<BrowserSessionRow
						messages={messageOrGroup}
						isLast={index === groupedMessages.length - 1}
						lastModifiedMessage={lastModifiedMessage}
						onHeightChange={handleRowHeightChange}
						isStreaming={isStreaming}
						isExpanded={(messageTs: number) => expandedRows[messageTs] ?? false}
						onToggleExpand={(messageTs: number) => {
							setExpandedRows((prev: Record<number, boolean>) => ({
								...prev,
								[messageTs]: !prev[messageTs],
							}))
						}}
					/>
				)
			}

			// regular message - at this point messageOrGroup is ClineMessage
			const message = messageOrGroup as ClineMessage
			const isEditable =
				message.type === "ask" &&
				message.ask === "tool" &&
				(() => {
					let tool: any = {}
					try {
						tool = JSON.parse(message.text || "{}")
					} catch (_e) {
						tool = {}
					}
					return tool.name === "str_replace_editor" || tool.name === "file_edit"
				})()

			return (
				<ChatRow
					key={message.ts}
					message={message}
					isExpanded={expandedRows[message.ts] || false}
					onToggleExpand={toggleRowExpansion} // This was already stabilized
					lastModifiedMessage={lastModifiedMessage} // Memoized reference
					isLast={index === groupedMessages.length - 1} // Array length is stable enough vs inline computation
					onHeightChange={handleRowHeightChange}
					isStreaming={isStreaming}
					onSuggestionClick={handleSuggestionClickInRow} // This was already stabilized
					onBatchFileResponse={handleBatchFileResponse}
					highlighted={highlightedMessageIndex === index} // kilocode_change: add highlight prop
					enableCheckpoints={enableCheckpoints} // kilocode_change
					onFollowUpUnmount={handleFollowUpUnmount}
					isFollowUpAnswered={message.isAnswered === true || message.ts === currentFollowUpTs}
					editable={isEditable}
					onPrimaryButtonClick={handlePrimaryButtonClick}
					onSecondaryButtonClick={handleSecondaryButtonClick}
					enableButtons={enableButtons && index === groupedMessages.length - 1}
					isAgentManagerMode={isAgentManagerMode} // kilocode_change: pass agent manager mode
					profilePlan={profileData?.plan ?? profileData?.tieredUsage?.plan}
				/>
			)
		},
		[
			expandedRows,
			toggleRowExpansion,
			lastModifiedMessage,
			groupedMessages.length,
			handleRowHeightChange,
			isStreaming,
			handleSuggestionClickInRow,
			handleBatchFileResponse,
			highlightedMessageIndex, // kilocode_change: add highlightedMessageIndex
			enableCheckpoints, // kilocode_change
			handleFollowUpUnmount,
			currentFollowUpTs,
			enableButtons,
			handlePrimaryButtonClick,
			handleSecondaryButtonClick,
			isAgentManagerMode, // kilocode_change: add to dependencies
			profileData?.plan,
			profileData?.tieredUsage?.plan,
		],
	)

	useEffect(() => {
		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}

		if (!clineAsk || !enableButtons) {
			return
		}

		// Exit early if user has already responded
		if (userRespondedRef.current) {
			return
		}

		const autoApproveOrReject = async () => {
			// Check for auto-reject first (commands that should be denied)
			if (lastMessage?.ask === "command" && isDeniedCommand(lastMessage)) {
				// Get the denied prefix for the localized message
				const deniedPrefix = getDeniedPrefix(lastMessage.text || "")
				if (deniedPrefix) {
					// Create the localized auto-deny message and send it with the rejection
					const autoDenyMessage = tSettings("autoApprove.execute.autoDenied", { prefix: deniedPrefix })

					vscode.postMessage({
						type: "askResponse",
						askResponse: "noButtonClicked",
						text: autoDenyMessage,
					})
				} else {
					// Auto-reject denied commands immediately if no prefix found
					vscode.postMessage({ type: "askResponse", askResponse: "noButtonClicked" })
				}

				setSendingDisabled(true)
				setClineAsk(undefined)
				setEnableButtons(false)
				return
			}

			// Then check for auto-approve
			if (lastMessage?.ask && isAutoApproved(lastMessage)) {
				// Special handling for follow-up questions
				if (lastMessage.ask === "followup") {
					// Handle invalid JSON
					let followUpData: FollowUpData = {}
					try {
						followUpData = JSON.parse(lastMessage.text || "{}") as FollowUpData
					} catch (error) {
						console.error("Failed to parse follow-up data:", error)
						return
					}

					if (followUpData && followUpData.suggest && followUpData.suggest.length > 0) {
						// Wait for the configured timeout before auto-selecting the first suggestion
						await new Promise<void>((resolve) => {
							// forked_change start
							if (!isMountedRef.current) {
								resolve()
								return
							}
							autoApproveTimeoutRef.current = setTimeout(() => {
								if (!isMountedRef.current) {
									resolve()
									return
								}
								autoApproveTimeoutRef.current = null
								resolve()
							}, followupAutoApproveTimeoutMs)
							// forked_change end
						})

						// Check if user responded manually
						if (userRespondedRef.current) {
							return
						}

						// Get the first suggestion
						const firstSuggestion = followUpData.suggest[0]

						// Handle the suggestion click
						handleSuggestionClickInRow(firstSuggestion)
						return
					}
				} else if (lastMessage.ask === "tool" && isWriteToolAction(lastMessage)) {
					// forked_change start
					await new Promise<void>((resolve) => {
						if (!isMountedRef.current) {
							resolve()
							return
						}
						autoApproveTimeoutRef.current = setTimeout(() => {
							if (!isMountedRef.current) {
								resolve()
								return
							}
							autoApproveTimeoutRef.current = null
							resolve()
						}, writeDelayMs)
					})
					// forked_change end
				}

				vscode.postMessage({ type: "askResponse", askResponse: "yesButtonClicked" })

				setSendingDisabled(true)
				setClineAsk(undefined)
				setEnableButtons(false)
			}
		}
		autoApproveOrReject()

		return () => {
			if (autoApproveTimeoutRef.current) {
				clearTimeout(autoApproveTimeoutRef.current)
				autoApproveTimeoutRef.current = null
			}
		}
	}, [
		clineAsk,
		enableButtons,
		handlePrimaryButtonClick,
		alwaysAllowBrowser,
		alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowExecute,
		followupAutoApproveTimeoutMs,
		alwaysAllowMcp,
		messages,
		allowedCommands,
		deniedCommands,
		mcpServers,
		isAutoApproved,
		lastMessage,
		writeDelayMs,
		isWriteToolAction,
		alwaysAllowFollowupQuestions,
		handleSuggestionClickInRow,
		isAllowedCommand,
		isDeniedCommand,
		getDeniedPrefix,
		tSettings,
	])

	// Add keyboard event handler
	const handleKeyDown = useCallback((event: KeyboardEvent) => {
		// Mode switching is disabled. The Cmd/Ctrl + . and Cmd/Ctrl + Shift + .
		// shortcuts no longer cycle modes. Consume the event so any default
		// behavior is suppressed.
		if ((event.metaKey || event.ctrlKey) && event.key === ".") {
			event.preventDefault()
		}
	}, [])

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown)
		window.addEventListener("wheel", handleWheel, { passive: true }) // kilocode_change
		return () => {
			window.removeEventListener("keydown", handleKeyDown)
			window.removeEventListener("wheel", handleWheel) // kilocode_change
		}
	}, [handleKeyDown, handleWheel]) // kilocode_change

	useImperativeHandle(ref, () => ({
		acceptInput: () => {
			if (enableButtons && primaryButtonText) {
				handlePrimaryButtonClick(inputValue, selectedImages)
			} else if (
				!sendingDisabled &&
				!isProfileDisabled &&
				(inputValue.trim() || selectedImages.length > 0 || selectedDocuments.length > 0)
			) {
				handleSendMessage(inputValue, selectedImages)
			}
		},
		// forked_change start
		focusInput: () => {
			if (textAreaRef.current) {
				textAreaRef.current.focus()
			}
		},
		// forked_change end
	}))

	const handleCondenseContext = (taskId: string) => {
		if (isCondensing || sendingDisabled) {
			return
		}
		setIsCondensing(true)
		setSendingDisabled(true)
		vscode.postMessage({ type: "condenseTaskContextRequest", text: taskId })
	}

	const areButtonsVisible = showScrollToBottom || primaryButtonText || secondaryButtonText

	return (
		<div data-testid="chat-view" className={isHidden ? "hidden" : "absolute inset-0 flex flex-col overflow-hidden"}>
			{(showAnnouncement || showAnnouncementModal) && (
				<Announcement
					hideAnnouncement={() => {
						if (showAnnouncementModal) {
							setShowAnnouncementModal(false)
						}
						if (showAnnouncement) {
							hideAnnouncement()
						}
					}}
				/>
			)}

			{/* kilocode_change: multi-chat tab bar — visible in regular chat view (not agent manager) when at least one tab exists */}
			{!isAgentManagerMode && unifiedTabs.length > 0 && (
				<ChatTabs
					tabs={unifiedTabs}
					onSelect={handleSelectTab}
					onClose={handleCloseTab}
					onAddTab={handleAddTab}
					onReorder={handleReorderTabs}
				/>
			)}

			{!task && isAgentManagerMode ? (
				<div className="flex-1 flex flex-col items-center justify-center relative px-8 pb-32">
					<div className="w-full max-w-[650px] flex flex-col gap-1">
						<div className="text-xs text-[var(--vscode-descriptionForeground)] flex items-center gap-2 ml-6 opacity-70">
							<span className="font-medium text-sm">
								{currentTaskItem?.workspace?.split(/[/\\]/).pop() ||
									cwd?.split(/[/\\]/).pop() ||
									"Workspace"}
							</span>
						</div>
						<div className="flex items-center gap-2 mt-1 ml-4">
							<button className="text-xs px-3 py-1.5 rounded-full border border-[var(--vscode-panel-border)] hover:bg-[var(--vscode-list-hoverBackground)] cursor-pointer text-[var(--vscode-foreground)] transition-colors inline-flex items-center">
								Open Editor Window
							</button>
						</div>
						{!isReviewOnlyMode && (
							<>
								<OrbitalUpdateBanner />
								<ChatTextArea
									ref={textAreaRef}
									inputValue={inputValue}
									setInputValue={setInputValue}
									sendingDisabled={sendingDisabled || isProfileDisabled}
									selectApiConfigDisabled={sendingDisabled && clineAsk !== "api_req_failed"}
									selectedImages={selectedImages}
									setSelectedImages={setSelectedImages}
									selectedDocuments={selectedDocuments}
									setSelectedDocuments={setSelectedDocuments}
									onSend={(text?: string, pasteChips?: PasteChipSerialized[]) =>
										handleSendMessage(text ?? inputValue, selectedImages, pasteChips)
									}
									onSelectImages={selectAttachments}
									shouldDisableImages={shouldDisableImages}
									onHeightChange={() => {
										if (isAtBottom) {
											scrollToBottomAuto()
										}
									}}
									mode={mode}
									setMode={setMode}
									modeShortcutText={modeShortcutText}
									sendMessageOnEnter={sendMessageOnEnter}
									isStreaming={isStreaming}
									onCancelStreaming={() => handleSecondaryButtonClick(inputValue, selectedImages)}
									profilePlan={profileData?.plan ?? profileData?.tieredUsage?.plan}
									onShowUsage={() => setShowUsageModal(true)}
								/>
								<BottomControls showApiConfig />
							</>
						)}
					</div>
				</div>
			) : (
				<>
					{task ? (
						<div className={`${isAgentManagerMode ? "ml-12 mr-64" : "mx-0"}`}>
							{/* kilocode_change: KiloTaskHeader only in agent manager mode — ChatTabs replaces it otherwise */}
							{isAgentManagerMode && (
								<KiloTaskHeader
									task={task}
									tokensIn={apiMetrics.totalTokensIn}
									tokensOut={apiMetrics.totalTokensOut}
									cacheWrites={apiMetrics.totalCacheWrites}
									cacheReads={apiMetrics.totalCacheReads}
									totalCost={apiMetrics.totalCost}
									contextTokens={apiMetrics.contextTokens}
									handleCondenseContext={handleCondenseContext}
									onClose={handleTaskCloseButtonClick}
									groupedMessages={groupedMessagesWithoutExploration}
									onMessageClick={handleMessageClick}
									isTaskActive={sendingDisabled}
									todos={latestTodos}
									title={(task as any)?.title}
									isAgentManagerMode={isAgentManagerMode}
								/>
							)}

							{hasSystemPromptOverride && (
								<div className="px-3">
									<SystemPromptWarning />
								</div>
							)}

							{showCheckpointWarning && (
								<div className="px-3">
									<CheckpointWarning />
								</div>
							)}
						</div>
					) : (
						<div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 relative">
							<div className="w-full h-full flex flex-col gap-4 px-3.5 transition-all duration-300">
								<div className={taskHistoryFullLength === 0 ? "mt-10" : undefined}>
									<KilocodeNotifications />
								</div>
								<div className="flex flex-grow flex-col justify-start gap-4">
									{!isReviewOnlyMode && (
										<div className="w-full min-w-0 mt-0 mb-1">
											<div className="relative overflow-hidden rounded-2xl border border-[var(--vscode-commandCenter-inactiveBorder)] bg-vscode-editor-background h-[90px]">
												<div
													className="flex transition-transform duration-500 ease-in-out h-full"
													style={{ transform: `translateX(-${activeMarketingCard * 100}%)` }}>
													{/* PR Reviews Card */}
													<div className="w-full flex-shrink-0 px-4 py-1 h-full">
														<div className="flex flex-col gap-1 h-full justify-center">
															<div className="flex flex-row gap-2 items-center">
																<p className="text-sm p-0 m-0 font-semibold text-vscode-foreground">
																	Setup Agentic PR Reviews
																</p>
																<div className="flex items-center flex-row gap-2">
																	<img
																		src={iconsBaseUri + "/github-ic.png"}
																		alt="GitHub"
																		className="w-3.5 h-3.5"
																	/>
																	<img
																		src={iconsBaseUri + "/gitlab-ic.png"}
																		alt="GitLab"
																		className="w-3.5 h-3.5"
																	/>
																	<img
																		src={iconsBaseUri + "/bitbucket-ic.png"}
																		alt="Bitbucket"
																		className="w-3.5 h-3.5"
																	/>
																	<img
																		src={iconsBaseUri + "/azure-devops-ic.png"}
																		alt="Azure DevOps"
																		className="w-3.5 h-3.5"
																	/>
																</div>
															</div>
															<p className="text-xs p-0 m-0 text-vscode-foreground opacity-70">
																Auto agentic reviews with context discovery on your Pull
																Requests.
															</p>
															<div className="flex flex-row gap-2 mt-0.5">
																<VSCodeButtonLink
																	appearance="primary"
																	href="https://app.matterai.so/get-started">
																	Setup Code Reviews
																</VSCodeButtonLink>
																<VSCodeButtonLink
																	appearance="secondary"
																	href="https://docs.matterai.so/quickstart-ai-code-review-agent">
																	Docs
																</VSCodeButtonLink>
															</div>
														</div>
													</div>

													{/* Orbcode CLI Card */}
													<div className="w-full flex-shrink-0 px-4 py-1 h-full">
														<div className="flex flex-col gap-1 h-full justify-center">
															<div className="flex flex-row gap-2 items-center">
																<p className="text-sm p-0 m-0 font-semibold text-vscode-foreground">
																	Introducing Orbcode CLI
																</p>
																<img
																	src={iconsBaseUri + "/matterai-company-ic.svg"}
																	alt="MatterAI"
																	className="w-3.5 h-3.5"
																/>
															</div>
															<p className="text-xs p-0 m-0 text-vscode-foreground opacity-70">
																Agentic coding in your terminal. Streaming TUI,
																approvals, headless mode.
															</p>
															<div className="flex flex-row gap-2 mt-0.5">
																<VSCodeButtonLink
																	appearance="primary"
																	href="https://github.com/MatterAIOrg/OrbCode">
																	View on GitHub
																</VSCodeButtonLink>
																<VSCodeButtonLink
																	appearance="secondary"
																	href="https://docs.matterai.so/orbcode-cli/overview">
																	Docs
																</VSCodeButtonLink>
															</div>
														</div>
													</div>
												</div>
											</div>

											{/* Dot indicators */}
											<div className="flex justify-center gap-2 mt-2">
												<button
													onClick={() => setActiveMarketingCard(0)}
													className={`rounded-full transition-all duration-300 ${
														activeMarketingCard === 0
															? "bg-[var(--vscode-button-background)] w-4 h-2"
															: "bg-[var(--vscode-panel-border)] w-2 h-2 hover:bg-[var(--vscode-descriptionForeground)]"
													}`}
													aria-label="PR Reviews card"
												/>
												<button
													onClick={() => setActiveMarketingCard(1)}
													className={`rounded-full transition-all duration-300 ${
														activeMarketingCard === 1
															? "bg-[var(--vscode-button-background)] w-4 h-2"
															: "bg-[var(--vscode-panel-border)] w-2 h-2 hover:bg-[var(--vscode-descriptionForeground)]"
													}`}
													aria-label="Orbcode CLI card"
												/>
											</div>
										</div>
									)}
									{/* kilocode_change: Background Agents panel replaced by ChatTabs at the top */}
									{!isReviewOnlyMode && taskHistoryFullLength > 0 && isExpanded && (
										<HistoryPreview taskHistoryVersion={taskHistoryVersion} />
									)}
								</div>
							</div>
						</div>
					)}

					{!task && showAutoApproveMenu && (
						<div className="mb-1 flex-initial min-h-0">
							<AutoApproveMenu />
						</div>
					)}

					{task && (
						<>
							<div
								className={`grow flex flex-col relative ${isAgentManagerMode ? `ml-12 ${isAgentFileViewerOpen ? "mr-12" : "mr-64"}` : "mx-0"}`}
								ref={scrollContainerRef}>
								{/* kilocode_change: Sticky user message - positioned outside Virtuoso for true sticky behavior */}
								<div
									ref={stickyHeaderRef}
									className={`px-3 pointer-events-none absolute -top-1 left-0 right-0 z-10 py-0.5`}>
									<div className="pointer-events-auto">
										<StickyUserMessage
											task={task}
											messages={groupedMessages}
											stickyIndex={stickyMessageIndex}
										/>
									</div>
								</div>
								<Virtuoso
									ref={virtuosoRef}
									key={task.ts}
									className="scrollable grow overflow-y-scroll mb-1 scrollbar-hide"
									// increasing top by 3_000 to prevent jumping around when user collapses a row
									increaseViewportBy={{ top: 400, bottom: 400 }} // kilocode_change: use more modest numbers to see if they reduce gray screen incidence
									data={groupedMessages}
									itemContent={itemContent}
									// kilocode_change: Spacer at top of list so items don't hide behind the sticky header
									components={{
										Header: () => <div style={{ height: stickyHeaderHeight }} />,
									}}
									atBottomStateChange={(isAtBottom: boolean) => {
										setIsAtBottom(isAtBottom)
										if (isAtBottom) {
											disableAutoScrollRef.current = false
										}
										// setShowScrollToBottom(disableAutoScrollRef.current && !isAtBottom)
									}}
									atBottomThreshold={10}
									initialTopMostItemIndex={groupedMessages.length - 1}
									// kilocode_change: Capture scroller element for pixel-perfect sticky tracking
									scrollerRef={(ref) => {
										if (ref instanceof HTMLElement) {
											virtuosoScrollerRef.current = ref
										}
									}}
								/>
							</div>
							<div className={`flex-initial min-h-0 ${!areButtonsVisible ? "mb-1" : ""}`}>
								{showAutoApproveMenu && <AutoApproveMenu />}
							</div>
							{/* Pinned todo list - single static position, updates in place (not a chat row) */}
							{latestTodos.length > 0 && (
								<div
									className={`px-2 mb-1 mx-3.5 ${isAgentManagerMode ? `ml-14 ${isAgentFileViewerOpen ? "mr-14" : "mr-64"}` : "mx-0"}`}>
									<PinnedTodoList todos={latestTodos} />
								</div>
							)}
						</>
					)}

					<div
						className={`${isAgentManagerMode ? `ml-12 ${isAgentFileViewerOpen ? "mr-12" : "mr-64"}` : "mx-0"}`}>
						<BackgroundShells taskId={currentTaskItem?.id} />
						<QueuedMessages
							queue={messageQueue}
							onRemove={(index) => {
								if (messageQueue[index]) {
									vscode.postMessage({ type: "removeQueuedMessage", text: messageQueue[index].id })
								}
							}}
							onUpdate={(index, newText) => {
								if (messageQueue[index]) {
									vscode.postMessage({
										type: "editQueuedMessage",
										payload: {
											id: messageQueue[index].id,
											text: newText,
											images: messageQueue[index].images,
										},
									})
								}
							}}
							onForceSend={(index) => {
								if (messageQueue[index]) {
									vscode.postMessage({ type: "forceSendQueuedMessage", text: messageQueue[index].id })
								}
							}}
						/>
					</div>
					{!task && showSourceControl && (
						<div className="z-[1000] w-full min-w-0 px-4 mb-1">
							<SourceControlPanel
								fileChanges={_gitChangesForReview}
								codeReviewResult={codeReviewResults}
								codeReviewError={codeReviewError}
								isLoading={isCodeReviewLoading}
								onRunCodeReview={handleRunCodeReview}
								onClose={() => setShowSourceControl(false)}
								hasKilocodeToken={!!apiConfiguration?.kilocodeToken}
							/>
						</div>
					)}

					{/* kilocode_change: Show notification when monthly limit is exhausted.
				    When overage is enabled for the user, the plan keeps running on API
				    credits, so we show an "overage active" banner instead of the
				    out-of-credits banner. */}
					{isUsageExhausted && !task && !profileData?.overage?.enabled && (
						<OutOfCreditsBanner
							className="w-full min-w-0 px-4 mb-4"
							creditsResetDate={profileData?.creditsResetDate}
							tieredUsage={profileData?.tieredUsage}
						/>
					)}
					{isUsageExhausted && !task && profileData?.overage?.enabled && (
						<OverageActiveBanner className="w-full min-w-0 px-4 mb-4" usage={profileData?.overage?.usage} />
					)}

					{/* {!task && (
						<div className={`w-full min-w-0 px-4 ${isReviewOnlyMode ? "mb-4" : "mb-1.5"}`}>
							<VSCodeButton
								appearance="secondary"
								className="flex w-full min-w-full code-review-btn"
								style={{
									borderRadius: "25px !important",
								}}
								onClick={() => {
									setShowSourceControl(true)
									// If there's an error, automatically retry when opening
									if (codeReviewError && !isCodeReviewLoading) {
										handleRunCodeReview()
									}
								}}
								disabled={isCodeReviewLoading}>
								{codeReviewError ? (
									<>
										<span className="codicon codicon-refresh mr-1" />
										Retry AI Code Review ({_gitChangesForReview.length}{" "}
										{_gitChangesForReview.length === 1 ? "change" : "changes"})
									</>
								) : (
									<>
										Run AI Code Review ({_gitChangesForReview.length}{" "}
										{_gitChangesForReview.length === 1 ? "change" : "changes"})
									</>
								)}
							</VSCodeButton>
						</div>
					)} */}
					{/* Chat input area - Hidden in review only mode */}
					{!isReviewOnlyMode && (
						<div
							className={`${isAgentManagerMode ? `ml-12 ${isAgentFileViewerOpen ? "mr-12" : "mr-64"}` : "mx-0"}`}>
							<OrbitalUpdateBanner />
							<ChatTextArea
								ref={textAreaRef}
								inputValue={inputValue}
								setInputValue={setInputValue}
								sendingDisabled={sendingDisabled || isProfileDisabled}
								selectApiConfigDisabled={sendingDisabled && clineAsk !== "api_req_failed"}
								selectedImages={selectedImages}
								setSelectedImages={setSelectedImages}
								selectedDocuments={selectedDocuments}
								setSelectedDocuments={setSelectedDocuments}
								onSend={(text?: string, pasteChips?: PasteChipSerialized[]) =>
									handleSendMessage(text ?? inputValue, selectedImages, pasteChips)
								}
								onSelectImages={selectAttachments}
								shouldDisableImages={shouldDisableImages}
								onHeightChange={() => {
									if (isAtBottom) {
										scrollToBottomAuto()
									}
								}}
								mode={mode}
								setMode={setMode}
								modeShortcutText={modeShortcutText}
								sendMessageOnEnter={sendMessageOnEnter} // kilocode_change
								isStreaming={isStreaming}
								onCancelStreaming={() => handleSecondaryButtonClick(inputValue, selectedImages)}
								profilePlan={profileData?.plan ?? profileData?.tieredUsage?.plan}
								onShowUsage={() => setShowUsageModal(true)}
							/>
						</div>
					)}
					{/* kilocode_change: added settings toggle the profile and model selection */}
					{!isReviewOnlyMode && (
						<div
							className={`${isAgentManagerMode ? `ml-12 ${isAgentFileViewerOpen ? "mr-12" : "mr-64"}` : "mx-0"}`}>
							<BottomControls showApiConfig />
						</div>
					)}
					{/* kilocode_change: end */}

					{/* kilocode_change: disable {isProfileDisabled && (
				<div className="px-3">
					<ProfileViolationWarning />
				</div>
			)} */}

					<div id="roo-portal" />
					{/* kilocode_change: disable  */}
					{/* <CloudUpsellDialog open={isUpsellOpen} onOpenChange={closeUpsell} onConnect={handleConnect} /> */}
				</>
			)}
			<UsageDialog
				open={showUsageModal}
				onOpenChange={setShowUsageModal}
				currentTaskLabel={(task as any)?.title || currentTaskItem?.task}
				tokensIn={apiMetrics.totalTokensIn}
				tokensOut={apiMetrics.totalTokensOut}
				cacheWrites={apiMetrics.totalCacheWrites}
				cacheReads={apiMetrics.totalCacheReads}
				totalCost={apiMetrics.totalCost}
				contextTokens={apiMetrics.contextTokens}
				hasActiveTask={!!task}
			/>
		</div>
	)
}

const ChatView = forwardRef(ChatViewComponent)

export default ChatView
