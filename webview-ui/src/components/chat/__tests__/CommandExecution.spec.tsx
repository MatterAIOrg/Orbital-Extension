import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

import { CommandExecution } from "../CommandExecution"
import { ExtensionStateContext } from "../../../context/ExtensionStateContext"

// Mock dependencies
vi.mock("react-use", () => ({
	useEvent: vi.fn(),
}))

import { vscode } from "../../../utils/vscode"

vi.mock("../../../utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("../../kilocode/common/CodeBlock", () => ({
	default: ({ source }: { source: string }) => <div data-testid="code-block">{source}</div>,
}))

vi.mock("../CommandPatternSelector", () => ({
	CommandPatternSelector: ({ patterns, onAllowPatternChange, onDenyPatternChange }: any) => (
		<div data-testid="command-pattern-selector">
			{patterns.map((pattern: any, index: number) => (
				<span key={index}>{pattern.pattern}</span>
			))}
			<button onClick={() => onAllowPatternChange(patterns[0]?.pattern)}>Allow</button>
			<button onClick={() => onDenyPatternChange(patterns[0]?.pattern)}>Deny</button>
		</div>
	),
}))

// Mock ExtensionStateContext
const mockExtensionState = {
	terminalShellIntegrationDisabled: false,
	allowedCommands: ["npm"],
	deniedCommands: ["rm"],
	setAllowedCommands: vi.fn(),
	setDeniedCommands: vi.fn(),
}

const ExtensionStateWrapper = ({ children }: { children: React.ReactNode }) => (
	<ExtensionStateContext.Provider value={mockExtensionState as any}>{children}</ExtensionStateContext.Provider>
)

