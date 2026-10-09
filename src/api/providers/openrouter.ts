import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import * as undici from "undici"

import { getActiveToolUseStyle, openRouterDefaultModelId, openRouterDefaultModelInfo } from "@roo-code/types"

import type { ApiHandlerOptions, ModelRecord } from "../../shared/api"

import { getModelParams } from "../transform/model-params"
import { convertToOpenAiMessages, replayReasoningAsContent } from "../transform/openai-format"
import type { OpenRouterReasoningParams } from "../transform/reasoning"
import { ApiStreamChunk } from "../transform/stream"

import { getModels } from "./fetchers/modelCache"
import { getModelEndpoints } from "./fetchers/modelEndpointCache"

import type {
	ApiHandlerCreateMessageMetadata, // kilocode_change
	SingleCompletionHandler,
} from "../index"
import { BaseProvider } from "./base-provider"
import { DEFAULT_HEADERS } from "./constants"
import { addNativeToolCallsToParams, processNativeToolCallsFromDelta } from "./kilocode/nativeToolCallHelpers"
import { verifyFinishReason } from "./kilocode/verifyFinishReason"

// forked_change start
type OpenRouterProviderParams = {
	order?: string[]
	only?: string[]
	allow_fallbacks?: boolean
	data_collection?: "allow" | "deny"
	sort?: "price" | "throughput" | "latency"
	zdr?: boolean
}

import { isAnyRecognizedKiloCodeError } from "../../shared/kilocode/errorUtils"
import { safeJsonParse } from "../../shared/safeJsonParse"
// forked_change end

import { handleOpenAIError } from "./utils/openai-error-handler"

// kilocode_change: Happy Eyeballs (RFC 8305) — race IPv4/IPv6 on connect so a
// broken address-family path (e.g. a carrier DNS64-synthesized IPv6 that
// doesn't actually route on a mobile hotspot) falls back to the other family
// instead of hanging. undici has no Happy Eyeballs by default, unlike curl.
const happyEyeballsAgent = new undici.Agent({
	connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 },
})
const happyEyeballsFetch: typeof fetch = (input, init) =>
	undici.fetch(input as undici.RequestInfo, {
		...(init as undici.RequestInit),
		dispatcher: happyEyeballsAgent,
	}) as unknown as Promise<Response>

// inference failover circuit breaker.
// Primary inference host is api2.matterai.so. If the GCP VM is completely down
// (connection-level failure — NOT an HTTP error from a responding server), trip
// the breaker and route to the fallback host api.matterai.so for a 5-minute
// cooldown. After the cooldown a half-open probe retries api2: on success the
// breaker closes, on connection failure it reopens for another cooldown.
// HTTP 4xx/5xx responses from a live server never trip the breaker — only fetch
// rejections (TypeError) do, since those mean the host was unreachable.
const INFERENCE_PRIMARY_HOST = "api2.matterai.so"
const INFERENCE_FALLBACK_HOST = "api.matterai.so"
const INFERENCE_CB_COOLDOWN_MS = 5 * 60 * 1000

let inferenceCircuitOpen = false
let inferenceCircuitOpenedAt = 0

function isInferenceConnectionFailure(err: unknown): boolean {
	// undici/Node fetch rejects with a TypeError ("fetch failed") for network-level
	// errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, connect timeout, socket hang up).
	// HTTP error responses resolve as a Response and are thrown later by the SDK as
	// APIError, so they never reach this path and never trip the breaker.
	return err instanceof TypeError
}

/**
 * fetch wrapper that failovers inference traffic from api2.matterai.so to
 * api.matterai.so when the primary host is unreachable. Only the primary host
 * is rewritten; any other host (e.g. a user-configured custom base URL) passes
 * through untouched.
 */
