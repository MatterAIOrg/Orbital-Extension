import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { toModelToolName } from "../../shared/toolAliases"

export function convertToOpenAiMessages(
	anthropicMessages: Anthropic.Messages.MessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = []

	for (const anthropicMessage of anthropicMessages) {
		if (typeof anthropicMessage.content === "string") {
			// forked_change start: Preserve reasoning fields for assistant messages with string content
			if (anthropicMessage.role === "assistant") {
				const messageWithReasoning = anthropicMessage as typeof anthropicMessage & {
					reasoning?: string
					reasoning_content?: string
				}
				const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
					role: "assistant",
					content: anthropicMessage.content,
				}
				if (messageWithReasoning.reasoning) {
					;(assistantMsg as any).reasoning = messageWithReasoning.reasoning
				}
				if (messageWithReasoning.reasoning_content) {
					;(assistantMsg as any).reasoning_content = messageWithReasoning.reasoning_content
				}
				openAiMessages.push(assistantMsg)
			} else {
				openAiMessages.push({ role: anthropicMessage.role, content: anthropicMessage.content })
			}
			// forked_change end
		} else {
			// image_url.url is base64 encoded image data
			// ensure it contains the content-type of the image: data:image/png;base64,
			/*
		{ role: "user", content: "" | { type: "text", text: string } | { type: "image_url", image_url: { url: string } } },
		 // content required unless tool_calls is present
		{ role: "assistant", content?: "" | null, tool_calls?: [{ id: "", function: { name: "", arguments: "" }, type: "function" }] },
		{ role: "tool", tool_call_id: "", content: ""}
		 */
			if (anthropicMessage.role === "user") {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolResultBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_result") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						} // user cannot send tool_use messages
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process tool result messages FIRST since they must follow the tool use messages
				let toolResultImages: Anthropic.Messages.ImageBlockParam[] = []
				toolMessages.forEach((toolMessage) => {
					// The Anthropic SDK allows tool results to be a string or an array of text and image blocks, enabling rich and structured content. In contrast, the OpenAI SDK only supports tool results as a single string, so we map the Anthropic tool result parts into one concatenated string to maintain compatibility.
					let content: string

					if (typeof toolMessage.content === "string") {
						content = toolMessage.content
					} else {
						content =
							toolMessage.content
								?.map((part) => {
									if (part.type === "image") {
										toolResultImages.push(part)
										return "(see following user message for image)"
									}
									return part.text
								})
								.join("\n") ?? ""
					}
					openAiMessages.push({
						role: "tool",
						tool_call_id: toolMessage.tool_use_id,
						content: content,
					})
				})

				// If tool results contain images, send as a separate user message
				// I ran into an issue where if I gave feedback for one of many tool uses, the request would fail.
				// "Messages following `tool_use` blocks must begin with a matching number of `tool_result` blocks."
				// Therefore we need to send these images after the tool result messages
				// NOTE: it's actually okay to have multiple user messages in a row, the model will treat them as a continuation of the same input (this way works better than combining them into one message, since the tool result specifically mentions (see following user message for image)
				// NOTE: with native tool calling, user-attached images arrive inside tool_result
				// blocks (e.g. feedback on attempt_completion). They must be forwarded as a
				// follow-up user message, otherwise the model only sees the placeholder text.
				if (toolResultImages.length > 0) {
					openAiMessages.push({
						role: "user",
						content: toolResultImages.map((part) => ({
							type: "image_url",
							image_url: {
								// kilocode_change begin support type==url
								url:
									part.source.type === "url"
										? part.source.url
										: `data:${part.source.media_type};base64,${part.source.data}`,
								// kilocode_change end
							},
						})),
					})
				}

				// Process non-tool messages
				if (nonToolMessages.length > 0) {
					openAiMessages.push({
						role: "user",
						content: nonToolMessages.map((part) => {
							if (part.type === "image") {
								return {
									type: "image_url",
									image_url: {
										// kilocode_change begin support type==url
										url:
											part.source.type === "url"
												? part.source.url
												: `data:${part.source.media_type};base64,${part.source.data}`,
										// forked_change end
									},
								}
							}
							return { type: "text", text: part.text }
						}),
					})
				}
			} else if (anthropicMessage.role === "assistant") {
				const { nonToolMessages, toolMessages } = anthropicMessage.content.reduce<{
					nonToolMessages: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[]
					toolMessages: Anthropic.ToolUseBlockParam[]
				}>(
					(acc, part) => {
						if (part.type === "tool_use") {
							acc.toolMessages.push(part)
						} else if (part.type === "text" || part.type === "image") {
							acc.nonToolMessages.push(part)
						} // assistant cannot send tool_result messages
						return acc
					},
					{ nonToolMessages: [], toolMessages: [] },
				)

				// Process non-tool messages
				let content: string | undefined
				if (nonToolMessages.length > 0) {
					content = nonToolMessages
						.map((part) => {
							if (part.type === "image") {
								return "" // impossible as the assistant cannot send images
							}
							return part.text
						})
						.join("\n")
				}

				// Process tool use messages
				let tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[] = toolMessages.map((toolMessage) => ({
					id: toolMessage.id,
					type: "function",
					function: {
						name: toModelToolName(toolMessage.name),
						// json string
						arguments: JSON.stringify(toolMessage.input),
					},
				}))

				// forked_change start: Preserve reasoning fields from the original message
				// Some models (DeepSeek, OpenRouter, etc.) return reasoning/reasoning_content
				// in their responses, and these should be passed through in subsequent API calls
				const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
					role: "assistant",
					content,
					// Cannot be an empty array. API expects an array with minimum length 1, and will respond with an error if it's empty
					tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
				}

				// Pass through reasoning fields if present on the source message
				const messageWithReasoning = anthropicMessage as typeof anthropicMessage & {
					reasoning?: string
					reasoning_content?: string
				}
				if (messageWithReasoning.reasoning) {
					;(assistantMsg as any).reasoning = messageWithReasoning.reasoning
				}
				if (messageWithReasoning.reasoning_content) {
					;(assistantMsg as any).reasoning_content = messageWithReasoning.reasoning_content
				}

				openAiMessages.push(assistantMsg)
				// forked_change end
			}
		}
	}

	// forked_change start: Final safety net before the request leaves for the provider.
	// The OpenAI spec requires every assistant `tool_calls[i].id` to be answered by a
	// `tool` message. Our task loop already guarantees this upstream, but if anything
	// ever slips through (a malformed resumed history, a future regression, an
	// interrupted turn), a single unmatched tool_call makes the provider reject the
	// whole request. Rather than fail, backfill a placeholder `tool` message for any
	// tool_call that has no result so the request always stays spec-compliant.
	return backfillMissingToolResults(openAiMessages)
}

