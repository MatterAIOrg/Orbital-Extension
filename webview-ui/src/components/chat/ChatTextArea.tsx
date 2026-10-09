import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"

import { DocumentAttachment, ExtensionMessage } from "@roo/ExtensionMessage"
import { WebviewMessage } from "@roo/WebviewMessage"
import { mentionRegex, unescapeSpaces } from "@roo/context-mentions"
import { Mode, getAllModes } from "@roo/modes"

import { Button, StandardTooltip } from "@/components/ui" // kilocode_change
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { convertToMentionPath } from "@/utils/path-mentions"
import { vscode } from "@/utils/vscode"
import {
	ContextMenuOptionType,
	SearchResult,
	getContextMenuOptions,
	insertMention,
	removeMention,
	shouldShowContextMenu,
} from "@src/utils/context-mentions"

import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { cn } from "@/lib/utils"
import { valueToHtml as renderValueToHtml, containsListSyntax } from "@/utils/chat-render"
import { VolumeX } from "lucide-react"
import DocumentAttachments from "../common/DocumentAttachments"
import PasteChips, { PasteChip } from "../common/PasteChips"
import Thumbnails, { ImageAttachment } from "../common/Thumbnails"
import { ModelSelector } from "../kilocode/chat/ModelSelector"
import { EffortSelector } from "./EffortSelector"
import { useSelectedModel } from "../ui/hooks/useSelectedModel"
import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import { CHAT_CONTENT_HORIZONTAL_PADDING } from "./chatLayout"
import CommandApprovalSelector from "./CommandApprovalSelector" // forked_change
import ContextMenu from "./ContextMenu"
import { ContextUsageIndicator } from "./ContextUsageIndicator" // kilocode_change
import { ImageWarningBanner } from "./ImageWarningBanner" // kilocode_change
import { usePromptHistory } from "./hooks/usePromptHistory"
import { AcceptRejectButtons } from "./kilocode/AcceptRejectButtons"

// forked_change start: pull slash commands from Cline
import SlashCommandMenu from "@/components/chat/SlashCommandMenu"
import { ArrowUp02Icon, PlusIcon } from "@/utils/customIcons"
import {
	SlashCommand,
	getMatchingSlashCommands,
	insertSlashCommand,
	shouldShowSlashCommandsMenu,
} from "@/utils/slash-commands"
// forked_change end

// kilocode_change start: detect pasted file paths for attachments
const IMAGE_PATH_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"]
const DOCUMENT_PATH_EXTENSIONS = [".csv", ".docx", ".json", ".md", ".pdf", ".text", ".txt", ".tsv", ".xlsx"]
const ATTACHMENT_PATH_EXTENSIONS = [...IMAGE_PATH_EXTENSIONS, ...DOCUMENT_PATH_EXTENSIONS]

// Pastes at least this long are collapsed into a paste chip in the attachment
// strip below the chat input. The full text is stored in the chip and merged
// back into the message at the chip's cursor position when the message is sent.
const PASTE_CHIP_THRESHOLD = 500

// Two newlines separate a merged chip's text from the surrounding prompt text.
const PASTE_CHIP_SEPARATOR = "\n\n"

// Merge paste chips back into the message text at their recorded cursor
// positions, as if the text had been pasted there directly. Chips are inserted
// from the end backwards so earlier positions stay valid. Each chip is padded
// with two newlines on any side that has neighboring text, so the pasted
// content never butts up against the surrounding prompt.
export const mergePasteChips = (text: string, chips: PasteChip[]): string => {
	const sorted = [...chips].sort((a, b) => b.insertPosition - a.insertPosition)
	let result = text
	for (const chip of sorted) {
		const position = Math.max(0, Math.min(chip.insertPosition, result.length))
		const content = chip.text.trim()
		const prefix = position > 0 ? PASTE_CHIP_SEPARATOR : ""
		const suffix = position < result.length ? PASTE_CHIP_SEPARATOR : ""
		result = result.slice(0, position) + prefix + content + suffix + result.slice(position)
	}
	return result
}

// MIME types for document attachments that arrive as File blobs when a file is
// copied directly (e.g. from Finder/Explorer). Maps MIME -> file extension so we
// can name the temp file correctly for the extension's extractor.
const DOCUMENT_MIME_TO_EXT: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/json": ".json",
	"text/csv": ".csv",
	"text/tab-separated-values": ".tsv",
	"text/plain": ".txt",
	"text/markdown": ".md",
}

// Browser-safe file extension / basename helpers (the webview cannot use node:path)
export const fileExt = (name: string): string => {
	const idx = name.lastIndexOf(".")
	return idx > 0 ? name.slice(idx).toLowerCase() : ""
}

// ext is expected to be a lowercased, dot-prefixed extension (as returned by fileExt).
// Compare case-insensitively so files with uppercase extensions (e.g. "Report.PDF")
// still have their extension stripped, but preserve the original casing of the base name.
export const fileBaseName = (name: string, ext: string): string =>
	ext && name.toLowerCase().endsWith(ext) ? name.slice(0, name.length - ext.length) : name

/**
 * Returns a normalized absolute file path if the pasted text looks like a path
 * to a supported attachment file (image or document), otherwise null. Relative
 * paths are resolved against the provided cwd. file:// URIs are decoded.
 */
function resolveAttachmentPath(text: string, cwd?: string): string | null {
	let candidate = text.trim()

	// Strip file:// protocol
	if (candidate.startsWith("file://")) {
		try {
			candidate = decodeURIComponent(candidate.substring(7))
		} catch {
			return null
		}
	}

	// Fix leading slash on Windows paths like /d:/...
	if (candidate.startsWith("/") && candidate[2] === ":") {
		candidate = candidate.substring(1)
	}

	const lower = candidate.toLowerCase()
	if (!ATTACHMENT_PATH_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
		return null
	}

	// Absolute path (POSIX or Windows drive letter)
	if (candidate.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(candidate)) {
		return candidate
	}

	// Relative path: resolve against cwd if available
	if (cwd) {
		const sep = cwd.includes("\\") ? "\\" : "/"
		return `${cwd.replace(/[\\/]+$/, "")}${sep}${candidate.replace(/^\.?\//, "").replace(/^\.?\\/, "")}`
	}

	return null
}
// kilocode_change end: detect pasted file paths for attachments

interface ChatTextAreaProps {
	inputValue: string
	setInputValue: React.Dispatch<React.SetStateAction<string>>

	sendingDisabled: boolean
	selectApiConfigDisabled: boolean
	selectedImages: ImageAttachment[]
	setSelectedImages: React.Dispatch<React.SetStateAction<ImageAttachment[]>>
	selectedDocuments?: DocumentAttachment[]
	setSelectedDocuments?: React.Dispatch<React.SetStateAction<DocumentAttachment[]>>
	onSend: (text?: string, pasteChips?: PasteChip[]) => void
	onSelectImages: () => void
	shouldDisableImages: boolean
	onHeightChange?: (height: number) => void
	mode: Mode
	setMode: (value: Mode) => void
	modeShortcutText: string
	// Edit mode props
	isEditMode?: boolean
	onCancel?: () => void
	sendMessageOnEnter?: boolean // kilocode_change
	// Streaming state and cancel handler
	isStreaming?: boolean
	onCancelStreaming?: () => void
	profilePlan?: string
	onShowUsage?: () => void
}

