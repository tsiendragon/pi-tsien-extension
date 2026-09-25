/**
 * Local type shims for two runtime-only dependencies.
 *
 * - `jsdom` ships no types, and this repo pins its `@earendil-works/*` devDependencies to
 *   local tarballs, so `npm i -D @types/jsdom` is not available here. Only the tiny
 *   surface we use is declared; drop this block once `@types/jsdom` is installed.
 * - `turndown-plugin-gfm` has no bundled or DefinitelyTyped types.
 */

declare module "jsdom" {
	export class JSDOM {
		constructor(html?: string, options?: { url?: string; contentType?: string });
		readonly window: { readonly document: Document };
	}
}

declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: TurndownService.Plugin;
	export const tables: TurndownService.Plugin;
	export const strikethrough: TurndownService.Plugin;
	export const taskListItems: TurndownService.Plugin;
}