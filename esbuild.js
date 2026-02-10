const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

async function build() {
  const ctx = await esbuild.context({
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

  if (watch) {
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
