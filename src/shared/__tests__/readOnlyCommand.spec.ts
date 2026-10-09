// npx vitest run src/shared/__tests__/readOnlyCommand.spec.ts

import { describe, expect, it } from "vitest"

import { isReadOnlyCommand } from "../readOnlyCommand"

describe("isReadOnlyCommand", () => {
	it.each([
		`rg -n "foo" src/`,
		`rg -n "=>" src -g '*.ts'`,
		`rg --files src | head -50`,
		`grep -rn "a|b" . --include='*.ts' 2>/dev/null`,
		`find . -name '*.ts' -not -path '*/node_modules/*'`,
		`ls -la src/ && pwd`,
		`cd src && rg -l TODO | wc -l`,
		`git status --short`,
		`git diff --stat; git log --oneline -20`,
		`cat package.json | jq .version`,
	])("treats %s as read-only", (command) => {
		expect(isReadOnlyCommand(command)).toBe(true)
	})

	it.each([
		``,
		`rm -rf node_modules`,
		`echo hi > file.txt`,
		`cat a >> b`,
		`rg foo | xargs rm`,
		`find . -name '*.log' -delete`,
		`find . -exec rm {} \;`,
		`rg --pre ./evil.sh foo`,
		`sort -o out.txt in.txt`,
		`ls $(rm -rf /)`,
		"ls `whoami`",
		`git commit -m x`,
		`git -c core.pager=evil log`,
		`git diff --output=out.patch`,
		`ls; rm file`,
		`ls && npm install`,
		`sed -i s/a/b/ file`,
		`FOO=1 rg x`,
		`cat <<EOF\nhi\nEOF`,
		`ls "unterminated`,
	])("does not treat %s as read-only", (command) => {
		expect(isReadOnlyCommand(command)).toBe(false)
	})
})
