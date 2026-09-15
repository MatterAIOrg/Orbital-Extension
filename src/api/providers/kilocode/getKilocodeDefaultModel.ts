import { openRouterDefaultModelId, type ProviderSettings } from "@roo-code/types"
import { getKiloUrlFromToken } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { z } from "zod"
import { fetchWithTimeout } from "./fetchWithTimeout"
import { DEFAULT_HEADERS } from "../constants"

type KilocodeToken = string

type OrganizationId = string

const cache = new Map<string, { promise: Promise<string>; expiresAt: number }>()

// The default follows the account plan, so a cached value must expire: a plan
// change (or a catalog edit) has to be picked up without an extension reload.
const CACHE_TTL_MS = 10 * 60 * 1000

const catalogSchema = z.object({
	data: z.array(
		z.object({
			id: z.string(),
			freePlan: z.boolean().nullish(),
		}),
	),
})

const profileSchema = z.object({
	plan: z.string().nullish(),
	tieredUsage: z.object({ plan: z.string().nullish() }).nullish(),
})

const fetcher = fetchWithTimeout(5000)

const CATALOG_URL = "https://api.matterai.so/v1/web/models"
const PROFILE_URL = "https://api.matterai.so/axoncode/profile"

/** Whether an AxonCode plan string is the free tier (a missing plan counts as free). */
function isFreePlan(plan?: string | null): boolean {
	const normalized = plan?.trim().toLowerCase() ?? ""
	return normalized === "" || normalized === "free"
}

/**
 * Resolves the default model from the live MatterAI catalog: free accounts get
 * the entry the backend flags `freePlan`, every other plan gets the first entry
 * the backend serves (index 0, ordered by the catalog's `sortOrder`).
 */
async function fetchCatalogDefaultModel(
	kilocodeToken: KilocodeToken,
	providerSettings?: ProviderSettings,
): Promise<string> {
	const headers: Record<string, string> = {
		...DEFAULT_HEADERS,
		Authorization: `Bearer ${kilocodeToken}`,
	}

	// Add X-KILOCODE-TESTER: SUPPRESS header if the setting is enabled
	if (
		providerSettings?.kilocodeTesterWarningsDisabledUntil &&
		providerSettings.kilocodeTesterWarningsDisabledUntil > Date.now()
	) {
		headers["X-KILOCODE-TESTER"] = "SUPPRESS"
	}

	const [catalogResponse, profileResponse] = await Promise.all([
		fetcher(getKiloUrlFromToken(CATALOG_URL, kilocodeToken), { headers }),
		fetcher(getKiloUrlFromToken(PROFILE_URL, kilocodeToken), { headers }),
	])

	if (!catalogResponse.ok) {
		throw new Error(`Fetching model catalog from ${CATALOG_URL} failed: ${catalogResponse.status}`)
	}

	const catalog = await catalogSchema.parseAsync(await catalogResponse.json())
	const models = catalog.data.filter((model) => !model.id.startsWith("axon-"))
	if (models.length === 0) {
		throw new Error(`Model catalog from ${CATALOG_URL} was empty`)
	}

	// A failed profile fetch must not block the default: an unknown plan is
	// treated as free, which still resolves to a usable catalog entry.
	const plan = profileResponse.ok
		? ((await profileSchema.parseAsync(await profileResponse.json())).plan ?? undefined)
		: undefined

	if (isFreePlan(plan)) {
		const freeModel = models.find((model) => model.freePlan === true)
		if (freeModel) {
			console.info(`Default model for the free plan: ${freeModel.id}`)
			return freeModel.id
		}
	}

	console.info(`Default model from ${CATALOG_URL}: ${models[0]!.id}`)
	return models[0]!.id
}

async function fetchKilocodeDefaultModel(
	kilocodeToken: KilocodeToken,
	_organizationId?: OrganizationId,
	providerSettings?: ProviderSettings,
): Promise<string> {
	try {
		return await fetchCatalogDefaultModel(kilocodeToken, providerSettings)
	} catch (err) {
		console.error("Failed to get default model", err)
		TelemetryService.instance.captureException(err, { context: "getKilocodeDefaultModel" })
		return openRouterDefaultModelId
	}
}

export async function getKilocodeDefaultModel(
	kilocodeToken?: KilocodeToken,
	organizationId?: OrganizationId,
	providerSettings?: ProviderSettings,
): Promise<string> {
	if (!kilocodeToken) {
		return openRouterDefaultModelId
	}
	const key = JSON.stringify({
		kilocodeToken,
		organizationId,
		testerSuppressed: providerSettings?.kilocodeTesterWarningsDisabledUntil,
	})
	let defaultModelPromise = cache.get(key)
	if (!defaultModelPromise || defaultModelPromise.expiresAt <= Date.now()) {
		defaultModelPromise = {
			promise: fetchKilocodeDefaultModel(kilocodeToken, organizationId, providerSettings),
			expiresAt: Date.now() + CACHE_TTL_MS,
		}
		cache.set(key, defaultModelPromise)
	}
	return await defaultModelPromise.promise
}