describe("CommandExecution", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should render command without output", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="npm install" />
			</ExtensionStateWrapper>,
		)

		expect(screen.getByTestId("code-block")).toHaveTextContent("npm install")
	})

	it("shows the command title and keeps legacy details collapsed until requested", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-compact" text={"npm test\nOutput:\nTests passed"} />
			</ExtensionStateWrapper>,
		)

		expect(screen.getByTestId("command-title")).toHaveTextContent("npm test")
		expect(screen.getByTestId("command-status")).toHaveTextContent("Bash")
		expect(screen.getByTestId("command-execution-details")).toHaveClass("hidden")

		fireEvent.click(screen.getByRole("button", { name: "Expand command details" }))

		expect(screen.getByTestId("command-execution-details")).not.toHaveClass("hidden")
		expect(screen.getByRole("button", { name: "Collapse command details" })).toBeInTheDocument()
	})

	it("shows running state with the Matter progress indicator", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-running" text="npm test" />
			</ExtensionStateWrapper>,
		)

		expect(screen.getByTestId("command-status")).toHaveTextContent("Bash")
		expect(screen.getByRole("status", { name: "Working" })).toBeInTheDocument()
	})

	it("does not render legacy command approval controls", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-no-legacy-approval" text="npm test" />
			</ExtensionStateWrapper>,
		)

		expect(screen.queryByText("Run Everything")).not.toBeInTheDocument()
		expect(screen.queryByText("Run")).not.toBeInTheDocument()
		expect(screen.queryByText("Reject")).not.toBeInTheDocument()
		expect(screen.queryByText("Submit")).not.toBeInTheDocument()
	})

	it("should render command with output", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="npm install\nOutput:\nInstalling packages..." />
			</ExtensionStateWrapper>,
		)

		const codeBlocks = screen.getAllByTestId("code-block")
		expect(codeBlocks[0]).toHaveTextContent("npm install")
	})

	it("should prefer the provided command message as the title", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text={"MESSAGE:Installing dependencies\n---\nnpm install"} />
			</ExtensionStateWrapper>,
		)

		expect(screen.getByTestId("command-title")).toHaveTextContent("Installing dependencies")
	})

	it("should show command pattern selector for commands", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="npm install express" />
			</ExtensionStateWrapper>,
		)

		expect(screen.getByTestId("command-pattern-selector")).toBeInTheDocument()
		// Check that the command is shown in the pattern selector
		const selector = screen.getByTestId("command-pattern-selector")
		expect(selector).toHaveTextContent("npm install express")
	})

	it("should handle allow command change", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="git push" />
			</ExtensionStateWrapper>,
		)

		const allowButton = screen.getByText("Allow")
		fireEvent.click(allowButton)

		expect(mockExtensionState.setAllowedCommands).toHaveBeenCalledWith(["npm", "git push"])
		expect(mockExtensionState.setDeniedCommands).toHaveBeenCalledWith(["rm"])
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "allowedCommands", commands: ["npm", "git push"] })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deniedCommands", commands: ["rm"] })
	})

	it("should handle deny command change", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="docker run" />
			</ExtensionStateWrapper>,
		)

		const denyButton = screen.getByText("Deny")
		fireEvent.click(denyButton)

		expect(mockExtensionState.setAllowedCommands).toHaveBeenCalledWith(["npm"])
		expect(mockExtensionState.setDeniedCommands).toHaveBeenCalledWith(["rm", "docker run"])
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "allowedCommands", commands: ["npm"] })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deniedCommands", commands: ["rm", "docker run"] })
	})

	it("should toggle allowed command", () => {
		// Update the mock state to have "npm test" in allowedCommands
		const stateWithNpmTest = {
			...mockExtensionState,
			allowedCommands: ["npm test"],
			deniedCommands: ["rm"],
		}

		render(
			<ExtensionStateContext.Provider value={stateWithNpmTest as any}>
				<CommandExecution executionId="test-1" text="npm test" />
			</ExtensionStateContext.Provider>,
		)

		const allowButton = screen.getByText("Allow")
		fireEvent.click(allowButton)

		// "npm test" is already in allowedCommands, so it should be removed
		expect(stateWithNpmTest.setAllowedCommands).toHaveBeenCalledWith([])
		expect(stateWithNpmTest.setDeniedCommands).toHaveBeenCalledWith(["rm"])
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "allowedCommands", commands: [] })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deniedCommands", commands: ["rm"] })
	})

	it("should toggle denied command", () => {
		// Update the mock state to have "rm -rf" in deniedCommands
		const stateWithRmRf = {
			...mockExtensionState,
			allowedCommands: ["npm"],
			deniedCommands: ["rm -rf"],
		}

		render(
			<ExtensionStateContext.Provider value={stateWithRmRf as any}>
				<CommandExecution executionId="test-1" text="rm -rf" />
			</ExtensionStateContext.Provider>,
		)

		const denyButton = screen.getByText("Deny")
		fireEvent.click(denyButton)

		// "rm -rf" is already in deniedCommands, so it should be removed
		expect(stateWithRmRf.setAllowedCommands).toHaveBeenCalledWith(["npm"])
		expect(stateWithRmRf.setDeniedCommands).toHaveBeenCalledWith([])
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "allowedCommands", commands: ["npm"] })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deniedCommands", commands: [] })
	})

	it("should parse command with Output: separator", () => {
		const commandText = `npm install
Output:
Installing...`

		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text={commandText} />
			</ExtensionStateWrapper>,
		)

		const codeBlocks = screen.getAllByTestId("code-block")
		expect(codeBlocks[0]).toHaveTextContent("npm install")
	})

	it("should parse command with output", () => {
		const commandText = `npm install
Output:
Suggested patterns: npm, npm install, npm run`

		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text={commandText} />
			</ExtensionStateWrapper>,
		)

		// First check that the command was parsed correctly
		const codeBlocks = screen.getAllByTestId("code-block")
		expect(codeBlocks[0]).toHaveTextContent("npm install")
		expect(codeBlocks[1]).toHaveTextContent("Suggested patterns: npm, npm install, npm run")

		const selector = screen.getByTestId("command-pattern-selector")
		expect(selector).toBeInTheDocument()
		// Should show the full command in the selector
		expect(selector).toHaveTextContent("npm install")
	})

	it("should handle commands with pipes", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="ls -la | grep test" />
			</ExtensionStateWrapper>,
		)

		const selector = screen.getByTestId("command-pattern-selector")
		expect(selector).toBeInTheDocument()
		// Should show one of the individual commands from the pipe
		expect(selector.textContent).toMatch(/ls -la|grep test/)
	})

	it("should handle commands with && operator", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="npm install && npm test" />
			</ExtensionStateWrapper>,
		)

		const selector = screen.getByTestId("command-pattern-selector")
		expect(selector).toBeInTheDocument()
		// Should show one of the individual commands from the && chain
		expect(selector.textContent).toMatch(/npm install|npm test|npm/)
	})

	it("should not show pattern selector for empty commands", () => {
		render(
			<ExtensionStateWrapper>
				<CommandExecution executionId="test-1" text="" />
			</ExtensionStateWrapper>,
		)

		expect(screen.queryByTestId("command-pattern-selector")).not.toBeInTheDocument()
	})

	it("should stay collapsed when terminal shell integration is disabled", () => {
		const disabledState = {
			...mockExtensionState,
			terminalShellIntegrationDisabled: true,
		}

		const commandText = `npm install
Output:
Output here`

		render(
			<ExtensionStateContext.Provider value={disabledState as any}>
				<CommandExecution executionId="test-1" text={commandText} />
			</ExtensionStateContext.Provider>,
		)

		// Parsed details remain available, but the compact row should stay collapsed.
		expect(screen.getByTestId("command-execution-details")).toHaveClass("hidden")
		const codeBlocks = screen.getAllByTestId("code-block")
		expect(codeBlocks).toHaveLength(2)
		expect(codeBlocks[1]).toHaveTextContent("Output here")
	})

	it("should handle undefined allowedCommands and deniedCommands", () => {
		const stateWithUndefined = {
			...mockExtensionState,
			allowedCommands: undefined,
			deniedCommands: undefined,
		}

		render(
			<ExtensionStateContext.Provider value={stateWithUndefined as any}>
				<CommandExecution executionId="test-1" text="npm install" />
			</ExtensionStateContext.Provider>,
		)

		// Should show pattern selector when patterns are available
		expect(screen.getByTestId("command-pattern-selector")).toBeInTheDocument()
	})

	it("should handle command change when moving from denied to allowed", () => {
		// Update the mock state to have "rm file.txt" in deniedCommands
		const stateWithRmInDenied = {
			...mockExtensionState,
			allowedCommands: ["npm"],
			deniedCommands: ["rm file.txt"],
		}

		render(
			<ExtensionStateContext.Provider value={stateWithRmInDenied as any}>
				<CommandExecution executionId="test-1" text="rm file.txt" />
			</ExtensionStateContext.Provider>,
		)

		const allowButton = screen.getByText("Allow")
		fireEvent.click(allowButton)

		// "rm file.txt" should be removed from denied and added to allowed
		expect(stateWithRmInDenied.setAllowedCommands).toHaveBeenCalledWith(["npm", "rm file.txt"])
		expect(stateWithRmInDenied.setDeniedCommands).toHaveBeenCalledWith([])
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "allowedCommands", commands: ["npm", "rm file.txt"] })
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "deniedCommands", commands: [] })
	})

	describe("integration with CommandPatternSelector", () => {
		it("should show complex commands with multiple operators", () => {
			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-6" text="npm install && npm test || echo 'failed'" />
				</ExtensionStateWrapper>,
			)

			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			// Should show one of the individual commands from the complex chain
			expect(selector.textContent).toMatch(/npm install|npm test|echo|npm/)
		})

		it("should handle commands with output", () => {
			const commandWithOutput = `npm install
Output:
Installing packages...
Other output here`

			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-6" text={commandWithOutput} />
				</ExtensionStateWrapper>,
			)

			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			// Should show the command in the selector
			expect(selector).toHaveTextContent("npm install")
		})

		it("should handle commands with subshells", () => {
			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-7" text="echo $(whoami) && git status" />
				</ExtensionStateWrapper>,
			)

			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			// Should show one of the individual commands
			expect(selector.textContent).toMatch(/echo|whoami|git status|git/)
		})

		it("should handle commands with backtick subshells", () => {
			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-8" text="git commit -m `date`" />
				</ExtensionStateWrapper>,
			)

			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			// Should show one of the individual commands
			expect(selector.textContent).toMatch(/git commit|date|git/)
		})

		it("should handle commands with special characters", () => {
			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-9" text="cd ~/projects && npm start" />
				</ExtensionStateWrapper>,
			)

			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			// Should show one of the individual commands
			expect(selector.textContent).toMatch(/cd ~\/projects|npm start|cd|npm/)
		})

		it("should handle commands with mixed content including output", () => {
			const commandWithMixedContent = `npm test
Output:
Running tests...
✓ Test 1 passed
✓ Test 2 passed`

			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-10" text={commandWithMixedContent} />
				</ExtensionStateWrapper>,
			)

			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			// Should show the command in the selector
			expect(selector).toHaveTextContent("npm test")
		})

		it("should update both allowed and denied lists when commands conflict", () => {
			const conflictState = {
				...mockExtensionState,
				allowedCommands: ["git"],
				deniedCommands: ["git push origin main"],
			}

			render(
				<ExtensionStateContext.Provider value={conflictState as any}>
					<CommandExecution executionId="test-11" text="git push origin main" />
				</ExtensionStateContext.Provider>,
			)

			// Click to allow "git push origin main"
			const allowButton = screen.getByText("Allow")
			fireEvent.click(allowButton)

			// Should add to allowed and remove from denied
			expect(conflictState.setAllowedCommands).toHaveBeenCalledWith(["git", "git push origin main"])
			expect(conflictState.setDeniedCommands).toHaveBeenCalledWith([])
		})

		it("should handle commands with special quotes", () => {
			// Test with a command that has quotes
			const commandWithQuotes = "echo 'test with unclosed quote"

			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-12" text={commandWithQuotes} />
				</ExtensionStateWrapper>,
			)

			// Should still render the command
			expect(screen.getByTestId("code-block")).toHaveTextContent("echo 'test with unclosed quote")

			// Should show pattern selector with a command pattern
			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			expect(selector.textContent).toMatch(/echo/)
		})

		it("should handle empty or whitespace-only commands", () => {
			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-13" text="   " />
				</ExtensionStateWrapper>,
			)

			// Should render without errors
			expect(screen.getByTestId("code-block")).toBeInTheDocument()

			// Should not show pattern selector for empty commands
			expect(screen.queryByTestId("command-pattern-selector")).not.toBeInTheDocument()
		})

		it("should handle commands with only output and no command prefix", () => {
			const outputOnly = `Some output without a command
Multiple lines of output
Without any command prefix`

			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-14" text={outputOnly} />
				</ExtensionStateWrapper>,
			)

			// Should treat the entire text as command when no prefix is found
			const codeBlock = screen.getByTestId("code-block")
			// The mock CodeBlock component renders text content without preserving newlines
			expect(codeBlock.textContent).toContain("Some output without a command")
			expect(codeBlock.textContent).toContain("Multiple lines of output")
			expect(codeBlock.textContent).toContain("Without any command prefix")
		})

		it("should handle simple commands", () => {
			const plainCommand = "docker build ."

			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-15" text={plainCommand} />
				</ExtensionStateWrapper>,
			)

			// Should render the command
			expect(screen.getByTestId("code-block")).toHaveTextContent("docker build .")

			// Should show pattern selector with the full command
			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()
			expect(selector).toHaveTextContent("docker build .")

			// Verify no output is shown (since there's no Output: separator)
			const codeBlocks = screen.getAllByTestId("code-block")
			expect(codeBlocks).toHaveLength(1) // Only the command block, no output block
		})

		it("should handle commands with numeric output", () => {
			const commandWithNumericOutput = `wc -l *.go *.java
Output:
			   10 file1.go
			   20 file2.go
			   15 Main.java
			   45 total`

			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-16" text={commandWithNumericOutput} />
				</ExtensionStateWrapper>,
			)

			// Should render the command and output
			const codeBlocks = screen.getAllByTestId("code-block")
			expect(codeBlocks[0]).toHaveTextContent("wc -l *.go *.java")

			// Should show pattern selector
			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()

			// Should show a command pattern
			expect(selector.textContent).toMatch(/wc/)

			// The output should still be displayed in the code block
			expect(codeBlocks.length).toBeGreaterThan(1)
			expect(codeBlocks[1].textContent).toContain("45 total")
		})

		it("should handle commands with zero output", () => {
			const commandWithZeroTotal = `wc -l *.go *.java
Output:
		     0 total`

			render(
				<ExtensionStateWrapper>
					<CommandExecution executionId="test-17" text={commandWithZeroTotal} />
				</ExtensionStateWrapper>,
			)

			// Should show pattern selector
			const selector = screen.getByTestId("command-pattern-selector")
			expect(selector).toBeInTheDocument()

			// Should show a command pattern
			expect(selector.textContent).toMatch(/wc/)

			// The output should still be displayed in the code block
			const codeBlocks = screen.getAllByTestId("code-block")
			expect(codeBlocks.length).toBeGreaterThan(1)
			expect(codeBlocks[1]).toHaveTextContent("0 total")
		})
	})
})

