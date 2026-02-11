const esbuild = require('esbuild');
const glob = require('glob');

const watch = process.argv.includes('--watch');

async function build() {
  // Bundle the extension entry point
  const extCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: 'out/extension.js',
    sourcemap: true,
    external: ['vscode'],
    format: 'cjs',
    loader: { '.ts': 'ts' },
    tsconfig: 'tsconfig.json',
  });

  // Compile all source files individually for tests
  // (tests import modules like ../debug-server which need to exist as separate files)
  const allFiles = glob.sync('src/**/*.ts');
  const testCtx = await esbuild.context({
    entryPoints: allFiles,
    bundle: false,
    platform: 'node',
    target: 'node20',
    outdir: 'out',
    outbase: 'src',
    sourcemap: true,
    format: 'cjs',
    loader: { '.ts': 'ts' },
    tsconfig: 'tsconfig.json',
  });

  if (watch) {
    await Promise.all([extCtx.watch(), testCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([extCtx.rebuild(), testCtx.rebuild()]);
    await Promise.all([extCtx.dispose(), testCtx.dispose()]);
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
