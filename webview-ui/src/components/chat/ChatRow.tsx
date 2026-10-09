import { VSCodeBadge, VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { Undo2 } from "lucide-react"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Trans, useTranslation } from "react-i18next"
import { useSize } from "react-use"

import type { ClineMessage, FollowUpData, SuggestionItem } from "@roo-code/types"
import { Mode } from "@roo/modes"

import { ClineApiReqInfo, ClineAskUseMcpServer, ClineSayTool } from "@roo/ExtensionMessage"
import { COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"
import { TurnStats } from "./TurnStats"
import { safeJsonParse } from "@roo/safeJsonParse"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { findMatchingResourceOrTemplate } from "@src/utils/mcp"
import { removeLeadingNonAlphanumeric } from "@src/utils/removeLeadingNonAlphanumeric"
import { vscode } from "@src/utils/vscode"

import CodeAccordian, { extractFirstLineNumberFromDiff } from "../common/CodeAccordian"
import ImageBlock from "../common/ImageBlock"
import MarkdownBlock from "../common/MarkdownBlock"
import PasteChips, { getDisplayTextWithoutPasteChips } from "../common/PasteChips"
import Thumbnails, { ImageAttachment } from "../common/Thumbnails"
import { ToolUseBlock, ToolUseBlockHeader } from "../common/ToolUseBlock"
import ErrorRow from "./ErrorRow"
import GitHubDiffView from "./GitHubDiffView"
import { ReasoningBlock } from "./ReasoningBlock"
import UpdateTodoListToolBlock from "./UpdateTodoListToolBlock"

import McpResourceRow from "../mcp/McpResourceRow"

import { LowCreditWarning } from "../kilocode/chat/LowCreditWarning" // kilocode_change
import { OutOfCreditsBanner } from "../kilocode/chat/OutOfCreditsBanner" // kilocode_change
import { BatchFilePermission } from "./BatchFilePermission"
import { CommandExecution } from "./CommandExecution"
import { CommandExecutionError } from "./CommandExecutionError"
import { FollowUpSuggest } from "./FollowUpSuggest"
import { Markdown } from "./Markdown"
import { FILE_TYPE_LABELS, formatBytes } from "./FilePreviewModal"
import { MatterProgressIndicator, ProgressIndicator } from "./ProgressIndicator"
import { ReadOnlyChatText } from "./ReadOnlyChatText"
import ReportBugPreview from "./ReportBugPreview"

import { cn } from "@/lib/utils"
import { FigmaIcon, Globe02Icon, PlayIcon } from "@/utils/customIcons"
import { getIconForFilePath, getIconUrlByName } from "vscode-material-icons"
import { appendImages, normalizeImages } from "@src/utils/imageUtils"
import { InvalidModelWarning } from "../kilocode/chat/InvalidModelWarning" // kilocode_change
import { NewTaskPreview } from "../kilocode/chat/NewTaskPreview" // kilocode_change
import { StandardTooltip } from "../ui" // kilocode_change
import { useSelectedModel } from "../ui/hooks/useSelectedModel"
import { getModelIdKey } from "../kilocode/hooks/useSelectedModel"
import { AutoApprovedRequestLimitWarning } from "./AutoApprovedRequestLimitWarning"
import { ChatTextArea } from "./ChatTextArea"
import { CHAT_CONTENT_HORIZONTAL_PADDING } from "./chatLayout"
import ChatTimestamps from "./ChatTimestamps" // kilocode_change
import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import CodebaseSearchResultsDisplay from "./CodebaseSearchResultsDisplay"
import { CondenseContextErrorRow, CondensingContextRow, ContextCondenseRow } from "./ContextCondenseRow"
import { McpExecution } from "./McpExecution"
import { useOptionalAgentFileViewer } from "../agent/AgentFileViewerContext" // kilocode_change: for agent manager file viewer
import { PlanFileIndicator } from "./PlanFileIndicator"

interface ChatRowProps {
	message: ClineMessage
	messageIndex?: number // kilocode_change: for sticky message tracking
	lastModifiedMessage?: ClineMessage
	isExpanded: boolean
	isLast: boolean
	isStreaming: boolean
	onToggleExpand: (ts: number) => void
	onHeightChange: (isTaller: boolean) => void
	onSuggestionClick?: (suggestion: SuggestionItem, event?: React.MouseEvent) => void
	onBatchFileResponse?: (response: { [key: string]: boolean }) => void
	highlighted?: boolean // kilocode_change: Add highlighted prop
	enableCheckpoints?: boolean // kilocode_change
	onFollowUpUnmount?: () => void
	isFollowUpAnswered?: boolean
	editable?: boolean
	onPrimaryButtonClick?: (text?: string, images?: ImageAttachment[]) => void
	onSecondaryButtonClick?: (text?: string, images?: ImageAttachment[]) => void
	enableButtons?: boolean
	isAgentManagerMode?: boolean
	disableReasoningAutoExpand?: boolean
	profilePlan?: string
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}

const headerStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "0px",
	fontWeight: "600",
	fontSize: "12px",
	marginBottom: "2px",
	wordBreak: "break-word",
	opacity: "0.75",
	flexShrink: 0,
}

// Build a GitHub-style unified diff for fileEdit when backend doesn't supply one
const stripTruncationMarker = (value: string) =>
	value
		.replace(/\n?\.\.\.\(truncated\)\s*$/g, "")
		.replace(/\n?\.\.\. \(truncated\)\s*$/g, "")
		.trimEnd()

const buildFileEditDiff = (tool: ClineSayTool): string | undefined => {
	const path = tool.path || "file"
	const oldText = stripTruncationMarker((tool.search ?? "").trimEnd())
	const newText = stripTruncationMarker((tool.replace ?? tool.content ?? "").trimEnd())

	if (!oldText && !newText) return undefined

	const oldLines = oldText.split(/\r?\n/)
	const newLines = newText.split(/\r?\n/)
	let leadingContext = 0

	while (
		leadingContext < oldLines.length &&
		leadingContext < newLines.length &&
		oldLines[leadingContext] === newLines[leadingContext]
	) {
		leadingContext += 1
	}

	let trailingContext = 0
	while (
		trailingContext < oldLines.length - leadingContext &&
		trailingContext < newLines.length - leadingContext &&
		oldLines[oldLines.length - 1 - trailingContext] === newLines[newLines.length - 1 - trailingContext]
	) {
		trailingContext += 1
	}

	const contextBefore = leadingContext > 0 ? [oldLines[leadingContext - 1]] : []
	const contextAfter = trailingContext > 0 ? [oldLines[oldLines.length - trailingContext]] : []
	const changedOldLines = oldLines.slice(leadingContext, Math.max(leadingContext, oldLines.length - trailingContext))
	const changedNewLines = newLines.slice(leadingContext, Math.max(leadingContext, newLines.length - trailingContext))
	const visibleOldLines = [...contextBefore, ...changedOldLines, ...contextAfter]
	const visibleNewLines = [...contextBefore, ...changedNewLines, ...contextAfter]

	const lines: string[] = []
	lines.push(`--- a/${path}`)
	lines.push(`+++ b/${path}`)

	// Calculate hunk header with line numbers
	const contextOffset = contextBefore.length
	const hunkStart = Math.max(1, (tool.startLine ?? 1) + leadingContext - contextOffset)
	const oldStart = hunkStart
	const oldCount = visibleOldLines.length
	const newStart = hunkStart
	const newCount = visibleNewLines.length
	lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)

	for (const line of contextBefore) {
		lines.push(` ${line}`)
	}

	for (const line of changedOldLines) {
		lines.push(`-${line}`)
	}

	for (const line of changedNewLines) {
		lines.push(`+${line}`)
	}

	for (const line of contextAfter) {
		lines.push(` ${line}`)
	}

	return lines.join("\n")
}

// Detect signatures of a downstream stream disconnection (network drop, socket close, fetch failure).
// These surface as raw SDK/transport errors rather than structured API error objects.
const STREAM_DISCONNECT_PATTERNS: ReadonlyArray<RegExp> = [
	/econnreset/i,
	/socket hang up/i,
	/socket closed/i,
	/other side closed/i,
	/fetch failed/i,
	/network error/i,
	/terminated/i,
	/aborted/i,
	/underlying socket/i,
	/connection reset/i,
	/connection aborted/i,
	/etimedout/i,
	/enotfound/i,
	/read econnreset/i,
]

const isStreamDisconnectError = (message: string): boolean => {
	if (!message) return false
	const lower = message.toLowerCase()
	return STREAM_DISCONNECT_PATTERNS.some((pattern) => pattern.test(lower))
}

const hasTruncatedDiffContent = (diff?: string | null) =>
	Boolean(diff && (diff.includes("...(truncated)") || diff.includes("... (truncated)")))

const computeDiffStats = (diff?: string | null) => {
	if (!diff) return null
	let added = 0
	let removed = 0
	diff.split(/\r?\n/).forEach((line) => {
		if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) return
		if (line.startsWith("+")) added += 1
		else if (line.startsWith("-")) removed += 1
	})
	return { added, removed }
}

