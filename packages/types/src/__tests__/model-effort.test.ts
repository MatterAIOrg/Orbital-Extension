// npx vitest run src/__tests__/model-effort.test.ts

import { describe, expect, it } from "vitest"

import { getModelEffortLevels, isGatewayEffort, resolveModelEffort } from "../model-effort.js"

const info = (reasoningEfforts?: Array<"low" | "medium" | "high" | "max">) => ({ reasoningEfforts })

describe("model effort", () => {
	it("uses the catalog's levels, with a built-in list for known models before it loads", () => {
		expect(getModelEffortLevels("any/model", info(["low", "high"]))).toEqual(["low", "high"])
		expect(getModelEffortLevels("zai/glm-5.3")).toEqual(["low", "medium", "high", "max"])
		expect(getModelEffortLevels("unknown/model")).toEqual([])
		// An explicit empty list from the catalog turns the selector off.
		expect(getModelEffortLevels("zai/glm-5.3", info([]))).toEqual([])
	})

	it("resolves the user's pick, else medium, else the first level", () => {
		const levels = info(["low", "medium", "high", "max"])
		expect(resolveModelEffort({ "zai/glm-5.3": "max" }, "zai/glm-5.3", levels)).toBe("max")
		expect(resolveModelEffort(undefined, "zai/glm-5.3", levels)).toBe("medium")
		expect(resolveModelEffort({ m: "max" }, "m", info(["low", "high"]))).toBe("low")
		expect(resolveModelEffort({ m: "max" }, "m", info([]))).toBeUndefined()
	})

	it("validates levels", () => {
		expect(isGatewayEffort("max")).toBe(true)
		expect(isGatewayEffort("xhigh")).toBe(false)
	})
})
