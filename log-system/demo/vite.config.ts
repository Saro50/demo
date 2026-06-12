import { defineConfig } from 'vite';

export default defineConfig({
  root: 'browser',
  server: {
    port: 3102,
    open: '/sdk-test.html',
  },
  resolve: {
    // Vite 自动解析 node_modules 中的包名，不需要额外配置
    // @myby/log-sdk → node_modules/@myby/log-sdk/package.json → src/index.ts
  },
});
