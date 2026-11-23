import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  timeout: 60000,
  use: {
    headless: true,
    baseURL: 'http://localhost:5199',
    // SwiftShader/软件 GL 也可，确保无头环境有 WebGL2
    launchOptions: {
      args: ['--use-angle=gl', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'npx vite --port 5199',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
