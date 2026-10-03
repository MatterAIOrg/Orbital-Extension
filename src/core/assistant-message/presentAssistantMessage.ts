import cloneDeep from "clone-deep"
import { serializeError } from "serialize-error"

import type { AssistantMessageContent } from "./parseAssistantMessage"
import { TelemetryService } from "@roo-code/telemetry"
import type { ClineAsk, ModeConfig, ToolName, ToolProgressStatus } from "@roo-code/types"

import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolParamName, ToolResponse } from "../../shared/tools"

import { accessMcpResourceTool } from "../tools/accessMcpResourceTool"
import { attemptCompletionTool } from "../tools/attemptCompletionTool"
import { browserActionTool } from "../tools/browserActionTool"
import { executeCommandTool } from "../tools/executeCommandTool"
import { fetchInstructionsTool } from "../tools/fetchInstructionsTool"
import { fileEditTool } from "../tools/fileEditTool"
import { multiFileEditTool } from "../tools/multiFileEditTool"
import { fileWriteTool } from "../tools/fileWriteTool"
import { listCodeDefinitionNamesTool } from "../tools/listCodeDefinitionNamesTool"
import { listFilesTool } from "../tools/listFilesTool"
import { newTaskTool } from "../tools/newTaskTool"
import { getReadFileToolDescription, readFileTool } from "../tools/readFileTool"
import { searchFilesTool } from "../tools/searchFilesTool"
import { switchModeTool } from "../tools/switchModeTool"
import { useMcpToolTool } from "../tools/useMcpToolTool"
import { mcpAuthenticateTool } from "../tools/mcpAuthenticateTool"

import { generateImageTool } from "../tools/generateImageTool"
import { generateFileTool } from "../tools/generateFileTool"
import { lspTool } from "../tools/lspTool"
import { runSlashCommandTool } from "../tools/runSlashCommandTool"
import { updateTodoListTool } from "../tools/updateTodoListTool"
import { useSkillTool } from "../tools/useSkillTool"

import Anthropic from "@anthropic-ai/sdk" // kilocode_change
import { formatResponse } from "../prompts/responses"
import { Task } from "../task/Task"
import { yieldPromise } from "../kilocode" // kilocode_change
import { codebaseSearchTool } from "../tools/codebaseSearchTool"
import { condenseTool } from "../tools/condenseTool" // kilocode_change
import { newRuleTool } from "../tools/newRuleTool" // kilocode_change
import { reportBugTool } from "../tools/reportBugTool" // kilocode_change
import { validateToolUse } from "../tools/validateToolUse"
import { webFetchTool } from "../tools/webFetchTool"
import { webSearchTool } from "../tools/webSearchTool"
import { figmaFetchTool } from "../tools/figmaFetchTool"
import { askFollowupQuestionTool } from "../tools/askFollowupQuestionTool"
import { MAX_PARALLEL_READ_ONLY_TOOLS, MAX_TOOL_REPETITION_AUTO_RETRIES } from "../tools/toolExecutionPolicy"
import { formatArgumentRepairNote } from "../../utils/jsonRepair" // forked_change

type PresentAssistantMessageOptions = {
	/** Explicit content-block index used by the read-only batch scheduler. */
	blockIndex?: number
	/** Internal execution path; skips the presenter lock and block advancement. */
	parallel?: boolean
	/** Per-block result buffer, committed in assistant/model order by the scheduler. */
	resultBuffer?: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[]
}

// These tools only observe repository state. They can run concurrently once the
// assistant message is complete. Mutating, interactive, and external tools remain
// on the existing serialized path.
const PARALLEL_READ_ONLY_TOOLS = new Set<ToolName>([
	"read_file",
	"search_files",
	"list_files",
	"list_code_definition_names",
	"codebase_search",
	"lsp",
])

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response.
 * - Displays text content to the user.
 * - Executes tool use requests with appropriate user approval.
 * - Manages the flow of conversation by determining when to proceed to the next content block.
 * - Coordinates file system checkpointing for modified files.
 * - Controls the conversation state to determine when to continue to the next request.
 *
 * The function uses a locking mechanism to prevent concurrent execution and handles
 * partial content blocks during streaming. It's designed to work with the streaming
 * API response pattern, where content arrives incrementally and needs to be processed
 * as it becomes available.
 */

