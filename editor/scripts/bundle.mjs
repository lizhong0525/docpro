import { build } from 'esbuild';

// CommonJS modules from Express and Mammoth use Node builtins through require.
await build({
  entryPoints: ['server/index.ts'],
  outfile: 'runtime/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['vite'],
  banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: 'eof',
});
