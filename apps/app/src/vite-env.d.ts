/// <reference types="vite/client" />
// Vite raw-import declarations (?raw bundles file contents as strings).
declare module '*?raw' {
	const content: string;
	export default content;
}
