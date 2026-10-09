import axios from "axios"
import { z } from "zod"

import {
	type ModelInfo,
	isModelParameter,
	OPEN_ROUTER_COMPUTER_USE_MODELS,
	OPEN_ROUTER_REASONING_BUDGET_MODELS,
	OPEN_ROUTER_REQUIRED_REASONING_BUDGET_MODELS,
	anthropicModels,
	isGatewayEffort,
} from "@roo-code/types"

import type { ApiHandlerOptions } from "../../../shared/api"
import { parseApiPrice } from "../../../shared/cost"
import { DEFAULT_HEADERS } from "../constants" // kilocode_change

/**
 * OpenRouterBaseModel
 */

const openRouterArchitectureSchema = z.object({
	input_modalities: z.array(z.string()).nullish(),
	output_modalities: z.array(z.string()).nullish(),
	tokenizer: z.string().nullish(),
})

const openRouterPricingSchema = z.object({
	prompt: z.string().nullish(),
	completion: z.string().nullish(),
	input_cache_write: z.string().nullish(),
	input_cache_read: z.string().nullish(),
})

const modelRouterBaseModelSchema = z.object({
	name: z.string(),
	description: z.string().optional(),
	context_length: z.number(),
	max_completion_tokens: z.number().nullish(),
	preferredIndex: z.number().nullish(), // kilocode_change
	pricing: openRouterPricingSchema.optional(),
})

export type OpenRouterBaseModel = z.infer<typeof modelRouterBaseModelSchema>

/**
 * OpenRouterModel
 */

export const openRouterModelSchema = modelRouterBaseModelSchema.extend({
	id: z.string(),
	architecture: openRouterArchitectureSchema.optional(),
	top_provider: z.object({ max_completion_tokens: z.number().nullish() }).optional(),
	supported_parameters: z.array(z.string()).optional(),
})

export type OpenRouterModel = z.infer<typeof openRouterModelSchema>

/**
 * OpenRouterModelEndpoint
 */

export const openRouterModelEndpointSchema = modelRouterBaseModelSchema.extend({
	model_name: z.string(), // kilocode_change
	provider_name: z.string(),
	tag: z.string().optional(),
})

export type OpenRouterModelEndpoint = z.infer<typeof openRouterModelEndpointSchema>

/**
 * OpenRouterModelsResponse
 */

const openRouterModelsResponseSchema = z.object({
	data: z.array(openRouterModelSchema),
})

type OpenRouterModelsResponse = z.infer<typeof openRouterModelsResponseSchema>

/**
 * OpenRouterModelEndpointsResponse
 */

const openRouterModelEndpointsResponseSchema = z.object({
	data: z.object({
		id: z.string(),
		name: z.string(),
		description: z.string().optional(),
		architecture: openRouterArchitectureSchema.optional(),
		supported_parameters: z.array(z.string()).optional(),
		endpoints: z.array(openRouterModelEndpointSchema),
	}),
})

type OpenRouterModelEndpointsResponse = z.infer<typeof openRouterModelEndpointsResponseSchema>

/**
 * MatterAI OpenRouter Models Response
 */

const matterAiOpenRouterModelSchema = z.object({
	id: z.string(),
	name: z.string().optional(),
	description: z.string().optional(),
	context_length: z.number().optional(),
	max_output_length: z.number().optional(),
	input_modalities: z.array(z.string()).optional(),
	output_modalities: z.array(z.string()).optional(),
	supported_sampling_parameters: z.array(z.string()).optional(),
	iconUrl: z.string().optional(),
	reasoning_efforts: z.array(z.string()).optional(), // forked_change
	pricing: z
		.object({
			prompt: z.string().optional(),
			completion: z.string().optional(),
			input_cache_reads: z.string().optional(),
			input_cache_writes: z.string().optional(),
		})
		.optional(),
})

const matterAiOpenRouterModelsResponseSchema = z.object({
	data: z.array(matterAiOpenRouterModelSchema),
})

type MatterAiOpenRouterModel = z.infer<typeof matterAiOpenRouterModelSchema>

/**
 * getOpenRouterModels
 */

