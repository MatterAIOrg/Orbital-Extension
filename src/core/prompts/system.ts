import * as os from "os"
import * as vscode from "vscode"

import type {
	CustomModePrompts,
	Experiments,
	ModeConfig,
	PromptComponent,
	TodoItem,
	HistoryItem,
} from "@roo-code/types"

import type { SystemPromptSettings } from "./types"

import { ToolUseStyle } from "../../../packages/types/src" // kilocode_change
import { CodeIndexManager } from "../../services/code-index/manager"
import { McpHub } from "../../services/mcp/McpHub"
import { formatLanguage } from "../../shared/language"
import { Mode, defaultModeSlug, getGroupName, getModeBySlug, getModeSelection, modes } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { isEmpty } from "../../utils/object"

import { PromptVariables, loadSystemPromptFile } from "./sections/custom-system-prompt"

import { type ClineProviderState } from "../webview/ClineProvider" // kilocode_change
import { addCustomInstructions, getMcpServersSection } from "./sections"
import { getToolDescriptionsForMode } from "./tools"
import { discoverSkills } from "../tools/skills"
import type { ContextBreakdownParts } from "../sliding-window/contextBreakdown"

/**
 * Result of generating a system prompt: the full markdown string (`text`) and
 * the per-category text fragments (`parts`) that the UI uses to build the
 * context-window usage breakdown.
 */
export interface SystemPromptParts {
	text: string
	parts: ContextBreakdownParts
}

// Helper function to get prompt component, filtering out empty objects
export function getPromptComponent(
	customModePrompts: CustomModePrompts | undefined,
	mode: string,
): PromptComponent | undefined {
	const component = customModePrompts?.[mode]
	// Return undefined if component is empty
	if (isEmpty(component)) {
		return undefined
	}
	return component
}

/**
 * Available skills catalog. Sent with the environment details on the first
 * message (not in the system prompt, which stays static across workspaces).
 */
export async function getSkillsSection(workspacePath: string): Promise<string> {
	const skills = await discoverSkills({ workspacePath })

	if (skills.length === 0) {
		return ""
	}

	const skillList = skills
		.map((skill) => {
			return `  - ${skill.metadata.name}: ${skill.metadata.description}`
		})
		.join("\n")

	return `You are provided Skills below, these skills are to be used by you as per your descretion. The purpose of these skills is to provide you additional niche context for you tasks. You might get skills for React, Security or even third-party tools. Use the tool use_skill with a listed name or an explicit skill directory/SKILL.md path to get the skill context:
${skillList}

IMPORTANT: Skills are not tool calls such as read_file_with_content.
`
}

