import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

/**
 * Emit a minimal `dist/package.json` (and copy README/LICENSE) so the package
 * can be published straight from `dist/`. The published manifest carries only
 * what consumers need — no `scripts`, `devDependencies`, or dev config — and
 * entry-point paths are rewritten relative to `dist/`.
 */
function publishManifest() {
  return {
    name: 'publish-manifest',
    closeBundle() {
      const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
      const stripDist = (p) => (typeof p === 'string' ? p.replace(/^(\.\/)?dist\//, './') : p);

      const minimal = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        keywords: pkg.keywords,
        author: pkg.author,
        license: pkg.license,
        type: pkg.type,
        engines: pkg.engines,
        main: stripDist(pkg.main),
        module: stripDist(pkg.module),
        types: stripDist(pkg.types),
        exports: {
          '.': {
            types: stripDist(pkg.exports['.'].types),
            require: stripDist(pkg.exports['.'].require),
            import: stripDist(pkg.exports['.'].import),
          },
        },
        repository: pkg.repository,
        bugs: pkg.bugs,
        homepage: pkg.homepage,
      };

      writeFileSync('dist/package.json', JSON.stringify(minimal, null, 2) + '\n');
      copyFileSync('README.md', 'dist/README.md');
      copyFileSync('LICENSE', 'dist/LICENSE');
    },
  };
}

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
    // single file. The TypeScript plugin also emits the type declarations.
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
    // Emit the minimal dist/package.json + copy README/LICENSE.
    publishManifest(),
  ],
  external: ['dgram', 'net', 'crypto', 'tls', 'os', 'events', 'stream', 'util', 'fs', 'path'],
};
