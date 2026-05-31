import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/index.ts',
  output: [
    { file: 'dist/index.cjs', format: 'cjs', exports: 'auto', sourcemap: false },
    { file: 'dist/index.mjs', format: 'es', sourcemap: false },
  ],
  plugins: [
    json(),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    // Transpile to ESM so rollup can resolve + bundle the module graph into a
    // single file; declarations are emitted separately by `tsc`. (With the
    // tsconfig's node16/CommonJS module setting, the plugin would emit per-file
    // require() calls that rollup leaves unbundled.)
    typescript({
      tsconfig: './tsconfig.json',
      module: 'esnext',
      moduleResolution: 'bundler',
      declaration: true,
      declarationDir: 'dist/types',
      declarationMap: false,
      sourceMap: false,
      outDir: undefined,
    }),
    // Minify the published bundles.
    terser(),
  ],
  external: ['dgram', 'net', 'crypto', 'tls', 'os', 'events', 'stream', 'util', 'fs', 'path'],
};
