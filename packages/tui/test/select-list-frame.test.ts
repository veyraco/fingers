import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { visibleWidth } from "../src/utils.ts";

const plain = (text: string) => text;
const theme = {
	selectedPrefix: plain,
	selectedText: plain,
	description: plain,
	scrollInfo: plain,
	noMatch: plain,
	tag: (text: string) => `<${text}>`,
};

const items = [
	{ value: "model", label: "model", description: "switch model or provider" },
	{ value: "agents", label: "agents", description: "sub-agents: start, watch, steer, stop", tag: "ee" },
	{ value: "login", label: "login", description: "sign in" },
];

describe("SelectList tags", () => {
	it("renders an item's tag after its description, styled with theme.tag", () => {
		const lines = new SelectList(items, 5, theme).render(90);
		assert.match(lines[1], /sub-agents: start, watch, steer, stop< {3}ee>$/);
		assert.doesNotMatch(lines[0], /ee/);
	});

	it("keeps the tag inside the width when the description is truncated", () => {
		const lines = new SelectList(items, 5, { ...theme, tag: plain }).render(46);
		for (const line of lines) assert.ok(visibleWidth(line) <= 46, line);
		assert.ok(lines[1].endsWith("   ee"), lines[1]);
	});
});

describe("SelectList frame", () => {
	const frame = {
		title: "Commands",
		tagLegends: { ee: "= needs fingers login and a Veyra tier that includes it" },
		hint: "↑↓ move · tab complete · enter run · esc close",
	};

	it("draws a titled box with the legend for shown tags and the key hints below", () => {
		const list = new SelectList(
			items,
			5,
			{ ...theme, tag: plain },
			{ frame, selectedMarker: "❯ ", minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 },
		);
		const lines = list.render(80);
		assert.ok(lines[0].startsWith("╭─ Commands ─"), lines[0]);
		assert.ok(lines[0].endsWith("╮"));
		assert.ok(lines[1].startsWith("│ ❯ model"), lines[1]);
		assert.ok(lines[1].endsWith(" │"));
		assert.match(lines[2], /^│ {3}agents {6}sub-agents: start, watch, steer, stop {3}ee +│$/);
		assert.equal(lines[4].replace(/[│ ]/g, ""), "");
		assert.ok(lines[5].startsWith("│ ee = needs fingers login and a Veyra tier that includes it"), lines[5]);
		assert.ok(lines[6].startsWith("╰─") && lines[6].endsWith("╯"));
		assert.equal(lines[7], "");
		assert.equal(lines[8], "  ↑↓ move · tab complete · enter run · esc close");
		for (const line of lines) assert.ok(visibleWidth(line) <= 80, line);
		for (const line of lines.slice(0, 7)) assert.equal(visibleWidth(line), 80, line);
	});

	it("leaves out the legend when no shown item carries the tag", () => {
		const list = new SelectList(
			items.filter((item) => !item.tag),
			5,
			theme,
			{ frame },
		);
		assert.ok(!list.render(80).some((line) => line.includes("needs fingers login")));
	});

	it("maps mouse rows below the top border to items", () => {
		const list = new SelectList(items, 5, theme, { frame });
		let chosen: string | undefined;
		list.onSelect = (item) => {
			chosen = item.value;
		};
		const base = { x: 3, width: 80, height: 9, screenX: 3, screenY: 2, shift: false, alt: false, ctrl: false };
		list.handleMouse({ ...base, type: "press", button: "left", y: 2 } as never);
		list.handleMouse({ ...base, type: "click", button: "left", y: 2 } as never);
		assert.equal(chosen, "agents");
		assert.equal(list.handleMouse({ ...base, type: "press", button: "left", y: 0 } as never), undefined);
	});
});