export const ChatRowContent = ({
	message,
	messageIndex, // kilocode_change: for sticky message tracking
	lastModifiedMessage,
	isExpanded,
	isLast,
	isStreaming,
	onToggleExpand,
	onSuggestionClick,
	onFollowUpUnmount,
	onBatchFileResponse,
	// enableCheckpoints, // kilocode_change
	isFollowUpAnswered,
	// _editable,
	onPrimaryButtonClick,
	onSecondaryButtonClick,
	enableButtons,
	isAgentManagerMode: _isAgentManagerMode,
	disableReasoningAutoExpand,
	profilePlan,
}: ChatRowContentProps) => {
	const { t } = useTranslation()

	// kilocode_change: read this optionally so switching out of Agent Manager dismisses the panel instead of throwing
	const optionalAgentFileViewer = useOptionalAgentFileViewer()
	const agentFileViewer = _isAgentManagerMode ? optionalAgentFileViewer : null

	// kilocode_change: add showTimestamps
	const {
		mcpServers,
		alwaysAllowMcp,
		// currentCheckpoint,
		mode,
		apiConfiguration,
		showTimestamps,
	} = useExtensionState()
	const { info: model } = useSelectedModel(apiConfiguration)
	// Get model ID key for the current provider (used when saving edits with model changes)
	const modelIdKey = apiConfiguration?.apiProvider
		? getModelIdKey({ provider: apiConfiguration.apiProvider })
		: undefined
	const [isEditing, setIsEditing] = useState(false)
	const [editedContent, setEditedContent] = useState("")
	const [editMode, setEditMode] = useState<Mode>(mode || "code")
	const [editImages, setEditImages] = useState<ImageAttachment[]>([])

	// Material icon theme base URI, injected by the extension host. Used to
	// resolve file-type icons for the generate_file chat row (same library as
	// mention chips and the context menu).
	const [materialIconsBaseUri, setMaterialIconsBaseUri] = useState("")
	useEffect(() => {
		if (typeof window !== "undefined" && (window as any).MATERIAL_ICONS_BASE_URI) {
			setMaterialIconsBaseUri((window as any).MATERIAL_ICONS_BASE_URI)
		}
	}, [])

	const streamingWords = useMemo(() => ["Working"], [])
	const [currentWordIndex, setCurrentWordIndex] = useState(() => Math.floor(Math.random() * streamingWords.length))

	const isStreamingWords = useMemo(() => {
		// Animation should only be active for the last message - if this is not the last message, never animate
		if (!isLast) return false
		const type = message.type === "ask" ? message.ask : message.say
		if (type !== "api_req_started") return false
		if (!message.text) return false
		const info = safeJsonParse<ClineApiReqInfo>(message.text)
		if (!info) return false
		// Streaming words should only animate while the request is still in progress
		// (no cancel reason, no failed msg)
		const apiReqCancelReason = info.cancelReason
		const apiRequestFailedMessage =
			isLast && lastModifiedMessage?.ask === "api_req_failed" ? lastModifiedMessage?.text : undefined
		const apiReqStreamingFailedMessage = info.streamingFailedMessage

		return (
			apiReqCancelReason === undefined &&
			apiRequestFailedMessage === undefined &&
			apiReqStreamingFailedMessage === undefined
		)
	}, [message.type, message.ask, message.say, message.text, isLast, lastModifiedMessage])

	useEffect(() => {
		if (!isStreamingWords) return

		const interval = setInterval(() => {
			setCurrentWordIndex((prev) => {
				let newIndex
				do {
					newIndex = Math.floor(Math.random() * streamingWords.length)
				} while (newIndex === prev && streamingWords.length > 1)
				return newIndex
			})
		}, 1000)
		return () => clearInterval(interval)
	}, [streamingWords.length, isStreamingWords])

	// Handle message events for image selection during edit mode
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const msg = event.data
			if (msg.type === "selectedImages" && msg.context === "edit" && msg.messageTs === message.ts && isEditing) {
				setEditImages((prevImages) =>
					appendImages(prevImages, normalizeImages(msg.images), MAX_IMAGES_PER_MESSAGE),
				)
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [isEditing, message.ts])

	// Memoized callback to prevent re-renders caused by inline arrow functions.
	const handleToggleExpand = useCallback(() => {
		onToggleExpand(message.ts)
	}, [onToggleExpand, message.ts])

	// Handle edit button click
	const handleEditClick = useCallback(() => {
		setIsEditing(true)
		setEditedContent(message.text || "")
		setEditImages(normalizeImages(message.images))
		setEditMode(mode || "code")
		// Edit mode is now handled entirely in the frontend
		// No need to notify the backend
	}, [message.text, message.images, mode])

	// Handle cancel edit
	const handleCancelEdit = useCallback(() => {
		setIsEditing(false)
		setEditedContent(message.text || "")
		setEditImages(normalizeImages(message.images))
		setEditMode(mode || "code")
	}, [message.text, message.images, mode])

	// Handle save edit
	const handleSaveEdit = useCallback(
		(content?: string) => {
			setIsEditing(false)
			// Send edited message to backend with current model configuration
			// This ensures model changes during edit are preserved
			// For vscode-lm provider, we need to construct the model ID from the selector
			let apiModelId: string | undefined
			if (apiConfiguration?.apiProvider === "vscode-lm" && apiConfiguration?.vsCodeLmModelSelector) {
				apiModelId = `${apiConfiguration.vsCodeLmModelSelector.vendor}/${apiConfiguration.vsCodeLmModelSelector.family}`
			} else if (modelIdKey) {
				apiModelId = apiConfiguration?.[modelIdKey] as string | undefined
			}
			// Convert ImageAttachment[] back to string[] for backend compatibility
			const imageDataUrls = editImages.map((img) => img.dataUrl)
			vscode.postMessage({
				type: "submitEditedMessage",
				value: message.ts,
				editedMessageContent: content ?? editedContent,
				images: imageDataUrls,
				apiProvider: apiConfiguration?.apiProvider,
				apiModelId,
				thirdPartySelectedModel: apiConfiguration?.thirdPartySelectedModel,
			})
		},
		[message.ts, editedContent, editImages, apiConfiguration, modelIdKey],
	)

	// Handle image selection for editing
	const handleSelectImages = useCallback(() => {
		vscode.postMessage({ type: "selectImages", context: "edit", messageTs: message.ts })
	}, [message.ts])

	// kilocode_change: usageMissing, inferenceProvider
	const [cost, usageMissing, inferenceProvider, apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
		if (message.text !== null && message.text !== undefined && message.say === "api_req_started") {
			const info = safeJsonParse<ClineApiReqInfo>(message.text)
			return [
				info?.cost,
				info?.usageMissing,
				info?.inferenceProvider,
				info?.cancelReason,
				info?.streamingFailedMessage,
			]
		}

		return [undefined, undefined, undefined]
	}, [message.text, message.say])

	// forked_change start: hide cost display check
	const { hideCostBelowThreshold } = useExtensionState()
	const shouldShowCost = useMemo(() => {
		if (cost === undefined || cost === null || cost <= 0) return false
		if (isExpanded) return true
		const threshold = hideCostBelowThreshold ?? 0
		return cost >= threshold
	}, [cost, isExpanded, hideCostBelowThreshold])
	// forked_change end: hide cost display check

	// When resuming task, last wont be api_req_failed but a resume_task
	// message, so api_req_started will show loading spinner. That's why we just
	// remove the last api_req_started that failed without streaming anything.
	const apiRequestFailedMessage =
		isLast && lastModifiedMessage?.ask === "api_req_failed" // if request is retried then the latest message is a api_req_retried
			? lastModifiedMessage?.text
			: undefined

	const isCommandExecuting =
		isLast && lastModifiedMessage?.ask === "command" && lastModifiedMessage?.text?.includes(COMMAND_OUTPUT_STRING)

	const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

	const type = message.type === "ask" ? message.ask : message.say

	const normalColor = "var(--vscode-foreground)"
	const errorColor = "var(--vscode-errorForeground)"
	const successColor = "var(--vscode-button-background)"
	const cancelledColor = "var(--vscode-descriptionForeground)"

	const [icon, title] = useMemo(() => {
		switch (type) {
			case "error":
			case "mistake_limit_reached":
				return [null, null] // These will be handled by ErrorRow component
			case "command":
				return [
					isCommandExecuting ? <ProgressIndicator /> : null,
					// <TerminalSquare className="size-3 -mr-1" aria-label="Terminal icon" />
					<span style={headerStyle}>{t("chat:commandExecution.running")}</span>,
				]
			case "use_mcp_server":
				const mcpServerUse = safeJsonParse<ClineAskUseMcpServer>(message.text)
				if (mcpServerUse === undefined) {
					return [null, null]
				}
				return [
					isMcpServerResponding ? <ProgressIndicator /> : null,
					<span style={{ color: normalColor }}>
						{mcpServerUse.type === "use_mcp_tool"
							? t("chat:mcp.wantsToUseTool", { serverName: mcpServerUse.serverName })
							: t("chat:mcp.wantsToAccessResource", { serverName: mcpServerUse.serverName })}
					</span>,
				]
			case "completion_result":
				return [
					<span style={{ color: successColor, marginBottom: "-1.5px" }}></span>,
					<span style={{ color: successColor }}>{t("chat:taskCompleted")}</span>,
				]
			case "api_req_retry_delayed":
				return []
			case "api_req_started":
				const getIconSpan = (iconName: string, color: string) => (
					<div
						style={{
							width: 16,
							height: 16,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}>
						<span
							className={`codicon codicon-${iconName}`}
							style={{ color, fontSize: 16, marginBottom: "-1.5px" }}
						/>
					</div>
				)
				return [
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							getIconSpan("error", cancelledColor)
						) : (
							getIconSpan("error", errorColor)
						)
					) : cost !== null && cost !== undefined ? (
						getIconSpan("arrow-swap", normalColor)
					) : apiRequestFailedMessage ? null : (
						<MatterProgressIndicator />
					),
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							<span style={{ color: normalColor }}>{t("chat:apiRequest.cancelled")}</span>
						) : (
							<span style={{ color: errorColor }}>{t("chat:apiRequest.streamingFailed")}</span>
						)
					) : cost !== null && cost !== undefined ? (
						// forked_change start: tooltip
						<StandardTooltip content={inferenceProvider && `Inference Provider: ${inferenceProvider}`}>
							<span style={{ color: normalColor }}>{t("chat:apiRequest.title")}</span>
						</StandardTooltip>
					) : // forked_change end
					apiRequestFailedMessage ? null : (
						<span style={{ color: normalColor, display: "inline-flex", alignItems: "center", gap: 8 }}>
							{streamingWords[currentWordIndex]}
							<TurnStats />
						</span>
					),
				]
			case "followup":
				return [
					// <MessageCircleQuestionMark className="w-4 shrink-0" aria-label="Question icon" />,
					<span style={{ color: normalColor }}>{t("chat:questions.hasQuestion")}</span>,
				]
			default:
				return [null, null]
		}
	}, [
		type,
		isCommandExecuting,
		message,
		isMcpServerResponding,
		apiReqCancelReason,
		cost,
		apiRequestFailedMessage,
		t,
		inferenceProvider,
		currentWordIndex,
		streamingWords,
	])

	const tool = useMemo(() => {
		const isToolAsk = message.type === "ask" && message.ask === "tool"
		const isToolSay = message.type === "say" && (message.say as any) === "tool"

		if (isToolAsk || isToolSay) {
			return safeJsonParse<ClineSayTool>(message.text)
		}

		return null
	}, [message.type, message.ask, message.say, message.text])

	const followUpData = useMemo(() => {
		if (message.type === "ask" && message.ask === "followup" && !message.partial) {
			return safeJsonParse<FollowUpData>(message.text)
		}
		return null
	}, [message.type, message.ask, message.partial, message.text])

	useEffect(() => {
		if (!agentFileViewer || message.partial) return
		if (tool?.tool !== "fileEdit" && tool?.tool !== "newFileCreated") return

		agentFileViewer.openDiffReview()
	}, [agentFileViewer, message.partial, message.ts, tool?.tool])

	if (tool) {
		const toolIcon = (name: string) => (
			<span
				className={`codicon codicon-${name}`}
				style={{ color: "var(--vscode-foreground)", marginBottom: "-1.5px" }}></span>
		)

		switch (tool.tool) {
			case "fileEdit": {
				const fallbackFileEditDiff = buildFileEditDiff(tool)
				const fileEditDiff =
					tool.diff && !hasTruncatedDiffContent(tool.diff) ? tool.diff : (fallbackFileEditDiff ?? tool.diff)
				const diffStats = computeDiffStats(fileEditDiff)
				// Use startLine from tool if available, otherwise extract from diff
				const editLineNumber = tool.startLine ?? extractFirstLineNumberFromDiff(fileEditDiff)
				const fileName = tool.path?.split("/").pop() || tool.path || "file"
				const openFileWithLine = () => {
					// kilocode_change: in agent manager mode, keep the right panel on the aggregate pending diff review
					if (agentFileViewer) {
						agentFileViewer.openDiffReview()
						return
					}
					// For absolute paths (outside workspace or outside CWD but inside workspace), use the path directly
					// For relative paths, prefix with ./
					const filePath =
						tool.isOutsideWorkspace || tool.path?.startsWith("/") ? tool.path : "./" + tool.path
					vscode.postMessage({
						type: "openFile",
						text: filePath,
						values: editLineNumber ? { line: editLineNumber } : undefined,
					})
				}
				return (
					<>
						<div
							className={cn(
								"animate-fade-up flex flex-row gap-1 w-full min-w-0 cursor-pointer",
								message.partial ? "items-center" : "items-start",
							)}
							onClick={handleToggleExpand}>
							<div style={headerStyle} className="">
								{message.partial ? (
									<MatterProgressIndicator className="relative top-px mr-1" />
								) : tool.isProtected ? (
									<span
										className="codicon codicon-lock"
										style={{
											color: "var(--vscode-editorWarning-foreground)",
											marginBottom: "-1.5px",
										}}
									/>
								) : null}
								<span style={{}}>
									{message.partial
										? tool.isProtected
											? t("chat:fileOperations.editingFileProtected")
											: tool.isOutsideWorkspace
												? t("chat:fileOperations.editingFileOutsideWorkspace")
												: t("chat:fileOperations.editingFile")
										: tool.isProtected
											? t("chat:fileOperations.wantsToEditProtected")
											: tool.isOutsideWorkspace
												? t("chat:fileOperations.wantsToEditOutsideWorkspace")
												: t("chat:fileOperations.wantsToEdit")}
								</span>
							</div>
							<div
								className={cn(
									"flex flex-1 items-center gap-2 min-w-0",
									message.partial ? "relative -top-px" : "-mt-[1px]",
								)}>
								{tool.path ? (
									<span
										className="cursor-pointer hover:underline text-vscode-descriptionForeground min-w-0 flex-1 truncate"
										role="button"
										tabIndex={0}
										title={tool.path + (editLineNumber ? `:${editLineNumber}` : "")}
										aria-label={tool.path}
										onClick={(e) => {
											e.stopPropagation()
											openFileWithLine()
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault()
												e.stopPropagation()
												openFileWithLine()
											}
										}}>
										{fileName}
									</span>
								) : null}
								{diffStats ? (
									<span className="text-xs text-vscode-descriptionForeground flex shrink-0 gap-1 ml-0 mt-[1px]">
										<span style={{ color: "#3fa266" }}>+{diffStats.added}</span>
										<span style={{ color: "#fc6b83" }}>-{diffStats.removed}</span>
									</span>
								) : null}
							</div>
						</div>
						{isExpanded && (
							<GitHubDiffView
								diff={fileEditDiff ?? tool.content ?? tool.replace ?? ""}
								filePath={tool.path}
								isProtected={tool.isProtected}
								isOutsideWorkspace={tool.isOutsideWorkspace}
								diffStats={diffStats}
								isLoading={message.partial}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
								onOpenFile={openFileWithLine}
							/>
						)}
					</>
				)
			}
			case "multiFileEdit": {
				// This case is now mostly unused since multiFileEditTool emits individual fileEdit messages
				// Keeping as fallback for any edge cases
				return (
					<div style={headerStyle} className="">
						<span style={{}}>{t("chat:fileOperations.wantsToEditMultiple", { count: 1 })}</span>
					</div>
				)
			}
			case "planFileEdit":
				return (
					<div
						className={`animate-fade-up flex ${isExpanded ? "flex-col" : "flex-col"} gap-1 items-start pb-2`}>
						<div style={headerStyle} className="">
							<span style={{}}>Plan file edited</span>
						</div>
						<div className="">
							<PlanFileIndicator filename={tool.filename || "plan.md"} isActive={true} />
							{isExpanded ? (
								<MarkdownBlock markdown={tool.content ?? ""} />
							) : (
								<CodeAccordian
									path={undefined}
									code={tool.content ?? ""}
									language="markdown"
									isLoading={message.partial}
									isExpanded={isExpanded}
									onToggleExpand={handleToggleExpand}
								/>
							)}
							{!message.partial && (
								<div className="flex gap-2 mt-2">
									<VSCodeButton
										onClick={() => {
											vscode.postMessage({
												type: "implementPlan",
												payload: {
													planFile: tool.filename || "plan.md",
													planContent: tool.content || "",
												},
											})
										}}>
										<PlayIcon className="w-4 h-4 mr-1 rtl:-scale-x-100" />
										Implement
									</VSCodeButton>
									<VSCodeButton
										onClick={() => {
											vscode.postMessage({
												type: "openPlanFile",
												payload: {
													planFile: tool.filename || "plan.md",
												},
											})
										}}>
										<span className="codicon codicon-open-preview mr-1" />
										Open in Editor
									</VSCodeButton>
								</div>
							)}
						</div>
					</div>
				)
			case "codebaseSearch": {
				return (
					<div className="animate-fade-up" style={headerStyle}>
						{/* {toolIcon("search")} */}
						<span style={{}}>
							{tool.path ? (
								<Trans
									i18nKey="chat:codebaseSearch.wantsToSearchWithPath"
									components={{ code: <code></code> }}
									values={{ query: tool.query, path: tool.path }}
								/>
							) : (
								<Trans
									i18nKey="chat:codebaseSearch.wantsToSearch"
									components={{ code: <code></code> }}
									values={{ query: tool.query }}
								/>
							)}
						</span>
					</div>
				)
			}
			case "updateTodoList" as any: {
				// Rendered by the pinned todo list in ChatView (single static
				// position, updated in place) instead of a new chat row per update.
				return null
			}
			case "newFileCreated": {
				// Build diff for new file (all additions)
				const newFilePath = tool.path || "file"
				const newFileContent = tool.content || ""
				const newFileLines = newFileContent.split(/\r?\n/)
				const newFileDiff =
					newFileLines.length > 0
						? [
								`--- /dev/null`,
								`+++ b/${newFilePath}`,
								`@@ -0,0 +1,${newFileLines.length} @@`,
								...newFileLines.map((line: string) => `+${line}`),
							].join("\n")
						: ""
				const newFileDiffStats = computeDiffStats(newFileDiff)
				const newFileName = tool.path?.split("/").pop() || tool.path || "file"
				const openNewFileWithLine = () => {
					// kilocode_change: in agent manager mode, keep the right panel on the aggregate pending diff review
					if (agentFileViewer) {
						agentFileViewer.openDiffReview()
						return
					}
					// For absolute paths (outside workspace or outside CWD but inside workspace), use the path directly
					// For relative paths, prefix with ./
					const filePath =
						tool.isOutsideWorkspace || tool.path?.startsWith("/") ? tool.path : "./" + tool.path
					vscode.postMessage({
						type: "openFile",
						text: filePath,
						values: undefined,
					})
				}
				return (
					<>
						<div
							className={cn(
								"animate-fade-up flex flex-row gap-1 w-full min-w-0 cursor-pointer",
								message.partial ? "items-center" : "items-start",
							)}
							onClick={handleToggleExpand}>
							<div style={headerStyle} className="">
								{message.partial ? (
									<MatterProgressIndicator className="relative top-px mr-1" />
								) : tool.isProtected ? (
									<span
										className="codicon codicon-lock"
										style={{
											color: "var(--vscode-editorWarning-foreground)",
											marginBottom: "-1.5px",
										}}
									/>
								) : null}
								<span style={{}}>
									{message.partial
										? tool.isProtected
											? t("chat:fileOperations.creatingFileProtected")
											: tool.isOutsideWorkspace
												? t("chat:fileOperations.creatingFileOutsideWorkspace")
												: t("chat:fileOperations.creatingFile")
										: tool.isProtected
											? t("chat:fileOperations.wantsToEditProtected")
											: tool.isOutsideWorkspace
												? t("chat:fileOperations.wantsToCreateOutsideWorkspace")
												: t("chat:fileOperations.wantsToCreate")}
								</span>
							</div>
							<div
								className={cn(
									"flex flex-1 items-center gap-2 min-w-0",
									message.partial ? "relative -top-px" : "-mt-[1px]",
								)}>
								{tool.path ? (
									<span
										className="cursor-pointer hover:underline text-vscode-descriptionForeground min-w-0 flex-1 truncate"
										role="button"
										tabIndex={0}
										title={tool.path}
										aria-label={tool.path}
										onClick={(e) => {
											e.stopPropagation()
											openNewFileWithLine()
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault()
												e.stopPropagation()
												openNewFileWithLine()
											}
										}}>
										{newFileName}
									</span>
								) : null}
								{newFileDiffStats ? (
									<span className="text-xs text-vscode-descriptionForeground flex shrink-0 gap-1 ml-0 mt-[1px]">
										<span style={{ color: "#3fa266" }}>+{newFileDiffStats.added}</span>
										<span style={{ color: "#fc6b83" }}>-{newFileDiffStats.removed}</span>
									</span>
								) : null}
							</div>
						</div>
						{isExpanded && (
							<GitHubDiffView
								diff={newFileDiff}
								filePath={tool.path}
								isProtected={tool.isProtected}
								isOutsideWorkspace={tool.isOutsideWorkspace}
								diffStats={newFileDiffStats}
								isLoading={message.partial}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
								onOpenFile={openNewFileWithLine}
							/>
						)}
					</>
				)
			}
			case "readFile":
				// Check if this is a batch file permission request
				const isBatchRequest = message.type === "ask" && tool.batchFiles && Array.isArray(tool.batchFiles)

				if (isBatchRequest) {
					return (
						<>
							<div style={headerStyle}>
								{/* <Eye className="w-4 shrink-0" aria-label="View files icon" /> */}
								<span style={{}}>{t("chat:fileOperations.wantsToReadMultiple")}</span>
							</div>
							<BatchFilePermission
								files={tool.batchFiles || []}
								onPermissionResponse={(response) => {
									onBatchFileResponse?.(response)
								}}
								ts={message?.ts}
							/>
						</>
					)
				}

				const splitPaths = tool.path?.split("/")
				let fileName = splitPaths?.[splitPaths.length - 1]
				fileName = removeLeadingNonAlphanumeric(fileName ?? "") + "\u200E"

				// Helper to open file - in agent manager mode, use right panel; otherwise use editor
				const openReadFile = () => {
					// kilocode_change: in agent manager mode, open file in right panel if content available
					if (agentFileViewer && tool.content) {
						agentFileViewer.openFileInViewer({
							filePath: tool.path || "file",
							content: tool.content,
							line: tool.offset,
							isOutsideWorkspace: tool.isOutsideWorkspace,
						})
						return
					}
					// For absolute paths (outside workspace or outside CWD but inside workspace), use the path directly
					// For relative paths, prefix with ./
					const filePath =
						tool.isOutsideWorkspace || tool.path?.startsWith("/") ? tool.path : "./" + tool.path
					vscode.postMessage({
						type: "openFile",
						text: filePath,
						values: tool.offset ? { line: tool.offset } : undefined,
					})
				}

				// Regular single file read request
				return (
					<div className="flex items-center gap-1 min-w-0">
						<div style={headerStyle}>
							{/* <FileCode2 className="w-3 h-3 shrink-0" aria-label="Read file icon" /> */}
							<span style={{}}>
								{message.type === "ask"
									? tool.isOutsideWorkspace
										? t("chat:fileOperations.wantsToReadOutsideWorkspace")
										: tool.additionalFileCount && tool.additionalFileCount > 0
											? t("chat:fileOperations.wantsToReadAndXMore", {
													count: tool.additionalFileCount,
												})
											: t("chat:fileOperations.wantsToRead")
									: t("chat:fileOperations.didRead")}
							</span>
						</div>
						<div className="flex-1 min-w-0">
							<ToolUseBlock>
								<ToolUseBlockHeader className="group w-full min-w-0" onClick={openReadFile}>
									{tool.path?.startsWith(".") && <span>.</span>}
									<span
										className="min-w-0 truncate text-left rtl"
										title={tool.path}
										aria-label={tool.path}>
										{fileName}
										{tool.offset !== undefined && tool.limit !== undefined
											? `#L${tool.offset}-${tool.offset + tool.limit - 1}`
											: tool.reason
													?.replace("lines", "#L")
													?.replaceAll(" ", "")
													.replaceAll("(", "")
													.replaceAll(")", "")}
									</span>
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</div>
				)
			case "webFetch":
				return (
					<div className="flex gap-1">
						<div style={headerStyle}>
							<Globe02Icon className="size-3 mr-1" />
							<span style={{}}>Fetched</span>
						</div>
						<div className="">
							<ToolUseBlock>
								<ToolUseBlockHeader>
									<span
										style={{
											fontWeight: "500",
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
											maxWidth: "100%",
											display: "block",
										}}>
										{tool.content}
									</span>
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</div>
				)
			case "webSearch": {
				const searchQuery = tool.query
				const searchResults = tool.results

				return (
					<div className="flex gap-1">
						<div style={headerStyle}>
							<Globe02Icon className="size-3 mr-1" />
							<span style={{}}>Searched</span>
						</div>
						<div className="">
							<ToolUseBlock>
								<ToolUseBlockHeader style={{}}>
									<div
										style={{
											fontWeight: "500",
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
										}}>
										{searchQuery}
									</div>
									{searchResults && searchResults.length > 0 && (
										<div
											style={{
												display: "flex",
												flexDirection: "column",
												gap: "4px",
												width: "100%",
											}}>
											{searchResults.map((result, index) => (
												<div
													key={index}
													style={{
														display: "flex",
														alignItems: "center",
														gap: "4px",
														fontSize: "calc(var(--vscode-font-size) - 1px)",
														color: "var(--vscode-descriptionForeground)",
													}}>
													<span
														className="codicon codicon-link"
														style={{ fontSize: "12px" }}></span>
													<span>{result.title || result.url}</span>
												</div>
											))}
										</div>
									)}
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</div>
				)
			}
			case "fetchInstructions":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("file-code")}
							<span style={{}}>{t("chat:instructions.wantsToFetch")}</span>
						</div>
						<div className="">
							<CodeAccordian
								code={tool.content}
								language="markdown"
								isLoading={message.partial}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</>
				)
			case "listFilesTopLevel":
				return (
					<div
						className={`flex ${isExpanded ? "flex-col items-start" : "flex-row items-center"} gap-1 min-w-0`}>
						<div style={headerStyle}>
							{/* <ListTree className="w-4 shrink-0" aria-label="List files icon" /> */}
							<span style={{}}>
								{message.type === "ask"
									? tool.isOutsideWorkspace
										? t("chat:directoryOperations.wantsToViewTopLevelOutsideWorkspace")
										: t("chat:directoryOperations.wantsToViewTopLevel")
									: tool.isOutsideWorkspace
										? t("chat:directoryOperations.didViewTopLevelOutsideWorkspace")
										: t("chat:directoryOperations.didViewTopLevel")}
							</span>
						</div>
						<div className="flex-1 min-w-0">
							<CodeAccordian
								headerClassName="w-full min-w-0"
								path={tool.path}
								code={tool.content}
								language="shell-session"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</div>
				)
			case "listFilesRecursive":
				return (
					<div
						className={`flex ${isExpanded ? "flex-col items-start" : "flex-row items-center"} gap-1 min-w-0`}>
						<div style={headerStyle}>
							{/* <FolderTree className="w-4 shrink-0" aria-label="Folder tree icon" /> */}
							<span style={{}}>
								{message.type === "ask"
									? tool.isOutsideWorkspace
										? t("chat:directoryOperations.wantsToViewRecursiveOutsideWorkspace")
										: t("chat:directoryOperations.wantsToViewRecursive")
									: tool.isOutsideWorkspace
										? t("chat:directoryOperations.didViewRecursiveOutsideWorkspace")
										: t("chat:directoryOperations.didViewRecursive")}
							</span>
						</div>
						<div className="flex-1 min-w-0">
							<CodeAccordian
								headerClassName="w-full min-w-0"
								path={tool.path}
								code={tool.content}
								language="shellsession"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</div>
				)
			case "listCodeDefinitionNames":
				return (
					<div
						className={`flex ${isExpanded ? "flex-col items-start" : "flex-row items-center"} gap-1 min-w-0`}>
						<div style={headerStyle}>
							<span style={{}}>
								{message.type === "ask"
									? tool.isOutsideWorkspace
										? t("chat:directoryOperations.wantsToViewDefinitionsOutsideWorkspace")
										: t("chat:directoryOperations.wantsToViewDefinitions")
									: tool.isOutsideWorkspace
										? t("chat:directoryOperations.didViewDefinitionsOutsideWorkspace")
										: t("chat:directoryOperations.didViewDefinitions")}
							</span>
						</div>
						<div className="flex-1 min-w-0">
							<CodeAccordian
								headerClassName="w-full min-w-0"
								path={tool.path}
								code={tool.content}
								language="markdown"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</div>
				)
			case "searchFiles":
				return (
					<div className={`flex ${isExpanded ? "flex-col" : "flex-row"} gap-1 min-w-0`}>
						<div style={{ ...headerStyle, flexShrink: 1, minWidth: 0 }}>
							{/* <Search className="w-3 h-3 shrink-0" aria-label="Search icon" /> */}
							<span style={{ minWidth: 0 }}>
								{message.type === "ask" ? (
									<Trans
										i18nKey={
											tool.isOutsideWorkspace
												? "chat:directoryOperations.wantsToSearchOutsideWorkspace"
												: "chat:directoryOperations.wantsToSearch"
										}
										components={{ code: <code className="font-medium text-xs">{tool.regex}</code> }}
										values={{ regex: tool.regex }}
										className="text-xs"
									/>
								) : (
									<Trans
										i18nKey={
											tool.isOutsideWorkspace
												? "chat:directoryOperations.didSearchOutsideWorkspace"
												: "chat:directoryOperations.didSearch"
										}
										components={{ code: <code className="font-medium">{tool.regex}</code> }}
										values={{ regex: tool.regex }}
									/>
								)}
								{tool.filePattern && (
									<>
										<span className="mx-1 font-normal" aria-hidden="true">
											·
										</span>
										<code className="font-medium text-xs">{tool.filePattern}</code>
									</>
								)}
							</span>
						</div>
						<div className="flex-1 min-w-0">
							<CodeAccordian
								headerClassName="w-full min-w-0"
								path={tool.path!}
								code={tool.content}
								language="shellsession"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</div>
				)
			case "lsp":
				return (
					<div className={`flex ${isExpanded ? "flex-col" : "flex-row"} gap-1 min-w-0`}>
						<div style={{ ...headerStyle, flexShrink: 1, minWidth: 0 }}>
							<span style={{ minWidth: 0 }}>
								{message.type === "ask" ? (
									<Trans
										i18nKey="chat:lsp.wantsToUse"
										components={{ code: <code className="font-medium">{tool.operation}</code> }}
										values={{ operation: tool.operation, path: tool.path }}
									/>
								) : (
									<Trans
										i18nKey="chat:lsp.didUse"
										components={{ code: <code className="font-medium">{tool.operation}</code> }}
										values={{ operation: tool.operation, path: tool.path }}
									/>
								)}
							</span>
						</div>
						<div className="flex-1 min-w-0">
							<CodeAccordian
								headerClassName="w-full min-w-0"
								path={tool.path}
								code={tool.content}
								language="markdown"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</div>
				)
			case "switchMode":
				return (
					<>
						<div style={headerStyle}>
							{/* <PocketKnife className="w-4 shrink-0" aria-label="Switch mode icon" /> */}
							<span style={{}}>
								{message.type === "ask" ? (
									<>
										{tool.reason ? (
											<Trans
												i18nKey="chat:modes.wantsToSwitchWithReason"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode, reason: tool.reason }}
											/>
										) : (
											<Trans
												i18nKey="chat:modes.wantsToSwitch"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode }}
											/>
										)}
									</>
								) : (
									<>
										{tool.reason ? (
											<Trans
												i18nKey="chat:modes.didSwitchWithReason"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode, reason: tool.reason }}
											/>
										) : (
											<Trans
												i18nKey="chat:modes.didSwitch"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode }}
											/>
										)}
									</>
								)}
							</span>
						</div>
					</>
				)
			case "newTask":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("tasklist")}
							<span style={{}}>
								<Trans
									i18nKey="chat:subtasks.wantsToCreate"
									components={{ code: <code>{tool.mode}</code> }}
									values={{ mode: tool.mode }}
								/>
							</span>
						</div>
						<div
							style={{
								marginTop: "4px",
								backgroundColor: "var(--vscode-badge-background)",
								border: "none",
								borderRadius: "4px 4px 0 0",
								overflow: "hidden",
								marginBottom: "2px",
							}}>
							<div
								style={{
									padding: "6px 10px 6px 12px",
									backgroundColor: "var(--vscode-badge-background)",
									borderBottom: "none",

									fontSize: "var(--vscode-font-size)",
									color: "var(--vscode-badge-foreground)",
									display: "flex",
									alignItems: "center",
									gap: "6px",
								}}>
								<span className="codicon codicon-arrow-right"></span>
								{t("chat:subtasks.newTaskContent")}
							</div>
							<div style={{ padding: "8px 12px", backgroundColor: "var(--vscode-editor-background)" }}>
								<MarkdownBlock markdown={tool.content} />
							</div>
						</div>
					</>
				)
			case "finishTask":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("check-all")}
							<span style={{}}>{t("chat:subtasks.wantsToFinish")}</span>
						</div>
						<div
							style={{
								marginTop: "4px",
								backgroundColor: "var(--vscode-editor-background)",
								border: "none",
								borderRadius: "4px",
								overflow: "hidden",
								marginBottom: "8px",
							}}>
							<div
								style={{
									padding: "6px 10px 6px 12px",
									backgroundColor: "var(--vscode-badge-background)",
									borderBottom: "none",

									fontSize: "var(--vscode-font-size)",
									color: "var(--vscode-badge-foreground)",
									display: "flex",
									alignItems: "center",
									gap: "6px",
								}}>
								<span className="codicon codicon-check"></span>
								{t("chat:subtasks.completionContent")}
							</div>
							<div style={{ padding: "8px 12px", backgroundColor: "var(--vscode-editor-background)" }}>
								<MarkdownBlock markdown={t("chat:subtasks.completionInstructions")} />
							</div>
						</div>
					</>
				)
			case "runSlashCommand": {
				const slashCommandInfo = tool
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("play")}
							<span style={{}}>
								{message.type === "ask"
									? t("chat:slashCommand.wantsToRun")
									: t("chat:slashCommand.didRun")}
							</span>
						</div>
						<div
							style={{
								marginTop: "4px",
								backgroundColor: "var(--vscode-textCodeBlock-background)",
								border: "none",
								borderRadius: "6px",
								overflow: "hidden",
								cursor: "pointer",
							}}
							onClick={handleToggleExpand}>
							<ToolUseBlockHeader
								className="group"
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									padding: "7px 10px",
								}}>
								<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
									<span style={{ fontWeight: "500", fontSize: "var(--vscode-font-size)" }}>
										/{slashCommandInfo.command}
									</span>
									{slashCommandInfo.source && (
										<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
											{slashCommandInfo.source}
										</VSCodeBadge>
									)}
								</div>
							</ToolUseBlockHeader>
							{isExpanded && (slashCommandInfo.args || slashCommandInfo.description) && (
								<div
									style={{
										padding: "8px 12px",
										borderTop: "none",
										display: "flex",
										flexDirection: "column",
										gap: "8px",
									}}>
									{slashCommandInfo.args && (
										<div>
											<span style={{ fontWeight: "500" }}>Arguments: </span>
											<span style={{ color: "var(--vscode-descriptionForeground)" }}>
												{slashCommandInfo.args}
											</span>
										</div>
									)}
									{slashCommandInfo.description && (
										<div style={{ color: "var(--vscode-descriptionForeground)" }}>
											{slashCommandInfo.description}
										</div>
									)}
								</div>
							)}
						</div>
					</>
				)
			}
			case "generateImage":
				return (
					<>
						<div style={headerStyle}>
							{tool.isProtected ? (
								<span
									className="codicon codicon-lock"
									style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
								/>
							) : (
								toolIcon("file-media")
							)}
							<span style={{}}>
								{message.type === "ask"
									? tool.isProtected
										? t("chat:fileOperations.wantsToGenerateImageProtected")
										: tool.isOutsideWorkspace
											? t("chat:fileOperations.wantsToGenerateImageOutsideWorkspace")
											: t("chat:fileOperations.wantsToGenerateImage")
									: t("chat:fileOperations.didGenerateImage")}
							</span>
						</div>
						{message.type === "ask" && (
							<div className="">
								<CodeAccordian
									path={tool.path}
									code={tool.content}
									language="text"
									isExpanded={isExpanded}
									onToggleExpand={handleToggleExpand}
								/>
							</div>
						)}
					</>
				)
			// forked_change start: background shells
			case "checkBackground":
			case "killBackground": {
				const label =
					tool.tool === "checkBackground"
						? message.partial
							? t("chat:backgroundShells.checking")
							: t("chat:backgroundShells.checked")
						: message.partial
							? t("chat:backgroundShells.stopping")
							: t("chat:backgroundShells.stopped")
				return (
					<div className="flex gap-1">
						<div style={headerStyle}>
							<span>{label}</span>
						</div>
						<div className="">
							<ToolUseBlock>
								<ToolUseBlockHeader className="group">
									<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left font-mono">
										{tool.content || ""}
									</span>
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</div>
				)
			}
			// forked_change end
			case "useSkill":
				return (
					<div className="flex gap-1">
						<div style={headerStyle}>
							<span style={{}}>{message.partial ? "Using skill..." : "Used skill"}</span>
						</div>
						<div className="">
							<ToolUseBlock>
								<ToolUseBlockHeader className="group">
									<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left">
										{tool.content || "unknown"}
									</span>
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</div>
				)
			case "figmaFetch":
				return (
					<div className="flex gap-1 min-w-0">
						<div style={{ ...headerStyle, flexShrink: 0 }}>
							<FigmaIcon className="size-3 mr-1" />
							<span style={{}}>Fetched from Figma</span>
						</div>
						<div className="min-w-0 flex-1 overflow-hidden">
							<ToolUseBlock>
								<ToolUseBlockHeader>
									<span
										style={{
											fontWeight: "500",
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
											display: "block",
										}}>
										{tool.content}
									</span>
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</div>
				)
			case "generateFile": {
				const fileType = tool.fileType?.toUpperCase() || "FILE"
				const fileName = tool.path?.split("/").pop() || tool.path || "file"
				const fileTypeLower = (tool.fileType || "").toLowerCase()
				const fileIconUrl =
					materialIconsBaseUri && fileTypeLower
						? getIconUrlByName(getIconForFilePath(`${fileName}`), materialIconsBaseUri)
						: ""
				const fileIconEl = tool.isProtected ? (
					<span
						className="codicon codicon-lock"
						style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
					/>
				) : fileIconUrl ? (
					<img
						src={fileIconUrl}
						alt=""
						style={{ width: 16, height: 16, marginBottom: "-1.5px", flexShrink: 0 }}
					/>
				) : (
					toolIcon("new-file")
				)
				const sizeLabel = tool.bytes ? formatBytes(tool.bytes) : ""
				const typeLabel = FILE_TYPE_LABELS[fileTypeLower] || fileType
				return (
					<>
						<div style={{ ...headerStyle, marginBottom: "8px", display: "flex", gap: "4px" }}>
							{fileIconEl}
							<span style={{}}>
								{message.type === "ask"
									? tool.isProtected
										? t("chat:fileOperations.wantsToGenerateFileProtected", { fileType })
										: tool.isOutsideWorkspace
											? t("chat:fileOperations.wantsToGenerateFileOutsideWorkspace", { fileType })
											: t("chat:fileOperations.wantsToGenerateFile", { fileType })
									: t("chat:fileOperations.didGenerateFile", { fileType })}
							</span>
						</div>
						{message.type === "ask" && (
							<div className="">
								<CodeAccordian
									path={tool.path}
									code={tool.content}
									language="text"
									isExpanded={isExpanded}
									onToggleExpand={handleToggleExpand}
								/>
							</div>
						)}
						{message.type === "say" && tool.fileData && (
							<div
								className=""
								style={{
									display: "flex",
									alignItems: "center",
									gap: "12px",
									padding: "12px 16px",
									borderRadius: "8px",
									border: "1px solid var(--vscode-commandCenter-inactiveBorder)",
									backgroundColor: "var(--vscode-editor-background)",
									maxWidth: "520px",
									marginTop: "4px",
								}}>
								{/* File icon */}
								<div
									style={{
										width: 40,
										height: 40,
										borderRadius: "8px",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										backgroundColor: "var(--vscode-badge-background)",
										flexShrink: 0,
									}}>
									{fileIconUrl ? (
										<img src={fileIconUrl} alt="" style={{ width: 24, height: 24 }} />
									) : (
										<span className="codicon codicon-file" style={{ fontSize: 20 }} />
									)}
								</div>
								{/* File info */}
								<div style={{ flex: 1, minWidth: 0 }}>
									<div
										style={{
											fontWeight: 600,
											fontSize: "13px",
											color: "var(--vscode-foreground)",
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
										}}>
										{fileName}
									</div>
									<div
										style={{
											fontSize: "11px",
											color: "var(--vscode-descriptionForeground)",
											textTransform: "uppercase",
											letterSpacing: "0.05em",
											marginTop: "2px",
										}}>
										{typeLabel}
										{sizeLabel && ` \u00b7 ${sizeLabel}`}
									</div>
								</div>
								{/* Buttons */}
								<div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
									<VSCodeButton
										onClick={() =>
											vscode.postMessage({
												type: "viewFile",
												values: {
													fileData: tool.fileData,
													fileType: fileTypeLower,
													defaultFileName: fileName,
													content: tool.content,
													mimeType: tool.mimeType,
													bytes: tool.bytes,
												},
											})
										}
										appearance="primary">
										{t("chat:fileOperations.viewFile")}
									</VSCodeButton>
									<VSCodeButton
										onClick={() =>
											vscode.postMessage({
												type: "saveFile",
												values: {
													fileData: tool.fileData,
													defaultFileName: fileName,
													mimeType: tool.mimeType,
												},
											})
										}
										appearance="secondary">
										{t("chat:fileOperations.saveFile")}
									</VSCodeButton>
								</div>
							</div>
						)}
					</>
				)
			}
			default:
				return null
		}
	}

	switch (message.type) {
		case "say":
			switch (message.say) {
				case "diff_error":
					return (
						<ErrorRow
							type="diff_error"
							message={message.text || ""}
							expandable={true}
							showCopyButton={true}
						/>
					)
				case "subtask_result":
					return (
						<div>
							<div
								style={{
									marginTop: "0px",
									backgroundColor: "var(--vscode-badge-background)",
									border: "none",
									borderRadius: "0 0 4px 4px",
									overflow: "hidden",
									marginBottom: "8px",
								}}>
								<div
									style={{
										padding: "6px 10px 6px 12px",
										backgroundColor: "var(--vscode-badge-background)",
										borderBottom: "none",

										fontSize: "var(--vscode-font-size)",
										color: "var(--vscode-badge-foreground)",
										display: "flex",
										alignItems: "center",
										gap: "6px",
									}}>
									<span className="codicon codicon-arrow-left"></span>
									{t("chat:subtasks.resultContent")}
								</div>
								<div
									style={{
										padding: "8px 12px",
										backgroundColor: "var(--vscode-editor-background)",
									}}>
									<MarkdownBlock markdown={message.text} />
								</div>
							</div>
						</div>
					)
				case "reasoning":
					return (
						<ReasoningBlock
							content={message.text || ""}
							ts={message.ts}
							isStreaming={isStreaming}
							_isLast={isLast}
							disableAutoExpand={disableReasoningAutoExpand}
							partial={message.partial}
							metadata={message.metadata as any}
						/>
					)
				case "api_req_started":
					// Determine if the API request is in progress
					const isApiRequestInProgress =
						apiReqCancelReason === undefined && apiRequestFailedMessage === undefined && cost === undefined

					return (
						<>
							<div
								className={`group text-sm transition-opacity ${
									isApiRequestInProgress ? "opacity-100" : "opacity-40 hover:opacity-100"
								}`}
								style={{
									...headerStyle,
									marginBottom:
										((cost === null || cost === undefined) && apiRequestFailedMessage) ||
										apiReqStreamingFailedMessage
											? 2
											: 0,
									justifyContent: "space-between",
								}}>
								<div style={{ display: "flex", alignItems: "center", gap: "10px", flexGrow: 1 }}>
									{icon}
									{/* forked_change start */}
									<div style={{ display: "flex", alignItems: "center", gap: "8px", flexGrow: 1 }}>
										{title}
										{/* {showTimestamps && <ChatTimestamps ts={message.ts} />} */}
									</div>
									{/* forked_change end */}
								</div>
								<div
									className="text-xs text-vscode-dropdown-foreground border-vscode-dropdown-border/50 border px-1.5 py-0.5 rounded-lg"
									style={{ opacity: shouldShowCost ? 1 : 0 }}>
									${Number(cost || 0)?.toFixed(4)}
								</div>
								{
									// forked_change start
									!cost && usageMissing && (
										<StandardTooltip content={t("kilocode:pricing.costUnknownDescription")}>
											<div className="flex items-center text-xs text-vscode-dropdown-foreground border-vscode-dropdown-border/50 border px-1.5 py-0.5 rounded-lg whitespace-nowrap">
												<span className="codicon codicon-warning pr-1"></span>
												{t("kilocode:pricing.costUnknown")}
											</div>
										</StandardTooltip>
									)
									// forked_change end
								}
							</div>
							{(((cost === null || cost === undefined) && apiRequestFailedMessage) ||
								apiReqStreamingFailedMessage) && (
								<ErrorRow
									type={apiReqStreamingFailedMessage ? "streaming_failed" : "api_failure"}
									message={apiRequestFailedMessage || apiReqStreamingFailedMessage || ""}
									additionalContent={
										apiReqStreamingFailedMessage &&
										isStreamDisconnectError(apiReqStreamingFailedMessage) ? (
											<>
												<br />
												<br />
												{t("chat:apiRequest.streamDisconnected")}
											</>
										) : apiRequestFailedMessage?.toLowerCase().includes("powershell") ? (
											<>
												<br />
												<br />
												{t("chat:powershell.issues")}{" "}
												<a
													href="https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22"
													style={{ color: "inherit", textDecoration: "underline" }}>
													troubleshooting guide
												</a>
												.
											</>
										) : undefined
									}
								/>
							)}
						</>
					)
				case "api_req_finished":
					return null // we should never see this message type
				case "text":
					// Check if this is the "out of credits" message
					const isOutOfCreditsMessage =
						message.text?.includes("Your plan is out of credits") &&
						message.text?.includes("https://app.matterai.so/billing")

					if (isOutOfCreditsMessage) {
						return <OutOfCreditsBanner />
					}

					const initialTaskDisplayText = getDisplayTextWithoutPasteChips(
						message.text || "",
						message.pasteChips,
					)

					return (
						<div>
							{/* <div style={headerStyle}>
								<MessageCircle className="w-4 shrink-0" aria-label="Speech bubble icon" />
								<span style={{}}>{t("chat:text.rooSaid")}</span>
							</div> */}
							<div className="">
								{initialTaskDisplayText ? (
									<Markdown markdown={initialTaskDisplayText} partial={message.partial} />
								) : null}
								{message.images && message.images.length > 0 && (
									<div style={{ marginTop: "0px" }}>
										{message.images.map((image, index) => (
											<ImageBlock key={index} imageData={image} />
										))}
									</div>
								)}
								{message.pasteChips && message.pasteChips.length > 0 && (
									<PasteChips chips={message.pasteChips} readonly compact />
								)}
							</div>
						</div>
					)
				case "user_feedback":
					const userFeedbackDisplayText = getDisplayTextWithoutPasteChips(
						message.text || "",
						message.pasteChips,
					)
					const hasChips = Boolean(message.pasteChips && message.pasteChips.length > 0)
					const hasImages = Boolean(message.images && message.images.length > 0)
					const hasAttachments = hasChips || hasImages
					const hasText = Boolean(userFeedbackDisplayText)

					const actionButtons = (
						<div className="flex items-center gap-2 pr-1 ml-auto shrink-0">
							<StandardTooltip content={t("chat:checkpoint.menu.restore")}>
								<div
									className="cursor-pointer shrink-0 opacity-20 hover:opacity-100 transition-opacity"
									style={{ visibility: isStreaming ? "hidden" : "visible" }}
									onClick={(e) => {
										e.stopPropagation()
										handleEditClick()
									}}
									title={t("chat:checkpoint.restore")}>
									<Undo2 className="w-3.5 h-3.5" />
								</div>
							</StandardTooltip>
							<div
								className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
								style={{ visibility: isStreaming ? "hidden" : "visible" }}
								onClick={(e) => {
									e.stopPropagation()
									handleEditClick()
								}}>
								{/* <Edit className="w-4 shrink-0" aria-label="Edit message icon" /> */}
							</div>
							<div
								className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
								style={{ visibility: isStreaming ? "hidden" : "visible" }}
								onClick={(e) => {
									e.stopPropagation()
									vscode.postMessage({ type: "deleteMessage", value: message.ts })
								}}>
								{/* <Trash2 className="w-4 shrink-0" aria-label="Delete message icon" /> */}
							</div>
						</div>
					)

					return (
						<div className="group" data-user-feedback="true" data-message-index={messageIndex}>
							{/* <div style={headerStyle}>
								<User className="w-4 shrink-0" aria-label="User icon" />
								<span style={{}}>{t("chat:feedback.youSaid")}</span>
							</div> */}
							<div
								className={cn(
									isEditing ? "rounded-xl" : "rounded-sm",
									"whitespace-pre-wrap mb-1",
									"bg-vscode-textCodeBlock-background",
									isEditing ? "overflow-visible" : "overflow-hidden", // kilocode_change
									isEditing ? "text-vscode-editor-foreground" : "cursor-text p-1",
								)}>
								{isEditing ? (
									<div className="flex flex-col gap-2">
										<ChatTextArea
											inputValue={editedContent}
											setInputValue={setEditedContent}
											sendingDisabled={false}
											selectApiConfigDisabled={true}
											selectedImages={editImages}
											setSelectedImages={setEditImages}
											onSend={handleSaveEdit}
											onSelectImages={handleSelectImages}
											shouldDisableImages={!model?.supportsImages}
											mode={editMode}
											setMode={setEditMode}
											modeShortcutText=""
											isEditMode={true}
											onCancel={handleCancelEdit}
											profilePlan={profilePlan}
										/>
									</div>
								) : hasText && !hasAttachments ? (
									<div className="flex justify-between items-end w-full gap-2">
										<div className="flex-grow min-w-0">
											<ReadOnlyChatText
												value={userFeedbackDisplayText}
												className="px-1 py-1 wrap-anywhere rounded-lg transition-colors hover:bg-vscode-editor-hover-highlight"
												onClick={() => {
													if (!isStreaming) {
														handleEditClick()
													}
												}}
												title={t("chat:queuedMessages.clickToEdit")}
											/>
										</div>
										<div className="mb-1.5">{actionButtons}</div>
									</div>
								) : hasAttachments ? (
									<div className="flex flex-col gap-1.5">
										{hasText && (
											<div className="w-full">
												<ReadOnlyChatText
													value={userFeedbackDisplayText}
													className="px-1 py-1 wrap-anywhere rounded-lg transition-colors hover:bg-vscode-editor-hover-highlight"
													onClick={() => {
														if (!isStreaming) {
															handleEditClick()
														}
													}}
													title={t("chat:queuedMessages.clickToEdit")}
												/>
											</div>
										)}
										{hasImages && hasChips && (
											<Thumbnails images={message.images!} style={{ marginTop: "2px" }} />
										)}
										<div className="flex justify-between items-center w-full gap-2">
											<div className="flex-grow min-w-0">
												{hasChips ? (
													<PasteChips chips={message.pasteChips!} readonly compact />
												) : (
													<Thumbnails images={message.images!} />
												)}
											</div>
											{actionButtons}
										</div>
									</div>
								) : (
									<div className="flex justify-end w-full">{actionButtons}</div>
								)}
							</div>
						</div>
					)
				case "user_feedback_diff":
					const tool = safeJsonParse<ClineSayTool>(message.text)
					return (
						<div style={{ marginTop: -10, width: "100%" }}>
							<CodeAccordian
								code={tool?.diff}
								language="diff"
								isFeedback={true}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					)
				case "error":
					return <ErrorRow type="error" message={message.text || ""} />
				case "completion_result":
					return (
						<>
							<div style={headerStyle}>
								{icon}
								{/* forked_change start */}
								<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
									{title}
									{showTimestamps && <ChatTimestamps ts={message.ts} />}
								</div>
								{/* forked_change end */}
							</div>
							<div className="pb-1">
								<Markdown markdown={message.text} />
							</div>
						</>
					)
				case "shell_integration_warning":
					return <CommandExecutionError />
				case "checkpoint_saved":
					return null
				// return (
				// 	<CheckpointSaved
				// 		ts={message.ts!}
				// 		commitHash={message.text!}
				// 		currentHash={currentCheckpoint}
				// 		checkpoint={message.checkpoint}
				// 	/>
				// )
				case "condense_context":
					if (message.partial) {
						return <CondensingContextRow />
					}
					return message.contextCondense ? <ContextCondenseRow {...message.contextCondense} /> : null
				case "condense_context_error":
					return <CondenseContextErrorRow errorText={message.text} />
				case "codebase_search_result":
					let parsed: {
						content: {
							query: string
							results: Array<{
								filePath: string
								score: number
								startLine: number
								endLine: number
								codeChunk: string
							}>
						}
					} | null = null

					try {
						if (message.text) {
							parsed = JSON.parse(message.text)
						}
					} catch (error) {
						console.error("Failed to parse codebaseSearch content:", error)
					}

					if (parsed && !parsed?.content) {
						console.error("Invalid codebaseSearch content structure:", parsed.content)
						return <div>Error displaying search results.</div>
					}

					const { results = [] } = parsed?.content || {}

					return <CodebaseSearchResultsDisplay results={results} />
				// forked_change start: upstream pr https://github.com/RooCodeInc/Roo-Code/pull/5452
				case "browser_action_result":
					// This should not normally be rendered here as browser_action_result messages
					// should be grouped into browser sessions and rendered by BrowserSessionRow.
					// If we see this, it means the message grouping logic has a bug.
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<div style={{ paddingTop: 10 }}>
								<div
									style={{
										color: "var(--vscode-errorForeground)",
										fontFamily: "monospace",
										fontSize: "12px",
										padding: "8px",
										backgroundColor:
											"color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent)",
										border: "none",
										borderRadius: "4px",
										marginBottom: "8px",
									}}>
									⚠️ Browser action result not properly grouped - this is a bug in the message
									grouping logic
								</div>
								<Markdown markdown={message.text} partial={message.partial} />
							</div>
						</>
					)
				// forked_change end
				case "user_edit_todos":
					return <UpdateTodoListToolBlock userEdited onChange={() => {}} />
				case "tool" as any:
					// Handle say tool messages
					const sayTool = safeJsonParse<ClineSayTool>(message.text)
					if (!sayTool) return null

					switch (sayTool.tool) {
						case "runSlashCommand": {
							const slashCommandInfo = sayTool
							return (
								<>
									<div style={headerStyle}>
										<span
											className="codicon codicon-terminal-cmd"
											style={{
												color: "var(--vscode-foreground)",
												marginBottom: "-1.5px",
											}}></span>
										<span style={{}}>{t("chat:slashCommand.didRun")}</span>
									</div>
									<div className="">
										<ToolUseBlock>
											<ToolUseBlockHeader
												style={{
													display: "flex",
													flexDirection: "column",
													alignItems: "flex-start",
													gap: "4px",
													padding: "7px 10px",
												}}>
												<div
													style={{
														display: "flex",
														alignItems: "center",
														gap: "8px",
														width: "100%",
													}}>
													<span
														style={{
															fontWeight: "500",
															fontSize: "var(--vscode-font-size)",
														}}>
														/{slashCommandInfo.command}
													</span>
													{slashCommandInfo.args && (
														<span
															style={{
																color: "var(--vscode-descriptionForeground)",
																fontSize: "var(--vscode-font-size)",
															}}>
															{slashCommandInfo.args}
														</span>
													)}
												</div>
												{slashCommandInfo.description && (
													<div
														style={{
															color: "var(--vscode-descriptionForeground)",
															fontSize: "calc(var(--vscode-font-size) - 1px)",
														}}>
														{slashCommandInfo.description}
													</div>
												)}
												{slashCommandInfo.source && (
													<div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
														<VSCodeBadge
															style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
															{slashCommandInfo.source}
														</VSCodeBadge>
													</div>
												)}
											</ToolUseBlockHeader>
										</ToolUseBlock>
									</div>
								</>
							)
						}
						case "executeCommand": {
							// Handle executeCommand tool - render command execution UI
							return (
								<>
									<div style={headerStyle}>
										<span
											className="codicon codicon-terminal"
											style={{
												color: "var(--vscode-foreground)",
												marginBottom: "-1.5px",
											}}></span>
										<span style={{}}>{t("chat:commandExecution.running")}</span>
									</div>
									<div className="">
										<ToolUseBlock>
											<ToolUseBlockHeader className="group">
												<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left font-mono text-xs">
													{sayTool.command || "command"}
												</span>
											</ToolUseBlockHeader>
										</ToolUseBlock>
									</div>
								</>
							)
						}
						case "planFileEdit": {
							// Handle planFileEdit tool - render plan file edit UI
							const planFileName = sayTool.path?.split("/").pop() || sayTool.path || "plan file"
							return (
								<>
									<div style={headerStyle}>
										<span
											className="codicon codicon-edit"
											style={{
												color: "var(--vscode-foreground)",
												marginBottom: "-1.5px",
											}}></span>
										<span style={{}}>Edited plan file</span>
									</div>
									<div className="">
										<ToolUseBlock>
											<ToolUseBlockHeader className="group">
												<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left">
													{planFileName}
												</span>
											</ToolUseBlockHeader>
										</ToolUseBlock>
									</div>
								</>
							)
						}
						default:
							return null
					}
				case "image":
					// Parse the JSON to get imageUri and imagePath
					const imageInfo = safeJsonParse<{ imageUri: string; imagePath: string }>(message.text || "{}")
					if (!imageInfo) {
						return null
					}
					return (
						<div style={{ marginTop: "10px" }}>
							<ImageBlock imageUri={imageInfo.imageUri} imagePath={imageInfo.imagePath} />
						</div>
					)
				default:
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{/* forked_change start */}
									<div style={{ display: "flex", alignItems: "center", gap: "8px", flexGrow: 1 }}>
										{title}
										{showTimestamps && <ChatTimestamps ts={message.ts} />}
									</div>
									{/* forked_change end */}
								</div>
							)}
							<div style={{ paddingTop: 10 }}>
								<Markdown markdown={message.text} partial={message.partial} />
							</div>
						</>
					)
			}
		case "ask":
			switch (message.ask) {
				case "mistake_limit_reached":
					return <ErrorRow type="mistake_limit" message={message.text || ""} />
				case "api_req_failed":
					return <CommandExecution executionId={message.ts.toString()} text={message.text} />
				case "command":
					return (
						<CommandExecution
							executionId={message.ts.toString()}
							text={message.text}
							onPrimaryButtonClick={onPrimaryButtonClick}
							onSecondaryButtonClick={onSecondaryButtonClick}
							enableButtons={enableButtons}
						/>
					)
				case "use_mcp_server":
					// Parse the message text to get the MCP server request
					const messageJson = safeJsonParse<any>(message.text, {})

					// Extract the response field if it exists
					const { response, ...mcpServerRequest } = messageJson

					// Create the useMcpServer object with the response field
					const useMcpServer: ClineAskUseMcpServer = {
						...mcpServerRequest,
						response,
					}

					if (!useMcpServer) {
						return null
					}

					const server = mcpServers.find((server) => server.name === useMcpServer.serverName)

					return (
						<>
							<div style={headerStyle}>
								{icon}
								{title}
							</div>
							<div className="w-full bg-vscode-textCodeBlock-background rounded-lg px-2 py-1 mt-2">
								{useMcpServer.type === "access_mcp_resource" && (
									<McpResourceRow
										item={{
											// Use the matched resource/template details, with fallbacks
											...(findMatchingResourceOrTemplate(
												useMcpServer.uri || "",
												server?.resources,
												server?.resourceTemplates,
											) || {
												name: "",
												mimeType: "",
												description: "",
											}),
											// Always use the actual URI from the request
											uri: useMcpServer.uri || "",
										}}
									/>
								)}
								{useMcpServer.type === "use_mcp_tool" && (
									<McpExecution
										executionId={message.ts.toString()}
										text={useMcpServer.arguments}
										serverName={useMcpServer.serverName}
										toolName={useMcpServer.toolName}
										isArguments={true}
										server={server}
										useMcpServer={useMcpServer}
										alwaysAllowMcp={alwaysAllowMcp}
									/>
								)}
							</div>
						</>
					)
				case "completion_result":
					if (message.text) {
						return (
							<div>
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
								<div style={{ color: "var(--vscode-charts-green)", paddingTop: 10 }}>
									<Markdown markdown={message.text} partial={message.partial} />
								</div>
							</div>
						)
					} else {
						return null // Don't render anything when we get a completion_result ask without text
					}
				case "followup":
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{/* forked_change start */}
									<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
										{title}
										{showTimestamps && <ChatTimestamps ts={message.ts} />}
									</div>
									{/* forked_change start */}
								</div>
							)}
							<div className="mb-2 flex flex-col gap-1.5">
								<div className="overflow-hidden rounded-xl border border-[var(--vscode-commandCenter-inactiveBorder)] bg-[color-mix(in_srgb,var(--vscode-textCodeBlock-background)_78%,var(--vscode-editor-background))] p-3 shadow-[0_6px_18px_rgba(0,0,0,0.1)]">
									<div className="mb-1.5 flex items-center">
										<span className="text-sm font-medium text-vscode-descriptionForeground">
											Question
										</span>
									</div>
									<div className="text-[15px] leading-6 text-vscode-foreground [&_p]:m-0">
										<Markdown
											markdown={message.partial === true ? message?.text : followUpData?.question}
										/>
									</div>
									<FollowUpSuggest
										suggestions={followUpData?.suggest}
										onSuggestionClick={onSuggestionClick}
										ts={message?.ts}
										onCancelAutoApproval={onFollowUpUnmount}
										isAnswered={isFollowUpAnswered}
									/>
								</div>
							</div>
						</>
					)

				// kilocode_change begin
				case "condense":
					return (
						<>
							<div style={headerStyle}>
								<span
									className="codicon codicon-new-file"
									style={{
										color: normalColor,
										marginBottom: "-1.5px",
									}}></span>
								<span style={{ color: normalColor }}>
									{t("kilocode:chat.condense.wantsToCondense")}
								</span>
							</div>
							<NewTaskPreview context={message.text || ""} />
						</>
					)

				case "payment_required_prompt": {
					return (
						<LowCreditWarning
							message={message}
							isOrganization={!!apiConfiguration.kilocodeOrganizationId}
						/>
					)
				}
				case "invalid_model": {
					return <InvalidModelWarning message={message} isLast={isLast} />
				}
				case "report_bug":
					return (
						<>
							<div style={headerStyle}>
								<span
									className="codicon codicon-new-file"
									style={{
										color: normalColor,
										marginBottom: "-1.5px",
									}}></span>
								<span style={{ color: normalColor }}>KiloCode wants to create a Github issue:</span>
							</div>
							<ReportBugPreview data={message.text || ""} />
						</>
					)
				// forked_change end
				case "auto_approval_max_req_reached": {
					return <AutoApprovedRequestLimitWarning message={message} />
				}
				default:
					return null
			}
	}
}