export async function presentAssistantMessage(cline: Task, options: PresentAssistantMessageOptions = {}) {
	const isParallelWorker = options.parallel === true
	const blockIndex = options.blockIndex ?? cline.currentStreamingContentIndex

	if (cline.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${cline.taskId}.${cline.instanceId} aborted`)
	}

	if (!isParallelWorker && cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	if (!isParallelWorker) {
		cline.presentAssistantMessageLocked = true
		cline.presentAssistantMessageHasPendingUpdates = false

		// Native providers may return several independent read/search calls in one
		// assistant message. Execute them concurrently, then commit their results in
		// model order so the API pairing contract remains intact.
		const parallelBlockIndexes = getParallelReadOnlyBlockIndexes(cline, blockIndex)
		if (cline.didCompleteReadingStream && parallelBlockIndexes.length > 1) {
			try {
				await executeParallelReadOnlyBlocks(cline, parallelBlockIndexes)
			} finally {
				cline.presentAssistantMessageLocked = false
			}
			// The batch stops at the first block that cannot run concurrently (e.g.
			// execute_command following a run of read-only calls). Continue the
			// presentation chain so those trailing blocks still execute — the batch
			// only marks the message ready when it consumed every block.
			if (!cline.abort && cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
				await presentAssistantMessage(cline)
			}
			return
		}
	}

	if (blockIndex >= cline.assistantMessageContent.length) {
		// This may happen if the last content block was completed before
		// streaming could finish. If streaming is finished, and we're out of
		// bounds then this means we already  presented/executed the last
		// content block and are ready to continue to next request.
		if (cline.didCompleteReadingStream) {
			cline.userMessageContentReady = true
		}

		if (!isParallelWorker) {
			cline.presentAssistantMessageLocked = false
		}
		return
	}

	const rawBlock = cline.assistantMessageContent[blockIndex]
	// Shallow copy is sufficient - strings are immutable and we only need to
	// prevent the stream from mutating the reference. Deep cloning large
	// content strings would be expensive and unnecessary.
	const block: AssistantMessageContent =
		rawBlock.type === "tool_use" ? { ...rawBlock, params: { ...rawBlock.params } } : { ...rawBlock }

	switch (block.type) {
		case "text": {
			if (cline.didRejectTool) {
				break
			}

			let content = block.content

			if (content) {
				// Have to do this for partial and complete since sending
				// content in thinking tags to markdown renderer will
				// automatically be removed.
				// Remove end substrings of <thinking or </thinking (below xml
				// parsing is only for opening tags).
				// Tthis is done with the xml parsing below now, but keeping
				// here for reference.
				// content = content.replace(/<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?$/, "")
				//
				// Remove all instances of <thinking> (with optional line break
				// after) and </thinking> (with optional line break before).
				// - Needs to be separate since we dont want to remove the line
				//   break before the first tag.
				// - Needs to happen before the xml parsing below.
				content = content.replace(/<thinking>\s?/g, "")
				content = content.replace(/\s?<\/thinking>/g, "")

				// Remove partial XML tag at the very end of the content (for
				// tool use and thinking tags), Prevents scrollview from
				// jumping when tags are automatically removed.
				const lastOpenBracketIndex = content.lastIndexOf("<")

				if (lastOpenBracketIndex !== -1) {
					const possibleTag = content.slice(lastOpenBracketIndex)

					// Check if there's a '>' after the last '<' (i.e., if the
					// tag is complete) (complete thinking and tool tags will
					// have been removed by now.)
					const hasCloseBracket = possibleTag.includes(">")

					if (!hasCloseBracket) {
						// Extract the potential tag name.
						let tagContent: string

						if (possibleTag.startsWith("</")) {
							tagContent = possibleTag.slice(2).trim()
						} else {
							tagContent = possibleTag.slice(1).trim()
						}

						// Check if tagContent is likely an incomplete tag name
						// (letters and underscores only).
						const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)

						// Preemptively remove < or </ to keep from these
						// artifacts showing up in chat (also handles closing
						// thinking tags).
						const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"

						// If the tag is incomplete and at the end, remove it
						// from the content.
						if (isOpeningOrClosing || isLikelyTagName) {
							content = content.slice(0, lastOpenBracketIndex).trim()
						}
					}
				}
			}

			await cline.say("text", content, undefined, block.partial)
			break
		}
		case "tool_use":
			const toolDescription = (): string => {
				switch (block.name) {
					case "execute_command":
						return `[${block.name} for '${block.params.command}']`
					case "read_file":
						return getReadFileToolDescription(block.name, block.params)
					case "fetch_instructions":
						return `[${block.name} for '${block.params.task}']`
					case "file_edit":
						return `[${block.name} for '${(block.params as any).file_path || block.params.target_file}']`
					case "multi_file_edit": {
						let editCount = 0
						try {
							const editsRaw = (block.params as any).edits
							if (editsRaw) {
								const edits = JSON.parse(editsRaw)
								editCount = Array.isArray(edits) ? edits.length : 0
							}
						} catch {
							// During streaming, edits might be incomplete
						}
						return `[${block.name} for ${editCount} edits]`
					}
					case "file_write":
						return `[${block.name} for '${(block.params as any).file_path}']`
					case "list_files":
						return `[${block.name} for '${block.params.path}']`
					case "list_code_definition_names":
						return `[${block.name} for '${block.params.path}']`
					case "lsp":
						return `[${block.name} ${block.params.operation} at '${block.params.file_path}:${block.params.line}:${block.params.character}']`
					case "search_files":
						return `[${block.name} for '${block.params.regex}'${
							block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
						}]`
					case "browser_action":
						return `[${block.name} for '${block.params.action}']`
					case "use_mcp_tool":
						return `[${block.name} for '${block.params.server_name}']`
					case "mcp_authenticate":
						return `[${block.name} for '${block.params.server_name}']`
					case "access_mcp_resource":
						return `[${block.name} for '${block.params.server_name}']`
					case "ask_followup_question":
						return `[${block.name} for '${block.params.question}']`
					case "attempt_completion":
						return `[${block.name}]`
					case "switch_mode":
						return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
					case "codebase_search": // Add case for the new tool
						return `[${block.name} for '${block.params.query}']`
					case "update_todo_list":
						return `[${block.name}]`
					case "new_task": {
						const mode = block.params.mode ?? defaultModeSlug
						const message = block.params.message ?? "(no message)"
						const modeName = getModeBySlug(mode, customModes)?.name ?? mode
						return `[${block.name} in ${modeName} mode: '${message}']`
					}
					// forked_change start
					case "new_rule":
						return `[${block.name} for '${block.params.path}']`
					case "report_bug":
						return `[${block.name}]`
					case "condense":
						return `[${block.name}]`
					// forked_change end
					case "run_slash_command":
						return `[${block.name} for '${block.params.command}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
					case "generate_image":
						return `[${block.name} for '${block.params.path}']`
					case "check_past_chat_memories":
						return `[${block.name} for '${block.params.regex}']`
					case "use_skill":
						return `[${block.name} for '${block.params.skill_name}']`
					case "web_fetch":
						return `[${block.name} for '${block.params.url}']`
					case "figma_fetch":
						return `[${block.name} for '${block.params.url}']`
					case "web_search":
						return `[${block.name} for '${block.params.query}']`
					default:
						return `[${block.name}]`
				}
			}

			// forked_change start: Track whether a tool_result was pushed for this
			// tool_use block. We use this in the try/finally below to guarantee that
			// every non-partial tool_use with a toolUseId gets a matching tool_result
			// pushed onto userMessageContent — otherwise the assistant's tool_use blocks
			// (which were already added to apiConversationHistory) won't pair up with
			// the user's tool_result blocks on the next API call, causing the provider
			// to reject the request with a tool_use_id mismatch.
			//
			// Common ways the result can fail to be pushed:
			//   - cline.ask() throws "Current ask promise was ignored" mid-tool
			//   - a duplicate tool call short-circuits via checkAndRegisterToolCall
			//   - an unexpected error escapes the tool handler before pushToolResult
			let toolResultPushed = false
			// forked_change end

			const pushToolResult_withToolUseId_kilocode = (
				...items: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
			) => {
				const resultContent = options.resultBuffer ?? cline.userMessageContent
				// Check for non-empty toolUseId - empty string should be treated as missing
				if (block.toolUseId && block.toolUseId.length > 0) {
					// forked_change: a tool may push more than once for the same tool_use
					// (e.g. handleError pushes a toolError and the tool then pushes its
					// aggregated output, or askApproval pushes user feedback before the
					// result). The API allows only ONE tool_result per tool_use_id —
					// providers reject or misbehave on duplicates — so merge follow-up
					// pushes into the existing tool_result block instead of adding a
					// second one.
					const existingToolResult = resultContent.find(
						(item): item is Anthropic.ToolResultBlockParam =>
							item.type === "tool_result" && item.tool_use_id === block.toolUseId,
					)
					if (existingToolResult) {
						if (typeof existingToolResult.content === "string") {
							existingToolResult.content = [{ type: "text", text: existingToolResult.content }]
						} else if (!existingToolResult.content) {
							existingToolResult.content = []
						}
						existingToolResult.content.push(...items)
					} else {
						resultContent.push({
							type: "tool_result",
							tool_use_id: block.toolUseId,
							content: items,
						})
					}
				} else {
					resultContent.push(...items)
				}
				// forked_change: mark that this tool_use already has a result so the
				// safety net in the finally block doesn't double-push.
				toolResultPushed = true
			}

			// These stay in the same lexical scope as toolDescription, while their
			// asynchronous lookup happens inside the guarded processing block below.
			let mode: string | undefined
			let customModes: ModeConfig[] | undefined

			const removeStaleToolPreview = async () => {
				try {
					await cline.removeStalePartialToolAskMessage()
				} catch (error) {
					console.error("[presentAssistantMessage] Failed to remove stale tool preview:", error)
				}
			}

			// forked_change start: Wrap the entire tool_use processing body in a
			// try/catch/finally. Any throw from cline.ask, validateToolUse, the
			// repetition check, the per-tool handlers, or any helper here is caught
			// here and converted into a tool_result, instead of bubbling out and
			// leaving the assistant tool_use unmatched.
			try {
				// forked_change end

				// A complete tool block supersedes any streaming preview. Do this
				// before state lookup, duplicate checks, validation, checkpointing,
				// or execution: each can fail or return early, and leaving the
				// preview behind makes the UI spinner run forever. Cleanup is
				// best-effort so a persistence/UI refresh error cannot stop the tool.
				//
				// file_write deliberately keeps its preview through execution and
				// settles that same row in place. Its finally block below removes
				// the preview only when execution exits before it can be settled.
				if (!isParallelWorker && !block.partial && block.name !== "file_write") {
					await removeStaleToolPreview()
				}

				const state = await cline.providerRef.deref()?.getState()
				mode = state?.mode
				customModes = state?.customModes

				if (cline.didRejectTool) {
					// Ignore any tool content after user has rejected tool once.
					if (!block.partial) {
						pushToolResult_withToolUseId_kilocode({
							type: "text",
							text: `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`,
						})
					} else {
						// Partial tool after user rejected a previous tool.
						pushToolResult_withToolUseId_kilocode({
							type: "text",
							text: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`,
						})
					}

					break
				}

				// Check for duplicate tool calls (same name + same args) when the tool call is complete
				// Only check/register when !block.partial to avoid registering partial streaming updates
				// which would cause the final complete call to be incorrectly flagged as duplicate
				if (!block.partial) {
					const toolCallSignature = cline.getToolCallSignature(block.name, block.params)
					if (cline.checkAndRegisterToolCall(toolCallSignature)) {
						cline.didAlreadyUseTool = true
						// forked_change: explicitly push a tool_result for the duplicate so the
						// assistant tool_use is paired in the API conversation history. Without
						// this push, the bare `break` below would leave the tool_use unmatched
						// and the next request would fail with a tool_use_id mismatch.
						pushToolResult_withToolUseId_kilocode({
							type: "text",
							text: `Duplicate tool call detected for ${toolDescription()}. The same tool call was already executed in this turn — its previous result still applies. If that result was not what you expected, the parameters were wrong: change the parameters (e.g. add a missing offset) instead of repeating the identical call.`,
						})
						break
					}
				}

				const pushToolResult = (content: ToolResponse) => {
					// forked_change start
					const items = new Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>()

					// No prefix - just return raw tool output
					if (typeof content === "string") {
						items.push({ type: "text", text: content || "(tool did not return anything)" })
					} else {
						items.push(...content)
					}
					pushToolResult_withToolUseId_kilocode(...items)
					// forked_change end

					// Track that at least one tool ran during this assistant turn.
					// We still continue processing later content blocks because
					// native/OpenAI responses may legitimately batch multiple tool
					// calls into a single assistant message.
					cline.didAlreadyUseTool = true

					// If this is not a partial block (i.e., the tool has completed execution),
					// and the stream has finished reading, set userMessageContentReady
					// to allow the task loop to continue. This is critical for native tool
					// calls where the block state might not trigger the normal completion flow.
					//
					// forked_change: only do this on the LAST content block. With parallel
					// native tool calls, multiple tool_use blocks live in the same assistant
					// message; setting userMessageContentReady=true after the first tool's
					// pushToolResult races the recursion processing later blocks — pWaitFor
					// in the task loop returns and fires off the next request with only one
					// tool_result, leaving subsequent tool_uses unmatched.
					if (
						!block.partial &&
						cline.didCompleteReadingStream &&
						blockIndex >= cline.assistantMessageContent.length - 1
					) {
						cline.userMessageContentReady = true
					}
				}

				const askApproval = async (
					type: ClineAsk,
					partialMessage?: string,
					progressStatus?: ToolProgressStatus,
					isProtected?: boolean,
				) => {
					// forked_change start: yolo mode

					const state = await cline.providerRef.deref()?.getState()
					if (state?.yoloMode) {
						return true
					}
					// forked_change end

					// forked_change start: auto-approve a tool without blocking on a real user
					// response. We still surface the tool's final UI row (so the user can see
					// what ran), but setImmediate posts a "yesButtonClicked" right after the ask
					// starts waiting, and we .catch() any race-condition throw (e.g. "Current ask
					// promise was ignored") so the tool flow can always continue. This mirrors
					// what webFetchTool / readFileTool were already doing inline.
					const autoApproveWithoutBlocking = async () => {
						if (partialMessage) {
							if (cline.parallelToolExecution) {
								// Parallel read-only workers must not share the single interactive
								// ask promise. Persist a non-interactive progress row instead.
								await cline.say("tool", partialMessage, undefined, false, undefined, progressStatus, {
									isNonInteractive: true,
								})
								return true
							}
							setImmediate(() => {
								try {
									// Guard for tests where cline is a partial mock without this method.
									cline.handleWebviewAskResponse?.("yesButtonClicked", undefined, undefined)
								} catch {
									// best-effort; never let the auto-approval poke crash the flow
								}
							})
							await cline
								.ask(type, partialMessage, false, progressStatus, isProtected || false, true)
								.catch(() => {})
						}
						return true
					}

					// Only `execute_command` (ask type "command") ever surfaces a Run/Cancel
					// prompt. Every other tool — file edits, MCP, web, browser actions, etc. —
					// always auto-approves.
					if (type !== "command") {
						return autoApproveWithoutBlocking()
					}

					// Command approval mode, selected from the chat textarea dropdown:
					//   "fullAccess"   → auto-approve every command (also covers the per-task
					//                    "Run Everything" toggle, autoApproveAllCommands)
					//   "approveForMe" → auto-approve commands the model marked non-dangerous
					//                    via the `isDangerous` param (default)
					//   "ask"          → always prompt before running
					// Read-only commands (rg, ls, git diff, ...) skip the prompt in every mode: they
					// replace the old search_files/list_files tools, which never prompted.
					const commandApprovalMode = state?.commandApprovalMode ?? "approveForMe"
					const fullCommandAccess = commandApprovalMode === "fullAccess" || cline.autoApproveAllCommands
					const approveBecauseSafe =
						commandApprovalMode === "approveForMe" && !cline.pendingCommandIsDangerous

					const approveBecauseReadOnly = cline.pendingCommandIsReadOnly && !cline.pendingCommandIsDangerous

					if (fullCommandAccess || approveBecauseSafe || approveBecauseReadOnly) {
						return autoApproveWithoutBlocking()
					}
					// forked_change end

					const { response, text, images, pasteChips } = await cline.ask(
						type,
						partialMessage,
						false,
						progressStatus,
						isProtected || false,
					)

					if (response !== "yesButtonClicked") {
						// On reject, do nothing - just reject
						cline.didRejectTool = true

						// If the user sent a message (which caused the rejection), it might be queued
						// Process any queued messages now
						cline.processQueuedMessages()

						return false
					}

					// Handle yesButtonClicked with text.
					if (text || (images && images.length > 0) || (pasteChips && pasteChips.length > 0)) {
						await cline.say(
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
						pushToolResult(
							formatResponse.toolResult(formatResponse.toolApprovedWithFeedback(text || ""), images),
						)
					}

					return true
				}

				const askFinishSubTaskApproval = async () => {
					// Ask the user to approve this task has completed, and he has
					// reviewed it, and we can declare task is finished and return
					// control to the parent task to continue running the rest of
					// the sub-tasks.
					const toolMessage = JSON.stringify({ tool: "finishTask" })
					return await askApproval("tool", toolMessage)
				}

				const handleError = async (action: string, error: Error) => {
					const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

					await cline.say(
						"error",
						`Error ${action}:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`,
					)

					pushToolResult(formatResponse.toolError(errorString))
				}

				// If block is partial, remove partial closing tag so its not
				// presented to user.
				const removeClosingTag = (tag: ToolParamName, text?: string): string => {
					if (!block.partial) {
						return text || ""
					}

					if (!text) {
						return ""
					}

					// This regex dynamically constructs a pattern to match the
					// closing tag:
					// - Optionally matches whitespace before the tag.
					// - Matches '<' or '</' optionally followed by any subset of
					//   characters from the tag name.
					const tagRegex = new RegExp(
						`\\s?<\/?${tag
							.split("")
							.map((char) => `(?:${char})?`)
							.join("")}$`,
						"g",
					)

					return text.replace(tagRegex, "")
				}

				if (block.name !== "browser_action") {
					await cline.browserSession.closeBrowser()
				}

				if (!block.partial) {
					cline.recordToolUsage(block.name)
					TelemetryService.instance.captureToolUsage(cline.taskId, block.name)
				}

				// Validate tool use before execution.
				// forked_change: `mode` and `customModes` are now hoisted above the
				// outer tool_use try block so toolDescription's closure can see them.
				try {
					validateToolUse(
						block.name as ToolName,
						mode ?? defaultModeSlug,
						customModes ?? [],
						{ file_edit: cline.diffEnabled },
						block.params,
					)
				} catch (error) {
					cline.consecutiveMistakeCount++
					pushToolResult(formatResponse.toolError(error.message))
					break
				}

				// Check for identical consecutive tool calls.
				if (!block.partial) {
					// Use the detector to check for repetition, passing the ToolUse
					// block directly.
					const repetitionCheck = cline.toolRepetitionDetector.check(block)

					// If execution is not allowed, auto-retry instead of asking the user.
					// forked_change: instead of stopping and waiting for user input,
					// we show an error in the UI, set a flag for the task loop to
					// handle the history rewrite + retry, and break.
					if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
						// Show the repetition error in the UI so the user knows what happened.
						await cline.say(
							"error",
							repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
						)

						// Track tool repetition in telemetry.
						TelemetryService.instance.captureConsecutiveMistakeError(cline.taskId)

						// Signal the task loop to auto-retry only a small number of times.
						// The repetition detector resets after blocking, so without a
						// separate budget an unchanged model could repeat this cycle forever.
						const repetitionRetryCount = cline.toolRepetitionAutoRetryCount ?? 0
						const canAutoRetry = repetitionRetryCount < MAX_TOOL_REPETITION_AUTO_RETRIES
						if (canAutoRetry) {
							cline.toolRepetitionAutoRetryCount = repetitionRetryCount + 1
							cline.toolRepetitionAutoRetry = true
						} else {
							await cline.say(
								"error",
								`Automatic recovery stopped after ${MAX_TOOL_REPETITION_AUTO_RETRIES} repeated tool-call retries. The next model response must use a different tool or approach.`,
								undefined,
								undefined,
								undefined,
								undefined,
								{ isNonInteractive: true },
							)
						}

						// Push a tool error result to maintain tool_use/tool_result
						// pairing for the current response.
						pushToolResult(
							formatResponse.toolError(
								`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
							),
						)
						break
					}
				}

				if (!isParallelWorker) {
					await checkpointSaveAndMark(cline) // kilocode_change: moved out of switch
				}

				// forked_change start: Check if context condensation is needed before executing tools
				// that may add significant content to the context window.
				// This prevents context window overflow when the LLM requests to read files
				// with a nearly full context.
				const toolsThatAddContent = [
					"read_file",
					"search_files",
					"list_files",
					"list_code_definition_names",
					"codebase_search",
					"lsp",
					"web_fetch",
					"web_search",
					"figma_fetch",
					"use_mcp_tool",
					"access_mcp_resource",
				]
				if (!isParallelWorker && !block.partial && toolsThatAddContent.includes(block.name)) {
					await cline.checkAndCondenseContext()
				}
				// forked_change end

				switch (block.name) {
					case "update_todo_list": {
						// For native tool calls, the partial block is just for UI display during streaming.
						// We should only execute the actual tool logic when the block is complete (partial: false).
						if (!block.partial) {
							await updateTodoListTool(
								cline,
								block,
								askApproval,
								handleError,
								pushToolResult,
								removeClosingTag,
							)
						} else {
							// For partial blocks, just update the UI display without executing
							// The tool will be executed when the complete block arrives
							const todosRaw = block.params.todos || ""
							try {
								const { parseMarkdownChecklist } = await import("../tools/updateTodoListTool")
								const todos = parseMarkdownChecklist(todosRaw)
								const approvalMsg = JSON.stringify({
									tool: "updateTodoList",
									todos,
								})
								await cline.ask("tool", approvalMsg, true).catch(() => {})
							} catch {
								// Ignore parsing errors for partial blocks
							}
						}
						break
					}
					case "file_edit":
						await fileEditTool(cline, block, handleError, pushToolResult, removeClosingTag)
						break
					case "multi_file_edit":
						await multiFileEditTool(cline, block, handleError, pushToolResult, removeClosingTag)
						break
					case "file_write":
						await fileWriteTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "read_file":
						await readFileTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "fetch_instructions":
						await fetchInstructionsTool(cline, block, askApproval, handleError, pushToolResult)
						break
					case "list_files":
						await listFilesTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "codebase_search":
						await codebaseSearchTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "list_code_definition_names":
						await listCodeDefinitionNamesTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "lsp":
						await lspTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "search_files":
						await searchFilesTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "browser_action":
						await browserActionTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "execute_command":
						await executeCommandTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "use_mcp_tool":
						await useMcpToolTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "mcp_authenticate":
						await mcpAuthenticateTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "access_mcp_resource":
						await accessMcpResourceTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "ask_followup_question":
						await askFollowupQuestionTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "switch_mode":
						await switchModeTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "new_task":
						await newTaskTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "attempt_completion":
						await attemptCompletionTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
							toolDescription,
							askFinishSubTaskApproval,
						)
						break
					// forked_change start
					case "new_rule":
						await newRuleTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "report_bug":
						await reportBugTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "condense":
						await condenseTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					// forked_change end
					case "run_slash_command":
						await runSlashCommandTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "generate_image":
						await generateImageTool(
							cline,
							block,
							askApproval,
							handleError,
							pushToolResult,
							removeClosingTag,
						)
						break
					case "generate_file":
						await generateFileTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "use_skill":
						await useSkillTool(cline, block, handleError, pushToolResult)
						break
					case "web_fetch":
						await webFetchTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "figma_fetch":
						await figmaFetchTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					case "web_search":
						await webSearchTool(cline, block, askApproval, handleError, pushToolResult, removeClosingTag)
						break
					default:
						break
				}

				// forked_change start: close the try and add catch/finally for the tool_use
				// safety net. The catch keeps a thrown error (e.g. "Current ask promise was
				// ignored") from escaping presentAssistantMessage, and the finally guarantees
				// a matching tool_result is pushed for every non-partial tool_use with a
				// toolUseId so the assistant tool_use / user tool_result pairing stays
				// consistent in the API conversation history.
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error)
				console.error(`[presentAssistantMessage] Tool '${block.name}' processing threw: ${errMsg}`, error)
				try {
					// Non-interactive so a late tool failure can never supersede a
					// pending ask (e.g. the api_req_failed retry prompt) with an
					// interactive error row and kill it via "ask was ignored".
					await cline.say(
						"error",
						`Tool '${block.name}' failed: ${errMsg}`,
						undefined,
						undefined,
						undefined,
						undefined,
						{ isNonInteractive: true },
					)
				} catch {
					// best-effort; never let the error reporter itself break the loop
				}
			} finally {
				if (!block.partial && block.name === "file_write") {
					await removeStaleToolPreview()
				}

				// forked_change: transparency for auto-repaired arguments. The parser
				// repaired the malformed JSON before execution; appending what actually
				// ran to the tool result stops the model from repeating the same
				// malformed form on the next turn.
				if (block.repaired && !block.partial && toolResultPushed && !cline.didRejectTool) {
					try {
						const executedArguments =
							block.name === "use_mcp_tool"
								? String(block.params.arguments ?? "{}")
								: JSON.stringify(block.params)
						pushToolResult_withToolUseId_kilocode({
							type: "text",
							text: formatArgumentRepairNote(executedArguments),
						})
					} catch (error) {
						console.error("[presentAssistantMessage] Failed to append argument repair note:", error)
					}
				}

				// CRITICAL: every non-partial tool_use with a toolUseId MUST have a
				// matching tool_result pushed, even on failure. The assistant message
				// already contains the tool_use block, so without a paired tool_result
				// the next API request will be rejected for an unmatched tool_use_id.
				if (!block.partial && block.toolUseId && block.toolUseId.length > 0 && !toolResultPushed) {
					try {
						;(options.resultBuffer ?? cline.userMessageContent).push({
							type: "tool_result",
							tool_use_id: block.toolUseId,
							content: [
								{
									type: "text",
									text: `Tool '${block.name}' did not produce a result (an internal error or interrupted ask occurred). Please try a different approach or ask the user for clarification.`,
								},
							],
						})
						toolResultPushed = true

						// Make sure the task loop can move forward even on failure —
						// otherwise the next iteration may hang waiting for a result.
						// Only signal readiness when this is the LAST content block: for a
						// mid-message failure the presentation chain still has blocks to
						// execute, and flipping the flag here would let the task loop fire
						// the next request before they are presented (same bug class as the
						// parallel read-only batch skipping a trailing execute_command).
						cline.didAlreadyUseTool = true
						if (
							cline.didCompleteReadingStream &&
							!isParallelWorker &&
							blockIndex >= cline.assistantMessageContent.length - 1
						) {
							cline.userMessageContentReady = true
						}
					} catch (e) {
						console.error("[presentAssistantMessage] Failed to push fallback tool_result:", e)
					}
				}
			}
			// forked_change end

			break
	}

	// Seeing out of bounds is fine, it means that the next too call is being
	// built up and ready to add to assistantMessageContent to present.
	// When you see the UI inactive during this, it means that a tool is
	// breaking without presenting any UI. For example the file_write tool
	// was breaking when relpath was undefined, and for invalid relpath it never
	// presented UI.
	// This needs to be placed here, if not then calling
	// cline.presentAssistantMessage below would fail (sometimes) since it's
	// locked.
	if (isParallelWorker) {
		return
	}

	cline.presentAssistantMessageLocked = false

	// NOTE: When tool is rejected, iterator stream is interrupted and it waits
	// for `userMessageContentReady` to be true. Future calls to present will
	// skip execution since `didRejectTool` and iterate until `contentIndex` is
	// set to message length and it sets userMessageContentReady to true itself
	// (instead of preemptively doing it in iterator).
	if (!block.partial || cline.didRejectTool) {
		// Block is finished streaming and executing.
		if (blockIndex === cline.assistantMessageContent.length - 1) {
			// It's okay that we increment if !didCompleteReadingStream, it'll
			// just return because out of bounds and as streaming continues it
			// will call `presentAssitantMessage` if a new block is ready. If
			// streaming is finished then we set `userMessageContentReady` to
			// true when out of bounds. This gracefully allows the stream to
			// continue on and all potential content blocks be presented.
			// Last block is complete and it is finished executing
			cline.userMessageContentReady = true // Will allow `pWaitFor` to continue.
		}

		// Call next block if it exists (if not then read stream will call it
		// when it's ready).
		// Need to increment regardless, so when read stream calls this function
		// again it will be streaming the next block.
		cline.currentStreamingContentIndex = blockIndex + 1

		if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
			// There are already more content blocks to stream, so we'll call
			// this function ourselves.
			// forked_change start: prevent excessive recursion
			await yieldPromise()
			await presentAssistantMessage(cline)
			// forked_change end
			return
		}

		// If we've already used a tool and there are no more blocks to process,
		// we need to set userMessageContentReady to true to allow the loop to continue.
		// This fixes the issue where update_todo_list (or other tools) execute but
		// the agent stops because userMessageContentReady is never set.
		// This handles the case where the stream has finished and we've processed all blocks,
		// but userMessageContentReady wasn't set because we weren't at the last block when
		// the tool executed.
		if (cline.didAlreadyUseTool && cline.didCompleteReadingStream) {
			cline.userMessageContentReady = true
		}
	}

	// Block is partial, but the read stream may have finished.
	if (cline.presentAssistantMessageHasPendingUpdates) {
		// forked_change start: prevent excessive recursion
		await yieldPromise()
		await presentAssistantMessage(cline)
		// forked_change end
	}
}