export const ChatTextArea = forwardRef<HTMLDivElement, ChatTextAreaProps>(
	(
		{
			inputValue,
			setInputValue,
			// sendingDisabled,
			// selectApiConfigDisabled,
			selectedImages,
			setSelectedImages,
			selectedDocuments = [],
			setSelectedDocuments,
			onSend,
			onSelectImages,
			shouldDisableImages,
			onHeightChange,
			// _mode,
			// setMode,
			// _modeShortcutText,
			isEditMode = false,
			onCancel,
			sendMessageOnEnter = true,
			isStreaming = false,
			onCancelStreaming,
			profilePlan,
			onShowUsage,
		},
		ref,
	) => {
		const { t } = useAppTranslation()
		const {
			filePaths,
			currentApiConfigName,
			apiConfiguration,
			customModes,
			cwd,
			localWorkflows, // kilocode_change
			globalWorkflows, // kilocode_change
			taskHistoryVersion, // kilocode_change
			clineMessages,
		} = useExtensionState()

		const {
			id: selectedModelId,
			provider: selectedProvider,
			info: selectedModelInfo,
		} = useSelectedModel(apiConfiguration)

		// kilocode_change: audio transcription hook
		const {
			recorderState: _recorderState,
			startRecording: _startRecording,
			stopRecording: _stopRecording,
			error: _recorderError,
		} = useAudioRecorder((text: string) => {
			// Functional update: transcript chunks arrive asynchronously while
			// recording, so append against the latest value (not a stale closure).
			setInputValue((prev) => (prev ? `${prev} ${text}` : text))
		})

		// Find the ID and display text for the currently selected API configuration
		// const { currentConfigId, displayName } = useMemo(() => {
		// 	const currentConfig = listApiConfigMeta?.find((config) => config.name === currentApiConfigName)
		// 	return {
		// 		currentConfigId: currentConfig?.id || "",
		// 		displayName: currentApiConfigName || "", // Use the name directly for display
		// 	}
		// }, [listApiConfigMeta, currentApiConfigName])

		// const [gitCommits, setGitCommits] = useState<any[]>([])
		const [showDropdown, setShowDropdown] = useState(false)
		const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])

		// kilocode_change begin: remove button from chat when it gets to small
		const [containerWidth, setContainerWidth] = useState<number>(300) // Default to a value larger than our threshold

		// Pasted-text chips waiting to be merged into the message on send. Each
		// chip remembers the cursor position of its paste so the full text is
		// re-inserted exactly where it was pasted.
		const [pasteChips, setPasteChips] = useState<PasteChip[]>([])

		const containerRef = useRef<HTMLDivElement>(null)

		// Map of short mention display text -> full path for file/folder mentions
		// Format in textarea: @[filename.ext] -> expands to @/full/path/filename.ext
		const mentionMapRef = useRef<Map<string, string>>(new Map())

		const nextPasteIdRef = useRef(0)

		// Expand short mentions @filename to full paths @/full/path before sending
		const expandMentions = useCallback((text: string): string => {
			// Match @word patterns that might be filenames or folder names
			return text.replace(/@([a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9]+)?)/g, (_match, name) => {
				const fullPath = mentionMapRef.current.get(name)
				if (fullPath) {
					return `${fullPath}`
				}
				// If no mapping found, keep original (might be a valid full path or other mention)
				return _match
			})
		}, [])

		// Wrapper for onSend that merges paste chips and expands mentions first
		const handleSend = useCallback(() => {
			if (inputValue.trim().startsWith("/resume")) {
				vscode.postMessage({ type: "switchTab", tab: "history" })
				setInputValue("")
				return
			}

			if (inputValue.trim() === "/usage" || inputValue.trim().startsWith("/usage ")) {
				onShowUsage?.()
				setInputValue("")
				return
			}

			// Snapshot the chips before clearing so we can pass them through to
			// onSend; the parent stores them on the outgoing message so the chat
			// history can render the chips instead of (or alongside) the merged
			// raw text.
			const chipsSnapshot = pasteChips

			// Merge any pasted-text chips into the message at their recorded
			// positions, as if the text had been pasted there directly, then clear
			// the strip (the text is now part of the outgoing value).
			const mergedValue = mergePasteChips(inputValue, chipsSnapshot)
			if (chipsSnapshot.length > 0) {
				setPasteChips([])
			}

			const expandedValue = expandMentions(mergedValue)
			if (expandedValue !== inputValue) {
				setInputValue(expandedValue)
			}

			// Pass the final text through onSend directly so the parent never
			// reads a stale inputValue from an earlier render.
			onSend(expandedValue, chipsSnapshot)
		}, [inputValue, pasteChips, setInputValue, expandMentions, onSend, onShowUsage])

		const handleRemovePasteChip = useCallback((id: string) => {
			setPasteChips((prev) => prev.filter((chip) => chip.id !== id))
		}, [])

		useEffect(() => {
			if (!containerRef.current) return

			// Check if ResizeObserver is available (it won't be in test environment)
			if (typeof ResizeObserver === "undefined") return

			const resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					const width = entry.contentRect.width
					setContainerWidth(width)
				}
			})

			resizeObserver.observe(containerRef.current)

			return () => {
				resizeObserver.disconnect()
			}
		}, [])
		// forked_change end

		const [searchLoading, setSearchLoading] = useState(false)
		const [searchRequestId, setSearchRequestId] = useState<string>("")

		// Close dropdown when clicking outside.
		useEffect(() => {
			const handleClickOutside = () => {
				if (showDropdown) {
					setShowDropdown(false)
				}
			}

			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}, [showDropdown])

		const [isDraggingOver, setIsDraggingOver] = useState(false)
		// forked_change start: pull slash commands from Cline
		const [showSlashCommandsMenu, setShowSlashCommandsMenu] = useState(false)
		const [selectedSlashCommandsIndex, setSelectedSlashCommandsIndex] = useState(0)
		const [slashCommandsQuery, setSlashCommandsQuery] = useState("")
		const slashCommandsMenuContainerRef = useRef<HTMLDivElement>(null)
		// kilocode_end
		const [showContextMenu, setShowContextMenu] = useState(false)
		const [cursorPosition, setCursorPosition] = useState(0)
		const [searchQuery, setSearchQuery] = useState("")
		const textAreaRef = useRef<HTMLDivElement | null>(null)
		const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)
		const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
		const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
		const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
		const contextMenuContainerRef = useRef<HTMLDivElement>(null)
		const [isFocused, setIsFocused] = useState(false)
		const [imageWarning, setImageWarning] = useState<string | null>(null) // kilocode_change
		const [materialIconsBaseUri, setMaterialIconsBaseUri] = useState("")

		// const [isUserInput, setIsUserInput] = useState(false)
		const isUserInputRef = useRef(false) // Use ref to avoid re-renders
		const intendedCursorPositionRef = useRef<number | null>(null) // Track intended cursor position for synchronous restoration
		const lastSelectionRef = useRef<{ start: number; end: number } | null>(null)
		// True while an IME composition session is active in the contenteditable.
		// During composition the browser owns the DOM and the in-progress text, so
		// we must not rebuild innerHTML or the partial character will be lost or
		// duplicated when the composer finalizes.
		const isComposingRef = useRef(false)

		// get the icons base uri on mount
		useEffect(() => {
			const w = window as any
			setMaterialIconsBaseUri(w.MATERIAL_ICONS_BASE_URI)
		}, [])

		const applyCursorPosition = useCallback((position: number) => {
			setCursorPosition(position)
			intendedCursorPositionRef.current = position
		}, [])

		// Use custom hook for prompt history navigation
		const { handleHistoryNavigation, resetHistoryNavigation, resetOnInputChange } = usePromptHistory({
			clineMessages,
			taskHistoryVersion, // kilocode_change
			cwd,
			inputValue,
			setInputValue,
			cursorPosition,
			applyCursorPosition,
		})

		// Fetch git commits when Git is selected or when typing a hash.
		useEffect(() => {
			if (/^[a-f0-9]+$/i.test(searchQuery)) {
				const message: WebviewMessage = {
					type: "searchCommits",
					query: searchQuery || "",
				} as const
				vscode.postMessage(message)
			}
		}, [searchQuery])

		// forked_change start: Image warning handlers
		const showImageWarning = useCallback((messageKey: string) => {
			setImageWarning(messageKey)
		}, [])

		const dismissImageWarning = useCallback(() => {
			setImageWarning(null)
		}, [])
		// forked_change end: Image warning handlers

		// forked_change start: Clear images if unsupported
		// Track previous shouldDisableImages state to detect when model image support changes
		const prevShouldDisableImages = useRef<boolean>(shouldDisableImages)
		useEffect(() => {
			if (!prevShouldDisableImages.current && shouldDisableImages && selectedImages.length > 0) {
				setSelectedImages([])
				showImageWarning("kilocode:imageWarnings.imagesRemovedNoSupport")
			}
			prevShouldDisableImages.current = shouldDisableImages
		}, [shouldDisableImages, selectedImages.length, setSelectedImages, showImageWarning])
		// forked_change end: Clear images if unsupported

		const allModes = useMemo(() => getAllModes(customModes), [customModes])

		const queryItems = useMemo(() => {
			return [
				// { type: ContextMenuOptionType.Problems, value: "problems" },
				// { type: ContextMenuOptionType.Terminal, value: "terminal" },
				// ...gitCommits,
				// ...openedTabs
				// 	.filter((tab) => tab.path)
				// 	.map((tab) => ({
				// 		type: ContextMenuOptionType.OpenedFile,
				// 		value: "/" + tab.path,
				// 	})),
				...filePaths
					.map((file) => "/" + file)
					.map((path) => ({
						type: path.endsWith("/") ? ContextMenuOptionType.Folder : ContextMenuOptionType.File,
						value: path,
					})),
			]
		}, [filePaths])

		useEffect(() => {
			const handleClickOutside = (event: MouseEvent) => {
				if (
					contextMenuContainerRef.current &&
					!contextMenuContainerRef.current.contains(event.target as Node)
				) {
					setShowContextMenu(false)
				}
			}

			if (showContextMenu) {
				document.addEventListener("mousedown", handleClickOutside)
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutside)
			}
		}, [showContextMenu, setShowContextMenu])

		// forked_change start: pull slash commands from Cline
		const handleSlashCommandsSelect = useCallback(
			(command: SlashCommand) => {
				setShowSlashCommandsMenu(false)

				// Mode switching is disabled. Slash commands that would switch
				// modes are ignored entirely; remaining slash commands still
				// insert as before.
				const modeSwitchCommands = getAllModes(customModes).map((mode) => mode.slug)
				if (modeSwitchCommands.includes(command.name)) {
					return
				}

				if (command.name === "resume") {
					vscode.postMessage({ type: "switchTab", tab: "history" })
					setInputValue("")
					return
				}

				if (command.name === "usage") {
					onShowUsage?.()
					setInputValue("")
					return
				}

				// Handle other slash commands (like newtask)
				const { newValue, commandIndex } = insertSlashCommand(inputValue, command.name)
				const newCursorPosition = newValue.indexOf(" ", commandIndex + 1 + command.name.length) + 1

				setInputValue(newValue)
				setCursorPosition(newCursorPosition)
				intendedCursorPositionRef.current = newCursorPosition

				setTimeout(() => {
					textAreaRef.current?.focus()
				}, 0)
			},
			[inputValue, setInputValue, customModes, onShowUsage],
		)
		// forked_change end

		useEffect(() => {
			if (!showContextMenu) {
				setSelectedType(null)
			}
		}, [showContextMenu])

		const handleBlur = useCallback(() => {
			// Only hide the context menu if the user didn't click on it.
			if (!isMouseDownOnMenu) {
				setShowContextMenu(false)
				setShowSlashCommandsMenu(false) // kilocode_change: pull slash commands from Cline
			}

			setIsFocused(false)
			lastSelectionRef.current = null
		}, [isMouseDownOnMenu])

		const toPlainText = useCallback((node: Node, isLastSibling: boolean): string => {
			if (node.nodeType === Node.TEXT_NODE) {
				return node.textContent || ""
			}

			if (node.nodeType === Node.ELEMENT_NODE) {
				const el = node as HTMLElement

				if (el.dataset?.mentionValue) {
					return el.dataset.mentionValue
				}

				if (el.dataset?.commandValue) {
					return el.dataset.commandValue
				}

				// <li data-list-marker="-">item</li> must round-trip back to "- item",
				// exactly matching what the user typed and what valueToHtml produced.
				// Indentation and the trailing space-after-marker are reconstructed
				// here so the synthetic offset stays in sync with the rendered HTML.
				if (el.dataset?.listMarker !== undefined) {
					const indent = el.dataset.listIndent ? parseInt(el.dataset.listIndent, 10) : 0
					const marker = el.dataset.listMarker
					let result = `${" ".repeat(indent)}${marker} `
					const children = Array.from(el.childNodes)
					const isListNode = (n: Node): boolean =>
						n.nodeType === Node.ELEMENT_NODE &&
						((n as HTMLElement).tagName === "UL" || (n as HTMLElement).tagName === "OL")
					for (let i = 0; i < children.length; i++) {
						const currChild = children[i]
						// Only insert a "\n" when crossing the boundary between
						// text/chip content and a nested list. Chips and text are
						// contiguous in the source and must NOT be separated, or
						// the round-tripped plain text gains a phantom newline
						// that breaks caret math and corrupts the input value.
						if (isListNode(currChild)) {
							result += "\n"
						} else if (i > 0 && isListNode(children[i - 1])) {
							result += "\n"
						}
						result += toPlainText(currChild, i === children.length - 1)
					}
					if (!isLastSibling) result += "\n"
					return result
				}

				if (el.tagName === "BR") {
					return "\n"
				}

				const children = Array.from(el.childNodes)
				const text = children.map((child, idx) => toPlainText(child, idx === children.length - 1)).join("")

				if ((el.tagName === "DIV" || el.tagName === "P") && !isLastSibling) {
					return text + "\n"
				}

				return text
			}

			return ""
		}, [])

		const getPlainTextFromInput = useCallback(() => {
			if (!textAreaRef.current) return ""
			const children = Array.from(textAreaRef.current.childNodes)
			return children.map((child, idx) => toPlainText(child, idx === children.length - 1)).join("")
		}, [toPlainText])

		const getNodeTextLength = useCallback((node: Node): number => {
			if (node.nodeType === Node.TEXT_NODE) {
				return (node.textContent || "").length
			}

			if (node.nodeType === Node.ELEMENT_NODE) {
				const el = node as HTMLElement

				if (el.dataset?.mentionValue) {
					return el.dataset.mentionValue.length
				}

				if (el.dataset?.commandValue) {
					return el.dataset.commandValue.length
				}

				// LI contributes the marker + the spacer character PLUS its body text.
				// This matches toPlainText so caret math stays consistent in both directions.
				if (el.dataset?.listMarker !== undefined) {
					const indent = el.dataset.listIndent ? parseInt(el.dataset.listIndent, 10) : 0
					const marker = el.dataset.listMarker
					let total = indent + marker.length + 1
					total += Array.from(el.childNodes).reduce((sum, child) => sum + getNodeTextLength(child), 0)
					// toPlainText appends "\n" after every non-last LI to mirror the
					// newline that separates list items in the source text. Mirror it
					// here so caret math stays consistent in both directions.
					const parent = el.parentNode
					if (parent) {
						const siblings = Array.from(parent.childNodes)
						if (siblings.indexOf(el) !== siblings.length - 1) {
							total += 1
						}
					}
					return total
				}

				if (el.tagName === "BR") {
					return 1
				}

				return Array.from(el.childNodes).reduce((sum, child) => sum + getNodeTextLength(child), 0)
			}

			return 0
		}, [])

		const computeTextOffset = useCallback(
			(root: Node, target: Node, offset: number): number => {
				// Bytes attributed to the leading "- " (or "1. ") marker on an LI
				// without counting the actual content. symmetric with the contribution
				// getNodeTextLength makes for plain text that surrounds lists.
				const listPrefix = (el: HTMLElement): number => {
					if (el.dataset?.listMarker === undefined) return 0
					const indent = el.dataset.listIndent ? parseInt(el.dataset.listIndent, 10) : 0
					return indent + (el.dataset.listMarker?.length ?? 0) + 1
				}

				if (root === target) {
					if (target.nodeType === Node.ELEMENT_NODE) {
						const targetEl = target as HTMLElement
						const children = Array.from(target.childNodes)
						let total = 0
						if (targetEl.dataset?.listMarker !== undefined) {
							total += listPrefix(targetEl)
						}
						for (let i = 0; i < offset && i < children.length; i++) {
							total += getNodeTextLength(children[i])
						}
						return total
					}
					return offset
				}

				let total = 0
				for (const child of Array.from(root.childNodes)) {
					if (child === target) {
						return total + computeTextOffset(child, target, offset)
					}
					if (child.contains(target)) {
						const childEl = child as HTMLElement
						// When the cursor lands inside an LI's text content, attribute
						// the leading marker bytes to the running total before
						// descending, otherwise caret math loses the marker.
						if (childEl.dataset?.listMarker !== undefined) {
							return total + listPrefix(childEl) + computeTextOffset(childEl, target, offset)
						}
						return total + computeTextOffset(child, target, offset)
					}
					total += getNodeTextLength(child)
				}

				return total
			},
			[getNodeTextLength],
		)

		const getSelectionOffsets = useCallback((): { start: number; end: number } | null => {
			if (!textAreaRef.current) return null
			const selection = window.getSelection()
			if (!selection || selection.rangeCount === 0) return null

			const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
			if (
				!anchorNode ||
				!focusNode ||
				!textAreaRef.current.contains(anchorNode) ||
				!textAreaRef.current.contains(focusNode)
			) {
				return null
			}

			const anchor = computeTextOffset(textAreaRef.current, anchorNode, anchorOffset)
			const focus = computeTextOffset(textAreaRef.current, focusNode, focusOffset)

			return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
		}, [computeTextOffset])

		useEffect(() => {
			const rememberSelection = () => {
				const selection = getSelectionOffsets()
				if (selection) {
					lastSelectionRef.current = selection
				}
			}

			document.addEventListener("selectionchange", rememberSelection)
			return () => document.removeEventListener("selectionchange", rememberSelection)
		}, [getSelectionOffsets])

		const getCaretPosition = useCallback(() => {
			if (!textAreaRef.current) return 0
			const selection = window.getSelection()
			if (!selection || !selection.focusNode || !textAreaRef.current.contains(selection.focusNode)) return 0

			return computeTextOffset(textAreaRef.current, selection.focusNode, selection.focusOffset)
		}, [computeTextOffset])

		const getCurrentInputSnapshot = useCallback(() => {
			return {
				value: getPlainTextFromInput(),
				cursor: getCaretPosition(),
			}
		}, [getCaretPosition, getPlainTextFromInput])

		const handleMentionSelect = useCallback(
			(type: ContextMenuOptionType, value?: string) => {
				// forked_change start
				if (type === ContextMenuOptionType.Image) {
					setShowContextMenu(false)
					setSelectedType(null)

					const { value: currentValue, cursor: currentCursorPosition } = getCurrentInputSnapshot()
					const beforeCursor = currentValue.slice(0, currentCursorPosition)
					const afterCursor = currentValue.slice(currentCursorPosition)
					const lastAtIndex = beforeCursor.lastIndexOf("@")

					if (lastAtIndex !== -1) {
						const newValue = beforeCursor.slice(0, lastAtIndex) + afterCursor
						setInputValue(newValue)
						setCursorPosition(lastAtIndex)
						intendedCursorPositionRef.current = lastAtIndex
					} else if (currentValue !== inputValue) {
						setInputValue(currentValue)
						setCursorPosition(currentCursorPosition)
						intendedCursorPositionRef.current = currentCursorPosition
					}

					onSelectImages()
					return
				}
				// forked_change end

				if (type === ContextMenuOptionType.NoResults) {
					return
				}

				if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
					if (!value) {
						setSelectedType(type)
						setSearchQuery("")
						setSelectedMenuIndex(0)
						return
					}
				}

				setShowContextMenu(false)
				setSelectedType(null)

				let insertValue = value || ""

				if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
					const fullPath = value || ""
					if (fullPath.startsWith("/")) {
						const segments = fullPath.split("/").filter(Boolean)
						const filename = segments.pop() || fullPath
						insertValue = filename
						mentionMapRef.current.set(filename, fullPath)
					} else {
						insertValue = fullPath
					}
				}

				const { newValue, mentionIndex } = insertMention(inputValue, cursorPosition, insertValue)

				setInputValue(newValue)
				const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
				setCursorPosition(newCursorPosition)
				intendedCursorPositionRef.current = newCursorPosition

				setTimeout(() => {
					textAreaRef.current?.focus()
				}, 0)
			},
			[cursorPosition, getCurrentInputSnapshot, inputValue, onSelectImages, setInputValue, setCursorPosition],
		)

		const handlePaste = useCallback(
			async (e: React.ClipboardEvent) => {
				const items = e.clipboardData.items

				const pastedText = e.clipboardData.getData("text")
				const _pastedHtml = e.clipboardData.getData("text/html")

				// Use actual DOM caret position and text content (React state may be stale
				// after Shift+Enter inserts a newline — inputValue won't re-render until next
				// cycle, but the DOM is already updated)
				const selection = getSelectionOffsets()
				const selectionStart = selection?.start ?? getCaretPosition()
				const selectionEnd = selection?.end ?? selectionStart
				const currentValue = getPlainTextFromInput()

				// kilocode_change start: detect pasted file paths and attach them
				// instead of inserting the path as plain text. The webview cannot
				// read the filesystem, so we ask the extension to read the file and
				// return image/document attachments via the existing
				// selectedAttachments response channel.
				const trimmedPaste = pastedText.trim()
				if (trimmedPaste && !trimmedPaste.includes("\n")) {
					const attachmentPath = resolveAttachmentPath(trimmedPaste, cwd)
					if (attachmentPath) {
						const lower = attachmentPath.toLowerCase()
						const isImage = IMAGE_PATH_EXTENSIONS.some((ext) => lower.endsWith(ext))
						if (isImage) {
							if (shouldDisableImages) {
								e.preventDefault()
								showImageWarning("kilocode:imageWarnings.modelNoImageSupport")
								return
							}
							if (selectedImages.length >= MAX_IMAGES_PER_MESSAGE) {
								e.preventDefault()
								showImageWarning("kilocode:imageWarnings.maxImagesReached")
								return
							}
						}
						e.preventDefault()
						vscode.postMessage({ type: "attachmentPathToAttachment", imagePath: attachmentPath })
						return
					}
				}
				// kilocode_change end: detect pasted file paths

				// Check if the pasted content is a URL, add space after so user
				// can easily delete if they don't want it.
				const urlRegex = /^\S+:\/\/\S+$/
				if (urlRegex.test(pastedText.trim())) {
					e.preventDefault()
					const trimmedUrl = pastedText.trim()
					const newValue =
						currentValue.slice(0, selectionStart) + trimmedUrl + " " + currentValue.slice(selectionEnd)
					setInputValue(newValue)
					const newCursorPosition = selectionStart + trimmedUrl.length + 1
					setCursorPosition(newCursorPosition)
					intendedCursorPositionRef.current = newCursorPosition
					setShowContextMenu(false)

					return
				}

				// Collapse large text pastes (>= 500 chars) into a single paste chip in
				// the attachment strip below the input. The full text is kept in the chip
				// and merged back into the message at this exact cursor position when the
				// message is sent (see mergePasteChips).
				if (pastedText.length >= PASTE_CHIP_THRESHOLD) {
					e.preventDefault()
					const pasteId = String(nextPasteIdRef.current++)
					setPasteChips((prev) => [
						...prev,
						{ id: pasteId, text: pastedText, insertPosition: selectionStart },
					])
					setCursorPosition(selectionStart)
					intendedCursorPositionRef.current = selectionStart
					setShowContextMenu(false)
					return
				}

				// Handle all text pastes (both HTML and plain text) manually to ensure correct
				// cursor position handling with mention chips. Browser default paste behavior
				// doesn't understand mention chips and can insert text in wrong positions.
				if (pastedText) {
					e.preventDefault()
					const plainText = pastedText

					const newValue =
						currentValue.slice(0, selectionStart) + plainText + currentValue.slice(selectionEnd)
					const newCursorPosition = selectionStart + plainText.length

					setInputValue(newValue)
					setCursorPosition(newCursorPosition)
					intendedCursorPositionRef.current = newCursorPosition
					setShowContextMenu(false)
					return
				}

				const acceptedTypes = ["png", "jpeg", "webp"]

				const imageItems = Array.from(items).filter((item) => {
					const [type, subtype] = item.type.split("/")
					return type === "image" && acceptedTypes.includes(subtype)
				})

				// forked_change start: Image validation with warning messages
				if (imageItems.length > 0) {
					e.preventDefault()

					if (shouldDisableImages) {
						showImageWarning(`kilocode:imageWarnings.modelNoImageSupport`)
						return
					}
					if (selectedImages.length >= MAX_IMAGES_PER_MESSAGE) {
						showImageWarning(`kilocode:imageWarnings.maxImagesReached`)
						return
					}
					// forked_change end: Image validation with warning messages

					const imagePromises = imageItems.map((item) => {
						return new Promise<ImageAttachment | null>((resolve) => {
							const blob = item.getAsFile()

							if (!blob) {
								resolve(null)
								return
							}

							const fileName = blob.name || `image_${Date.now()}.png`
							const reader = new FileReader()

							reader.onloadend = () => {
								if (reader.error) {
									console.error(t("chat:errorReadingFile"), reader.error)
									resolve(null)
								} else {
									const result = reader.result
									if (typeof result === "string") {
										resolve({ dataUrl: result, name: fileName })
									} else {
										resolve(null)
									}
								}
							}

							reader.readAsDataURL(blob)
						})
					})

					const imageDataArray = await Promise.all(imagePromises)
					const validImages = imageDataArray.filter((img): img is ImageAttachment => img !== null)

					if (validImages.length > 0) {
						setSelectedImages((prevImages) =>
							[...prevImages, ...validImages].slice(0, MAX_IMAGES_PER_MESSAGE),
						)
					} else {
						console.warn(t("chat:noValidImages"))
					}
				}

				// kilocode_change start: handle non-image file blobs pasted directly
				// (e.g. copying a PDF from Finder). The webview cannot extract
				// document text, so read the blob as a data URL and ask the
				// extension to process it.
				const documentFileItems = Array.from(items).filter((item) => {
					if (item.kind !== "file") return false
					const file = item.getAsFile()
					if (!file) return false
					// Skip images (already handled above) and items with no usable type
					if (item.type.startsWith("image/")) return false
					const ext = fileExt(file.name || "")
					if (DOCUMENT_PATH_EXTENSIONS.includes(ext)) return true
					// Fall back to MIME mapping for files with no/empty extension
					return !!DOCUMENT_MIME_TO_EXT[item.type]
				})

				if (documentFileItems.length > 0) {
					e.preventDefault()
					const filePromises = documentFileItems.map((item) => {
						return new Promise<{ dataUrl: string; name: string } | null>((resolve) => {
							const file = item.getAsFile()
							if (!file) {
								resolve(null)
								return
							}
							const ext = fileExt(file.name || "")
							const resolvedExt = ext || DOCUMENT_MIME_TO_EXT[item.type] || ""
							const baseName = fileBaseName(file.name || "attachment", ext)
							const fileName = `${baseName}${resolvedExt}`
							const reader = new FileReader()
							reader.onloadend = () => {
								if (reader.error || typeof reader.result !== "string") {
									resolve(null)
								} else {
									resolve({ dataUrl: reader.result, name: fileName })
								}
							}
							reader.readAsDataURL(file)
						})
					})

					const fileResults = await Promise.all(filePromises)
					for (const file of fileResults) {
						if (file) {
							vscode.postMessage({
								type: "pastedFileAttachment",
								fileDataUrl: file.dataUrl,
								fileName: file.name,
							})
						}
					}
				}
				// kilocode_change end: handle non-image file blobs pasted directly
			},
			[
				shouldDisableImages,
				setSelectedImages,
				setInputValue,
				t,
				selectedImages.length, // kilocode_change - added selectedImages.length
				showImageWarning, // kilocode_change - added showImageWarning
				getCaretPosition,
				getSelectionOffsets,
				getPlainTextFromInput,
				cwd, // kilocode_change - for image path resolution
			],
		)

		const handleMenuMouseDown = useCallback(() => {
			setIsMouseDownOnMenu(true)
		}, [])

		// List formatting is shared with ReadOnlyChatText/StickyUserMessage via
		// the central chat-render helper. Memoize so useLayoutEffect does not
		// rebuild innerHTML on every unrelated re-render (each rebuild would
		// collapse the caret/selection).
		const valueToHtml = useCallback(
			(value: string) =>
				renderValueToHtml(
					value,
					materialIconsBaseUri,
					mentionMapRef.current,
					customModes,
					localWorkflows,
					globalWorkflows,
				),
			[materialIconsBaseUri, customModes, localWorkflows, globalWorkflows],
		)

		const setSelectionOffsets = useCallback((start: number, end: number = start) => {
			const el = textAreaRef.current
			if (!el) return

			const locatePoint = (position: number): { node: Node; offset: number } => {
				let remaining = Math.max(0, position)

				const walk = (node: Node): { node: Node; offset: number } | null => {
					if (node.nodeType === Node.TEXT_NODE) {
						const length = node.textContent?.length || 0
						if (remaining <= length) return { node, offset: remaining }
						remaining -= length
						// After consuming the entire textNode, if it is the last
						// child of its parent, the caret sits at the end of the
						// textNode. Return that position so the caret lands
						// inside the parent (e.g. inside an <li>) instead of
						// falling back to the end of the outermost container,
						// which would visually break out of the list item.
						const parent = node.parentNode
						if (parent) {
							const siblings = Array.from(parent.childNodes) as ChildNode[]
							const index = siblings.indexOf(node as ChildNode)
							if (remaining === 0 && index === siblings.length - 1) {
								return { node: parent, offset: index + 1 }
							}
						}
						return null
					}

					if (node.nodeType !== Node.ELEMENT_NODE) return null
					const element = node as HTMLElement
					const atomicLength = element.dataset?.mentionValue?.length ?? element.dataset?.commandValue?.length

					if (atomicLength !== undefined || element.tagName === "BR") {
						const length = atomicLength ?? 1
						const parent = element.parentNode
						if (!parent) return null
						const index = Array.from(parent.childNodes).indexOf(element)
						if (remaining === 0) return { node: parent, offset: index }
						if (remaining <= length) {
							remaining = 0
							return { node: parent, offset: index + 1 }
						}
						remaining -= length
						return null
					}

					// LI: attribute leading "- " bytes to the running total before
					// descending so that the marker stays transparent to the caller,
					// then walk into the body text. The marker itself is purely a
					// presentational pseudo-element (see index.css .chat-list) so
					// the caret must land on the real content node.
					if (element.dataset?.listMarker !== undefined) {
						const indent = element.dataset.listIndent ? parseInt(element.dataset.listIndent, 10) : 0
						const prefix = indent + (element.dataset.listMarker?.length ?? 0) + 1
						if (remaining <= indent) {
							// Caret before the list body (between indent and marker).
							// Snap to the start of the LI so we never expose a DOM
							// position without a corresponding plain-text character.
							const parent = element.parentNode
							if (!parent) return null
							const index = Array.from(parent.childNodes).indexOf(element)
							return { node: parent, offset: index + 1 }
						}
						if (remaining <= prefix) {
							// Caret sits in the marker slot — land on the start of the
							// first child so subsequent text-input remains inside the LI.
							const firstChild = element.childNodes[0] ?? element
							return { node: firstChild, offset: 0 }
						}
						remaining -= prefix
					}

					for (const child of Array.from(element.childNodes)) {
						const point = walk(child)
						if (point) return point
					}

					if (element.dataset?.listMarker !== undefined) {
						const parent = element.parentNode
						if (parent) {
							const siblings = Array.from(parent.childNodes)
							const index = siblings.indexOf(element)
							if (index !== siblings.length - 1) {
								if (remaining <= 1) return { node: parent, offset: index + 1 }
								remaining -= 1
							}
						}
					}

					return null
				}

				return walk(el) ?? { node: el, offset: el.childNodes.length }
			}

			const startPoint = locatePoint(start)
			const endPoint = locatePoint(end)
			const range = document.createRange()
			range.setStart(startPoint.node, startPoint.offset)
			range.setEnd(endPoint.node, endPoint.offset)

			const selection = window.getSelection()
			if (!selection) return
			selection.removeAllRanges()
			selection.addRange(range)
			lastSelectionRef.current = { start, end }
		}, [])

		const setCaretPosition = useCallback((position: number) => setSelectionOffsets(position), [setSelectionOffsets])

		useLayoutEffect(() => {
			if (!textAreaRef.current) return

			// While the user is composing text (IME / dead keys), the browser owns the
			// partial character. Rebuilding innerHTML here would either lose it or
			// duplicate it once the composition ends, so we always skip.
			if (isComposingRef.current) {
				return
			}

			// Only update innerHTML if the change is not from user input
			// This prevents destroying the selection when user is typing or pressing Enter
			if (isUserInputRef.current) {
				// Reset the flag after checking it
				isUserInputRef.current = false
				// If the typed text still has no list syntax (e.g. plain letters / a
				// single "- " that was deleted before pressing space), there is
				// nothing structured to rebuild, so we skip. This avoids a full DOM
				// rewrite on every keystroke for normal text.
				if (!containsListSyntax(inputValue)) {
					intendedCursorPositionRef.current = null
					return
				}
				// Otherwise fall through: list syntax appears or changed during typing,
				// so we need to swap plain-text into <ul>/<ol>/<li>. Preserve the
				// queued caret position so the user lands in the right place.
			}

			const previousSelection = lastSelectionRef.current
			const liveSelection = getSelectionOffsets()
			if (liveSelection && liveSelection.start !== liveSelection.end) {
				// A live range is authoritative while the user is dragging or extending a
				// selection. Never replace it with an older caret snapshot.
				lastSelectionRef.current = liveSelection
			}
			const intendedCursorPosition = intendedCursorPositionRef.current
			intendedCursorPositionRef.current = null

			const html = valueToHtml(inputValue)
			if (textAreaRef.current.innerHTML !== html) {
				textAreaRef.current.innerHTML = html
			}

			// A parent render can reset a contenteditable selection even when its HTML
			// did not change. Restore after every commit, using the last browser
			// selectionchange snapshot rather than reading the already-reset selection.
			const targetSelection =
				intendedCursorPosition !== null
					? { start: intendedCursorPosition, end: intendedCursorPosition }
					: liveSelection && liveSelection.start !== liveSelection.end
						? liveSelection
						: previousSelection
			if (targetSelection) {
				const currentSelection = getSelectionOffsets()
				if (
					!currentSelection ||
					currentSelection.start !== targetSelection.start ||
					currentSelection.end !== targetSelection.end
				) {
					setSelectionOffsets(targetSelection.start, targetSelection.end)
				}
			}
		})

		const updateCursorPosition = useCallback(() => {
			const selection = getSelectionOffsets()
			if (selection) {
				lastSelectionRef.current = selection
				// Updating React state while a drag/Shift selection is in progress causes
				// another editor commit, which can collapse the native range.
				if (selection.start === selection.end) {
					setCursorPosition(selection.end)
				}
			}
		}, [getSelectionOffsets])

		const handleKeyUp = useCallback(
			(e: React.KeyboardEvent<HTMLDivElement>) => {
				if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
					updateCursorPosition()
				}
			},
			[updateCursorPosition],
		)

		const handleKeyDown = useCallback(
			(event: React.KeyboardEvent<HTMLDivElement>) => {
				if (showSlashCommandsMenu) {
					if (event.key === "Escape") {
						setShowSlashCommandsMenu(false)
						return
					}

					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedSlashCommandsIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							const commands = getMatchingSlashCommands(
								slashCommandsQuery,
								customModes,
								localWorkflows,
								globalWorkflows,
							)

							if (commands.length === 0) {
								return prevIndex
							}

							const newIndex = (prevIndex + direction + commands.length) % commands.length
							return newIndex
						})
						return
					}

					// Don't intercept modifier+Enter (e.g. cmd+enter for new line)
					if (
						(event.key === "Enter" || event.key === "Tab") &&
						selectedSlashCommandsIndex !== -1 &&
						!event.metaKey &&
						!event.ctrlKey
					) {
						event.preventDefault()
						const commands = getMatchingSlashCommands(
							slashCommandsQuery,
							customModes,
							localWorkflows,
							globalWorkflows,
						)
						if (commands.length > 0) {
							handleSlashCommandsSelect(commands[selectedSlashCommandsIndex])
						}
						return
					}
				}

				if (showContextMenu) {
					if (event.key === "Escape") {
						setSelectedType(null)
						setSelectedMenuIndex(3)
						return
					}

					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedMenuIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							const options = getContextMenuOptions(
								searchQuery,
								selectedType,
								queryItems,
								fileSearchResults,
								allModes,
							)
							const optionsLength = options.length

							if (optionsLength === 0) return prevIndex

							const selectableOptions = options.filter(
								(option) =>
									// option.type !== ContextMenuOptionType.URL &&
									option.type !== ContextMenuOptionType.NoResults,
							)

							if (selectableOptions.length === 0) return -1

							const currentSelectableIndex = selectableOptions.findIndex(
								(option) => option === options[prevIndex],
							)

							const newSelectableIndex =
								(currentSelectableIndex + direction + selectableOptions.length) %
								selectableOptions.length

							return options.findIndex((option) => option === selectableOptions[newSelectableIndex])
						})
						return
					}
					// Don't intercept modifier+Enter (e.g. cmd+enter for new line)
					if (
						(event.key === "Enter" || event.key === "Tab") &&
						selectedMenuIndex !== -1 &&
						!event.metaKey &&
						!event.ctrlKey
					) {
						event.preventDefault()
						const selectedOption = getContextMenuOptions(
							searchQuery,
							selectedType,
							queryItems,
							fileSearchResults,
							allModes,
						)[selectedMenuIndex]
						if (
							selectedOption &&
							// selectedOption.type !== ContextMenuOptionType.URL &&
							selectedOption.type !== ContextMenuOptionType.NoResults
						) {
							handleMentionSelect(selectedOption.type, selectedOption.value)
						}
						return
					}
				}

				const isComposing = event.nativeEvent?.isComposing ?? false
				const liveSelection = getSelectionOffsets()
				const liveValue = getPlainTextFromInput()
				const activeValue = textAreaRef.current ? liveValue : inputValue
				const activeCursorPosition = liveSelection?.end ?? cursorPosition
				const hasSelection = liveSelection ? liveSelection.start !== liveSelection.end : false

				const shouldSendMessage =
					!isComposing &&
					event.key === "Enter" &&
					!event.metaKey &&
					!event.ctrlKey &&
					((sendMessageOnEnter && !event.shiftKey) || (!sendMessageOnEnter && event.shiftKey))

				if (shouldSendMessage) {
					event.preventDefault()

					resetHistoryNavigation()
					handleSend()
					return
				}

				// List continuation / exit on Enter: when the caret sits inside a list line
				// and the keystroke would normally insert a newline (i.e. not send the
				// message), insert the next marker so the user can keep typing items
				// without retyping "- " or "1. " on every line. If the current line is
				// just the marker with no content, exit the list instead — the second
				// press of Enter (or Shift+Enter) on a freshly-opened list item drops
				// the marker and leaves the cursor on a plain blank line.
				const wouldInsertNewline =
					event.key === "Enter" && !isComposing && !event.metaKey && !event.ctrlKey && !hasSelection
				if (wouldInsertNewline && containsListSyntax(activeValue)) {
					const beforeCursor = activeValue.slice(0, activeCursorPosition)
					const lineStart = beforeCursor.lastIndexOf("\n") + 1
					const nextNewline = activeValue.indexOf("\n", activeCursorPosition)
					const lineEnd = nextNewline === -1 ? activeValue.length : nextNewline
					const currentLine = activeValue.slice(lineStart, lineEnd)
					const match = currentLine.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/)
					if (match) {
						event.preventDefault()
						const indent = match[1]
						const marker = match[2]

						// Empty list item (just "- " / "1. ") → exit the list. Strip the
						// marker while keeping the surrounding newlines so the caret
						// drops onto a fresh blank line below the previous list item
						// rather than snapping back to the end of the last item.
						if (match[4] === "") {
							const prefix = indent + marker + match[3]
							const prefixStart = lineStart
							const prefixEnd = prefixStart + prefix.length
							const newValue = activeValue.slice(0, prefixStart) + activeValue.slice(prefixEnd)
							// Keep the caret at prefixStart. The character at
							// prefixStart in the new value is the newline that used
							// to terminate the previous list item (or end-of-string
							// if there was nothing before it), so the caret sits on
							// the new blank line below the list.
							const newCursor = prefixStart
							setInputValue(newValue)
							setCursorPosition(newCursor)
							intendedCursorPositionRef.current = newCursor
							lastSelectionRef.current = { start: newCursor, end: newCursor }
							return
						}

						const nextMarker = /[-*+]/.test(marker) ? "-" : `${parseInt(marker, 10) + 1}.`
						const insertion = `\n${indent}${nextMarker} `
						const newValue =
							activeValue.slice(0, activeCursorPosition) +
							insertion +
							activeValue.slice(activeCursorPosition)
						const newCursor = activeCursorPosition + insertion.length
						setInputValue(newValue)
						setCursorPosition(newCursor)
						intendedCursorPositionRef.current = newCursor
						lastSelectionRef.current = { start: newCursor, end: newCursor }
						return
					}
				}

				if (handleHistoryNavigation(event, showContextMenu, isComposing)) {
					return
				}

				if (event.key === "Backspace" && !isComposing) {
					const charBeforeCursor = activeValue[activeCursorPosition - 1]
					const charAfterCursor = activeValue[activeCursorPosition]

					const charBeforeIsWhitespace =
						charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"

					const charAfterIsWhitespace =
						charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

					if (
						charBeforeIsWhitespace &&
						activeValue.slice(0, activeCursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))
					) {
						const newCursorPosition = activeCursorPosition - 1
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							setCaretPosition(newCursorPosition)
							setCursorPosition(newCursorPosition)
						}

						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterMention(true)
					} else if (justDeletedSpaceAfterMention) {
						const { newText, newPosition } = removeMention(activeValue, activeCursorPosition)

						if (newText !== activeValue) {
							event.preventDefault()
							setInputValue(newText)
							intendedCursorPositionRef.current = newPosition
						}

						setJustDeletedSpaceAfterMention(false)
						setShowContextMenu(false)
					} else {
						setJustDeletedSpaceAfterMention(false)
					}
				}
			},
			[
				showSlashCommandsMenu,
				localWorkflows,
				globalWorkflows,
				customModes,
				handleSlashCommandsSelect,
				selectedSlashCommandsIndex,
				slashCommandsQuery,
				handleSend,
				showContextMenu,
				searchQuery,
				selectedMenuIndex,
				handleMentionSelect,
				selectedType,
				inputValue,
				cursorPosition,
				getSelectionOffsets,
				getPlainTextFromInput,
				setInputValue,
				justDeletedSpaceAfterMention,
				queryItems,
				allModes,
				fileSearchResults,
				handleHistoryNavigation,
				resetHistoryNavigation,
				sendMessageOnEnter,
				setCaretPosition,
			],
		)

		const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

		const handleInputChange = useCallback(() => {
			const newValue = getPlainTextFromInput()
			setInputValue(newValue)
			isUserInputRef.current = true // Mark this as user input using ref
			resetOnInputChange()

			const newCursorPosition = getCaretPosition()
			setCursorPosition(newCursorPosition)
			intendedCursorPositionRef.current = newCursorPosition
			lastSelectionRef.current = { start: newCursorPosition, end: newCursorPosition }

			let showMenu = shouldShowContextMenu(newValue, newCursorPosition)
			const slashMenuVisible = shouldShowSlashCommandsMenu(newValue, newCursorPosition)

			if (slashMenuVisible) {
				showMenu = false
			}

			setShowSlashCommandsMenu(slashMenuVisible)
			setShowContextMenu(showMenu)

			if (slashMenuVisible) {
				const slashIndex = newValue.indexOf("/")
				const query = newValue.slice(slashIndex + 1, newCursorPosition)
				setSlashCommandsQuery(query)
				setSelectedSlashCommandsIndex(0)
			} else {
				setSlashCommandsQuery("")
				setSelectedSlashCommandsIndex(0)
			}

			if (showMenu) {
				const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)

				if (newValue.startsWith("/") && lastAtIndex === -1) {
					const query = newValue
					setSearchQuery(query)
					setSelectedMenuIndex(0)
				} else {
					const query = newValue.slice(lastAtIndex + 1, newCursorPosition)
					setSearchQuery(query)

					if (query.length > 0) {
						setSelectedMenuIndex(0)

						if (searchTimeoutRef.current) {
							clearTimeout(searchTimeoutRef.current)
						}

						searchTimeoutRef.current = setTimeout(() => {
							const reqId = Math.random().toString(36).substring(2, 9)
							setSearchRequestId(reqId)
							setSearchLoading(true)

							vscode.postMessage({
								type: "searchFiles",
								query: unescapeSpaces(query),
								requestId: reqId,
							})
						}, 200)
					} else {
						setSelectedMenuIndex(-1)
					}
				}
			} else {
				setSearchQuery("")
				setSelectedMenuIndex(-1)
				setFileSearchResults([])
			}

			if (textAreaRef.current) {
				onHeightChange?.(textAreaRef.current.clientHeight)
			}
		}, [
			getPlainTextFromInput,
			getCaretPosition,
			resetOnInputChange,
			setInputValue,
			setCursorPosition,
			setShowSlashCommandsMenu,
			setShowContextMenu,
			setSlashCommandsQuery,
			setSelectedSlashCommandsIndex,
			setSearchQuery,
			setSelectedMenuIndex,
			setSearchRequestId,
			setSearchLoading,
			setFileSearchResults,
			onHeightChange,
		])

		// Handle enhanced prompt response and search results.
		useEffect(() => {
			const messageHandler = (event: MessageEvent) => {
				const message = event.data

				if (message.type === "enhancedPrompt") {
					if (message.text && textAreaRef.current) {
						try {
							// Use execCommand to replace text while preserving undo history
							if (document.execCommand) {
								// Use native browser methods to preserve undo stack
								const textarea = textAreaRef.current

								// Focus the textarea to ensure it's the active element
								textarea.focus()

								// Select all text first
								const selection = window.getSelection()
								if (selection) {
									selection.removeAllRanges()
									const range = document.createRange()
									range.selectNodeContents(textarea)
									selection.addRange(range)
								}
								document.execCommand("insertText", false, message.text)
								handleInputChange()
							} else {
								setInputValue(message.text)
							}
						} catch {
							setInputValue(message.text)
						}
					}
				}
				// else if (message.type === "commitSearchResults") {
				// 	const commits = message.commits.map((commit: any) => ({
				// 		type: ContextMenuOptionType.Git,
				// 		value: commit.hash,
				// 		label: commit.subject,
				// 		description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
				// 		icon: "$(git-commit)",
				// 	}))

				// 	setGitCommits(commits)
				// }
				else if (message.type === "fileSearchResults") {
					setSearchLoading(false)
					if (message.requestId === searchRequestId) {
						setFileSearchResults(message.results || [])
					}
					// forked_change start
				} else if (message.type === "insertTextToChatArea") {
					if (message.text) {
						setInputValue(message.text)
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.focus()
							}
						}, 0)
					}
				}
				// forked_change end
			}

			window.addEventListener("message", messageHandler)
			return () => window.removeEventListener("message", messageHandler)
		}, [handleInputChange, searchRequestId, setInputValue])

		const handleDrop = useCallback(
			async (e: React.DragEvent<HTMLDivElement>) => {
				// kilocode_change: detect whether this is a file/attachment drop
				// (external file drag or a path-like text). For plain text drags
				// (e.g. moving a text selection inside the editor) we let the
				// native behavior proceed by not preventing default.
				const textFieldList = e.dataTransfer.getData("text")
				const textUriList = e.dataTransfer.getData("application/vnd.code.uri-list")
				const droppedFiles = Array.from(e.dataTransfer.files)
				const text = textFieldList || textUriList
				const looksLikePathDrop =
					droppedFiles.length > 0 ||
					!!textUriList ||
					(text.length > 0 &&
						text
							.split(/\r?\n/)
							.some((line) => line.trim().startsWith("/") || /^[a-zA-Z]:[\\/]/.test(line.trim())))

				if (!looksLikePathDrop) {
					// Not a file drop — let the editor handle it natively.
					return
				}

				e.preventDefault()
				setIsDraggingOver(false)

				// When textFieldList is empty, it may attempt to use textUriList obtained from drag-and-drop tabs; if not empty, it will use textFieldList.
				if (text) {
					// Split text on newlines to handle multiple files
					const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "")

					if (lines.length > 0) {
						// kilocode_change start: route image/document paths to attachments
						// instead of inserting them as mentions, matching paste behavior.
						const mentionLines: string[] = []
						for (const line of lines) {
							const attachmentPath = resolveAttachmentPath(line, cwd)
							if (attachmentPath) {
								const lower = attachmentPath.toLowerCase()
								const isImage = IMAGE_PATH_EXTENSIONS.some((ext) => lower.endsWith(ext))
								if (isImage) {
									if (shouldDisableImages) {
										showImageWarning("kilocode:imageWarnings.modelNoImageSupport")
										continue
									}
									if (selectedImages.length >= MAX_IMAGES_PER_MESSAGE) {
										showImageWarning("kilocode:imageWarnings.maxImagesReached")
										continue
									}
								}
								vscode.postMessage({ type: "attachmentPathToAttachment", imagePath: attachmentPath })
							} else {
								mentionLines.push(line)
							}
						}
						// kilocode_change end: route image/document paths to attachments

						// Process remaining lines as mentions
						let newValue = inputValue.slice(0, cursorPosition)
						let totalLength = 0

						// Using a standard for loop instead of forEach for potential performance gains.
						for (let i = 0; i < mentionLines.length; i++) {
							const line = mentionLines[i]
							// Convert each path to a mention-friendly format
							const fullMention = convertToMentionPath(line, cwd)
							// Extract filename for compact display
							let mentionText = fullMention
							if (fullMention.startsWith("@/")) {
								const pathWithoutAt = fullMention.slice(1) // Remove @
								const segments = pathWithoutAt.split("/").filter(Boolean)
								const filename = segments.pop() || pathWithoutAt
								mentionText = `${filename}`
								// Store mapping for expansion
								mentionMapRef.current.set(filename, pathWithoutAt)
							}
							newValue += mentionText
							totalLength += mentionText.length

							// Add space after each mention except the last one
							if (i < mentionLines.length - 1) {
								newValue += " "
								totalLength += 1
							}
						}

						// Add space after the last mention and append the rest of the input
						if (mentionLines.length > 0) {
							newValue += " " + inputValue.slice(cursorPosition)
							totalLength += 1

							setInputValue(newValue)
							const newCursorPosition = cursorPosition + totalLength + 1
							setCursorPosition(newCursorPosition)
							intendedCursorPositionRef.current = newCursorPosition
						}
					}

					return
				}

				if (droppedFiles.length > 0) {
					const acceptedTypes = ["png", "jpeg", "webp"]

					const imageFiles = droppedFiles.filter((file) => {
						const [type, subtype] = file.type.split("/")
						return type === "image" && acceptedTypes.includes(subtype)
					})

					// forked_change start: Image validation with warning messages for drag and drop
					if (imageFiles.length > 0) {
						if (shouldDisableImages) {
							showImageWarning("kilocode:imageWarnings.modelNoImageSupport")
							return
						}
						if (selectedImages.length >= MAX_IMAGES_PER_MESSAGE) {
							showImageWarning("kilocode:imageWarnings.maxImagesReached")
							return
						}
						// forked_change end: Image validation with warning messages for drag and drop

						const imagePromises = imageFiles.map((file) => {
							return new Promise<ImageAttachment | null>((resolve) => {
								const reader = new FileReader()

								reader.onloadend = () => {
									if (reader.error) {
										console.error(t("chat:errorReadingFile"), reader.error)
										resolve(null)
									} else {
										const result = reader.result
										if (typeof result === "string") {
											resolve({ dataUrl: result, name: file.name || `image_${Date.now()}.png` })
										} else {
											resolve(null)
										}
									}
								}

								reader.readAsDataURL(file)
							})
						})

						const imageDataArray = await Promise.all(imagePromises)
						const validImages = imageDataArray.filter((img): img is ImageAttachment => img !== null)

						if (validImages.length > 0) {
							const imageUrls = validImages.map((img) => img.dataUrl)
							setSelectedImages((prevImages) =>
								[...prevImages, ...validImages].slice(0, MAX_IMAGES_PER_MESSAGE),
							)

							if (typeof vscode !== "undefined") {
								vscode.postMessage({ type: "draggedImages", dataUrls: imageUrls })
							}
						} else {
							console.warn(t("chat:noValidImages"))
						}
					}

					// kilocode_change start: handle non-image document files dropped
					// from the OS (e.g. Finder). The webview cannot extract document
					// text, so read each as a data URL and ask the extension to process
					// it, matching the paste flow.
					const documentFiles = droppedFiles.filter((file) => {
						if (file.type.startsWith("image/")) return false
						const ext = fileExt(file.name || "")
						if (DOCUMENT_PATH_EXTENSIONS.includes(ext)) return true
						return !!DOCUMENT_MIME_TO_EXT[file.type]
					})

					if (documentFiles.length > 0) {
						const filePromises = documentFiles.map((file) => {
							return new Promise<{ dataUrl: string; name: string } | null>((resolve) => {
								const ext = fileExt(file.name || "")
								const resolvedExt = ext || DOCUMENT_MIME_TO_EXT[file.type] || ""
								const baseName = fileBaseName(file.name || "attachment", ext)
								const fileName = `${baseName}${resolvedExt}`
								const reader = new FileReader()
								reader.onloadend = () => {
									if (reader.error || typeof reader.result !== "string") {
										resolve(null)
									} else {
										resolve({ dataUrl: reader.result, name: fileName })
									}
								}
								reader.readAsDataURL(file)
							})
						})

						const fileResults = await Promise.all(filePromises)
						for (const file of fileResults) {
							if (file) {
								vscode.postMessage({
									type: "pastedFileAttachment",
									fileDataUrl: file.dataUrl,
									fileName: file.name,
								})
							}
						}
					}
					// kilocode_change end: handle non-image document files dropped
				}
			},
			[
				cursorPosition,
				cwd,
				inputValue,
				setInputValue,
				setCursorPosition,
				shouldDisableImages,
				setSelectedImages,
				t,
				selectedImages.length, // kilocode_change - added selectedImages.length
				showImageWarning, // kilocode_change - added showImageWarning
			],
		)

		const [isTtsPlaying, setIsTtsPlaying] = useState(false)

		useEvent("message", (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "ttsStart") {
				setIsTtsPlaying(true)
			} else if (message.type === "ttsStop") {
				setIsTtsPlaying(false)
			}
		})

		const placeholderBottomText = `${t("chat:addContext")}${shouldDisableImages ? `, ${t("chat:dragFiles")}` : `, ${t("chat:dragFilesImages")}`}`
		const attachmentButtonLabel = isEditMode ? t("chat:addImages") : t("chat:addAttachments")
		const shouldDisableAttachmentButton = isEditMode && shouldDisableImages

		// Common mode selector handler
		// const handleModeChange = useCallback(
		// 	(value: Mode) => {
		// 		setMode(value)
		// 		vscode.postMessage({ type: "mode", text: value })
		// 	},
		// 	[setMode],
		// )

		// // Helper function to get API config dropdown options
		// // kilocode_change: unused
		// const _getApiConfigOptions = useMemo(() => {
		// 	const pinnedConfigs = (listApiConfigMeta || [])
		// 		.filter((config) => pinnedApiConfigs && pinnedApiConfigs[config.id])
		// 		.map((config) => ({
		// 			value: config.id,
		// 			label: config.name,
		// 			name: config.name,
		// 			type: DropdownOptionType.ITEM,
		// 			pinned: true,
		// 		}))
		// 		.sort((a, b) => a.label.localeCompare(b.label))

		// 	const unpinnedConfigs = (listApiConfigMeta || [])
		// 		.filter((config) => !pinnedApiConfigs || !pinnedApiConfigs[config.id])
		// 		.map((config) => ({
		// 			value: config.id,
		// 			label: config.name,
		// 			name: config.name,
		// 			type: DropdownOptionType.ITEM,
		// 			pinned: false,
		// 		}))
		// 		.sort((a, b) => a.label.localeCompare(b.label))

		// 	const hasPinnedAndUnpinned = pinnedConfigs.length > 0 && unpinnedConfigs.length > 0

		// 	return [
		// 		...pinnedConfigs,
		// 		...(hasPinnedAndUnpinned
		// 			? [
		// 				{
		// 					value: "sep-pinned",
		// 					label: t("chat:separator"),
		// 					type: DropdownOptionType.SEPARATOR,
		// 				},
		// 			]
		// 			: []),
		// 		...unpinnedConfigs,
		// 		{
		// 			value: "sep-2",
		// 			label: t("chat:separator"),
		// 			type: DropdownOptionType.SEPARATOR,
		// 		},
		// 		{
		// 			value: "settingsButtonClicked",
		// 			label: t("chat:edit"),
		// 			type: DropdownOptionType.ACTION,
		// 		},
		// 	]
		// }, [listApiConfigMeta, pinnedApiConfigs, t])

		// Helper function to handle API config change
		// kilocode_change: unused
		// const _handleApiConfigChange = useCallback((value: string) => {
		// 	if (value === "settingsButtonClicked") {
		// 		vscode.postMessage({
		// 			type: "loadApiConfiguration",
		// 			text: value,
		// 			values: { section: "providers" },
		// 		})
		// 	} else {
		// 		vscode.postMessage({ type: "loadApiConfigurationById", text: value })
		// 	}
		// }, [])

		// Helper function to render API config item
		// kilocode_change: unused
		// const _renderApiConfigItem = useCallback(
		// 	({ type, value, label, pinned }: any) => {
		// 		if (type !== DropdownOptionType.ITEM) {
		// 			return label
		// 		}

		// 		const config = listApiConfigMeta?.find((c) => c.id === value)
		// 		const isCurrentConfig = config?.name === currentApiConfigName

		// 		return (
		// 			<div className="flex justify-between gap-2 w-full h-5">
		// 				<div
		// 					className={cn("truncate min-w-0 overflow-hidden", {
		// 						"font-medium": isCurrentConfig,
		// 					})}>
		// 					{label}
		// 				</div>
		// 				<div className="flex justify-end w-10 flex-shrink-0">
		// 					<div
		// 						className={cn("size-5 p-1", {
		// 							"block group-hover:hidden": !pinned,
		// 							hidden: !isCurrentConfig,
		// 						})}>
		// 						<Check className="size-3" />
		// 					</div>
		// 					<StandardTooltip content={pinned ? t("chat:unpin") : t("chat:pin")}>
		// 						<Button
		// 							variant="ghost"
		// 							size="icon"
		// 							onClick={(e) => {
		// 								e.stopPropagation()
		// 								togglePinnedApiConfig(value)
		// 								vscode.postMessage({
		// 									type: "toggleApiConfigPin",
		// 									text: value,
		// 								})
		// 							}}
		// 							className={cn("size-5", {
		// 								"hidden group-hover:flex": !pinned,
		// 								"bg-accent": pinned,
		// 							})}>
		// 							<Pin className="size-3 p-0.5 opacity-50" />
		// 						</Button>
		// 					</StandardTooltip>
		// 				</div>
		// 			</div>
		// 		)
		// 	},
		// 	[listApiConfigMeta, currentApiConfigName, t, togglePinnedApiConfig],
		// )

		// Helper function to render the text area section
		const renderTextAreaSection = () => (
			<div
				ref={containerRef}
				className={cn(
					"relative",
					"flex-1",
					"flex",
					"flex-col",
					"min-h-0",
					"overflow-hidden",
					"rounded-2xl",
					!isEditMode &&
						(isFocused
							? "border border-[var(--vscode-commandCenter-inactiveBorder)]"
							: isDraggingOver
								? "border-1 border-dashed border-[var(--vscode-commandCenter-inactiveBorder)]"
								: "border border-[var(--vscode-commandCenter-inactiveBorder)]"),
					!isEditMode &&
						(isDraggingOver
							? "bg-[color-mix(in_srgb,var(--vscode-input-background)_95%,white)]"
							: "bg-vscode-input-background"),
					"transition-background-color duration-150 ease-in-out",
					"will-change-background-color",
					"outline-none",
				)}>
				<div
					ref={(el) => {
						if (typeof ref === "function") {
							ref(el)
						} else if (ref) {
							ref.current = el
						}
						textAreaRef.current = el
					}}
					role="textbox"
					contentEditable
					suppressContentEditableWarning
					aria-multiline="true"
					data-testid="chat-input"
					onInput={handleInputChange}
					onFocus={() => setIsFocused(true)}
					onCompositionStart={() => {
						isComposingRef.current = true
					}}
					onCompositionEnd={() => {
						isComposingRef.current = false
						// The DOM is now finalized; let the next layout effect rebuild
						// innerHTML from the freshly committed plain text.
						isUserInputRef.current = false
					}}
					onKeyDown={(e) => {
						if (isEditMode && e.key === "Escape" && !e.nativeEvent?.isComposing) {
							e.preventDefault()
							onCancel?.()
							return
						}
						handleKeyDown(e)
					}}
					onKeyUp={handleKeyUp}
					onBlur={handleBlur}
					onPaste={handlePaste}
					onSelect={updateCursorPosition}
					onMouseUp={updateCursorPosition}
					onScroll={updateCursorPosition}
					spellCheck={false}
					autoFocus
					className={cn(
						"w-full",
						"text-vscode-input-foreground",
						"font-vscode-font-family",
						"text-vscode-editor-font-size",
						"cursor-text",
						"outline-none",
						isEditMode ? "pt-3 pb-2 px-3" : "pt-3 pb-1.5 px-3",
						"min-h-[80px]",
						"max-h-[calc(100vh/2.5)]",
						"box-border",
						"overflow-x-hidden",
						"overflow-y-auto",
						"flex-grow",
						"scrollbar-none",
						"scrollbar-hide",
						"whitespace-pre-wrap",
						"break-words",
					)}
					style={{
						caretColor: "var(--vscode-input-foreground)",
						lineHeight: "16px",
					}}
				/>

				{isTtsPlaying && (
					<StandardTooltip content={t("chat:stopTts")}>
						<Button
							variant="ghost"
							size="icon"
							className="absolute top-0 right-0 opacity-25 hover:opacity-100 z-10"
							onClick={() => vscode.postMessage({ type: "stopTts" })}>
							<VolumeX className="size-4" />
						</Button>
					</StandardTooltip>
				)}

				{!inputValue && (
					<div
						className="absolute inset-0 z-[3] px-3 flex items-start pt-3"
						style={{
							color: "var(--vscode-tab-inactiveForeground)",
							userSelect: "none",
							pointerEvents: "none",
							whiteSpace: "pre-wrap",
							lineHeight: "var(--vscode-editor-line-height)",
						}}>
						<span>{placeholderBottomText}</span>
					</div>
				)}

				{/* Bottom controls section */}
				<div className="flex items-center justify-between px-2 pb-1.5 pt-0 shrink-0">
					<div className="flex items-center gap-1 min-w-0">
						{/* <div className="shrink-0">
							<KiloModeSelector
								value={mode}
								onChange={setMode}
								modeShortcutText={modeShortcutText}
								customModes={customModes}
							/>
						</div> */}
						<div className="shrink-0 mr-1">
							<StandardTooltip content={attachmentButtonLabel}>
								<button
									aria-label={attachmentButtonLabel}
									disabled={shouldDisableAttachmentButton}
									onClick={() => {
										if (shouldDisableAttachmentButton) return
										onSelectImages()
									}}
									className={cn(
										"relative inline-flex items-center justify-center",
										"bg-transparent border-none py-1.5",
										"rounded-lg min-w-[24px] min-h-[28px]",
										"opacity-100 text-vscode-foreground",
										"transition-all duration-150",
										"focus-visible:ring-1 focus-visible:ring-white/50",
										"active:bg-[rgba(255,255,255,0.1)]",
										!shouldDisableAttachmentButton && "cursor-pointer",
										shouldDisableAttachmentButton && "cursor-not-allowed",
									)}>
									<PlusIcon
										className={cn("w-4 h-4 text-vscode-foreground opacity-100", {
											hidden: containerWidth < 235,
										})}
										style={{ opacity: 1 }}
									/>
								</button>
							</StandardTooltip>
						</div>
						{apiConfiguration && (
							<div className="w-auto overflow-hidden min-w-0" data-testid="model-selector">
								<ModelSelector
									currentApiConfigName={currentApiConfigName}
									apiConfiguration={apiConfiguration}
									fallbackText={`${selectedProvider}:${selectedModelId}`}
									profilePlan={profilePlan}
								/>
							</div>
						)}
						{/* forked_change: reasoning effort for MatterAI gateway models */}
						{selectedProvider === "kilocode" &&
							!apiConfiguration?.thirdPartySelectedModel &&
							selectedModelId && (
								<div className="shrink-0 ml-1" data-testid="effort-selector">
									<EffortSelector modelId={selectedModelId} modelInfo={selectedModelInfo} />
								</div>
							)}
						{/* forked_change: command approval mode selector */}
						<div className="shrink-0 ml-1" data-testid="command-approval-selector">
							<CommandApprovalSelector />
						</div>
					</div>
					<div className={cn("flex items-center", isEditMode ? "gap-1.5" : "gap-0")}>
						{isEditMode ? (
							<>
								<button
									aria-label={t("chat:cancel.title")}
									type="button"
									onClick={onCancel}
									className={cn(
										"relative inline-flex items-center justify-center box-border",
										"bg-transparent border border-[var(--vscode-commandCenter-inactiveBorder)]",
										"h-7 px-3 rounded-full text-xs font-medium leading-none",
										"text-vscode-foreground hover:bg-[var(--vscode-toolbar-hoverBackground)]",
										"transition-all duration-150",
										"cursor-pointer",
									)}>
									{t("chat:cancel.title")}
								</button>
								<button
									aria-label={t("kilocode:userFeedback.send")}
									type="button"
									onClick={handleSend}
									className={cn(
										"relative inline-flex items-center justify-center box-border",
										"bg-white hover:bg-white/90 text-black border border-transparent",
										"h-7 px-3 rounded-full text-xs font-medium leading-none",
										"transition-all duration-150",
										"cursor-pointer",
									)}>
									{t("kilocode:userFeedback.send")}
								</button>
							</>
						) : (
							<>
								<div className="flex items-center gap-0.5">
									<ContextUsageIndicator className={cn({ hidden: containerWidth < 235 })} />
								</div>
								<StandardTooltip content={isStreaming ? t("chat:cancel.title") : t("chat:sendMessage")}>
									<button
										aria-label={isStreaming ? t("chat:cancel.title") : t("chat:sendMessage")}
										disabled={false}
										onClick={isStreaming && !inputValue.trim() ? onCancelStreaming : handleSend}
										className={cn(
											"relative inline-flex items-center justify-center",
											"bg-transparent border-none",
											"rounded-lg min-w-[28px] min-h-[28px]",
											"opacity-100 hover:opacity-100 text-vscode-descriptionForeground hover:text-vscode-foreground",
											"transition-all duration-150",
											"focus-visible:ring-1 focus-visible:ring-white/50",
											"active:bg-[rgba(255,255,255,0.1)]",
											"cursor-pointer",
											isStreaming &&
												!inputValue.trim() &&
												"text-red-400 hover:text-red-300 hover:bg-red-500/10",
										)}>
										{isStreaming ? (
											<div className="w-4 h-4 bg-current rounded-sm"></div>
										) : (
											<div className="w-5.5 h-5.5 rounded-full bg-current/20 flex items-center justify-center">
												<ArrowUp02Icon className="w-4 h-4 rtl:-scale-x-100" />
											</div>
										)}
									</button>
								</StandardTooltip>
							</>
						)}
					</div>
				</div>
			</div>
		)

		return (
			<div
				className={cn(
					"relative",
					"flex",
					"flex-col",
					"gap-1",
					"bg-editor-background",
					isEditMode ? "px-0" : CHAT_CONTENT_HORIZONTAL_PADDING,
					"outline-none",
					"border-none",
					"w-full",
					"ml-auto",
					"mr-auto",
					"box-border",
				)}
				style={{}}>
				{/* Pinned file review actions (not a chat row) */}
				{!isEditMode && (
					<div className="px-0.5">
						<AcceptRejectButtons onDismiss={() => {}} />
					</div>
				)}
				<div className="relative">
					<div
						className={cn(
							"chat-text-area",
							"relative",
							"flex",
							"flex-col",
							"outline-none",
							"rounded-xl",
							"border-none",
						)}
						onDrop={handleDrop}
						onDragOver={(e) => {
							// VS Code intercepts native file drags; holding Shift lets the
							// drag reach the webview so we can handle it here.
							if (!e.shiftKey) {
								return
							}
							e.preventDefault()
							setIsDraggingOver(true)
							e.dataTransfer.dropEffect = "copy"
						}}
						onDragLeave={(e) => {
							e.preventDefault()
							const rect = e.currentTarget.getBoundingClientRect()

							if (
								e.clientX <= rect.left ||
								e.clientX >= rect.right ||
								e.clientY <= rect.top ||
								e.clientY >= rect.bottom
							) {
								setIsDraggingOver(false)
							}
						}}>
						{/* forked_change start: ImageWarningBanner integration */}
						<ImageWarningBanner
							messageKey={imageWarning ?? ""}
							onDismiss={dismissImageWarning}
							isVisible={!!imageWarning}
						/>
						{/* forked_change end: ImageWarningBanner integration */}
						{/* forked_change start: pull slash commands from Cline */}
						{showSlashCommandsMenu && (
							<div ref={slashCommandsMenuContainerRef}>
								<SlashCommandMenu
									onSelect={handleSlashCommandsSelect}
									selectedIndex={selectedSlashCommandsIndex}
									setSelectedIndex={setSelectedSlashCommandsIndex}
									onMouseDown={handleMenuMouseDown}
									query={slashCommandsQuery}
									customModes={customModes}
								/>
							</div>
						)}
						{/* forked_change end: pull slash commands from Cline */}
						{showContextMenu && (
							<div
								ref={contextMenuContainerRef}
								className={cn(
									"absolute",
									"bottom-full",
									"left-0",
									"right-0",
									"z-[1000]",
									"mb-2",
									"filter",
									"border-none",
									"outline-none",
								)}>
								<ContextMenu
									onSelect={handleMentionSelect}
									searchQuery={searchQuery}
									inputValue={inputValue}
									onMouseDown={handleMenuMouseDown}
									selectedIndex={selectedMenuIndex}
									setSelectedIndex={setSelectedMenuIndex}
									selectedType={selectedType}
									queryItems={queryItems}
									// modes={allModes}
									loading={searchLoading}
									dynamicSearchResults={fileSearchResults}
								/>
							</div>
						)}

						{renderTextAreaSection()}
					</div>
				</div>

				{(selectedImages.length > 0 || selectedDocuments.length > 0 || pasteChips.length > 0) && (
					<div
						style={{
							display: "flex",
							flexWrap: "wrap",
							gap: 8,
							rowGap: 6,
							left: "16px",
							zIndex: 2,
							marginTop: "4px",
							marginBottom: 0,
							paddingLeft: 16,
							paddingRight: 16,
						}}>
						<Thumbnails images={selectedImages} setImages={setSelectedImages} inline />
						<DocumentAttachments
							documents={selectedDocuments}
							setDocuments={setSelectedDocuments}
							materialIconsBaseUri={materialIconsBaseUri}
							inline
						/>
						<PasteChips chips={pasteChips} onRemove={handleRemovePasteChip} inline />
					</div>
				)}
			</div>
		)
	},
)