export async function getOpenRouterModels(
	options?: ApiHandlerOptions & { headers?: Record<string, string> }, // kilocode_change: added headers
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	// First, add static models from KILO_CODE_MODELS
	const { KILO_CODE_MODELS, registerDynamicKilocodeModels } = await import("../kilocode-models")

	for (const [id, model] of Object.entries(KILO_CODE_MODELS)) {
		models[id] = parseOpenRouterModel({
			id,
			model: {
				name: model.name,
				description: model.description,
				context_length: model.context_length,
				max_completion_tokens: model.max_output_length,
				pricing: {
					prompt: model.pricing.prompt,
					completion: model.pricing.completion,
					input_cache_write: model.pricing.input_cache_writes,
					input_cache_read: model.pricing.input_cache_reads,
				},
			},
			displayName: model.name,
			inputModality: model.input_modalities,
			outputModality: model.output_modalities,
			maxTokens: model.max_output_length,
			supportedParameters: model.supported_sampling_parameters,
			iconUrl: model.iconUrl,
			reasoningEfforts: model.reasoning_efforts,
		})
	}

	// Then, fetch dynamic models from MatterAI API
	try {
		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
			...options?.headers,
		}

		const base = (options?.openRouterBaseUrl || "https://api.matterai.so/v1/web").replace(/\/+$/, "")
		let url = base.endsWith("/models") ? base : `${base}/models`
		if (headers["Cache-Control"] === "no-cache") {
			url += (url.includes("?") ? "&" : "?") + "forceRefresh=true"
		}

		const response = await axios.get(url, { headers })

		const rawModels = response.data?.data || []

		if (Array.isArray(rawModels) && rawModels.length > 0) {
			registerDynamicKilocodeModels(rawModels)
		}

		for (const rawModel of rawModels) {
			if (!rawModel?.id || rawModel.id.startsWith("axon-")) {
				continue
			}

			// Filter out image generation models (only text output)
			const outputModalities = rawModel.output_modalities || []
			if (outputModalities.includes("image") && !outputModalities.includes("text")) {
				continue
			}

			const modelId = rawModel.id

			models[modelId] = parseOpenRouterModel({
				id: modelId,
				model: {
					name: rawModel.name || rawModel.id,
					description: rawModel.description,
					context_length: rawModel.context_length || 232000,
					max_completion_tokens: rawModel.max_output_length,
					pricing: rawModel.pricing
						? {
								prompt: rawModel.pricing.prompt,
								completion: rawModel.pricing.completion,
								input_cache_read: rawModel.pricing.input_cache_reads,
								input_cache_write: rawModel.pricing.input_cache_writes,
							}
						: undefined,
				},
				displayName: rawModel.name,
				inputModality: rawModel.input_modalities,
				outputModality: rawModel.output_modalities,
				maxTokens: rawModel.max_output_length,
				supportedParameters: rawModel.supported_sampling_parameters,
				iconUrl: rawModel.iconUrl,
				reasoningEfforts: rawModel.reasoning_efforts,
			})
		}
	} catch (error) {
		console.error(
			`Error fetching OpenRouter models from MatterAI: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
	}

	return models
}

/**
 * getOpenRouterModelEndpoints
 */

export async function getOpenRouterModelEndpoints(
	modelId: string,
	options?: ApiHandlerOptions & { headers?: Record<string, string> },
): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	// First, check static models from KILO_CODE_MODELS
	const { KILO_CODE_MODELS, registerDynamicKilocodeModels } = await import("../kilocode-models")

	const staticModel = KILO_CODE_MODELS[modelId]
	if (staticModel) {
		models["MatterAI"] = parseOpenRouterModel({
			id: staticModel.id,
			model: {
				name: staticModel.name,
				description: staticModel.description,
				context_length: staticModel.context_length,
				max_completion_tokens: staticModel.max_output_length,
				pricing: {
					prompt: staticModel.pricing.prompt,
					completion: staticModel.pricing.completion,
					input_cache_write: staticModel.pricing.input_cache_writes,
					input_cache_read: staticModel.pricing.input_cache_reads,
				},
			},
			displayName: staticModel.name,
			inputModality: staticModel.input_modalities,
			outputModality: staticModel.output_modalities,
			maxTokens: staticModel.max_output_length,
			supportedParameters: staticModel.supported_sampling_parameters,
			iconUrl: staticModel.iconUrl,
			reasoningEfforts: staticModel.reasoning_efforts,
		})
		return models
	}

	// If not found in static models, fetch from MatterAI API
	try {
		const headers: Record<string, string> = {
			...DEFAULT_HEADERS,
			...options?.headers,
		}

		const base = (options?.openRouterBaseUrl || "https://api.matterai.so/v1/web").replace(/\/+$/, "")
		let url = base.endsWith("/models") ? base : `${base}/models`
		if (headers["Cache-Control"] === "no-cache") {
			url += (url.includes("?") ? "&" : "?") + "forceRefresh=true"
		}

		const response = await axios.get(url, { headers })

		const rawModels = response.data?.data || []

		if (Array.isArray(rawModels) && rawModels.length > 0) {
			registerDynamicKilocodeModels(rawModels)
		}

		// Strip "openrouter/" prefix if present for matching
		const strippedModelId = modelId.replace(/^openrouter\//, "")

		const rawModel = (rawModels as MatterAiOpenRouterModel[]).find(
			(m) => m.id === strippedModelId || m.id === modelId,
		)

		if (!rawModel) {
			return models
		}

		// Filter out image generation models
		const outputModalities = rawModel.output_modalities || []
		if (outputModalities.includes("image") && !outputModalities.includes("text")) {
			return models
		}

		models["MatterAI"] = parseOpenRouterModel({
			id: rawModel.id,
			model: {
				name: rawModel.name || rawModel.id,
				description: rawModel.description,
				context_length: rawModel.context_length || 232000,
				max_completion_tokens: rawModel.max_output_length,
				pricing: rawModel.pricing
					? {
							prompt: rawModel.pricing.prompt,
							completion: rawModel.pricing.completion,
							input_cache_read: rawModel.pricing.input_cache_reads,
							input_cache_write: rawModel.pricing.input_cache_writes,
						}
					: undefined,
			},
			displayName: rawModel.name,
			inputModality: rawModel.input_modalities,
			outputModality: rawModel.output_modalities,
			maxTokens: rawModel.max_output_length,
			supportedParameters: rawModel.supported_sampling_parameters,
			iconUrl: rawModel.iconUrl,
			reasoningEfforts: rawModel.reasoning_efforts,
		})
	} catch (error) {
		console.error(
			`Error fetching OpenRouter model endpoints from MatterAI: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
	}

	return models
}

