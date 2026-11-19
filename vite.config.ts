import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import path from "path";
import wasm from 'vite-plugin-wasm';

export default defineConfig({
	plugins: [wasm(), sveltekit()],
	build: { target: 'esnext' },
	test: {
		globals: true, 
		environment: 'node', 
	},
  	resolve: {
    		alias: {
      			$lib: path.resolve("./src/lib"),
    		},
  	}
});

const config = {
	// …
	ssr: {
	  noExternal: ['three']
	}
  }
