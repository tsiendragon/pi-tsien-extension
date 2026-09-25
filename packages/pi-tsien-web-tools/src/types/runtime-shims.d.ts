/**
 * Local type shim for a runtime-only dependency: `turndown-plugin-gfm` has no bundled
 * types and none on DefinitelyTyped.
 */

declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: TurndownService.Plugin;
	export const tables: TurndownService.Plugin;
	export const strikethrough: TurndownService.Plugin;
	export const taskListItems: TurndownService.Plugin;
}