export const inferenceFailoverFetch: typeof fetch = async (input, init) => {
	const raw = typeof input === "string" ? input : ((input as any).url ?? (input as any).href ?? String(input))
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return happyEyeballsFetch(input, init)
	}

	const isPrimary = url.hostname === INFERENCE_PRIMARY_HOST

	// Breaker open and still in cooldown → skip the primary host entirely.
	if (isPrimary && inferenceCircuitOpen && Date.now() - inferenceCircuitOpenedAt < INFERENCE_CB_COOLDOWN_MS) {
		url.hostname = INFERENCE_FALLBACK_HOST
		return happyEyeballsFetch(url.toString(), init)
	}

	try {
		const response = await happyEyeballsFetch(url.toString(), init)
		// Got an HTTP response → host is up. A successful half-open probe closes the breaker.
		if (isPrimary && inferenceCircuitOpen) {
			inferenceCircuitOpen = false
			inferenceCircuitOpenedAt = 0
			console.warn("[inference-failover] api2 probe succeeded → circuit closed")
		}
		return response
	} catch (err) {
		if (isPrimary && isInferenceConnectionFailure(err)) {
			// Primary VM unreachable → trip the breaker and fail this request over to the fallback host.
			const reopened = inferenceCircuitOpen
			inferenceCircuitOpen = true
			inferenceCircuitOpenedAt = Date.now()
			console.warn(
				reopened
					? "[inference-failover] api2 probe failed → circuit reopened for 5m"
					: "[inference-failover] api2 connection failure → circuit open, failing over to api.matterai.so for 5m",
			)
			url.hostname = INFERENCE_FALLBACK_HOST
			return happyEyeballsFetch(url.toString(), init)
		}
		throw err
	}
}

/** @internal test-only: force the circuit breaker state. */
export function __setInferenceCircuitBreaker(open: boolean, openedAt = 0): void {
	inferenceCircuitOpen = open
	inferenceCircuitOpenedAt = openedAt
}
// forked_change end

function stripThinkingTokens(text: string): string {
	// Remove <think>...</think> blocks entirely, including nested ones
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

function flattenMessageContent(content: any): string {
	if (typeof content === "string") {
		return content
	}

	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") {
					return part
				}
				if (part.type === "text") {
					return part.text || ""
				}
				if (part.type === "image_url") {
					return "[Image]" // Placeholder for images since Cerebras doesn't support images
				}
				return ""
			})
			.filter(Boolean)
			.join("\n")
	}

	// Fallback for any other content types
	return String(content || "")
}

// Image generation types
interface ImageGenerationResponse {
	choices?: Array<{
		message?: {
			content?: string
			images?: Array<{
				type?: string
				image_url?: {
					url?: string
				}
			}>
		}
	}>
	error?: {
		message?: string
		type?: string
		code?: string
	}
}

export interface ImageGenerationResult {
	success: boolean
	imageData?: string
	imageFormat?: string
	error?: string
}

// Add custom interface for OpenRouter params.
type OpenRouterChatCompletionParams = OpenAI.Chat.ChatCompletionCreateParams & {
	transforms?: string[]
	include_reasoning?: boolean
	// https://openrouter.ai/docs/use-cases/reasoning-tokens
	reasoning?: OpenRouterReasoningParams
	provider?: OpenRouterProviderParams // kilocode_change
}

export // kilocode_change
interface CompletionUsage {
	completion_tokens?: number
	completion_tokens_details?: {
		reasoning_tokens?: number
	}
	prompt_tokens?: number
	prompt_tokens_details?: {
		cached_tokens?: number
	}
	total_tokens?: number
	cost?: number
	is_byok?: boolean // kilocode_change
	cost_details?: {
		upstream_inference_cost?: number
	}
}