const applyDiffToolDescription = `
Common tool calls and explanations

## file_edit

**Description**: Make exactly ONE targeted text replacement in ONE file.

**When to use**:
- You need to make a **single** edit to a single file.
- You know the exact text that should be replaced and its updated form.

**When NOT to use**:
- If you have **2 or more independent edits** that are all confirmed and ready right now, use \`multi_file_edit\` instead.
- Do not hold an edit back to accumulate a larger batch. If one edit is ready, make it now and gather the next edits afterwards.

**Parameters**:
1. \`file_path\` — Absolute path to the file you want to modify (e.g., /Users/username/project/src/file.ts).
2. \`old_string\` — The current text you expect to replace. Provide enough context for a unique match; this can be empty to replace the entire file.
3. \`new_string\` — The text that should replace the match. Use an empty string to delete the matched content.
4. \`replace_all\` (optional, default false) — Set to true to replace every occurrence of the matched text. Leave false to replace only a single uniquely identified match.

## multi_file_edit

**Description**: Make multiple text replacements across one or more files in a single tool call. Use it when several edits are already confirmed and ready in the same step.

**When to use**:
- You have **2 or more edits** that are all confirmed and ready now, whether to the same file or different files.
- Keep each batch small and cohesive: the edits that belong to the current step of the task, not the whole task.

**Parameters**:
1. \`edits\` — An array of edit objects. Each edit has:
   - \`file_path\` — Absolute path to the file to modify.
   - \`old_string\` — Exact text to replace (provide enough context for a unique match).
   - \`new_string\` — Replacement text.
   - \`replace_all\` (optional) — Set to true to replace every occurrence.

**Behavior**:
- Edits within the same file are applied bottom-to-top to preserve line offsets.
- Each edit is reported individually (success/failure) so you know exactly which edits worked.
- If an edit fails, other edits in the same file are still attempted.

**Example** (editing 2 places in the same file):
\`\`\`json
{
  "edits": [
    {"file_path": "/path/to/file.ts", "old_string": "const x = 1", "new_string": "const x = 2"},
    {"file_path": "/path/to/file.ts", "old_string": "return x", "new_string": "return x + 1"}
  ]
}
\`\`\`

**Guidance for choosing between file_edit and multi_file_edit**:
- 1 edit → \`file_edit\`
- 2+ edits ready now → \`multi_file_edit\`
- Never accumulate edits across the whole task into one giant batch. Edit granularity follows the steps of the task.

**Editing discipline (CRITICAL)**:
- ALWAYS copy \`old_string\` verbatim from a read_file result obtained in the same turn. NEVER reconstruct indentation or whitespace from memory — this is especially important in tab-indented files, where a reconstructed \`old_string\` will silently mismatch.
- Every \`old_string\` must identify the intended location exactly once. If the text is repeated, expand it with unchanged surrounding lines copied from the file until it is unique.
- A missing or multiple-match error means no edit was applied. Re-read the intended target before retrying; NEVER invent or guess a corrected \`old_string\`.
- Set \`replace_all\` to true only when the user's requested change intentionally applies to every occurrence. NEVER use it merely to bypass a multiple-match error.
- After any successful edit, treat all earlier reads of that file as stale. Re-read the region with read_file before editing the same area of the file again.
- If one edit in a \`multi_file_edit\` batch fails with a string mismatch, STOP and re-read the file before retrying that edit. Do not guess at a corrected \`old_string\` — guessed corrections compound the mismatch.

## read_file Tool Usage

The \`read_file\` tool reads one or more file regions in one operation. Batch all independent reads that are already known at the current step instead of issuing one call per file or walking through adjacent offsets.

### Parameters

- \`files\` (required): Array containing 1-10 file-region requests.
- \`files[].file_path\` (required): Absolute path to the file (e.g., /Users/username/project/src/file.ts).
- \`files[].offset\` (optional): Starting line number (1-indexed). Defaults to 1.
- \`files[].limit\` (optional): Number of lines to read. Use 200-1000; each region is capped at 1000 lines.

### Example

**Read several relevant regions together:**
\`\`\`json
{
  "files": [
    {"file_path": "/Users/username/project/src/App.tsx", "offset": 1, "limit": 1000},
    {"file_path": "/Users/username/project/src/utils.ts", "offset": 400, "limit": 500}
  ]
}
\`\`\`

Parameter rules: \`file_path\` must be absolute. \`offset\` must be >= 1 and \`limit\` must be between 200 and 1000 when specified. Omitting both reads from the top up to the 1000-line cap. To inspect line N in a large file, use an offset that includes enough context for the complete surrounding function or logical region.

When you don't know line numbers: use \`rg -n\` via \`Bash\` to locate the code, note the line number from the results, then \`read_file\` that region with surrounding context.

### Reading Strategy

- For files up to 1000 lines, read the whole file once. For larger files, prefer 500-1000-line logical regions. Do not request fewer than 200 lines merely to save context.
- Put every independent file or region you already know you need into the same \`files\` array. Use another call only when the first result reveals a genuinely new dependency.
- Budget your re-reads: if you have already read a region and have not edited it since, work from what you have instead of fetching it again. Re-read only when the file has changed or you genuinely lack the detail.
- After every read, verify the output matches the parameters you sent. If you meant to read around line N but the result starts at line 1, you omitted \`offset\` — re-issue the call with \`offset\` set. NEVER re-read the top of the file expecting a different result.
- For code reviews, first use a compact change inventory such as \`git status --short\`, \`git diff --stat\`, and \`git diff --unified=20\`. Do not dump an unbounded repository diff and then request the same per-file diffs again.


# Bash

The \`Bash\` tool runs bash commands on the user's system. It is your primary tool for exploring the codebase and for system operations: searching, listing, inspecting git state, installing dependencies, building, testing, starting servers, and other terminal-based tasks.

## Parameters

- \`command\` (required): The bash command to execute. Must be valid for the user's operating system and shell.
- \`cwd\` (optional): The working directory to execute the command in. If not provided, the current working directory is used. Ensure this is always an absolute path, starting with \`/\`. If you are running the command in the root directly, skip this parameter. The command executor is defaulted to run in the root directory. You already have the Current Workspace Directory in the Environment Details section.
- \`message\` (required): One-line description shown to the user.
- \`isDangerous\` (required): true only for destructive or irreversible commands.

CRITICAL: If the command is a very long running process, prefer to let the user know so they can run it manually in their terminal. If the user specifically requests to run a long running command, you may proceed.

Command validity rules: a command is never empty, never just \`:\`, never a bare single word with no arguments (except \`ls\` or \`pwd\`), and never contains tool-call markup tokens or angle-bracket tags of any kind.

## Exploring with the shell

There are no dedicated search or list tools. Use the shell, the way an engineer at a terminal would. Read-only commands (\`rg\`, \`grep\`, \`find\`, \`ls\`, \`cat\`, \`head\`, \`wc\`, \`git status/diff/log/show/grep\`, and pipes of these) run without an approval prompt, so use them freely.

- **Search contents:** \`rg -n "pattern" src/\`. Prefer \`rg\` (respects .gitignore, fast); fall back to \`grep -rn\` if it is missing. Useful flags: \`-g '*.ts'\` to filter files, \`-i\` case-insensitive, \`-w\` whole word, \`-F\` literal string, \`-l\` file names only, \`-c\` counts, \`-C 2\` context, \`-t py\` by language.
- **Find files by name:** \`rg --files -g '*auth*'\`, \`fd auth\`, or \`find . -name '*auth*' -not -path '*/node_modules/*'\`.
- **List a directory:** \`ls -la src/\`, or \`rg --files src | head -100\` for a recursive, gitignore-aware listing. \`tree -L 2 -I node_modules\` if available.
- **Structure of a file:** \`rg -n "^(export |class |function |def )" path/to/file\`.
- **Git state:** \`git status --short\`, \`git diff --stat\`, \`git log --oneline -20\`, \`git grep -n "pattern"\`.
- **Peek at a file:** \`head -50 file\`, \`wc -l file\`. Use \`read_file\` when you need real content for editing.

### Shell hygiene

- Bound the output: pipe through \`| head -50\` or use \`-l\`/\`-c\` first when a search may match widely.
- Scope searches to the narrowest plausible directory, never \`/\` or the home directory.
- Exclude test, spec, and mock paths from discovery searches by default (\`-g '!**/*.test.*' -g '!**/__tests__/**'\`) unless the task is about tests.
- Combine independent lookups into one call (\`rg -n foo src/ ; rg -n bar src/\`) or issue several calls in the same message.
- If a search returns hundreds of hits, tighten the pattern or path and search again. Do not scan through the dump.
- Never use \`cat\`, \`sed -n\`, or \`head\`/\`tail\` to read code you are about to edit; use \`read_file\`. Never use \`echo\`, heredocs, or \`sed -i\` to write files; use the edit tools.

## Working style

- Act directly. As soon as you know what to change, make the edit — do not write out plans or re-derive facts you already have.
- Simple requests (rename, small edit, one-line fix) need only: locate, edit, run the relevant check once.
- Batch independent reads and searches into one step; issue edits and the follow-up check together when the check does not depend on reading the edit result.
- If a call fails or a result looks wrong, fix the call and move on. Never repeat an identical call more than twice.

## Edit early, iterate in small steps

- Make the first edit as soon as the change for one file is confirmed. Do not map the whole codebase before touching anything — gather context per step, on demand, between edits.
- Alternate editing and checking: make an edit, run the relevant check (typecheck, test, or a targeted read), then continue. This is the intended workflow, not a planning failure.
- Track remaining work with \`update_todo_list\` (one step in progress at a time, updated after each sub-task) instead of holding a full multi-file plan in context.
- Keep each batch of edits small and cohesive — the edits that belong to the current step. A change spanning many files is executed as a sequence of small verified steps, not one giant multi-file edit.
- Do not re-read a file just to confirm an edit succeeded; the tool result already reports success or failure. (Re-reading before a NEW edit in the same area is still required.)

## Multi-repo workspaces

- When several repositories or workspace roots are open, work inside the one that owns the code being changed. Do not read sibling repos to "understand the ecosystem."
- Cross into another repo only when the task explicitly requires it (e.g., mirroring a change in a consumer). Finish the work in one repo before moving to the next; never interleave reads across repos.

## update_todo_list

**Description:**
Replace the entire TODO list with an updated checklist reflecting the current state. Always provide the full list; the system will overwrite the previous one. This tool is designed for step-by-step task tracking, allowing you to confirm completion of each step before updating, update multiple task statuses at once (e.g., mark one as completed and start the next), and dynamically add new todos discovered during long or complex tasks.

**Checklist Format:**
- Use a single-level markdown checklist (no nesting or subtasks), in intended execution order.
- Statuses: \`[ ]\` pending, \`[x]\` completed (fully finished, no unresolved issues), \`[-]\` in progress.

**Core Principles:**
- Update multiple statuses in a single call (e.g., mark the previous task completed and the next in progress).
- Add newly discovered actionable items immediately. Retain all unfinished tasks; remove one only if it is no longer relevant or the user asks.
- Mark a task completed only when fully accomplished. If blocked, keep it in_progress and add a todo describing what must be resolved.
- Keep the todo list AHEAD of the work, not behind it: it is a steering tool, not a changelog. Lay out upcoming steps before you start them instead of only recording steps after they are finished.

IMPORTANT: Use attempt_completion tool when you have completed the task. This signals that you are done.
`

