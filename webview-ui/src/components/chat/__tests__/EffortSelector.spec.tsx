import React from "react"
import { render, screen } from "@testing-library/react"

import { EffortSelector } from "../EffortSelector"

const mockState: { modelEfforts?: Record<string, string> } = {}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockState,
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/components/ui", () => ({
	DropdownOptionType: { ITEM: "item" },
	SelectDropdown: ({ value, options }: { value: string; options: Array<{ value: string }> }) => (
		<div data-testid="effort-dropdown" data-value={value} data-options={options.map((o) => o.value).join(",")} />
	),
}))

const info = { contextWindow: 232000, supportsPromptCache: true }

describe("EffortSelector", () => {
	beforeEach(() => {
		mockState.modelEfforts = undefined
	})

	it("defaults to medium with the catalog's levels", () => {
		render(
			<EffortSelector
				modelId="zai/glm-5.3"
				modelInfo={{ ...info, reasoningEfforts: ["low", "medium", "high", "max"] }}
			/>,
		)
		const dropdown = screen.getByTestId("effort-dropdown")
		expect(dropdown).toHaveAttribute("data-value", "medium")
		expect(dropdown).toHaveAttribute("data-options", "low,medium,high,max")
	})

	it("shows the saved pick for the model", () => {
		mockState.modelEfforts = { "zai/glm-5.3": "max" }
		render(
			<EffortSelector
				modelId="zai/glm-5.3"
				modelInfo={{ ...info, reasoningEfforts: ["low", "medium", "high", "max"] }}
			/>,
		)
		expect(screen.getByTestId("effort-dropdown")).toHaveAttribute("data-value", "max")
	})

	it("renders nothing for a model without an effort selector", () => {
		const { container } = render(<EffortSelector modelId="some/other-model" modelInfo={info} />)
		expect(container).toBeEmptyDOMElement()
	})
})
