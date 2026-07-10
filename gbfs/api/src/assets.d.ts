// Binary module imports (wrangler bundling rules).
declare module '*.ttf' {
	const data: ArrayBuffer;
	export default data;
}
declare module '*.wasm' {
	const mod: WebAssembly.Module;
	export default mod;
}
