import type { ClineMessage } from "@roo-code/types"

import { formatElapsed, formatTokenCount, getTurnStats } from "../TurnStats"

const say = (ts: number, sayType: string, text = "", partial?: boolean) =>
	({ type: "say", say: sayType, text, ts, partial }) as ClineMessage

const apiReq = (ts: number, tokensOut?: number) =>
	say(ts, "api_req_started", JSON.stringify(tokensOut === undefined ? {} : { tokensOut, cost: 0.01 }))

describe("getTurnStats", () => {
	it("starts the turn at the user's latest message, not the current request", () => {
		const messages = [
			say(1, "text", "task"),
			apiReq(2, 500),
			say(10, "user_feedback", "follow-up"),
			apiReq(11, 300),
			apiReq(20),
		]
		expect(getTurnStats(messages)).toEqual({ startedAt: 10, outputTokens: 300 })
	})

	it("adds an estimate for text still streaming in the current request", () => {
		const messages = [say(1, "text", "task"), apiReq(2, 100), apiReq(3), say(4, "text", "x".repeat(400), true)]
		expect(getTurnStats(messages)?.outputTokens).toBe(200)
	})

	it("returns nothing for an empty transcript", () => {
		expect(getTurnStats([])).toBeUndefined()
	})
})

describe("formatting", () => {
	it("formats elapsed time", () => {
		expect(formatElapsed(45_000)).toBe("45s")
		expect(formatElapsed(133_000)).toBe("2m 13s")
		expect(formatElapsed(3_840_000)).toBe("1h 4m")
	})

	it("formats token counts", () => {
		expect(formatTokenCount(840)).toBe("840")
		expect(formatTokenCount(4_200)).toBe("4.2k")
		expect(formatTokenCount(1_300_000)).toBe("1.3M")
	})
})
