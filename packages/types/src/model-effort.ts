// forked_change: per-model effort selector for models served through the
// MatterAI gateway. Shared by the extension (request header) and the webview
// (selector), so both resolve the same level.

import { gatewayEfforts, type GatewayEffort, type ModelInfo } from "./model.js"

export const DEFAULT_GATEWAY_EFFORT: GatewayEffort = "medium"

/** Used until the catalog (which advertises `reasoning_efforts`) has loaded. */
const FALLBACK_EFFORT_MODELS = new Set([
	"zai/glm-5.3",
	"zai/glm-5.3-flash",
	"gemini-3.8-flash",
	"deepseek/deepseek-v4.1-flash",
])

export function isGatewayEffort(value: unknown): value is GatewayEffort {
	return (gatewayEfforts as readonly unknown[]).includes(value)
}

/** Effort levels for the selector; empty when the model has none. */
export function getModelEffortLevels(modelId: string, info?: Pick<ModelInfo, "reasoningEfforts">): GatewayEffort[] {
	if (info?.reasoningEfforts) return info.reasoningEfforts
	return FALLBACK_EFFORT_MODELS.has(modelId) ? [...gatewayEfforts] : []
}

/**
 * Effort to send for a model: the user's pick for that model, else medium.
 * Undefined when the model has no effort selector.
 */
export function resolveModelEffort(
	modelEfforts: Record<string, GatewayEffort> | undefined,
	modelId: string,
	info?: Pick<ModelInfo, "reasoningEfforts">,
): GatewayEffort | undefined {
	const levels = getModelEffortLevels(modelId, info)
	if (levels.length === 0) return undefined
	const picked = modelEfforts?.[modelId]
	if (picked && levels.includes(picked)) return picked
	return levels.includes(DEFAULT_GATEWAY_EFFORT) ? DEFAULT_GATEWAY_EFFORT : levels[0]
}
