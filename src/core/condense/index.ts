import Anthropic from "@anthropic-ai/sdk"

import { TelemetryService } from "@roo-code/telemetry"

import { t } from "../../i18n"
import { ApiHandler } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import { CHARS_PER_TOKEN, estimateContentTokens } from "../sliding-window/estimate"

export const N_MESSAGES_TO_KEEP = 3
export const MIN_CONDENSE_THRESHOLD = 5 // Minimum percentage of context window to trigger condensing
export const MAX_CONDENSE_THRESHOLD = 80 // Maximum percentage of context window to trigger condensing

const SUMMARY_PROMPT = `\
Summarize this conversation with maximum information density. This summary will replace the conversation history — omit nothing needed to continue the work correctly.

Structure your output as follows:

ORIGINAL GOAL: Quote the user's original task or request verbatim.

PROGRESS: What has been accomplished so far. Current state of the work.

DECISIONS: Architectural choices, naming conventions, coding patterns, library/framework selections adopted, and WHY each was chosen.

FILES: For each file that was read, modified, or created:
- Full path
- Why it matters to the task
- Changes made (if any)
- Key code: function signatures, type definitions, error messages, constants

EXPLORATION ALREADY DONE: Searches, file reads, and investigations already performed and what each concluded — so they are NOT repeated after compaction.

FAILED APPROACHES: What was tried and did not work. Why it failed. What should NOT be attempted again.

KNOWLEDGE STATE:
- Confirmed: [facts verified during the conversation]
- Assumed/Inferred: [reasonable but unconfirmed assumptions]
- Unknown: [unresolved questions or gaps]

ENVIRONMENT: Relevant workspace settings, API providers, active modes, tool versions, or constraints affecting the task.

NEXT STEPS: Immediate next action — include a VERBATIM quote of the most recent task instruction from the user. List all pending tasks with their current status.

RULES:
- Preserve every file path, function name, variable name, error message, and identifier exactly as it appeared. Never paraphrase identifiers.
- The summary is the only surviving record: anything omitted is lost and must be re-derived by re-reading files. Include enough detail (paths, signatures, line numbers, error text) to continue without re-reading.
- Prefer listing over prose. Every token counts.
- Output ONLY the summary. No preamble, no "Here is the summary:", no commentary after.
`

// Prepended to the summary message inserted into the conversation after
// compaction. Ports codex's compact/summary_prefix.md: tells the model the
// history was compacted and that it must build on the recorded work instead
// of redoing it (re-searching, re-reading files, re-deriving facts).
export const SUMMARY_PREFIX = `\
[CONTEXT COMPACTION] An earlier assistant began this task and produced the summary below as a handoff. Treat it as the authoritative record of all work so far: do NOT repeat anything it describes — no re-running searches, no re-reading files it covers, no re-deriving facts it states. Continue from NEXT STEPS.`

/**
 * Share of the context window the summary request may use, tried in order
 * when the provider rejects it as too long. The smaller budgets cover
 * upstreams whose real window is under the catalog's.
 */
const SUMMARY_BUDGET_FRACTIONS = [0.6, 0.3, 0.15]
/** A trimmed summary request still sends the most recent tool results verbatim. */
const KEEP_RECENT_TOOL_RESULTS = 4

export type SummarizeResponse = {
	messages: ApiMessage[] // The messages after summarization
	summary: string // The summary text; empty string for no summary
	cost: number // The cost of the summarization operation
	newContextTokens?: number // The number of tokens in the context for the next API request
	error?: string // Populated iff the operation fails: error message shown to the user on failure (see Task.ts)
}

/**
 * Summarizes the conversation messages using an LLM call
 *
 * @param {ApiMessage[]} messages - The conversation messages
 * @param {ApiHandler} apiHandler - The API handler to use for token counting.
 * @param {string} systemPrompt - The system prompt for API requests, which should be considered in the context token count
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @param {boolean} isAutomaticTrigger - Whether the summarization is triggered automatically
 * @returns {SummarizeResponse} - The result of the summarization operation (see above)
 */
/**
 * Summarizes the conversation messages using an LLM call
 *
 * @param {ApiMessage[]} messages - The conversation messages
 * @param {ApiHandler} apiHandler - The API handler to use for token counting (fallback if condensingApiHandler not provided)
 * @param {string} systemPrompt - The system prompt for API requests (fallback if customCondensingPrompt not provided)
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @param {number} prevContextTokens - The number of tokens currently in the context, used to ensure we don't grow the context
 * @param {boolean} isAutomaticTrigger - Whether the summarization is triggered automatically
 * @param {string} customCondensingPrompt - Optional custom prompt to use for condensing
 * @param {ApiHandler} condensingApiHandler - Optional specific API handler to use for condensing
 * @returns {SummarizeResponse} - The result of the summarization operation (see above)
 */
