// npx vitest run src/core/condense/__tests__/fitSummarySource.spec.ts

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { fitSummarySource } from "../index"
import { estimateContentTokens } from "../../sliding-window/estimate"

vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureContextCondensed: vi.fn() } } }))

const size = (messages: ApiMessage[]) => messages.reduce((total, m) => total + estimateContentTokens(m.content), 0)

/** task, then `rounds` × (assistant tool call, user tool result of `resultChars`). */
function history(rounds: number, resultChars: number): ApiMessage[] {
	const messages: ApiMessage[] = [{ role: "user", content: "the task", ts: 0 }]
	for (let i = 1; i <= rounds; i++) {
		messages.push({
			role: "assistant",
			content: [{ type: "tool_use", id: `call_${i}`, name: "read_file", input: { path: `f${i}` } }],
			ts: i * 2,
		})
		messages.push({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: "x".repeat(resultChars) }],
			ts: i * 2 + 1,
		})
	}
	return messages
}

describe("fitSummarySource", () => {
	it("returns the history unchanged when it fits", () => {
		const messages = history(3, 100)
		expect(fitSummarySource(messages, 10_000)).toBe(messages)
	})

	it("stubs older tool results but keeps the last four verbatim", () => {
		const messages = history(8, 4_000)
		const fitted = fitSummarySource(messages, 6_000)
		const results = fitted.flatMap((m) =>
			typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"),
		) as Array<{ content: string }>
		expect(results).toHaveLength(8)
		expect(results.slice(0, 4).every((r) => r.content.includes("omitted to fit the summary request"))).toBe(true)
		expect(results.slice(4).every((r) => r.content === "x".repeat(4_000))).toBe(true)
		expect(size(fitted)).toBeLessThanOrEqual(6_000)
	})

	it("drops the oldest rounds, keeps the task, and never orphans a tool result", () => {
		const messages = history(20, 4_000)
		const fitted = fitSummarySource(messages, 2_500)
		expect(fitted[0].role).toBe("user")
		expect(fitted[0].content).toMatch(/^the task\n\n\[\d+ earlier messages omitted to fit the context window\.\]$/)
		expect(fitted[1].role).toBe("assistant")
		const callIds = new Set(
			fitted.flatMap((m) =>
				typeof m.content === "string" ? [] : m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : [])),
			),
		)
		for (const m of fitted) {
			if (typeof m.content === "string") continue
			for (const block of m.content) {
				if (block.type === "tool_result") expect(callIds.has(block.tool_use_id)).toBe(true)
			}
		}
		expect(size(fitted)).toBeLessThanOrEqual(2_500)
	})
})
