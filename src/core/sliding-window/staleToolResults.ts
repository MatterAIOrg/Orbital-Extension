import type { Anthropic } from "@anthropic-ai/sdk"

import { toModelToolName } from "../../shared/toolAliases"

/** Start stubbing stale tool results once context passes this fraction of the window. */
const PRUNE_TRIGGER_FRACTION = 0.4
/** The most recent tool results are always sent verbatim. */
const KEEP_RECENT_TOOL_RESULTS = 4
/** The prune boundary only advances in batches this large, so the request prefix
 *  (and the provider's prompt cache) stays stable between prunes. */
const PRUNE_BATCH = 6
/** Results shorter than this are not worth stubbing. */
const PRUNE_MIN_CHARS = 1500
/** Tools whose output is bulky and can simply be re-fetched. */
const PRUNABLE_TOOLS = new Set(["read_file", "execute_command", "codebase_search", "web_fetch", "web_search"])

type Message = Anthropic.Messages.MessageParam
type Block = Anthropic.Messages.ContentBlockParam

function resultText(block: Anthropic.Messages.ToolResultBlockParam): string | undefined {
	if (typeof block.content === "string") return block.content
	if (!block.content) return ""
	// Leave results with images alone: they cannot be re-derived from the stub.
	if (block.content.some((part) => part.type !== "text")) return undefined
	return block.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

/**
 * Once context is large, stop resending old bulky tool results verbatim. Only the
 * outgoing request is stubbed; the stored conversation is never touched. The
 * boundary only advances in batches so the request prefix stays identical between
 * advances and the provider's prompt cache keeps hitting.
 */
export class StaleToolResultPruner {
	/** Tool results in messages at indexes below this are sent as short stubs. */
	private prunedBefore = 0
	private lastLength = 0

	reset(): void {
		this.prunedBefore = 0
		this.lastLength = 0
	}

	apply<T extends Message>(messages: T[], contextTokens: number, contextWindow: number): T[] {
		// A shorter history means it was condensed or truncated: indexes shifted.
		if (messages.length < this.lastLength) this.prunedBefore = 0
		this.lastLength = messages.length

		this.advanceBoundary(messages, contextTokens, contextWindow)
		if (this.prunedBefore === 0) return messages

		const toolNames = new Map<string, string>()
		for (const message of messages) {
			if (message.role !== "assistant" || typeof message.content === "string") continue
			for (const block of message.content) {
				if (block.type === "tool_use") toolNames.set(block.id, block.name)
			}
		}

		return messages.map((message, index) => {
			if (index >= this.prunedBefore || message.role !== "user" || typeof message.content === "string") {
				return message
			}
			let changed = false
			const content = message.content.map((block): Block => {
				if (block.type !== "tool_result") return block
				const name = toolNames.get(block.tool_use_id) ?? ""
				const text = resultText(block)
				if (!PRUNABLE_TOOLS.has(name) || text === undefined || text.length < PRUNE_MIN_CHARS) return block
				changed = true
				const lines = text.split("\n").length
				return {
					...block,
					content: `[Earlier ${toModelToolName(name)} result (${lines} lines) removed to save context. Re-run the call if you still need it.]`,
				}
			})
			return changed ? { ...message, content } : message
		})
	}

	private advanceBoundary(messages: Message[], contextTokens: number, contextWindow: number): void {
		if (!contextWindow || contextTokens < contextWindow * PRUNE_TRIGGER_FRACTION) return
		// One entry per tool_result block, holding the index of its message.
		const resultMessageIndexes: number[] = []
		messages.forEach((message, index) => {
			if (message.role !== "user" || typeof message.content === "string") return
			for (const block of message.content) {
				if (block.type === "tool_result") resultMessageIndexes.push(index)
			}
		})
		if (resultMessageIndexes.length <= KEEP_RECENT_TOOL_RESULTS) return
		const boundary = resultMessageIndexes[resultMessageIndexes.length - KEEP_RECENT_TOOL_RESULTS]
		const newlyStale = resultMessageIndexes.filter((index) => index >= this.prunedBefore && index < boundary).length
		if (newlyStale >= PRUNE_BATCH) this.prunedBefore = boundary
	}
}
