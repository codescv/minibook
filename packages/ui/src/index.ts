import type { PlatformHost, SpeechPlayer } from '@minibook/core';

export interface MountedMiniBookApp {
  unmount(): void;
}

export function mountMiniBookApp(
  _container: HTMLElement,
  _host: PlatformHost,
  _speechPlayer: SpeechPlayer,
): MountedMiniBookApp {
  return {
    unmount() {},
  };
}