const ChatRow = memo((props: ChatRowProps) => {
	const { highlighted } = props // kilocode_change: Add highlighted prop
	const {
		isLast,
		onHeightChange,
		// message
	} = props
	// Store the previous height to compare with the current height
	// This allows us to detect changes without causing re-renders
	const prevHeightRef = useRef(0)

	const [chatrow, { height }] = useSize(
		<div
			// kilocode_change: add highlighted className
			className={cn(
				CHAT_CONTENT_HORIZONTAL_PADDING,
				"relative animate-fade-up py-[2px]",
				highlighted && "animate-message-highlight",
			)}>
			{/* {showTaskTimeline && <KiloChatRowGutterBar message={message} />} */}
			<ChatRowContent {...props} />
		</div>,
	)

	useEffect(() => {
		// used for partials, command output, etc.
		// NOTE: it's important we don't distinguish between partial or complete here since our scroll effects in chatview need to handle height change during partial -> complete
		const isInitialRender = prevHeightRef.current === 0 // prevents scrolling when new element is added since we already scroll for that
		// height starts off at Infinity
		if (isLast && height !== 0 && height !== Infinity && height !== prevHeightRef.current) {
			if (!isInitialRender) {
				onHeightChange(height > prevHeightRef.current)
			}
			prevHeightRef.current = height
		}
	}, [height, isLast, onHeightChange])

	return chatrow
})

export default ChatRow
