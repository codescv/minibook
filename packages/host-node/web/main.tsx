import { createWebSpeechPlayer, mountMiniBookApp } from '@minibook/ui';
import { createRestPlatformHost } from '../src/client/rest-host.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root mount element');
}

const host = createRestPlatformHost();
const speechPlayer = createWebSpeechPlayer();
mountMiniBookApp(container, host, speechPlayer);
