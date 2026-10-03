import { type ToolName, toolNames } from "@roo-code/types"
import { TextContent, ToolUse, ToolParamName, toolParamNames } from "../../shared/tools"
import { toInternalToolName } from "../../shared/toolAliases"
import { AssistantMessageContent } from "./parseAssistantMessage"
import { NativeToolCall, parseDoubleEncodedParams } from "./kilocode/native-tool-call"
import Anthropic from "@anthropic-ai/sdk" // kilocode_change
import { parseToolCallArguments } from "../../utils/jsonRepair" // forked_change

/**
 * Callback function type to check if a tool name is a valid MCP tool.
 * Returns the server name if it's an MCP tool, or undefined if not.
 */
export type McpToolChecker = (toolName: string) => { isMcpTool: boolean; serverName?: string } | undefined

// forked_change start
/**
 * Placeholder tags some models leak into tool-call JSON arguments, e.g.
 * `"limit": <longcat_arg_value>180`. The tag is an artifact of the provider's
 * internal argument templating and makes the arguments invalid JSON.
 */
const PLACEHOLDER_TAG = "<\\/?[a-zA-Z_][a-zA-Z0-9_.\\-]*>"

/**
 * Matches a placeholder tag in value position — immediately after a
 * `"key":` — so tags inside legitimate string values are never touched.
 */
const VALUE_POSITION_PLACEHOLDER_TAG = new RegExp(`("[^"]*"\\s*:\\s*)${PLACEHOLDER_TAG}`, "g")

/**
 * Remove placeholder tags that prefix a real value:
 * `"limit": <tag>180` becomes `"limit": 180`. Repeated until stable in case a
 * model emits several tags in a row. Used for partial-params display only;
 * actual argument parsing goes through `parseToolCallArguments`.
 */
function stripValuePositionTags(args: string): string {
	let stripped = args
	let previous: string
	do {
		previous = stripped
		stripped = stripped.replace(VALUE_POSITION_PLACEHOLDER_TAG, "$1")
	} while (stripped !== previous)
	return stripped
}
// forked_change end

/**
 * Parse a native tool-call `arguments` JSON string robustly.
 *
 * CRITICAL: valid JSON must be parsed VERBATIM so that escape sequences are
 * decoded exactly once. A previous implementation always ran a "quote the
 * unquoted value" regex BEFORE parsing. That regex also matched `"key": value`
 * patterns *inside* string values — e.g. source code such as
 * `"Content-Type": mimeType,` embedded in a `new_string` — which turned valid
 * JSON into invalid JSON. The resulting `JSON.parse` failure forced a fallback
 * to regex-based partial extraction that preserved literal "\n" instead of the
 * intended real newline, corrupting edits (e.g. `\n\n` written into files).
 *
 * Strategy:
 *   1. Only attempt parsing once the buffer looks like JSON (`{`/`[`).
 *      At finalization (`repairTruncated`) a braceless body such as
 *      `path: "src"` is still worth a repair attempt — the scanner rejects
 *      prose because a bare key must be followed by a colon.
 *   2. `parseToolCallArguments` strict-parses first, so well-formed arguments
 *      are never mutated. Only on failure does it apply the best-effort repair
 *      pass (placeholder tags, unquoted keys/values, single quotes, Python
 *      literals, comments, trailing commas, dropped key quotes). With
 *      `repairTruncated` it additionally closes dangling strings/containers
 *      and appends `null` after a dangling colon.
 *
 * @returns `{ parsed, repaired }` when complete & valid (or repaired), or
 *   `undefined` when the buffer is not yet valid JSON (caller should keep
 *   accumulating streaming deltas).
 */