/**
 * How this extension actually delivers per-session context. Static, so it
 * stays part of the cacheable system prompt.
 */
const harnessSection = `# Harness

The role definition and tool guide above describe context in generic terms; this is how Orbital actually delivers it:

- Per-session context is sent as conversation messages, not in this system prompt. The first user message may open with <system-reminder> blocks holding the user's custom instructions and rules (including AGENTS.md) and the git status at task start. It ends with the Environment Details: visible files and open tabs, active terminals, current mode and model, the Current Workspace Directory, operating system and shell, linked repositories, the available skills and the current time.
- <system-reminder> blocks, the Environment Details and <total_tokens> notes come from the harness, not the user. Heed them, but don't mention them in your response to the user.
- Each later user message and each round of tool results ends with <total_tokens>N tokens left</total_tokens>: the room left in your context window. When the conversation grows long, older context is summarized automatically, so you don't need to wrap up early or hand off mid-task.
- Text you output outside of tool calls is shown to the user as GitHub-flavored markdown in the VS Code chat panel.

# Workspace

The Current Workspace Directory is the active VS Code project directory, and is therefore the default directory for all tool operations. Commands run in the current workspace directory unless a different cwd is passed; changing directories inside a command does not modify the workspace directory. No file listing is attached; explore the project with Bash (\`ls\`, \`rg --files\`, \`git ls-files\`) rather than guessing at its layout. Prefer a non-recursive \`ls\` for generic directories where you don't need the nested structure, like the Desktop.`

