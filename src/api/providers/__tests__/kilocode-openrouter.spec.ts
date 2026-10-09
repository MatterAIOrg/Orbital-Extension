// kilocode_change - new file
// npx vitest run src/api/providers/__tests__/kilocode-openrouter.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	env: { appName: "Visual Studio Code" },
	version: "1.100.0",
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { KilocodeOpenrouterHandler } from "../kilocode-openrouter"
import { ApiHandlerOptions } from "../../../shared/api"
import {
	X_KILOCODE_TASKID,
	X_KILOCODE_ORGANIZATIONID,
	X_KILOCODE_PROJECTID,
	X_AXON_REPO,
	X_MODEL_CONTEXT_WINDOW,
	X_DEVICE_OS,
	X_CLIENT_USER_AGENT,
	X_REASONING_EFFORT,
} from "../../../shared/kilocode/headers"
import { Package } from "../../../shared/package"
import type { GatewayEffort } from "@roo-code/types"
import { setModelEffortsSource } from "../kilocode/modelEfforts"

const clientMetadataHeaders = {
	[X_MODEL_CONTEXT_WINDOW]: "232000",
	[X_DEVICE_OS]: process.platform,
	[X_CLIENT_USER_AGENT]: `Axon-Code/${Package.version} (Visual Studio Code/1.100.0)`,
}

// Mock dependencies
vitest.mock("openai")
vitest.mock("delay", () => ({ default: vitest.fn(() => Promise.resolve()) }))
vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockResolvedValue({
		"zai/glm-5.3": {
			maxTokens: 64000,
			contextWindow: 232000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 0,
			outputPrice: 0,
			description: "GLM 5.3",
		},
		"zai/glm-5.3-flash": {
			maxTokens: 64000,
			contextWindow: 232000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 0,
			outputPrice: 0,
			description: "GLM 5.3 Flash",
		},
		"anthropic/claude-sonnet-4": {
			maxTokens: 8192,
			contextWindow: 200000,
			supportsImages: true,
			supportsPromptCache: true,
			inputPrice: 3,
			outputPrice: 15,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
			description: "Claude 3.7 Sonnet",
		},
	}),
}))
vitest.mock("../fetchers/modelEndpointCache", () => ({
	getModelEndpoints: vitest.fn().mockResolvedValue({}),
}))
vitest.mock("../kilocode/getKilocodeDefaultModel", () => ({
	getKilocodeDefaultModel: vitest.fn().mockResolvedValue("zai/glm-5.3-flash"),
}))

