import { Anthropic } from "@anthropic-ai/sdk"

/** Rough chars-per-token for content the provider hasn't measured yet. */
export const CHARS_PER_TOKEN = 4
/** Tokens counted per image: its base64 length says nothing about its token cost. */
export const IMAGE_TOKEN_ESTIMATE = 1500

/**
 * Cheap token estimate for message content, used where a provider-reported
 * count isn't available yet (new tool results, a summary request's budget).
 */
export function estimateContentTokens(content: string | Anthropic.Messages.ContentBlockParam[]): number {
	if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN)
	let chars = 0
	let images = 0
	for (const block of content) {
		switch (block.type) {
			case "text":
				chars += block.text.length
				break
			case "image":
				images++
				break
			case "tool_use":
				chars += block.name.length + JSON.stringify(block.input ?? {}).length
				break
			case "tool_result":
				if (typeof block.content === "string") {
					chars += block.content.length
				} else {
					for (const part of block.content ?? []) {
						if (part.type === "text") chars += part.text.length
						else if (part.type === "image") images++
					}
				}
				break
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_ESTIMATE
}