export function tryParseToolArguments(
	rawArgs: string,
	options?: { repairTruncated?: boolean },
): { parsed: any; repaired?: boolean } | undefined {
	const repairTruncated = options?.repairTruncated ?? false
	const trimmed = rawArgs.trim()
	// During streaming, arguments may begin as natural-language text; wait until
	// the buffer actually looks like a JSON object/array before parsing.
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !repairTruncated) {
		return undefined
	}
	const result = parseToolCallArguments(rawArgs, { repairTruncated })
	return result ? { parsed: result.args, repaired: result.repaired } : undefined
}

/**
 * Parser for assistant messages. Maintains state between chunks
 * to avoid reprocessing the entire message on each update.
 */
export class AssistantMessageParser {
	private contentBlocks: AssistantMessageContent[] = []
	private currentTextContent: TextContent | undefined = undefined
	private currentTextContentStartIndex = 0
	private currentToolUse: ToolUse | undefined = undefined
	private currentToolUseStartIndex = 0
	private currentParamName: ToolParamName | undefined = undefined
	private currentParamValueStartIndex = 0
	private readonly MAX_ACCUMULATOR_SIZE = 1024 * 1024 // 1MB limit
	private readonly MAX_PARAM_LENGTH = 1024 * 100 // 100KB per parameter limit

	// forked_change start
	// State for accumulating native tool calls
	private nativeToolCallsAccumulator: Map<string, NativeToolCall> = new Map()
	private processedNativeToolCallIds: Set<string> = new Set()
	// Map index to id for tracking across streaming delta
	private nativeToolCallIndexToId: Map<number, string> = new Map()
	// Callback to check if a tool name is an MCP tool
	private mcpToolChecker: McpToolChecker | undefined
	// Track partial native tool calls that have been emitted but not yet completed
	private emittedPartialNativeToolCalls: Set<string> = new Set()
	// forked_change: Track tool calls dropped at finalization because their JSON
	// arguments never parsed. The task loop reads this to retry with a corrective
	// message instead of silently stopping the agent.
	private droppedMalformedToolCalls: { name: string; rawArguments: string }[] = []
	// forked_change end

	private accumulator = ""

	/**
	 * Initialize a new AssistantMessageParser instance.
	 */
	constructor(mcpToolChecker?: McpToolChecker) {
		this.mcpToolChecker = mcpToolChecker
		this.reset()
	}

	/**
	 * Reset the parser state.
	 */
	public reset(): void {
		this.contentBlocks = []
		this.currentTextContent = undefined
		this.currentTextContentStartIndex = 0
		this.currentToolUse = undefined
		this.currentToolUseStartIndex = 0
		this.currentParamName = undefined
		this.currentParamValueStartIndex = 0
		this.accumulator = ""

		// forked_change start
		this.nativeToolCallsAccumulator.clear()
		this.processedNativeToolCallIds.clear()
		this.nativeToolCallIndexToId.clear()
		this.emittedPartialNativeToolCalls.clear()
		this.droppedMalformedToolCalls = []
		// forked_change end
	}

	/**
	 * Returns the current parsed content blocks
	 */

	public getContentBlocks(): AssistantMessageContent[] {
		// Return a shallow copy to prevent external mutation
		return this.contentBlocks.slice()
	}

	// forked_change: Expose tool calls dropped at finalization because their JSON
	// arguments never parsed. The task loop uses this to retry with a corrective
	// message instead of silently stopping the agent.
	public getDroppedMalformedToolCalls(): { name: string; rawArguments: string }[] {
		return this.droppedMalformedToolCalls
	}