export class OpenRouterHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI
	protected models: ModelRecord = {}
	protected endpoints: ModelRecord = {}

	// forked_change start property
	protected get providerName(): "OpenRouter" | "KiloCode" {
		return "OpenRouter" as const
	}

	// forked_change: subclasses can override the fetch used by the OpenAI client
	// to inject inference failover (circuit breaker). Default keeps Happy Eyeballs.
	protected get inferenceFetch(): typeof fetch {
		return happyEyeballsFetch
	}
	// forked_change end

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		const baseURL = this.options.openRouterBaseUrl || "https://api2.matterai.so/v1/web"
		const apiKey = this.options.openRouterApiKey ?? "not-provided"

		this.client = new OpenAI({
			baseURL,
			apiKey,
			defaultHeaders: DEFAULT_HEADERS,
			// kilocode_change: route through the Happy Eyeballs agent so connect
			// falls back across address families instead of sticking on the first.
			// Subclasses may override `inferenceFetch` to add failover (circuit breaker).
			fetch: this.inferenceFetch,
		})
	}

	// forked_change start
	/** Whether stored reasoning is replayed as `reasoning_content` (see replayReasoningAsContent). */
	protected get replaysReasoningAsContent(): boolean {
		return false
	}

	customRequestOptions(metadata?: ApiHandlerCreateMessageMetadata): { headers: Record<string, string> } | undefined {
		const headers: Record<string, string> = {}

		if (metadata?.taskId) {
			headers["X-AXON-TASK-ID"] = metadata.taskId
		}

		return Object.keys(headers).length > 0 ? { headers } : undefined
	}

	getCustomRequestHeaders(taskId?: string) {
		return (taskId ? this.customRequestOptions({ taskId })?.headers : undefined) ?? {}
	}

	getTotalCost(lastUsage: CompletionUsage): number {
		return (lastUsage.cost_details?.upstream_inference_cost || 0) + (lastUsage.cost || 0)
	}

	getProviderParams(): { provider?: OpenRouterProviderParams } {
		if (this.options.openRouterSpecificProvider && this.endpoints[this.options.openRouterSpecificProvider]) {
			return {
				provider: {
					order: [this.options.openRouterSpecificProvider],
					only: [this.options.openRouterSpecificProvider],
					allow_fallbacks: false,
					data_collection: this.options.openRouterProviderDataCollection,
					zdr: this.options.openRouterZdr,
				},
			}
		}
		if (
			this.options.openRouterProviderDataCollection ||
			this.options.openRouterProviderSort ||
			this.options.openRouterZdr
		) {
			return {
				provider: {
					data_collection: this.options.openRouterProviderDataCollection,
					sort: this.options.openRouterProviderSort,
					zdr: this.options.openRouterZdr,
				},
			}
		}
		return {}
	}
	// forked_change end

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): AsyncGenerator<ApiStreamChunk> {
		const model = await this.fetchModel()

		const systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			content: systemPrompt,
		}
		let { id: modelId, maxTokens, temperature, topP, reasoning } = model
		const openAiMessages = convertToOpenAiMessages(messages)
		const convertedMessages = [
			systemMessage,
			...(this.replaysReasoningAsContent ? replayReasoningAsContent(openAiMessages) : openAiMessages),
		]

		const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model: modelId,
			temperature: 0.1,
			messages: convertedMessages,
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: model.maxTokens,
		}

		addNativeToolCallsToParams(requestOptions, this.options, metadata)

		let stream
		try {
			stream = await this.client.chat.completions.create(requestOptions, this.customRequestOptions(metadata))
		} catch (error) {
			if (this.providerName == "KiloCode" && isAnyRecognizedKiloCodeError(error)) {
				throw error
			}
			const err = new Error(makeOpenRouterErrorReadable(error)) as any
			err.status = error?.status || error?.code
			throw err
		}

		let lastUsage: CompletionUsage | undefined = undefined
		let inferenceProvider: string | undefined // kilocode_change

		try {
			let fullContent = ""

			let isThinking = false
			// let lastChunkTime = Date.now()

			for await (const chunk of stream) {
				// OpenRouter returns an error object instead of the OpenAI SDK throwing an error.
				if ("error" in chunk) {
					const error = chunk.error as { message?: string; code?: number }
					console.error(`OpenRouter API Error: ${error?.code} - ${error?.message}`)
					const err = new Error(`OpenRouter API Error ${error?.code}: ${error?.message}`) as any
					err.status = error?.code
					throw err
				}

				// forked_change start
				if ("provider" in chunk && typeof chunk.provider === "string") {
					inferenceProvider = chunk.provider
				}
				// forked_change end

				// Handle usage data which can be present even when choices is empty
				if (chunk.usage) {
					lastUsage = chunk.usage
				}

				// Get delta from choices, but handle case where choices might be empty
				const delta = chunk.choices[0]?.delta

				// const now = Date.now()
				// const msSinceLast = now - lastChunkTime
				// lastChunkTime = now
				// console.log(`[${new Date(now).toISOString()}] [+${msSinceLast}ms]`, delta)

				// Add defensive check for delta being undefined (e.g., final chunk with only usage data)
				if (!delta) {
					// forked_change: a delta-less heartbeat still proves the socket is alive, so
					// emit a keepalive to keep the stream idle timeout from firing. Skip it for a
					// final usage-only chunk — that's the end of the stream, not a quiet period.
					if (!chunk.usage) {
						yield { type: "keepalive" }
					}
					// Skip delta processing but continue to allow usage processing at the end of the loop
					continue
				}

				verifyFinishReason(chunk.choices[0]) // kilocode_change

				// forked_change: does this delta carry any user-visible payload? A heartbeat
				// delta (no content/reasoning/tool call) still keeps the socket alive, so we
				// emit a keepalive for it below to reset the stream idle timeout.
				const hasStreamPayload =
					Boolean(delta.content) ||
					("reasoning" in delta && Boolean((delta as { reasoning?: unknown }).reasoning)) ||
					("reasoning_content" in delta &&
						Boolean((delta as { reasoning_content?: unknown }).reasoning_content)) ||
					Boolean((delta as { tool_calls?: unknown }).tool_calls)

				// if (
				// 	delta /* kilocode_change */ &&
				// 	"reasoning" in delta &&
				// 	delta.reasoning &&
				// 	typeof delta.reasoning === "string"
				// ) {
				// 	yield { type: "reasoning", text: delta.reasoning }
				// }

				if (delta.content) {
					let newText = delta.content
					if (fullContent && newText.startsWith(fullContent)) {
						newText = newText.substring(fullContent.length)
					}
					fullContent = delta.content

					if (newText) {
						if (newText.includes("<think>")) {
							isThinking = true
						}
						// Check for thinking blocks
						if (newText.includes("<think>") || newText.includes("</think>") || isThinking) {
							if (newText.includes("</think>")) {
								isThinking = false
							}

							yield {
								type: "reasoning",
								text: newText,
							}
						} else {
							yield {
								type: "text",
								text: newText,
							}
						}
					}
				}

				// forked_change start: Handle reasoning from API (both 'reasoning' and 'reasoning_content' keys)
				// Some models send 'reasoning', others send 'reasoning_content'
				if ("reasoning" in delta && delta.reasoning) {
					const reasoningText = (delta.reasoning as string | undefined) || ""
					yield {
						type: "reasoning",
						text: reasoningText,
					}
				}

				if ("reasoning_content" in delta && delta.reasoning_content) {
					const reasoningText = (delta.reasoning_content as string | undefined) || ""
					yield {
						type: "reasoning",
						text: reasoningText,
					}
				}
				// forked_change end

				// Handle native tool calls when toolStyle is "json"
				yield* processNativeToolCallsFromDelta(delta, getActiveToolUseStyle(this.options))
				// forked_change end

				// forked_change: heartbeat/empty delta carried no payload — emit a keepalive so
				// the stream idle timeout treats the quiet-but-live connection as alive. A usage
				// chunk is the end of the stream, not a quiet period, so skip it.
				if (!hasStreamPayload && !chunk.usage) {
					yield { type: "keepalive" }
				}

				// if (delta?.content) {
				// 	yield { type: "text", text: delta.content }
				// }
			}

			// kilocode_change: logs removed
		} catch (error) {
			console.error("OpenRouter API Error:", error)
			let errorMessage = makeOpenRouterErrorReadable(error)
			const err = new Error(errorMessage) as any
			err.status = error?.status || error?.code
			throw err
		}

		if (lastUsage) {
			yield {
				type: "usage",
				inputTokens: lastUsage.prompt_tokens || 0,
				outputTokens: lastUsage.completion_tokens || 0,
				cacheReadTokens: lastUsage.prompt_tokens_details?.cached_tokens,
				reasoningTokens: lastUsage.completion_tokens_details?.reasoning_tokens,
				// forked_change start
				totalCost: this.getTotalCost(lastUsage),
				inferenceProvider,
				// forked_change end
			}
		}
	}

	public async fetchModel() {
		const [models, endpoints] = await Promise.all([
			getModels({ provider: "openrouter" }),
			getModelEndpoints({
				router: "openrouter",
				modelId: this.options.openRouterModelId,
				endpoint: this.options.openRouterSpecificProvider,
			}),
		])

		this.models = models
		this.endpoints = endpoints

		return this.getModel()
	}

	override getModel() {
		const id = this.options.openRouterModelId ?? openRouterDefaultModelId
		let info = this.models[id] ?? openRouterDefaultModelInfo

		// If a specific provider is requested, use the endpoint for that provider.
		if (this.options.openRouterSpecificProvider && this.endpoints[this.options.openRouterSpecificProvider]) {
			info = this.endpoints[this.options.openRouterSpecificProvider]
		}

		const params = getModelParams({
			format: "openrouter",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0.1,
		})

		return { id, info, topP: 0.95, ...params }
	}

	async completePrompt(prompt: string) {
		let { id: modelId, maxTokens, temperature, reasoning } = await this.fetchModel()

		const completionParams: OpenRouterChatCompletionParams = {
			model: modelId,
			max_tokens: maxTokens,
			temperature: 1,
			messages: [{ role: "user", content: prompt }],
			stream: false,
			...this.getProviderParams(), // kilocode_change: original expression was moved into function
			...(reasoning && { reasoning }),
		}

		let response
		try {
			response = await this.client.chat.completions.create(
				completionParams,
				this.customRequestOptions(), // kilocode_change
			)
		} catch (error) {
			throw handleOpenAIError(error, this.providerName)
		}

		if ("error" in response) {
			const error = response.error as { message?: string; code?: number }
			const err = new Error(`MatterAI API Error ${error?.code}: ${error?.message}`) as any
			err.status = error?.code
			throw err
		}

		const completion = response as OpenAI.Chat.ChatCompletion
		return completion.choices[0]?.message?.content || ""
	}

	/**
	 * Generate an image using OpenRouter's image generation API
	 * @param prompt The text prompt for image generation
	 * @param model The model to use for generation
	 * @param apiKey The OpenRouter API key (must be explicitly provided)
	 * @param inputImage Optional base64 encoded input image data URL
	 * @returns The generated image data and format, or an error
	 */
	async generateImage(
		prompt: string,
		model: string,
		apiKey: string,
		inputImage?: string,
		taskId?: string, // kilocode_change
	): Promise<ImageGenerationResult> {
		if (!apiKey) {
			return {
				success: false,
				error: "MatterAI API key is required for image generation",
			}
		}

		try {
			const response = await fetch(
				`${this.options.openRouterBaseUrl || "https://api.matterai.so/v1/web"}chat/completions`, // kilocode_change: support baseUrl
				{
					method: "POST",
					headers: {
						// forked_change start
						...DEFAULT_HEADERS,
						...this.getCustomRequestHeaders(taskId),
						// forked_change end
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model,
						messages: [
							{
								role: "user",
								content: inputImage
									? [
											{
												type: "text",
												text: prompt,
											},
											{
												type: "image_url",
												image_url: {
													url: inputImage,
												},
											},
										]
									: prompt,
							},
						],
						modalities: ["image", "text"],
					}),
				},
			)

			if (!response.ok) {
				const errorText = await response.text()
				let errorMessage = `Failed to generate image: ${response.status} ${response.statusText}`
				try {
					const errorJson = JSON.parse(errorText)
					if (errorJson.error?.message) {
						errorMessage = `Failed to generate image: ${errorJson.error.message}`
					}
				} catch {
					// Use default error message
				}
				return {
					success: false,
					error: errorMessage,
				}
			}

			const result: ImageGenerationResponse = await response.json()

			if (result.error) {
				return {
					success: false,
					error: `Failed to generate image: ${result.error.message}`,
				}
			}

			// Extract the generated image from the response
			const images = result.choices?.[0]?.message?.images
			if (!images || images.length === 0) {
				return {
					success: false,
					error: "No image was generated in the response",
				}
			}

			const imageData = images[0]?.image_url?.url
			if (!imageData) {
				return {
					success: false,
					error: "Invalid image data in response",
				}
			}

			// Extract base64 data from data URL
			const base64Match = imageData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
			if (!base64Match) {
				return {
					success: false,
					error: "Invalid image format received",
				}
			}

			return {
				success: true,
				imageData: imageData,
				imageFormat: base64Match[1],
			}
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error occurred",
			}
		}
	}
}

