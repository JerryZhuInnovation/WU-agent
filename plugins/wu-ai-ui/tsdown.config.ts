import { defineConfig } from 'tsdown'

const external = [
  'react',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-conversation',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    dts: true,
    clean: true,
    external,
  },
  {
    entry: { client: 'src/client.ts' },
    format: 'iife',
    platform: 'browser',
    clean: false,
    outputOptions: { entryFileNames: '[name].js' },
    external,
  },
])
