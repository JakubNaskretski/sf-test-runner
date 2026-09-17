const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

/** The extension host bundle. @type {import('esbuild').BuildOptions} */
const nodeOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** The three panel webviews. They run in a browser: no `vscode` module, no
 *  Node builtins — the only host bridge is `acquireVsCodeApi()`.
 *  @type {import('esbuild').BuildOptions} */
const browserOptions = {
  entryPoints: ['src/webview/tests.ts', 'src/webview/results.ts', 'src/webview/coverage.ts'],
  bundle: true,
  outdir: 'dist/webview',
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(nodeOptions),
      esbuild.context(browserOptions),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('esbuild: watching extension + webviews...');
  } else {
    await Promise.all([esbuild.build(nodeOptions), esbuild.build(browserOptions)]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