async function generatePromptParts(
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mode: Mode,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	browserViewportSize?: string,
	promptComponent?: PromptComponent,
	customModeConfigs?: ModeConfig[],
	_globalCustomInstructions?: string,
	diffEnabled?: boolean,
	experiments?: Record<string, boolean>,
	enableMcpServerCreation?: boolean,
	_language?: string,
	_rooIgnoreInstructions?: string,
	partialReadsEnabled?: boolean,
	settings?: SystemPromptSettings,
	_todoList?: TodoItem[],
	modelId?: string,
	toolUseStyle?: ToolUseStyle, // kilocode_change
	clineProviderState?: ClineProviderState, // kilocode_change
	_taskHistory?: HistoryItem[], // kilocode_change: Chat memories
): Promise<SystemPromptParts> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// If diff is disabled, don't pass the diffStrategy
	const effectiveDiffStrategy = diffStrategy

	// Get the full mode config to ensure we have the role definition (used for groups, etc.)
	const modeConfig = getModeBySlug(mode, customModeConfigs) || modes.find((m) => m.slug === mode) || modes[0]
	const { roleDefinition, baseInstructions } = getModeSelection(mode, promptComponent, customModeConfigs)

	// Check if MCP functionality should be included
	const hasMcpGroup = modeConfig.groups.some((groupEntry) => getGroupName(groupEntry) === "mcp")
	const hasMcpServers = mcpHub && mcpHub.getServers().length > 0
	const shouldIncludeMcp = hasMcpGroup && hasMcpServers

	const [mcpServersSection, skillsSection] = await Promise.all([
		// getModesSection(context, toolUseStyle /*kilocode_change*/),
		shouldIncludeMcp
			? getMcpServersSection(mcpHub, effectiveDiffStrategy, enableMcpServerCreation)
			: Promise.resolve(""),
		getSkillsSection(cwd),
	])

	const codeIndexManager = CodeIndexManager.getInstance(context, cwd)

	const toolDescriptions =
		toolUseStyle !== "json" // kilocode_change
			? await getToolDescriptionsForMode(
					mode,
					cwd,
					supportsComputerUse,
					codeIndexManager,
					effectiveDiffStrategy,
					browserViewportSize,
					shouldIncludeMcp ? mcpHub : undefined,
					customModeConfigs,
					experiments,
					partialReadsEnabled,
					settings,
					enableMcpServerCreation,
					modelId,
					clineProviderState, // kilocode_change
				)
			: ""
	const toolGuidance = toolUseStyle === "json" ? "" : applyDiffToolDescription

	// Split the tool descriptions string into "tool definitions" (everything that's
	// a tool schema/usage block) and the static system prompt (role definition,
	// tool guidance, previous chat titles, system info). The split is a heuristic:
	// tool descriptions begin with `## ` headers introducing a tool name.
	const toolDefinitionSections = toolDescriptions.split(/\n(?=##\s)/).filter((section) => section.trim().length > 0)
	const toolDefinitionsText = toolDefinitionSections.join("\n")

	// The system prompt is static: role definition, tool guidance and the
	// harness section. Per-session context (git status, AGENTS.md
	// instructions, environment details, skills, token budget) rides on the
	// conversation instead, so the provider's prompt cache keeps hitting
	// across sessions and projects.
	const systemPromptText = [roleDefinition, toolGuidance, harnessSection]
		.filter((part) => part && part.trim().length > 0)
		.join("\n\n")

	const basePrompt = `${roleDefinition}

${toolDescriptions}

${toolGuidance}

${harnessSection}

${mcpServersSection}
`

	return {
		text: basePrompt,
		parts: {
			systemPrompt: systemPromptText,
			toolDefinitions: toolDefinitionsText,
			rules: "",
			skills: skillsSection,
			mcp: mcpServersSection,
			subagentDefinitions: "",
		},
	}
}

/** Wrap harness-provided context the model should heed but not echo. */
export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`
}

/** Context prepended to the first user message: AGENTS.md instructions and the git snapshot. */
export function buildContextReminders(memorySection: string, gitStatus: string): string {
	const reminders: string[] = []
	if (memorySection) {
		reminders.push(
			systemReminder(
				`Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n${memorySection}`,
			),
		)
	}
	if (gitStatus) {
		reminders.push(
			systemReminder(
				`As you answer the user's questions, you can use the following context:\n${gitStatus}\n\nThis context was attached automatically; it isn't part of the user's message.`,
			),
		)
	}
	return reminders.join("\n")
}

