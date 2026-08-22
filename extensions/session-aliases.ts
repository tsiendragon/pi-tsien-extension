import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function sessionAliases(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a fresh session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await ctx.newSession();
		},
	});

	pi.registerCommand("exit", {
		description: "Quit pi",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