function getParallelReadOnlyBlockIndexes(cline: Task, startIndex: number): number[] {
	const indexes: number[] = []

	for (let index = startIndex; index < cline.assistantMessageContent.length; index++) {
		const block = cline.assistantMessageContent[index]
		if (block.type !== "tool_use" || block.partial || !PARALLEL_READ_ONLY_TOOLS.has(block.name)) {
			break
		}
		indexes.push(index)
	}

	return indexes
}

async function executeParallelReadOnlyBlocks(cline: Task, blockIndexes: number[]): Promise<void> {
	// Shared setup is intentionally performed once. In particular, context
	// condensation and checkpoint persistence must not race across workers.
	await cline.removeStalePartialToolAskMessage()
	await checkpointSaveAndMark(cline)
	await cline.checkAndCondenseContext()

	const resultBuffers = blockIndexes.map(
		() => [] as (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[],
	)
	const previousParallelState = cline.parallelToolExecution
	cline.parallelToolExecution = true

	try {
		let nextIndex = 0
		const workerCount = Math.min(MAX_PARALLEL_READ_ONLY_TOOLS, blockIndexes.length)
		await Promise.all(
			Array.from({ length: workerCount }, async () => {
				while (nextIndex < blockIndexes.length) {
					const resultIndex = nextIndex++
					await presentAssistantMessage(cline, {
						blockIndex: blockIndexes[resultIndex],
						parallel: true,
						resultBuffer: resultBuffers[resultIndex],
					})
				}
			}),
		)
	} finally {
		cline.parallelToolExecution = previousParallelState
	}

	// Tool results must be appended in the same order as the assistant tool calls,
	// even though the underlying filesystem/search operations finish out of order.
	for (const resultBuffer of resultBuffers) {
		cline.userMessageContent.push(...resultBuffer)
	}

	cline.currentStreamingContentIndex = blockIndexes[blockIndexes.length - 1] + 1

	// Only tell the task loop the assistant message is fully presented when the
	// batch ran through the last content block. getParallelReadOnlyBlockIndexes
	// stops at the first non-read-only block (e.g. execute_command after a run of
	// searches), so setting this unconditionally made the task loop fire the next
	// API request while that trailing tool_use was never presented or executed.
	if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
		cline.userMessageContentReady = true
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		// kilocode_change: order changed to prevent second execution while still awaiting the save
		task.currentStreamingDidCheckpoint = true
		await task.checkpointSave(true)
	} catch (error) {
		console.error(`[Task#presentAssistantMessage] Error saving checkpoint: ${error.message}`, error)
	}
}