/** Remaining context-window budget, appended to each user message and tool round. */
export function tokensLeftNote(tokensLeft: number): string {
	return `<total_tokens>${Math.max(0, Math.round(tokensLeft))} tokens left</total_tokens>`
}

export function isTokensLeftNote(text: string): boolean {
	return text.startsWith("<total_tokens>")
}

export const SYSTEM_PROMPT = async (
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	browserViewportSize?: string,
	inputMode: Mode = defaultModeSlug, // kilocode_change: name changed to inputMode
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	globalCustomInstructions?: string,
	diffEnabled?: boolean,
	experiments?: Experiments, // kilocode_change: type
	enableMcpServerCreation?: boolean,
	language?: string,
	rooIgnoreInstructions?: string,
	partialReadsEnabled?: boolean,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	toolUseStyle?: ToolUseStyle, // kilocode_change
	clineProviderState?: ClineProviderState, // kilocode_change
	taskHistory?: HistoryItem[], // kilocode_change: Chat memories
): Promise<string> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	const mode =
		getModeBySlug(inputMode, customModes)?.slug || modes.find((m) => m.slug === inputMode)?.slug || defaultModeSlug // kilocode_change: don't try to use non-existent modes

	// Try to load custom system prompt from file
	const variablesForPrompt: PromptVariables = {
		workspace: cwd,
		mode: mode,
		language: language ?? formatLanguage(vscode.env.language),
		shell: vscode.env.shell,
		operatingSystem: os.type(),
	}
	const fileCustomSystemPrompt = await loadSystemPromptFile(cwd, mode, variablesForPrompt)

	// Check if it's a custom mode
	const promptComponent = getPromptComponent(customModePrompts, mode)

	// Get full mode config from custom modes or fall back to built-in modes
	const currentMode = getModeBySlug(mode, customModes) || modes.find((m) => m.slug === mode) || modes[0]

	// If a file-based custom system prompt exists, use it
	if (fileCustomSystemPrompt) {
		const { roleDefinition, baseInstructions: baseInstructionsForFile } = getModeSelection(
			mode,
			promptComponent,
			customModes,
		)

		const customInstructions = await addCustomInstructions(
			baseInstructionsForFile,
			globalCustomInstructions || "",
			cwd,
			mode,
			{
				language: language ?? formatLanguage(vscode.env.language),
				rooIgnoreInstructions,
				settings,
			},
		)

		// For file-based prompts, don't include the tool sections
		return `${roleDefinition}

${fileCustomSystemPrompt}

${customInstructions}`
	}

	// If diff is disabled, don't pass the diffStrategy
	const effectiveDiffStrategy = diffEnabled ? diffStrategy : undefined

	return generatePromptParts(
		context,
		cwd,
		supportsComputerUse,
		currentMode.slug,
		mcpHub,
		effectiveDiffStrategy,
		browserViewportSize,
		promptComponent,
		customModes,
		globalCustomInstructions,
		diffEnabled,
		experiments,
		enableMcpServerCreation,
		language,
		rooIgnoreInstructions,
		partialReadsEnabled,
		settings,
		todoList,
		modelId,
		toolUseStyle, // kilocode_change
		clineProviderState, // kilocode_change
		taskHistory, // kilocode_change: Chat memories
	).then((result) => result.text)
}

