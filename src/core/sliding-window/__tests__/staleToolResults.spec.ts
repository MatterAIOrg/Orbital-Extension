// npx vitest run src/core/sliding-window/__tests__/staleToolResults.spec.ts

import { describe, expect, it } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

import { StaleToolResultPruner } from "../staleToolResults"

type Msg = Anthropic.Messages.MessageParam

const BIG = "x\n".repeat(1000)

/** One assistant tool call + its user tool_result, repeated `count` times. */
function conversation(count: number, tool = "execute_command"): Msg[] {
	const messages: Msg[] = [{ role: "user", content: "task" }]
	for (let i = 0; i < count; i++) {
		messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: tool, input: {} }] })
		messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: BIG }] })
	}
	return messages
}

const resultAt = (messages: Msg[], index: number) =>
	((messages[index].content as Anthropic.Messages.ContentBlockParam[])[0] as Anthropic.Messages.ToolResultBlockParam)
		.content

describe("StaleToolResultPruner", () => {
	it("leaves the history alone below 40% of the window", () => {
		const messages = conversation(10)
		expect(new StaleToolResultPruner().apply(messages, 10_000, 100_000)).toBe(messages)
	})

	it("stubs old bulky results, keeps the 4 most recent, and does not mutate the input", () => {
		const messages = conversation(10)
		const out = new StaleToolResultPruner().apply(messages, 50_000, 100_000)
		expect(resultAt(out, 2)).toMatch(/^\[Earlier Bash result \(1001 lines\) removed/)
		expect(resultAt(out, out.length - 1)).toBe(BIG)
		expect(resultAt(out, out.length - 7)).toBe(BIG) // 4th most recent
		expect(resultAt(messages, 2)).toBe(BIG)
	})

	it("only advances the boundary in batches so the prefix stays stable", () => {
		const pruner = new StaleToolResultPruner()
		// 4 recent + 5 stale candidates: fewer than a batch of 6, nothing pruned yet.
		const early = conversation(9)
		expect(pruner.apply(early, 50_000, 100_000)).toBe(early)
		const out = pruner.apply(conversation(10), 50_000, 100_000)
		expect(resultAt(out, 2)).toContain("removed to save context")
	})

	it("never stubs tools that cannot be re-run or small results", () => {
		const edits = conversation(10, "file_edit")
		expect(resultAt(new StaleToolResultPruner().apply(edits, 50_000, 100_000), 2)).toBe(BIG)
	})

	it("resets when the history shrinks (condensed)", () => {
		const pruner = new StaleToolResultPruner()
		pruner.apply(conversation(10), 50_000, 100_000)
		const condensed = conversation(3)
		expect(pruner.apply(condensed, 50_000, 100_000)).toBe(condensed)
	})
})