/**
 * forked_change: replay each assistant message's stored reasoning under the
 * OpenAI-compatible `reasoning_content` field instead of `reasoning`. The
 * message is sent back unchanged on every later request, so the model sees its
 * earlier thinking and the provider's prompt cache keeps matching.
 */
export function replayReasoningAsContent(
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
	return messages.map((message) => {
		if (message.role !== "assistant") return message
		const { reasoning, ...rest } = message as OpenAI.Chat.ChatCompletionAssistantMessageParam & {
			reasoning?: string
			reasoning_content?: string
		}
		if (!reasoning) return message
		return (rest.reasoning_content ? rest : { ...rest, reasoning_content: reasoning }) as typeof message
	})
}

/**
 * Ensures every assistant `tool_calls` entry is followed by a `tool` message for its
 * id. Any tool_call left unanswered gets a synthesized `tool` message with empty
 * content inserted right after the assistant message's existing tool results, so the
 * tool_call/tool_result pairing the provider validates is never broken.
 */
function backfillMissingToolResults(
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const result: OpenAI.Chat.ChatCompletionMessageParam[] = []

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		result.push(message)

		const toolCalls =
			message.role === "assistant"
				? (message as OpenAI.Chat.ChatCompletionAssistantMessageParam).tool_calls
				: undefined
		if (!toolCalls || toolCalls.length === 0) {
			continue
		}

		// Only backfill once the turn has actually been processed — i.e. another
		// message follows. A trailing assistant `tool_calls` message (the model just
		// emitted it, results not collected yet) is a valid intermediate history and
		// is never what we send to request the next turn, so leave it untouched.
		if (i === messages.length - 1) {
			continue
		}

		// Carry over the `tool` messages that already answer this assistant message and
		// record which tool_call ids they cover.
		const respondedIds = new Set<string>()
		let j = i + 1
		while (j < messages.length && messages[j].role === "tool") {
			const toolMessage = messages[j] as OpenAI.Chat.ChatCompletionToolMessageParam
			respondedIds.add(toolMessage.tool_call_id)
			result.push(toolMessage)
			j++
		}

		// Backfill a placeholder for every tool_call that wasn't answered.
		for (const toolCall of toolCalls) {
			if (!respondedIds.has(toolCall.id)) {
				result.push({ role: "tool", tool_call_id: toolCall.id, content: "" })
			}
		}

		// Skip the tool messages we already copied across.
		i = j - 1
	}

	return result
}