// forked_change start
function makeOpenRouterErrorReadable(error: any) {
	try {
		const metadata = error?.error?.metadata as { raw?: string; provider_name?: string } | undefined
		const parsedJson = safeJsonParse(metadata?.raw)
		const rawError = parsedJson as { error?: string & { message?: string }; detail?: string } | undefined

		if (error?.code !== 429 && error?.code !== 418) {
			// Safely extract error message, handling cases where rawError?.error might be an object
			let errorMessage: string | undefined

			if (rawError?.error?.message) {
				errorMessage = rawError.error.message
			} else if (typeof rawError?.error === "string") {
				errorMessage = rawError.error
			} else if (rawError?.detail) {
				errorMessage = rawError.detail
			} else if (error?.message) {
				errorMessage = error.message
			} else {
				// Handle case where error.error might be an object with undefined properties
				try {
					// If rawError?.error is an object, we need to safely stringify it
					if (rawError?.error && typeof rawError.error === "object") {
						errorMessage =
							JSON.stringify(rawError.error, (key, value) => {
								// Replace undefined values with a placeholder to avoid serialization issues
								return value === undefined ? "[undefined]" : value
							}) || "unknown error"
					} else {
						errorMessage = JSON.stringify(rawError?.error) || "unknown error"
					}
				} catch (e) {
					console.debug("Error stringifying rawError?.error:", e)
					errorMessage = "unknown error"
				}
			}

			// Ensure errorMessage is a string and doesn't contain problematic content
			if (typeof errorMessage !== "string") {
				try {
					errorMessage = JSON.stringify(errorMessage) || "unknown error"
				} catch (e) {
					errorMessage = "unknown error"
				}
			}

			const providerName = metadata?.provider_name ?? "Provider"

			// Ensure providerName is a string
			const safeProviderName = typeof providerName === "string" ? providerName : "Provider"

			return `${safeProviderName} error: ${errorMessage}`
		}

		try {
			const parsedJson = JSON.parse(error.error.metadata?.raw)
			const retryAfter = parsedJson?.error?.details
				?.map((detail: any) => detail.retryDelay)
				.filter((r: any) => r)[0]
			if (retryAfter) {
				return `Rate limit exceeded, try again in ${retryAfter}.`
			}
		} catch (e) {
			console.debug("Error parsing rate limit info:", e)
		}

		const fallbackMessage = error?.message || error
		return `Rate limit exceeded, try again later.\n${typeof fallbackMessage === "string" ? fallbackMessage : "Unknown error"}`
	} catch (e) {
		// If anything goes wrong in our error handling, return a safe default
		console.error("Error in makeOpenRouterErrorReadable:", e)
		return "Provider error: An unexpected error occurred while processing the API response"
	}
}
// forked_change end