/**
 * Build the system prompt and return both the rendered text and the
 * per-category text fragments used to build a context-window breakdown.
 *
 * The returned `parts` is intentionally raw text — token counts are computed
 * at the call site using `countStringTokens` so the UI can refresh on demand.
 */
export const getSystemPromptParts = async (
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	browserViewportSize?: string,
	inputMode: Mode = defaultModeSlug,
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	globalCustomInstructions?: string,
	diffEnabled?: boolean,
	experiments?: Experiments,
	enableMcpServerCreation?: boolean,
	language?: string,
	rooIgnoreInstructions?: string,
	partialReadsEnabled?: boolean,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	toolUseStyle?: ToolUseStyle,
	clineProviderState?: ClineProviderState,
	taskHistory?: HistoryItem[],
): Promise<SystemPromptParts> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	const mode =
		getModeBySlug(inputMode, customModes)?.slug || modes.find((m) => m.slug === inputMode)?.slug || defaultModeSlug

	const variablesForPrompt: PromptVariables = {
		workspace: cwd,
		mode,
		language: language ?? formatLanguage(vscode.env.language),
		shell: vscode.env.shell,
		operatingSystem: os.type(),
	}
	const fileCustomSystemPrompt = await loadSystemPromptFile(cwd, mode, variablesForPrompt)
	const promptComponent = getPromptComponent(customModePrompts, mode)
	const currentMode = getModeBySlug(mode, customModes) || modes.find((m) => m.slug === mode) || modes[0]

	if (fileCustomSystemPrompt) {
		const { roleDefinition, baseInstructions: baseInstructionsForFile } = getModeSelection(
			mode,
			promptComponent,
			customModes,
		)

		const customInstructions = await addCustomInstructions(
			baseInstructionsForFile,
			globalCustomInstructions || "",
			cwd,
			mode,
			{
				language: language ?? formatLanguage(vscode.env.language),
				rooIgnoreInstructions,
				settings,
			},
		)

		const text = `${roleDefinition}

${fileCustomSystemPrompt}

${customInstructions}`

		// File-based custom prompts don't expose the section breakdown — bucket
		// the entire prompt under "System prompt" so the user still sees the
		// full token usage even without a per-section split.
		return {
			text,
			parts: {
				systemPrompt: text,
				toolDefinitions: "",
				rules: "",
				skills: "",
				mcp: "",
				subagentDefinitions: "",
			},
		}
	}

	const effectiveDiffStrategy = diffEnabled ? diffStrategy : undefined

	return generatePromptParts(
		context,
		cwd,
		supportsComputerUse,
		currentMode.slug,
		mcpHub,
		effectiveDiffStrategy,
		browserViewportSize,
		promptComponent,
		customModes,
		globalCustomInstructions,
		diffEnabled,
		experiments,
		enableMcpServerCreation,
		language,
		rooIgnoreInstructions,
		partialReadsEnabled,
		settings,
		todoList,
		modelId,
		toolUseStyle,
		clineProviderState,
		taskHistory,
	)
}
