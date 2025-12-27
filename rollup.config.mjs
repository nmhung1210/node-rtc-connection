import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'src/index.js',
  output: [
    {
      file: 'dist/index.cjs',
      format: 'cjs',
      exports: 'auto',
      sourcemap: true
    },
    {
      file: 'dist/index.mjs',
      format: 'es',
      sourcemap: true
    }
  ],
  plugins: [
    nodeResolve({
      preferBuiltins: true
    }),
    commonjs()
  ],
  external: [
    'dgram',
    'net',
    'crypto',
    'tls',
    'os',
    'events',
    'stream',
    'util',
    'fs',
    'path'
  ]
};
