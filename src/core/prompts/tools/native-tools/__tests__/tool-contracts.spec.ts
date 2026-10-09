import { describe, expect, it } from "vitest"

import bash from "../bash"
import { nativeTools } from ".."
import fileEdit from "../file_edit"
import multiFileEdit from "../multi_file_edit"

function parameters(tool: any) {
	return tool.function.parameters
}

describe("native tool contracts", () => {
	it("offers shell search instead of dedicated search/list tools", () => {
		const names = nativeTools.map((tool) => tool.function.name)
		expect(names).toContain("Bash")
		expect(names).not.toContain("execute_command")
		expect(names).not.toContain("search_files")
		expect(names).not.toContain("list_files")
	})

	it("makes edit replacement intent explicit for strict schemas", () => {
		expect(parameters(fileEdit).required).toContain("replace_all")
		expect(parameters(fileEdit).properties.replace_all.type).toEqual(["boolean", "null"])
		expect(parameters(multiFileEdit).items).toBeUndefined()
		expect(parameters(multiFileEdit).properties.edits.items.required).toContain("replace_all")
	})

	it("requires command safety metadata", () => {
		expect(parameters(bash).required).toEqual(["command", "cwd", "message", "background", "isDangerous"])
		expect(parameters(bash).properties.background.type).toEqual(["boolean", "null"])
	})

	it("keeps strict schemas valid for optional arguments", () => {
		const visit = (schema: any, location: string) => {
			if (!schema || typeof schema !== "object") return

			if (schema.properties) {
				const required = new Set(schema.required ?? [])
				for (const property of Object.keys(schema.properties)) {
					expect(required.has(property), `${location}.${property} must be required`).toBe(true)
					visit(schema.properties[property], `${location}.${property}`)
				}
			}

			if (schema.items) visit(schema.items, `${location}[]`)
		}

		for (const tool of nativeTools) {
			if (tool.function.strict) visit(tool.function.parameters, tool.function.name)
		}
	})
})