describe("KilocodeOpenrouterHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		kilocodeToken: "test-token",
		kilocodeModel: "zai/glm-5.3-flash",
	}

	beforeEach(() => vitest.clearAllMocks())

	describe("customRequestOptions", () => {
		it("reports the selected model context window", async () => {
			const handler = new KilocodeOpenrouterHandler({
				kilocodeToken: "test-token",
				kilocodeModel: "zai/glm-5.3",
			})
			await handler.fetchModel()

			expect(handler.customRequestOptions()?.headers[X_MODEL_CONTEXT_WINDOW]).toBe("232000")
		})

		it("includes taskId header when provided in metadata", () => {
			const handler = new KilocodeOpenrouterHandler(mockOptions)
			const result = handler.customRequestOptions({ taskId: "test-task-id", mode: "code" })

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
				},
			})
		})

		it("includes organizationId header when configured", () => {
			const handler = new KilocodeOpenrouterHandler({
				...mockOptions,
				kilocodeOrganizationId: "test-org-id",
			})
			const result = handler.customRequestOptions({ taskId: "test-task-id", mode: "code" })

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
					[X_KILOCODE_ORGANIZATIONID]: "test-org-id",
				},
			})
		})

		it("includes projectId header when provided in metadata with organizationId", () => {
			const handler = new KilocodeOpenrouterHandler({
				...mockOptions,
				kilocodeOrganizationId: "test-org-id",
			})
			const result = handler.customRequestOptions({
				taskId: "test-task-id",
				mode: "code",
				projectId: "https://github.com/user/repo.git",
			})

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
					[X_KILOCODE_ORGANIZATIONID]: "test-org-id",
					[X_KILOCODE_PROJECTID]: "https://github.com/user/repo.git",
				},
			})
		})

		it("includes all headers when all metadata is provided", () => {
			const handler = new KilocodeOpenrouterHandler({
				...mockOptions,
				kilocodeOrganizationId: "test-org-id",
			})
			const result = handler.customRequestOptions({
				taskId: "test-task-id",
				mode: "code",
				projectId: "https://github.com/user/repo.git",
			})

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
					[X_KILOCODE_PROJECTID]: "https://github.com/user/repo.git",
					[X_KILOCODE_ORGANIZATIONID]: "test-org-id",
				},
			})
		})

		it("omits projectId header when not provided in metadata", () => {
			const handler = new KilocodeOpenrouterHandler({
				...mockOptions,
				kilocodeOrganizationId: "test-org-id",
			})
			const result = handler.customRequestOptions({ taskId: "test-task-id", mode: "code" })

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
					[X_KILOCODE_ORGANIZATIONID]: "test-org-id",
				},
			})
			expect(result?.headers).not.toHaveProperty(X_KILOCODE_PROJECTID)
		})

		it("omits projectId header when no organizationId is configured", () => {
			const handler = new KilocodeOpenrouterHandler(mockOptions)
			const result = handler.customRequestOptions({
				taskId: "test-task-id",
				mode: "code",
				projectId: "https://github.com/user/repo.git",
			})

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
				},
			})
			expect(result?.headers).not.toHaveProperty(X_KILOCODE_PROJECTID)
		})

		it("includes client metadata when no request metadata is provided", () => {
			const handler = new KilocodeOpenrouterHandler(mockOptions)
			const result = handler.customRequestOptions()

			expect(result).toEqual({ headers: clientMetadataHeaders })
		})

		it("includes repo header when provided in metadata", () => {
			const handler = new KilocodeOpenrouterHandler(mockOptions)
			const result = handler.customRequestOptions({
				taskId: "test-task-id",
				mode: "code",
				repo: "https://github.com/user/repo.git",
			})

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
					[X_AXON_REPO]: "https://github.com/user/repo.git",
				},
			})
		})

		it("includes repo header with folder name when not a git repository", () => {
			const handler = new KilocodeOpenrouterHandler(mockOptions)
			const result = handler.customRequestOptions({
				taskId: "test-task-id",
				mode: "code",
				repo: "my-project-folder",
			})

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
					[X_AXON_REPO]: "my-project-folder",
				},
			})
		})

		it("includes all headers including repo when all metadata is provided", () => {
			const handler = new KilocodeOpenrouterHandler({
				...mockOptions,
				kilocodeOrganizationId: "test-org-id",
			})
			const result = handler.customRequestOptions({
				taskId: "test-task-id",
				mode: "code",
				projectId: "https://github.com/user/repo.git",
				repo: "https://github.com/user/repo.git",
			})

			expect(result).toEqual({
				headers: {
					...clientMetadataHeaders,
					[X_KILOCODE_TASKID]: "test-task-id",
					[X_KILOCODE_ORGANIZATIONID]: "test-org-id",
					[X_KILOCODE_PROJECTID]: "https://github.com/user/repo.git",
					[X_AXON_REPO]: "https://github.com/user/repo.git",
				},
			})
		})
	})

	describe("createMessage", () => {
		it("sends the selected OSS model ID to the API", async () => {
			const handler = new KilocodeOpenrouterHandler({
				kilocodeToken: "test-token",
				kilocodeModel: "zai/glm-5.3",
			})

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: { content: "test response" } }],
					}
				},
			}
			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test system prompt", [
				{ role: "user" as const, content: "test message" },
			])
			await generator.next()

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "zai/glm-5.3" }), {
				// GLM 5.3 has an effort selector; with no pick it runs at medium.
				headers: { ...clientMetadataHeaders, [X_REASONING_EFFORT]: "medium" },
			})
		})

		it("sends the effort picked for the model on every request", async () => {
			const handler = new KilocodeOpenrouterHandler({
				kilocodeToken: "test-token",
				kilocodeModel: "zai/glm-5.3",
			})
			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { id: "test-id", choices: [{ delta: { content: "ok" } }] }
				},
			}
			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = { completions: { create: mockCreate } } as any

			let efforts: Record<string, GatewayEffort> = { "zai/glm-5.3": "max" }
			setModelEffortsSource(() => efforts)
			try {
				await handler.createMessage("system", [{ role: "user" as const, content: "hi" }]).next()
				// A pick made in another chat applies to the next request.
				efforts = { "zai/glm-5.3": "low" }
				await handler.createMessage("system", [{ role: "user" as const, content: "hi" }]).next()
			} finally {
				setModelEffortsSource(() => undefined)
			}

			expect(mockCreate.mock.calls[0][1].headers[X_REASONING_EFFORT]).toBe("max")
			expect(mockCreate.mock.calls[1][1].headers[X_REASONING_EFFORT]).toBe("low")
		})

		it("replays stored reasoning as reasoning_content", async () => {
			const handler = new KilocodeOpenrouterHandler({
				kilocodeToken: "test-token",
				kilocodeModel: "zai/glm-5.3",
			})
			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { id: "test-id", choices: [{ delta: { content: "ok" } }] }
				},
			}
			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = { completions: { create: mockCreate } } as any

			await handler
				.createMessage("system", [
					{ role: "user" as const, content: "hi" },
					{ role: "assistant" as const, content: "hello", reasoning: "thinking it over" } as any,
					{ role: "user" as const, content: "again" },
				])
				.next()

			const assistant = mockCreate.mock.calls[0][0].messages.find((m: any) => m.role === "assistant")
			expect(assistant.reasoning_content).toBe("thinking it over")
			expect(assistant.reasoning).toBeUndefined()
		})

		it("passes custom headers to OpenAI client", async () => {
			const handler = new KilocodeOpenrouterHandler({
				...mockOptions,
				kilocodeOrganizationId: "test-org-id",
			})

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: { content: "test response" } }],
					}
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]
			const metadata = {
				taskId: "test-task-id",
				mode: "code",
				projectId: "https://github.com/user/repo.git",
				repo: "https://github.com/user/repo.git",
			}

			const generator = handler.createMessage(systemPrompt, messages, metadata)
			await generator.next()

			// Verify the second argument (options) contains our custom headers
			expect(mockCreate).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					headers: {
						...clientMetadataHeaders,
						[X_REASONING_EFFORT]: "medium",
						[X_KILOCODE_TASKID]: "test-task-id",
						[X_KILOCODE_PROJECTID]: "https://github.com/user/repo.git",
						[X_KILOCODE_ORGANIZATIONID]: "test-org-id",
						[X_AXON_REPO]: "https://github.com/user/repo.git",
					},
				}),
			)
		})
	})
})
