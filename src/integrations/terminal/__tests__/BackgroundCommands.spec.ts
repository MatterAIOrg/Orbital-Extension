// npx vitest run src/integrations/terminal/__tests__/BackgroundCommands.spec.ts

import * as os from "os"

import {
	backgroundCommandsNote,
	getBackgroundCommand,
	killBackgroundCommand,
	killBackgroundCommandsFor,
	listBackgroundCommands,
	resetBackgroundCommands,
	startBackgroundCommand,
	subscribeBackgroundCommands,
	takeFinishedBackgroundCommands,
} from "../BackgroundCommands"

vi.mock("../../../utils/shell", () => ({
	getCommandShell: () => ({ path: "/bin/bash", isBash: true }),
}))

async function waitFor(check: () => boolean, timeoutMs = 5000) {
	const start = Date.now()
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out")
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

describe.skipIf(process.platform === "win32")("BackgroundCommands", () => {
	afterEach(() => {
		for (const cmd of listBackgroundCommands()) killBackgroundCommand(cmd.id)
		resetBackgroundCommands()
	})

	it("runs a command detached and captures its output", async () => {
		const cmd = startBackgroundCommand("echo hello; echo oops >&2; exit 3", os.tmpdir(), "task-1")
		expect(cmd.status).toBe("running")
		expect(cmd.id).toMatch(/^bg_/)

		await waitFor(() => getBackgroundCommand(cmd.id)?.status !== "running")
		const done = getBackgroundCommand(cmd.id)!
		expect(done.status).toBe("failed")
		expect(done.exitCode).toBe(3)
		expect(done.output).toContain("hello")
		expect(done.output).toContain("oops")
	})

	it("reports each finished command once, scoped to its task", async () => {
		const mine = startBackgroundCommand("true", os.tmpdir(), "task-1")
		const other = startBackgroundCommand("true", os.tmpdir(), "task-2")
		await waitFor(() => [mine, other].every((cmd) => getBackgroundCommand(cmd.id)?.status === "completed"))

		const note = backgroundCommandsNote("task-1")
		expect(note).toContain("<background_commands>")
		expect(note).toContain(mine.id)
		expect(note).not.toContain(other.id)
		expect(backgroundCommandsNote("task-1")).toBe("")
		expect(takeFinishedBackgroundCommands("task-2").map((cmd) => cmd.id)).toEqual([other.id])
	})

	it("stops a running command and every command of a task", async () => {
		const first = startBackgroundCommand("sleep 30", os.tmpdir(), "task-1")
		const second = startBackgroundCommand("sleep 30", os.tmpdir(), "task-1")
		await waitFor(() => Boolean(first.pid && second.pid))

		expect(killBackgroundCommand(first.id)).toBe(true)
		await waitFor(() => getBackgroundCommand(first.id)?.status === "killed")

		killBackgroundCommandsFor("task-1")
		await waitFor(() => getBackgroundCommand(second.id)?.status === "killed")
		expect(killBackgroundCommand(second.id)).toBe(false)
	})

	it("notifies listeners when commands start and finish", async () => {
		const listener = vi.fn()
		const unsubscribe = subscribeBackgroundCommands(listener)
		const cmd = startBackgroundCommand("true", os.tmpdir(), "task-1")
		await waitFor(() => getBackgroundCommand(cmd.id)?.status === "completed")
		unsubscribe()
		expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2)
	})
})
