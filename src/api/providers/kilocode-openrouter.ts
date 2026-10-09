import { ApiHandlerOptions, ModelRecord } from "../../shared/api"
import * as vscode from "vscode"
import { CompletionUsage, OpenRouterHandler, inferenceFailoverFetch } from "./openrouter"
import { getModelParams } from "../transform/model-params"
import { getModels } from "./fetchers/modelCache"
import { DEEP_SEEK_DEFAULT_TEMPERATURE, openRouterDefaultModelId, openRouterDefaultModelInfo } from "@roo-code/types"
import { getKiloBaseUriFromToken } from "@roo-code/types"
import { ApiHandlerCreateMessageMetadata } from ".."
import { getKilocodeApiModelId } from "./kilocode-models"
// import { getModelEndpoints } from "./fetchers/modelEndpointCache"
import { getKilocodeDefaultModel } from "./kilocode/getKilocodeDefaultModel"
import {
	X_KILOCODE_ORGANIZATIONID,
	X_KILOCODE_TASKID,
	X_KILOCODE_PROJECTID,
	X_KILOCODE_TESTER,
	X_AXON_REPO,
	X_MODEL_CONTEXT_WINDOW,
	X_DEVICE_OS,
	X_CLIENT_USER_AGENT,
	X_REASONING_EFFORT,
} from "../../shared/kilocode/headers"
import { resolveModelEffort } from "@roo-code/types"
import { getModelEfforts } from "./kilocode/modelEfforts"
import { Package } from "../../shared/package"

const getClientUserAgent = (): string => {
	const ideName = vscode.env?.appName?.trim()
	const ideVersion = vscode.version?.trim()
	const ideUserAgent = [ideName, ideVersion]
		.filter(Boolean)
		.join("/")
		.replace(/[^\x20-\x7E]/g, "")
	return `Axon-Code/${Package.version}${ideUserAgent ? ` (${ideUserAgent})` : ""}`
}

/**
 * A custom OpenRouter handler that overrides the getModel function
 * to provide custom model information and fetches models from the KiloCode OpenRouter endpoint.
 */
export class KilocodeOpenrouterHandler extends OpenRouterHandler {
	protected override models: ModelRecord = {}
	defaultModel: string = openRouterDefaultModelId

	protected override get providerName() {
		return "KiloCode" as const
	}

	// forked_change: route inference through the api2 → api circuit-breaker fetch
	// so a hard api2 outage (GCP VM down) fails over to api.matterai.so for 5m.
	protected override get inferenceFetch(): typeof fetch {
		return inferenceFailoverFetch
	}

	// forked_change: the MatterAI gateway takes earlier reasoning as
	// `reasoning_content`, like other OpenAI-compatible clients send it.
	protected override get replaysReasoningAsContent(): boolean {
		return true
	}

	constructor(options: ApiHandlerOptions) {
		// forked_change: inference must always hit api2.matterai.so in production.
		// getKiloUrlFromToken swaps the host to api.matterai.so (the default backend),
		// which silently bypasses api2 — so resolve the dev/prod host explicitly and
		// only borrow the localhost override for development tokens.
		const baseUri = getKiloBaseUriFromToken(options.kilocodeToken ?? "")
		const openRouterBaseUrl = baseUri.includes("localhost")
			? `${baseUri}/v1/web/`
			: "https://api2.matterai.so/v1/web/"
		options = {
			...options,
			openRouterBaseUrl,
			openRouterApiKey: options.kilocodeToken,
		}

		super(options)
	}

	override customRequestOptions(metadata?: ApiHandlerCreateMessageMetadata) {
		const { id: modelId, info } = this.getModel()
		const headers: Record<string, string> = {
			[X_MODEL_CONTEXT_WINDOW]: String(info.contextWindow),
			[X_DEVICE_OS]: process.platform,
			[X_CLIENT_USER_AGENT]: getClientUserAgent(),
		}

		// forked_change: read per request (not per task), so an effort picked in
		// any chat applies to every task's next request.
		const effort = resolveModelEffort(getModelEfforts(), modelId, info)
		if (effort) {
			headers[X_REASONING_EFFORT] = effort
		}

		if (metadata?.taskId) {
			headers[X_KILOCODE_TASKID] = metadata.taskId
		}

		const kilocodeOptions = this.options

		if (kilocodeOptions.kilocodeOrganizationId) {
			headers[X_KILOCODE_ORGANIZATIONID] = kilocodeOptions.kilocodeOrganizationId

			if (metadata?.projectId) {
				headers[X_KILOCODE_PROJECTID] = metadata.projectId
			}
		}

		// Add X-AXON-REPO header with git repository URL or root folder name
		if (metadata?.repo) {
			headers[X_AXON_REPO] = metadata.repo
		}

		// Add X-KILOCODE-TESTER: SUPPRESS header if the setting is enabled
		if (
			kilocodeOptions.kilocodeTesterWarningsDisabledUntil &&
			kilocodeOptions.kilocodeTesterWarningsDisabledUntil > Date.now()
		) {
			headers[X_KILOCODE_TESTER] = "SUPPRESS"
		}

		return { headers }
	}

	override getTotalCost(lastUsage: CompletionUsage): number {
		const model = this.getModel().info
		if (!model.inputPrice && !model.outputPrice) {
			return 0
		}
		// https://github.com/MatterAIOrg/Orbital-Extension-backend/blob/eb3d382df1e933a089eea95b9c4387db0c676e35/src/lib/processUsage.ts#L281
		if (lastUsage.is_byok) {
			return lastUsage.cost_details?.upstream_inference_cost || 0
		}

		return lastUsage.cost || 0
	}

	override getModel() {
		let selectedId = this.options.kilocodeModel ?? this.defaultModel

		// Safety net: if the selected model is not in the fetched model list,
		// fall back to the default. This handles stale config values that were
		// not yet caught by ClineProvider's validation during initialization.
		if (selectedId && !this.models[selectedId]) {
			selectedId = this.defaultModel
		}

		let info = this.models[selectedId] ?? openRouterDefaultModelInfo

		// If a specific provider is requested, use the endpoint for that provider.
		if (this.options.openRouterSpecificProvider && this.endpoints[this.options.openRouterSpecificProvider]) {
			info = this.endpoints[this.options.openRouterSpecificProvider]
		}

		// ALL Axon models accept image inputs. Force the flag so no downstream
		// gate (maybeRemoveImageBlocks, read_file, browser tool, system prompt)
		// can ever strip or skip images, even on a fallback model info.
		info = { ...info, supportsImages: true }

		const id = getKilocodeApiModelId(selectedId)

		const params = getModelParams({
			format: "openrouter",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

		return { id, info, topP: 0.95, ...params }
	}

	public override async fetchModel() {
		if (!this.options.kilocodeToken) {
			throw new Error("Your authentication token is expired, please login again")
		}

		const [models, defaultModel] = await Promise.all([
			getModels({
				provider: "kilocode-openrouter",
				kilocodeToken: this.options.kilocodeToken,
				kilocodeOrganizationId: this.options.kilocodeOrganizationId,
			}),
			getKilocodeDefaultModel(this.options.kilocodeToken, this.options.kilocodeOrganizationId, this.options),
		])

		this.models = models
		// Removed endpoints assignment as we only have 1 provider
		this.defaultModel = defaultModel
		return this.getModel()
	}
}