describe("CommandExecution approval panel", () => {
	const onApprove = vi.fn()
	const onReject = vi.fn()
	const approvalText = "MESSAGE:Allow dependency installation.\n---\nnpm install express"

	const renderApproval = () =>
		render(
			<ExtensionStateWrapper>
				<CommandExecution
					executionId="approval-test"
					text={approvalText}
					onPrimaryButtonClick={onApprove}
					onSecondaryButtonClick={onReject}
					enableButtons
				/>
			</ExtensionStateWrapper>,
		)

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the compact command approval view", () => {
		renderApproval()

		expect(screen.getByTestId("command-approval")).toBeInTheDocument()
		expect(screen.getByText("Allow dependency installation.")).toBeInTheDocument()
		expect(screen.getByTestId("command-approval-preview")).toHaveTextContent("npm install express")
		expect(screen.getByRole("button", { name: "1. Yes" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: /Yes, and don't ask again/ })).toHaveTextContent(
			"npm install express",
		)
		expect(
			screen.getByRole("button", { name: "3. No, and tell Orbital what to do differently" }),
		).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument()
	})

	it("expands and collapses the command preview", () => {
		renderApproval()

		fireEvent.click(screen.getByRole("button", { name: "Expand" }))
		expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
		expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument()
	})

	it("submits the selected approval option", () => {
		renderApproval()

		fireEvent.click(screen.getByRole("button", { name: "Submit" }))

		expect(onApprove).toHaveBeenCalledTimes(1)
		expect(onReject).not.toHaveBeenCalled()
	})

	it("allows the current command prefix before submitting", () => {
		renderApproval()

		fireEvent.click(screen.getByRole("button", { name: /Yes, and don't ask again/ }))
		fireEvent.click(screen.getByRole("button", { name: "Submit" }))

		expect(mockExtensionState.setAllowedCommands).toHaveBeenCalledWith(["npm", "npm install express"])
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "allowedCommands",
			commands: ["npm", "npm install express"],
		})
		expect(onApprove).toHaveBeenCalledTimes(1)
	})

	it("submits rejection feedback", () => {
		renderApproval()

		fireEvent.click(screen.getByRole("button", { name: "3. No, and tell Orbital what to do differently" }))
		fireEvent.change(screen.getByPlaceholderText("Tell Orbital what to do differently..."), {
			target: { value: "Use pnpm instead" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Submit" }))

		expect(onReject).toHaveBeenCalledWith("Use pnpm instead")
		expect(onApprove).not.toHaveBeenCalled()
	})

	it("supports arrow-key selection and Escape to skip", () => {
		renderApproval()

		fireEvent.keyDown(window, { key: "ArrowDown" })
		fireEvent.keyDown(window, { key: "Enter" })
		expect(mockExtensionState.setAllowedCommands).toHaveBeenCalled()
		expect(onApprove).toHaveBeenCalledTimes(1)

		fireEvent.keyDown(window, { key: "Escape" })
		expect(onReject).toHaveBeenCalledWith()
	})
})