export async function summarizeConversation(
	messages: ApiMessage[],
	apiHandler: ApiHandler,
	systemPrompt: string,
	taskId: string,
	prevContextTokens: number,
	isAutomaticTrigger?: boolean,
	customCondensingPrompt?: string,
	condensingApiHandler?: ApiHandler,
): Promise<SummarizeResponse> {
	TelemetryService.instance.captureContextCondensed(
		taskId,
		isAutomaticTrigger ?? false,
		!!customCondensingPrompt?.trim(),
		!!condensingApiHandler,
	)

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	// Always preserve the first message (which may contain slash command content)
	const firstMessage = messages[0]
	// Get messages to summarize, including the first message and excluding the last N messages
	const messagesToSummarize = getMessagesSinceLastSummary(messages.slice(0, -N_MESSAGES_TO_KEEP))

	if (messagesToSummarize.length <= 1) {
		// forked_change start
		const error =
			messages.length <= N_MESSAGES_TO_KEEP + 1
				? t("common:errors.condense_not_enough_messages", {
						prevContextTokens,
						messageCount: messages.length,
						minimumMessageCount: N_MESSAGES_TO_KEEP + 2,
					})
				: t("common:errors.condensed_recently")
		// forked_change end
		return { ...response, error }
	}

	const keepMessages = messages.slice(-N_MESSAGES_TO_KEEP)
	// Check if there's a recent summary in the messages we're keeping
	const recentSummaryExists = keepMessages.some((message) => message.isSummary)

	if (recentSummaryExists) {
		const error = t("common:errors.condensed_recently")
		return { ...response, error }
	}

	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: "Summarize the conversation so far, as described in the prompt instructions.",
	}

	// Note: this doesn't need to be a stream, consider using something like apiHandler.completePrompt
	// Use custom prompt if provided and non-empty, otherwise use the default SUMMARY_PROMPT
	const promptToUse = customCondensingPrompt?.trim() ? customCondensingPrompt.trim() : SUMMARY_PROMPT

	// Use condensing API handler if provided, otherwise use main API handler
	let handlerToUse = condensingApiHandler || apiHandler

	// Check if the chosen handler supports the required functionality
	if (!handlerToUse || typeof handlerToUse.createMessage !== "function") {
		console.warn(
			"Chosen API handler for condensing does not support message creation or is invalid, falling back to main apiHandler.",
		)

		handlerToUse = apiHandler // Fallback to the main, presumably valid, apiHandler

		// Ensure the main apiHandler itself is valid before this point or add another check.
		if (!handlerToUse || typeof handlerToUse.createMessage !== "function") {
			// This case should ideally not happen if main apiHandler is always valid.
			// Consider throwing an error or returning a specific error response.
			console.error("Main API handler is also invalid for condensing. Cannot proceed.")
			// Return an appropriate error structure for SummarizeResponse
			const error = t("common:errors.condense_handler_invalid")
			return { ...response, error }
		}
	}

	// forked_change start: the summary request carries the whole history, so
	// once that outgrows the window it would fail exactly when condensing is
	// needed. Under budget it is sent unchanged (keeping the prompt cache warm);
	// past it, it is trimmed, with smaller budgets tried if the provider still
	// says it doesn't fit.
	const contextWindow = handlerToUse.getModel().info.contextWindow
	let summary = ""
	let cost = 0
	let outputTokens = 0
	let summarized = false
	let lastError: unknown

	for (const fraction of SUMMARY_BUDGET_FRACTIONS) {
		const source = fitSummarySource(messagesToSummarize, Math.floor(contextWindow * fraction))
		const requestMessages = maybeRemoveImageBlocks([...source, finalRequestMessage], apiHandler).map(
			({ role, content }) => ({ role, content }),
		)
		summary = ""
		cost = 0
		outputTokens = 0
		try {
			const stream = handlerToUse.createMessage(promptToUse, requestMessages)
			for await (const chunk of stream) {
				if (chunk.type === "text") {
					summary += chunk.text
				} else if (chunk.type === "usage") {
					// Record final usage chunk only
					cost = chunk.totalCost ?? 0
					outputTokens = chunk.outputTokens ?? 0
				}
			}
			summarized = true
			break
		} catch (error) {
			if (!checkContextWindowExceededError(error)) {
				throw error
			}
			lastError = error
		}
	}

	if (!summarized) {
		console.warn("[summarizeConversation] summary request did not fit the context window:", lastError)
		return { ...response, error: t("common:errors.condense_failed") }
	}
	// forked_change end

	summary = summary.trim()

	if (summary.length === 0) {
		const error = t("common:errors.condense_failed")
		return { ...response, cost, error }
	}

	// The prefix tells the model this is a compaction handoff and that it must
	// not redo the work recorded in the summary.
	const summaryMessage: ApiMessage = {
		role: "assistant",
		content: `${SUMMARY_PREFIX}\n\n${summary}`,
		ts: keepMessages[0].ts,
		isSummary: true,
	}

	// Reconstruct messages: [first message, summary, last N messages]
	const newMessages = [firstMessage, summaryMessage, ...keepMessages]

	// Count the tokens in the context for the next API request
	// We only estimate the tokens in summaryMesage if outputTokens is 0, otherwise we use outputTokens
	const systemPromptMessage: ApiMessage = { role: "user", content: systemPrompt }

	const contextMessages = outputTokens
		? [systemPromptMessage, ...keepMessages]
		: [systemPromptMessage, summaryMessage, ...keepMessages]

	const contextBlocks = contextMessages.flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)

	const newContextTokens = outputTokens + (await apiHandler.countTokens(contextBlocks))
	if (newContextTokens >= prevContextTokens) {
		// kilocode_change add numbers
		const error = t("common:errors.condense_context_grew", { prevContextTokens, newContextTokens })
		return { ...response, cost, error }
	}
	return { messages: newMessages, summary, cost, newContextTokens }
}

