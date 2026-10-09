// npx vitest run src/core/environment/__tests__/contextReminders.spec.ts

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { getGitSnapshot } from "../contextReminders"
import { buildContextReminders, isTokensLeftNote, tokensLeftNote } from "../../prompts/system"

vi.mock("vscode", () => ({
	env: { language: "en" },
	workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
}))

describe("getGitSnapshot", () => {
	let repo: string

	beforeAll(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-git-snapshot-"))
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
		git("init", "-q", "-b", "main")
		git("config", "user.name", "Test User")
		git("config", "user.email", "test@example.com")
		fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
		git("add", ".")
		git("commit", "-q", "-m", "first commit")
		fs.writeFileSync(path.join(repo, "a.txt"), "changed\n")
		fs.writeFileSync(path.join(repo, "new.txt"), "new\n")
	})

	afterAll(() => {
		fs.rmSync(repo, { recursive: true, force: true })
	})

	it("lists branch, user, status and recent commits", async () => {
		const snapshot = await getGitSnapshot(repo)
		expect(snapshot).toContain("# gitStatus")
		expect(snapshot).toContain("Current branch: main")
		expect(snapshot).toContain("Git user: Test User")
		expect(snapshot).toMatch(/Status:\n M a\.txt\n\?\? new\.txt/)
		expect(snapshot).toMatch(/Recent commits:\n[0-9a-f]+ first commit/)
	})

	it("is empty outside a repository", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-no-git-"))
		try {
			expect(await getGitSnapshot(dir)).toBe("")
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe("context reminder helpers", () => {
	it("wraps instructions and git status in system-reminder blocks", () => {
		const text = buildContextReminders("Rules:\nuse tabs", "# gitStatus\nCurrent branch: main")
		expect(text.match(/<system-reminder>/g)).toHaveLength(2)
		expect(text).toContain("These instructions OVERRIDE any default behavior")
		expect(text).toContain("Rules:\nuse tabs")
		expect(text).toContain("Current branch: main")
		expect(buildContextReminders("", "")).toBe("")
	})

	it("formats the tokens-left note", () => {
		expect(tokensLeftNote(123_456.7)).toBe("<total_tokens>123457 tokens left</total_tokens>")
		expect(tokensLeftNote(-5)).toBe("<total_tokens>0 tokens left</total_tokens>")
		expect(isTokensLeftNote(tokensLeftNote(1))).toBe(true)
	})
})
