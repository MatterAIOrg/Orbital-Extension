import React from "react"
import type { ClineMessage } from "@roo-code/types"
import { fireEvent, render, screen } from "@/utils/test-utils"
import {
	ExplorationGroupRow,
	commandFromAskText,
	getGroupHeading,
	getGroupedCalls,
	isExplorationRelatedMessage,
} from "../ExplorationGroupRow"

// Render plural keys the way i18next would for the en locale.
const t = (key: string, options?: Record<string, unknown>) => {
	const count = options?.count as number | undefined
	return count === undefined ? key : `${key}:${count}`
}

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t }),
}))

vi.mock("../ChatRow", () => ({
	default: ({ message }: { message: ClineMessage }) => <div data-testid={`chat-row-${message.ts}`} />,
}))

const toolAsk = (ts: number, payload: Record<string, unknown>, partial = false) =>
	({ type: "ask", ask: "tool", text: JSON.stringify(payload), ts, partial }) as ClineMessage

const readFile = (ts: number, path = `src/file${ts}.ts`, partial = false) =>
	toolAsk(ts, { tool: "readFile", path }, partial)

const commandAsk = (ts: number, command: string) => ({ type: "ask", ask: "command", text: command, ts }) as ClineMessage

const createProps = (
	messages: ClineMessage[],
	overrides: Partial<React.ComponentProps<typeof ExplorationGroupRow>> = {},
) => ({
	messages,
	isLast: true,
	isStreaming: false,
	onToggleExpand: vi.fn(),
	isExpanded: false,
	onHeightChange: vi.fn(),
	expandedRows: {},
	toggleRowExpansion: vi.fn(),
	handleSuggestionClickInRow: vi.fn(),
	handleBatchFileResponse: vi.fn(),
	highlightedMessageIndex: null,
	enableCheckpoints: false,
	handleFollowUpUnmount: vi.fn(),
	currentFollowUpTs: null,
	enableButtons: false,
	handlePrimaryButtonClick: vi.fn(),
	handleSecondaryButtonClick: vi.fn(),
	isAgentManagerMode: false,
	...overrides,
})

describe("exploration grouping rules", () => {
	it("groups read-only commands but not mutating ones", () => {
		expect(isExplorationRelatedMessage(commandAsk(1, "rg -n foo src | head -20"))).toBe(true)
		expect(isExplorationRelatedMessage(commandAsk(2, "git diff --stat"))).toBe(true)
		expect(isExplorationRelatedMessage(commandAsk(3, "npm install"))).toBe(false)
		expect(isExplorationRelatedMessage(commandAsk(4, "rm -rf dist"))).toBe(false)
	})

	it("reads the command out of the ask text", () => {
		expect(commandFromAskText("MESSAGE:List files\n---\nls -la\nOutput:a\nb")).toBe("ls -la")
		expect(commandFromAskText("git status")).toBe("git status")
	})

	it("describes each finished call and skips partial ones", () => {
		const calls = getGroupedCalls([
			readFile(1, "src/a.ts"),
			toolAsk(2, { tool: "searchFiles", regex: "foo", path: "src" }),
			commandAsk(3, "rg --files src"),
			readFile(4, "src/b.ts", true),
		])
		expect(calls.map((call) => [call.kind, call.summary])).toEqual([
			["read", "src/a.ts"],
			["search", '"foo" in src'],
			["command", "$ rg --files src"],
		])
	})

	it("counts every file of a batched read", () => {
		const calls = getGroupedCalls([
			toolAsk(1, { tool: "readFile", batchFiles: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] }),
		])
		expect(calls[0]).toMatchObject({ kind: "read", count: 3, summary: "a.ts and 2 more" })
	})

	it("builds an OrbCode-style heading", () => {
		const calls = getGroupedCalls([readFile(1), readFile(2), commandAsk(3, "ls"), commandAsk(4, "git log -5")])
		expect(getGroupHeading(calls, t)).toBe("Chat:exploration.read:2, chat:exploration.ran:2")
	})
})

describe("ExplorationGroupRow", () => {
	it("shows the heading and swaps the latest call in while collapsed", () => {
		const { rerender } = render(<ExplorationGroupRow {...createProps([readFile(1, "src/a.ts")])} />)

		expect(screen.getByText("Chat:exploration.read:1")).toBeInTheDocument()
		expect(screen.getByTestId("exploration-latest-call")).toHaveTextContent("⎿ src/a.ts")
		expect(screen.queryByTestId("chat-row-1")).not.toBeInTheDocument()

		rerender(<ExplorationGroupRow {...createProps([readFile(1, "src/a.ts"), commandAsk(2, "rg -n foo")])} />)

		expect(screen.getByText("Chat:exploration.read:1, chat:exploration.ran:1")).toBeInTheDocument()
		expect(screen.getByTestId("exploration-latest-call")).toHaveTextContent("⎿ $ rg -n foo")
	})

	it("expands on click and closes once a row outside the group follows", () => {
		const messages = [readFile(1), readFile(2)]
		const { rerender } = render(<ExplorationGroupRow {...createProps(messages)} />)

		fireEvent.click(screen.getByText("Chat:exploration.read:2"))
		expect(screen.getByTestId("chat-row-2")).toBeInTheDocument()
		expect(screen.queryByTestId("exploration-latest-call")).not.toBeInTheDocument()

		const withNextEntry = [...messages, readFile(3)]
		rerender(<ExplorationGroupRow {...createProps(withNextEntry)} />)
		expect(screen.getByTestId("chat-row-3")).toBeInTheDocument()

		rerender(<ExplorationGroupRow {...createProps(withNextEntry, { isLast: false })} />)
		expect(screen.queryByTestId("chat-row-3")).not.toBeInTheDocument()
	})
})