	// forked_change start
	/**
	 * Extract partial parameters from an incomplete JSON string.
	 * This uses simple regex to extract key-value pairs that might be useful for UI display.
	 */
	private extractPartialParams(argsString: string): Record<string, string> {
		const partialParams: Record<string, string> = {}
		if (!argsString.trim()) return partialParams

		// For very large accumulated arguments, skip expensive regex extraction.
		// This avoids O(n²) regex work during streaming of large file_write
		// content. The UI can wait for the complete JSON.
		const MAX_EXTRACT_LENGTH = 20 * 1024 // 20KB
		if (argsString.length > MAX_EXTRACT_LENGTH) {
			return partialParams
		}

		// forked_change: strip placeholder tags (e.g. "limit": <longcat_arg_value>180)
		// so the partial display reflects the real value behind the tag.
		const cleaned = stripValuePositionTags(argsString)

		// Match patterns like "key": "value" or "key": "partial value (without closing quote)
		// Also match "key": unquoted_value for simple values
		// Handle escaped quotes within values: \"
		const quotedValueRegex = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
		const unquotedValueRegex = /"((?:[^"\\]|\\.)*)"\s*:\s*([a-zA-Z0-9_.*\/\-]+)/g

		let match
		// Extract quoted values
		while ((match = quotedValueRegex.exec(cleaned)) !== null) {
			partialParams[match[1]] = match[2]
		}
		// Extract unquoted values (only if not already captured as quoted)
		while ((match = unquotedValueRegex.exec(cleaned)) !== null) {
			if (!(match[1] in partialParams)) {
				partialParams[match[1]] = match[2]
			}
		}

		// Also try to extract partial quoted values (without closing quote)
		// e.g., "file_path": "src/componen  -> extract "src/componen"
		const partialQuotedRegex = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)$/g
		while ((match = partialQuotedRegex.exec(cleaned)) !== null) {
			partialParams[match[1]] = match[2]
		}

		return partialParams
	}

	/**
	 * Process native OpenAI-format tool calls and convert them to internal ToolUse format.
	 * This handles tool calls that come from OpenAI-compatible APIs in their native format
	 * rather than embedded as XML in text content.
	 *
	 * Native tool calls stream in as deltas, so this method accumulates them until complete.
	 *
	 * forked_change: Now yields partial tool calls immediately when tool name is known,
	 * allowing the UI to show "Editing filename..." during streaming.
	 *
	 * @param toolCalls Array of native tool call objects (may be partial during streaming).
	 * Native tool calling sets parallel_tool_calls = true, so this may contain
	 * several independent calls that all must be accumulated and executed.
	 */
	public *processNativeToolCalls(toolCalls: NativeToolCall[]): Generator<Anthropic.ToolUseBlockParam> {
		for (const toolCall of toolCalls) {
			// Determine the tracking key
			// If we have an index, use that to look up or store the id
			// Otherwise use the id directly (for non-streaming or first delta)
			let toolCallId: string

			if (toolCall.index !== undefined) {
				// Check if we've seen this index before
				const existingId = this.nativeToolCallIndexToId.get(toolCall.index)
				if (existingId) {
					toolCallId = existingId
				} else if (toolCall.id) {
					// First time seeing this index with an id - store the mapping
					toolCallId = toolCall.id
					this.nativeToolCallIndexToId.set(toolCall.index, toolCallId)
				} else {
					// Some OpenAI-compatible providers never send an id for a tool call
					// (or only send it in a later fragment). Dropping the call here used
					// to silently discard the whole tool call — every later fragment for
					// this index then hit "arguments for unknown tool call" and was
					// dropped too. Synthesize a stable id from the index instead; the
					// assistant message and its tool_results are built from these ids,
					// so pairing stays consistent. If the real id arrives in a later
					// delta, the mapping below still wins and accumulation continues
					// unchanged.
					toolCallId = `native-tool-call-${toolCall.index}`
					this.nativeToolCallIndexToId.set(toolCall.index, toolCallId)
				}
			} else if (toolCall.id) {
				toolCallId = toolCall.id
			} else {
				console.warn("[AssistantMessageParser] Skipping tool call without index or ID:", toolCall)
				continue
			}

			// Check if we've already processed this tool call as COMPLETE
			if (this.processedNativeToolCallIds.has(toolCallId)) {
				console.log("[AssistantMessageParser] Tool call already processed:", toolCallId)
				continue
			}

			// Get or create the accumulator entry for this tool call
			let accumulatedCall = this.nativeToolCallsAccumulator.get(toolCallId)

			// First delta: has function name (initialize accumulator)
			if (toolCall.function?.name) {
				const toolName = toInternalToolName(toolCall.function.name)

				// Validate that this is a recognized tool name (native or MCP)
				const isNativeTool = toolNames.includes(toolName as ToolName)
				const mcpCheck = this.mcpToolChecker?.(toolName)
				const isMcpTool = mcpCheck?.isMcpTool ?? false

				if (!isNativeTool && !isMcpTool) {
					console.warn("[AssistantMessageParser] Unknown tool name in native call:", toolName)
					continue
				}

				if (!accumulatedCall) {
					accumulatedCall = {
						id: toolCallId, // FIX: Use toolCallId instead of toolCall.id
						type: toolCall.type,
						function: {
							name: toolName,
							arguments: toolCall.function.arguments || "",
						},
						// forked_change: Track if this is an MCP tool and which server
						isMcpTool: isMcpTool,
						mcpServerName: mcpCheck?.serverName,
					}
					this.nativeToolCallsAccumulator.set(toolCallId, accumulatedCall)

					// forked_change: Immediately emit a partial tool use block when we have the name
					// This allows the UI to show "Editing filename..." during streaming
					this.finalizeTextContentBeforeToolUse()

					// Extract any partial params we can from the current arguments string
					const partialParams = this.extractPartialParams(accumulatedCall.function!.arguments || "")

					// Create partial ToolUse block
					const partialToolUse: ToolUse =
						accumulatedCall.isMcpTool && accumulatedCall.mcpServerName
							? {
									type: "tool_use" as const,
									name: "use_mcp_tool" as ToolName,
									params: {
										server_name: accumulatedCall.mcpServerName,
										tool_name: toolName,
										arguments: accumulatedCall.function!.arguments || "",
									},
									partial: true,
									toolUseId: accumulatedCall.id,
								}
							: {
									type: "tool_use" as const,
									name: toolName as ToolName,
									params: partialParams,
									partial: true,
									toolUseId: accumulatedCall.id,
								}

					// Add to content blocks
					this.contentBlocks.push(partialToolUse)
					this.emittedPartialNativeToolCalls.add(toolCallId)

					// Yield partial to the stream so UI can update
					yield {
						type: "tool_use" as const,
						name: partialToolUse.name,
						id: partialToolUse.toolUseId ?? "",
						input: partialToolUse.params,
					}
				} else {
					// Already have this tool call, append arguments
					accumulatedCall.function!.arguments += toolCall.function.arguments || ""
				}
			}
			// Subsequent deltas: only have arguments (append to existing accumulator)
			else if (accumulatedCall) {
				accumulatedCall.function!.arguments += toolCall.function?.arguments || ""
			}
			// Got arguments without ever getting a name - shouldn't happen
			else {
				console.warn("[AssistantMessageParser] Received arguments for unknown tool call:", toolCallId)
				continue
			}

			// Only try to parse if we have an accumulator (shouldn't be undefined at this point)
			if (!accumulatedCall) {
				continue
			}

			// Try to parse the arguments - if successful, the tool call is complete.
			// tryParseToolArguments parses valid JSON VERBATIM (escapes decoded
			// exactly once) and only repairs genuinely-malformed JSON; it never
			// throws — it returns undefined while the buffer is still incomplete.
			let isComplete = false
			let parsedArgs: Record<string, any> = {}
			let argumentsRepaired = false

			const parseResult = accumulatedCall.function!.arguments.trim()
				? tryParseToolArguments(accumulatedCall.function!.arguments)
				: undefined

			if (parseResult) {
				// Fix any double-encoded parameters
				parsedArgs = parseDoubleEncodedParams(parseResult.parsed)
				isComplete = true
				argumentsRepaired = parseResult.repaired ?? false
				if (argumentsRepaired) {
					console.warn("[AssistantMessageParser] Repaired malformed tool arguments")
				}
			} else {
				// Arguments are not yet complete valid JSON, continue accumulating.
				// forked_change: Update the partial tool use block with new partial params
				if (this.emittedPartialNativeToolCalls.has(toolCallId)) {
					// Find the partial tool use in content blocks and update its params
					const partialBlock = this.contentBlocks.find(
						(block): block is ToolUse =>
							block.type === "tool_use" && block.toolUseId === toolCallId && block.partial === true,
					)
					if (partialBlock) {
						// Update partial params from accumulated arguments
						const updatedPartialParams = this.extractPartialParams(accumulatedCall.function!.arguments)
						partialBlock.params =
							accumulatedCall.isMcpTool && accumulatedCall.mcpServerName
								? {
										server_name: accumulatedCall.mcpServerName,
										tool_name: accumulatedCall.function!.name,
										arguments: accumulatedCall.function!.arguments,
									}
								: updatedPartialParams
					}
				}
				continue
			}

			// Tool call is complete - convert it to ToolUse format
			if (isComplete) {
				const toolName = accumulatedCall.function!.name

				// forked_change: Handle MCP tools by converting to use_mcp_tool
				let toolUse: ToolUse
				if (accumulatedCall.isMcpTool && accumulatedCall.mcpServerName) {
					// Convert MCP tool call to use_mcp_tool format
					console.log("[MCP Debug] Converting native MCP tool call:", toolName, "args:", parsedArgs)
					toolUse = {
						type: "tool_use",
						name: "use_mcp_tool" as ToolName,
						params: {
							server_name: accumulatedCall.mcpServerName,
							tool_name: toolName,
							arguments: JSON.stringify(parsedArgs),
						},
						partial: false,
						toolUseId: accumulatedCall.id,
						repaired: argumentsRepaired,
					}
					console.log("[MCP Debug] Converted to use_mcp_tool:", toolUse.params)
				} else {
					// Create a ToolUse block from the native tool call
					toolUse = {
						type: "tool_use",
						name: toolName as ToolName,
						params: parsedArgs,
						partial: false, // Now complete after accumulation
						toolUseId: accumulatedCall.id,
						repaired: argumentsRepaired,
					}
				}

				// forked_change: Update the partial block in place by mutating the existing object
				// This ensures both contentBlocks and assistantMessageContent see the same updated object
				if (this.emittedPartialNativeToolCalls.has(toolCallId)) {
					const partialIndex = this.contentBlocks.findIndex(
						(block) =>
							block.type === "tool_use" &&
							(block as ToolUse).toolUseId === toolCallId &&
							(block as ToolUse).partial === true,
					)
					if (partialIndex !== -1) {
						// Mutate the existing block object in place - this updates the reference
						// that both contentBlocks and assistantMessageContent share
						const existingBlock = this.contentBlocks[partialIndex] as ToolUse
						existingBlock.name = toolUse.name
						existingBlock.params = toolUse.params
						existingBlock.partial = false
						existingBlock.toolUseId = toolUse.toolUseId
						existingBlock.repaired = toolUse.repaired
					} else {
						// Partial block not found, add as new (shouldn't happen normally)
						this.contentBlocks.push(toolUse)
					}
					this.emittedPartialNativeToolCalls.delete(toolCallId)
				} else {
					// No partial was emitted, add as new
					this.contentBlocks.push(toolUse)
				}

				// Mark this tool call as processed
				this.processedNativeToolCallIds.add(toolCallId)
				this.nativeToolCallsAccumulator.delete(toolCallId)

				yield {
					type: "tool_use",
					name: toolUse.name,
					id: toolUse.toolUseId ?? "",
					input: toolUse.params,
				}
			}
		}
	}

	/**
	 * Finalize text content before adding a tool use block.
	 * This ensures text content is properly closed before tool use starts.
	 */
	private finalizeTextContentBeforeToolUse(): void {
		if (this.currentTextContent) {
			this.currentTextContent.partial = false
			this.currentTextContent = undefined
		}
	}
	// forked_change end

	/**
	 * Process a new chunk of text and update the parser state.
	 * @param chunk The new chunk of text to process.
	 */
	public processChunk(chunk: string): AssistantMessageContent[] {
		if (this.accumulator.length + chunk.length > this.MAX_ACCUMULATOR_SIZE) {
			throw new Error("Assistant message exceeds maximum allowed size")
		}
		// Store the current length of the accumulator before adding the new chunk
		const accumulatorStartLength = this.accumulator.length

		for (let i = 0; i < chunk.length; i++) {
			const char = chunk[i]
			this.accumulator += char
			const currentPosition = accumulatorStartLength + i

			// There should not be a param without a tool use.
			if (this.currentToolUse && this.currentParamName) {
				const paramLength = this.accumulator.length - this.currentParamValueStartIndex
				if (paramLength > this.MAX_PARAM_LENGTH) {
					// Reset to a safe state
					this.currentParamName = undefined
					this.currentParamValueStartIndex = 0
					continue
				}
				const paramClosingTag = `</${this.currentParamName}>`
				// Check for closing tag without slicing the accumulator
				if (this.accumulator.endsWith(paramClosingTag)) {
					// End of param value.
					const currentParamValue = this.accumulator.slice(this.currentParamValueStartIndex)
					// Do not trim content parameters to preserve newlines, but strip first and last newline only
					const paramValue = currentParamValue.slice(0, -paramClosingTag.length)
					this.currentToolUse.params[this.currentParamName] =
						this.currentParamName === "content"
							? paramValue.replace(/^\n/, "").replace(/\n$/, "")
							: paramValue.trim()
					this.currentParamName = undefined
					continue
				}
				// Partial param value is accumulating.
				// Defer update to end of chunk to avoid O(n²) string slicing
				continue
			}

			// No currentParamName.

			if (this.currentToolUse) {
				const toolUseClosingTag = `</${this.currentToolUse.name}>`
				if (this.accumulator.endsWith(toolUseClosingTag)) {
					// End of a tool use.
					this.currentToolUse.partial = false

					this.currentToolUse = undefined
					continue
				} else {
					const possibleParamOpeningTags = toolParamNames.map((name) => `<${name}>`)
					for (const paramOpeningTag of possibleParamOpeningTags) {
						if (this.accumulator.endsWith(paramOpeningTag)) {
							// Start of a new parameter.
							const paramName = paramOpeningTag.slice(1, -1)
							if (!toolParamNames.includes(paramName as ToolParamName)) {
								// Handle invalid parameter name gracefully
								continue
							}
							this.currentParamName = paramName as ToolParamName
							this.currentParamValueStartIndex = this.accumulator.length
							break
						}
					}

					// There's no current param, and not starting a new param.

					// Special case for file_write where file contents could
					// contain the closing tag, in which case the param would have
					// closed and we end up with the rest of the file contents here.
					// To work around this, get the string between the starting
					// content tag and the LAST content tag.
					const contentParamName: ToolParamName = "content"

					if (
						this.currentToolUse.name === "file_write" &&
						this.accumulator.endsWith(`</${contentParamName}>`)
					) {
						const toolContent = this.accumulator.slice(this.currentToolUseStartIndex)
						const contentStartTag = `<${contentParamName}>`
						const contentEndTag = `</${contentParamName}>`
						const contentStartIndex = toolContent.indexOf(contentStartTag) + contentStartTag.length
						const contentEndIndex = toolContent.lastIndexOf(contentEndTag)

						if (contentStartIndex !== -1 && contentEndIndex !== -1 && contentEndIndex > contentStartIndex) {
							// Don't trim content to preserve newlines, but strip first and last newline only
							this.currentToolUse.params[contentParamName] = toolContent
								.slice(contentStartIndex, contentEndIndex)
								.replace(/^\n/, "")
								.replace(/\n$/, "")
						}
					}

					// Partial tool value is accumulating.
					continue
				}
			}

			// No currentToolUse.

			let didStartToolUse = false
			const possibleToolUseOpeningTags = toolNames.map((name) => `<${name}>`)

			for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
				if (this.accumulator.endsWith(toolUseOpeningTag)) {
					// Extract and validate the tool name
					const extractedToolName = toolUseOpeningTag.slice(1, -1)

					// Check if the extracted tool name is valid
					if (!toolNames.includes(extractedToolName as ToolName)) {
						// Invalid tool name, treat as plain text and continue
						continue
					}

					// Start of a new tool use.
					this.currentToolUse = {
						type: "tool_use",
						name: extractedToolName as ToolName,
						params: {},
						partial: true,
					}

					this.currentToolUseStartIndex = this.accumulator.length

					// This also indicates the end of the current text content.
					if (this.currentTextContent) {
						this.currentTextContent.partial = false

						// Remove the partially accumulated tool use tag from the
						// end of text (<tool).
						this.currentTextContent.content = this.currentTextContent.content
							.slice(0, -toolUseOpeningTag.slice(0, -1).length)
							.trim()

						// No need to push, currentTextContent is already in contentBlocks
						this.currentTextContent = undefined
					}

					// Immediately push new tool_use block as partial
					let idx = this.contentBlocks.findIndex((block) => block === this.currentToolUse)
					if (idx === -1) {
						this.contentBlocks.push(this.currentToolUse)
					}

					didStartToolUse = true
					break
				}
			}

			if (!didStartToolUse) {
				// No tool use, so it must be text either at the beginning or
				// between tools.
				if (this.currentTextContent === undefined) {
					// If this is the first chunk and we're at the beginning of processing,
					// set the start index to the current position in the accumulator
					this.currentTextContentStartIndex = currentPosition

					// Create a new text content block and add it to contentBlocks
					this.currentTextContent = {
						type: "text",
						content: "", // Defer content assignment to end of chunk
						partial: true,
					}

					// Add the new text content to contentBlocks immediately
					// Ensures it appears in the UI right away
					this.contentBlocks.push(this.currentTextContent)
				}
				// Defer text content update to end of chunk to avoid O(n²) slicing
			}
		}
		// Update partial param and text content values after processing the
		// entire chunk to avoid O(n²) string slicing in the hot loop.
		if (this.currentToolUse && this.currentParamName) {
			this.currentToolUse.params[this.currentParamName] = this.accumulator.slice(this.currentParamValueStartIndex)
		}
		if (this.currentTextContent) {
			this.currentTextContent.content = this.accumulator.slice(this.currentTextContentStartIndex).trim()
		}

		// Do not call finalizeContentBlocks() here.
		// Instead, update any partial blocks in the array and add new ones as they're completed.
		// This matches the behavior of the original parseAssistantMessage function.
		return this.getContentBlocks()
	}

	/**
	 * Finalize any partial content blocks.
	 * Should be called after processing the last chunk.
	 */
	public finalizeContentBlocks(): void {
		// forked_change start: Finalize any accumulated native tool calls
		this.finalizeNativeToolCalls()
		// forked_change end

		// Mark all partial blocks as complete
		for (const block of this.contentBlocks) {
			if (block.partial) {
				block.partial = false
			}
			if (block.type === "text" && typeof block.content === "string") {
				block.content = block.content.trim()
			}
		}
	}

	// forked_change start
	/**
	 * Finalize any accumulated native tool calls that haven't been yielded yet.
	 * This is called at the end of streaming to ensure all tool calls are processed,
	 * even if the JSON was complete but not yielded during streaming.
	 */
	private finalizeNativeToolCalls(): void {
		// Process any remaining accumulated tool calls
		for (const [toolCallId, accumulatedCall] of this.nativeToolCallsAccumulator.entries()) {
			// Skip if already processed
			if (this.processedNativeToolCallIds.has(toolCallId)) {
				continue
			}

			// Helper: Remove any previously emitted partial block for this tool call.
			// This is critical because by the time finalization runs, Task.ts has
			// already flipped every remaining partial block to partial:false
			// (Task.ts:2710-2711). We therefore MUST match the stale block by
			// toolUseId only — matching on `partial === true` would silently miss
			// it, leaving a corrupt block (built from regex-extracted partial params
			// that preserve literal "\n") alongside the correctly-parsed block, so
			// BOTH get executed and the edit is corrupted.
			const removePartialBlock = () => {
				if (this.emittedPartialNativeToolCalls.has(toolCallId)) {
					const partialIndex = this.contentBlocks.findIndex(
						(block) => block.type === "tool_use" && (block as ToolUse).toolUseId === toolCallId,
					)
					if (partialIndex !== -1) {
						this.contentBlocks.splice(partialIndex, 1)
					}
					this.emittedPartialNativeToolCalls.delete(toolCallId)
				}
			}

			// Try to parse the arguments one final time. Use the same raw-first
			// helper as the streaming path so valid JSON is decoded verbatim and
			// never mutated by the repair pass. The stream has now ended, so
			// repairTruncated closes dangling strings/containers and appends null
			// after a dangling colon — recovering calls whose JSON was cut off
			// mid-argument instead of dropping them.
			const finalParse = accumulatedCall.function?.arguments?.trim()
				? tryParseToolArguments(accumulatedCall.function.arguments, { repairTruncated: true })
				: { parsed: {} }

			if (!finalParse) {
				// Arguments are still not valid JSON — remove the partial block so it
				// doesn't get executed with incomplete params after finalizeContentBlocks
				// marks it as partial:false
				console.warn(
					`[AssistantMessageParser] Failed to parse accumulated tool call at finalization: ${toolCallId}`,
				)
				// forked_change: Track the dropped tool call so the task loop can retry
				// with a corrective message instead of silently stopping the agent.
				this.droppedMalformedToolCalls.push({
					name: accumulatedCall.function?.name ?? "unknown",
					rawArguments: accumulatedCall.function?.arguments ?? "",
				})
				removePartialBlock()
				continue
			}

			const parsedArgs: Record<string, any> = parseDoubleEncodedParams(finalParse.parsed)
			const argumentsRepaired = finalParse.repaired ?? false
			if (argumentsRepaired) {
				console.warn("[AssistantMessageParser] Repaired malformed tool arguments at finalization")
			}

			// Finalize any current text content before adding tool use
			if (this.currentTextContent) {
				this.currentTextContent.partial = false
				this.currentTextContent = undefined
			}

			const toolName = accumulatedCall.function!.name
			// forked_change: Handle MCP tools by converting to use_mcp_tool
			let toolUse: ToolUse
			if (accumulatedCall.isMcpTool && accumulatedCall.mcpServerName) {
				// Convert MCP tool call to use_mcp_tool format
				toolUse = {
					type: "tool_use",
					name: "use_mcp_tool" as ToolName,
					params: {
						server_name: accumulatedCall.mcpServerName,
						tool_name: toolName,
						arguments: JSON.stringify(parsedArgs),
					},
					partial: false,
					toolUseId: accumulatedCall.id,
					repaired: argumentsRepaired,
				}
			} else {
				// Create a ToolUse block from the native tool call
				toolUse = {
					type: "tool_use",
					name: toolName as ToolName,
					params: parsedArgs,
					partial: false,
					toolUseId: accumulatedCall.id,
					repaired: argumentsRepaired,
				}
			}

			// Remove the old partial block before adding the complete one
			removePartialBlock()

			// Add the tool use to content blocks
			this.contentBlocks.push(toolUse)

			// Mark this tool call as processed
			this.processedNativeToolCallIds.add(toolCallId)
		}

		// Clear the accumulator after finalization
		this.nativeToolCallsAccumulator.clear()
	}
	// forked_change end
}
