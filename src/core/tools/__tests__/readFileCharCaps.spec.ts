// npx vitest run src/core/tools/__tests__/readFileCharCaps.spec.ts

import { capReadResultsByCharacters, type FileResult } from "../readFileTool"

const served = (path: string, content: string, startLine = 1): FileResult => ({
	path,
	status: "approved",
	xmlContent: content,
	startLine,
	endLine: startLine + content.split("\n").length - 1,
})

describe("capReadResultsByCharacters", () => {
	it("leaves small reads alone", () => {
		const results = [served("a.ts", "line 1\nline 2")]
		capReadResultsByCharacters(results)
		expect(results[0].xmlContent).toBe("line 1\nline 2")
	})

	it("caps a file at 100k characters on a line boundary", () => {
		const content = Array.from({ length: 3_000 }, (_, i) => `${i + 1}|${"x".repeat(60)}`).join("\n")
		const results = [served("big.ts", content)]
		capReadResultsByCharacters(results)
		const text = results[0].xmlContent!
		expect(text.length).toBeLessThan(100_500)
		expect(text).toContain("Output capped at 100000 characters")
		expect(results[0].endLine).toBeLessThan(3_000)
	})

	it("cuts a single over-long line mid-line", () => {
		const results = [served("min.js", "x".repeat(250_000))]
		capReadResultsByCharacters(results)
		expect(results[0].xmlContent).toContain("Line 1 alone exceeds 100000 characters")
	})

	it("shares a 200k budget across the call and skips files past it", () => {
		// 2 × 99.6k leaves 800 characters: too little to be worth returning.
		const big = "y".repeat(99_600)
		const results = [served("a", big), served("b", big), served("c", big)]
		capReadResultsByCharacters(results)
		expect(results[0].xmlContent).toBe(big)
		expect(results[1].xmlContent).toBe(big)
		expect(results[2].xmlContent).toContain("[skipped]")
	})

	it("ignores errors and images", () => {
		const results: FileResult[] = [
			{ path: "e", status: "error", xmlContent: "z".repeat(150_000) },
			{ path: "i", status: "approved", xmlContent: "z".repeat(150_000), imageDataUrl: "data:" },
		]
		capReadResultsByCharacters(results)
		expect(results[0].xmlContent!.length).toBe(150_000)
		expect(results[1].xmlContent!.length).toBe(150_000)
	})
})
