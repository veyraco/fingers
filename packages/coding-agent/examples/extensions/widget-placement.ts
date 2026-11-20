import type { ExtensionAPI } from "@veyraco/fingers";

export default function widgetPlacementExtension(fingers: ExtensionAPI) {
	fingers.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