/**
 * parseOpenRouterModel
 */

export const parseOpenRouterModel = ({
	id,
	model,
	displayName, // kilocode_change
	inputModality,
	outputModality,
	maxTokens,
	supportedParameters,
	iconUrl, // kilocode_change
	reasoningEfforts, // forked_change
}: {
	id: string
	model: OpenRouterBaseModel
	displayName?: string // kilocode_change
	inputModality: string[] | null | undefined
	outputModality: string[] | null | undefined
	maxTokens: number | null | undefined
	supportedParameters?: string[]
	iconUrl?: string // kilocode_change
	reasoningEfforts?: unknown // forked_change: catalog `reasoning_efforts`
}): ModelInfo => {
	const cacheWritesPrice = model.pricing?.input_cache_write
		? parseApiPrice(model.pricing?.input_cache_write)
		: undefined

	const cacheReadsPrice = model.pricing?.input_cache_read ? parseApiPrice(model.pricing?.input_cache_read) : undefined

	const supportsPromptCache = typeof cacheReadsPrice !== "undefined" // some models support caching but don't charge a cacheWritesPrice, e.g. GPT-5

	const modelInfo: ModelInfo = {
		maxTokens: maxTokens || Math.ceil(model.context_length * 0.2),
		contextWindow: model.context_length,
		supportsImages: inputModality?.includes("image") ?? false,
		supportsPromptCache,
		inputPrice: parseApiPrice(model.pricing?.prompt),
		outputPrice: parseApiPrice(model.pricing?.completion),
		cacheWritesPrice,
		cacheReadsPrice,
		description: model.description,
		supportsReasoningEffort: supportedParameters ? supportedParameters.includes("reasoning") : undefined,
		supportedParameters: supportedParameters ? supportedParameters.filter(isModelParameter) : undefined,
		// forked_change start
		displayName,
		preferredIndex: model.preferredIndex,
		iconUrl,
		// Absent on older backends: the selector falls back to a built-in list.
		reasoningEfforts: Array.isArray(reasoningEfforts) ? reasoningEfforts.filter(isGatewayEffort) : undefined,
		// forked_change end
	}

	// The OpenRouter model definition doesn't give us any hints about
	// computer use, so we need to set that manually.
	if (OPEN_ROUTER_COMPUTER_USE_MODELS.has(id)) {
		modelInfo.supportsComputerUse = true
	}

	if (OPEN_ROUTER_REASONING_BUDGET_MODELS.has(id)) {
		modelInfo.supportsReasoningBudget = true
	}

	if (OPEN_ROUTER_REQUIRED_REASONING_BUDGET_MODELS.has(id)) {
		modelInfo.requiredReasoningBudget = true
	}

	// For backwards compatibility with the old model definitions we will
	// continue to disable extending thinking for anthropic/claude-3.7-sonnet
	// and force it for anthropic/claude-3.7-sonnet:thinking.

	if (id === "anthropic/claude-3.7-sonnet") {
		modelInfo.maxTokens = anthropicModels["claude-3-7-sonnet-20250219"].maxTokens
		modelInfo.supportsReasoningBudget = false
		modelInfo.supportsReasoningEffort = false
	}

	if (id === "anthropic/claude-3.7-sonnet:thinking") {
		modelInfo.maxTokens = anthropicModels["claude-3-7-sonnet-20250219:thinking"].maxTokens
	}

	// Set claude-opus-4.1 model to use the correct configuration
	if (id === "anthropic/claude-opus-4.1") {
		modelInfo.maxTokens = anthropicModels["claude-opus-4-1-20250805"].maxTokens
	}

	// Ensure correct reasoning handling for Claude Haiku 4.5 on OpenRouter
	// Use budget control and disable effort-based reasoning fallback
	if (id === "anthropic/claude-haiku-4.5") {
		modelInfo.supportsReasoningBudget = true
		modelInfo.supportsReasoningEffort = false
	}

	// Set horizon-alpha model to 32k max tokens
	if (id === "openrouter/horizon-alpha") {
		modelInfo.maxTokens = 32768
	}

	// Set horizon-beta model to 32k max tokens
	if (id === "openrouter/horizon-beta") {
		modelInfo.maxTokens = 32768
	}

	return modelInfo
}
