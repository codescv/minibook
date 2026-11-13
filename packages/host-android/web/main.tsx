import { mountMiniBookApp } from '@minibook/ui';
import { createCapacitorPlatformHost } from '../src/capacitor-host.js';
import { NativeSpeechPlayer } from '../src/speech/NativeSpeechPlayer.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root mount element');
}

const host = createCapacitorPlatformHost();
const speechPlayer = new NativeSpeechPlayer();
mountMiniBookApp(container, host, speechPlayer);
