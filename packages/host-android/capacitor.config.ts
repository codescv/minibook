import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.minibook.app',
  appName: 'Books',
  webDir: 'www',
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // All speech HTTP/WS I/O goes through MiniBookPlugin (OkHttp + secret substitution).
    CapacitorHttp: { enabled: false },
    // MainActivity keeps the WebView edge-to-edge and injects --m-safe-* insets.
    SystemBars: { insetsHandling: 'disable' },
  },
};

export default config;
