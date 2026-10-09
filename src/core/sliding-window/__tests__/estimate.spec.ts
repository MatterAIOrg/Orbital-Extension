// npx vitest run src/core/sliding-window/__tests__/estimate.spec.ts

import { estimateContentTokens, IMAGE_TOKEN_ESTIMATE } from "../estimate"

describe("estimateContentTokens", () => {
	it("counts ~4 characters per token for text and tool results", () => {
		expect(estimateContentTokens("x".repeat(400))).toBe(100)
		expect(
			estimateContentTokens([
				{ type: "text", text: "x".repeat(40) },
				{ type: "tool_result", tool_use_id: "1", content: "y".repeat(80) },
				{ type: "tool_result", tool_use_id: "2", content: [{ type: "text", text: "z".repeat(80) }] },
			]),
		).toBe(50)
	})

	it("counts a fixed cost per image", () => {
		expect(
			estimateContentTokens([
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(10_000) } },
			]),
		).toBe(IMAGE_TOKEN_ESTIMATE)
	})
})