/**
 * forked_change: the history for a summary request, trimmed to `budgetTokens`
 * when it doesn't fit. Older tool results are stubbed, oversized text cut, and
 * the oldest whole rounds dropped, keeping the first message (the task). Each
 * kept round starts at an assistant message so no tool result loses its call.
 */
export function fitSummarySource(messages: ApiMessage[], budgetTokens: number): ApiMessage[] {
	const size = (list: ApiMessage[]) =>
		list.reduce((total, message) => total + estimateContentTokens(message.content), 0)
	if (size(messages) <= budgetTokens) return messages

	// Stub every tool result except the most recent few.
	let toolResultsSeen = 0
	const stubbed = [...messages].reverse().map((message) => {
		if (typeof message.content === "string") return message
		const content = [...message.content].reverse().map((block) => {
			if (block.type !== "tool_result") return block
			toolResultsSeen++
			if (toolResultsSeen <= KEEP_RECENT_TOOL_RESULTS) return block
			const text =
				typeof block.content === "string"
					? block.content
					: (block.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n")
			const lines = text.split("\n").length
			return { ...block, content: `[Tool result (${lines} lines) omitted to fit the summary request.]` }
		})
		return { ...message, content: content.reverse() }
	})
	stubbed.reverse()

	// Cut any single message's text that would dominate the budget.
	const maxChars = Math.floor((budgetTokens * CHARS_PER_TOKEN) / 4)
	const marker = "\n[… truncated to fit the context window …]"
	let trimmed = stubbed.map((message) => {
		if (typeof message.content === "string") {
			return message.content.length > maxChars
				? { ...message, content: message.content.slice(0, maxChars) + marker }
				: message
		}
		return {
			...message,
			content: message.content.map((block) =>
				block.type === "text" && block.text.length > maxChars
					? { ...block, text: block.text.slice(0, maxChars) + marker }
					: block,
			),
		}
	})
	if (size(trimmed) <= budgetTokens || trimmed.length < 3) return trimmed

	// Drop the oldest rounds, keeping the first message.
	const [first, ...rest] = trimmed
	let start = 0
	while (size([first, ...rest.slice(start)]) > budgetTokens) {
		const next = rest.findIndex((message, index) => index > start && message.role === "assistant")
		if (next === -1) break
		start = next
	}
	if (start === 0) return trimmed
	const note = `[${start} earlier messages omitted to fit the context window.]`
	const firstWithNote: ApiMessage = {
		...first,
		content:
			typeof first.content === "string"
				? `${first.content}\n\n${note}`
				: [...first.content, { type: "text", text: note }],
	}
	trimmed = [firstWithNote, ...rest.slice(start)]
	return trimmed
}

/* Returns the list of all messages since the last summary message, including the summary. Returns all messages if there is no summary. */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	let lastSummaryIndexReverse = [...messages].reverse().findIndex((message) => message.isSummary)

	if (lastSummaryIndexReverse === -1) {
		return messages
	}

	const lastSummaryIndex = messages.length - lastSummaryIndexReverse - 1
	const messagesSinceSummary = messages.slice(lastSummaryIndex)

	// Bedrock requires the first message to be a user message.
	// We preserve the original first message to maintain context.
	// See https://github.com/RooCodeInc/Roo-Code/issues/4147
	if (messagesSinceSummary.length > 0 && messagesSinceSummary[0].role !== "user") {
		// Get the original first message (should always be a user message with the task)
		const originalFirstMessage = messages[0]
		if (originalFirstMessage && originalFirstMessage.role === "user") {
			// Use the original first message unchanged to maintain full context
			return [originalFirstMessage, ...messagesSinceSummary]
		} else {
			// Fallback to generic message if no original first message exists (shouldn't happen)
			const userMessage: ApiMessage = {
				role: "user",
				content: "Please continue from the following summary:",
				ts: messages[0]?.ts ? messages[0].ts - 1 : Date.now(),
			}
			return [userMessage, ...messagesSinceSummary]
		}
	}

	return messagesSinceSummary
}
