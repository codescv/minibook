import type { FullRefreshCadence, PlatformHost } from '@minibook/core';

export interface RefreshControllerDeps {
  readonly host: PlatformHost;
  readonly setFlashPhase: (phase: 'black' | 'white' | null) => void;
  readonly blackHoldMs?: number;
  readonly whiteHoldMs?: number;
  readonly waitPaint?: () => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultWaitPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * E-Ink anti-ghosting refresh controller (`ARCHITECTURE.md` §9.4).
 *
 * Strictly mutually exclusive branches:
 * - Vendor branch: swaps page first -> awaits 2x rAF -> calls `host.device.fullRefresh()`.
 *   If native returns `false`, permanently downgrades `vendorRefreshUsable = false` for the
 *   session and runs a single recovery flash without swapping a second time.
 * - Software flash branch: mounts solid `#000000` overlay BEFORE swapping -> swaps underneath ->
 *   holds 150ms -> switches to solid `#FFFFFF` for 60ms -> unmounts overlay.
 */
export class RefreshController {
  private turnsSinceFull = 0;
  private vendorRefreshUsable: boolean;
  private pending: Promise<void> = Promise.resolve();
  private inFlight = false;
  private readonly host: PlatformHost;
  private readonly setFlashPhase: (phase: 'black' | 'white' | null) => void;
  private readonly blackHoldMs: number;
  private readonly whiteHoldMs: number;
  private readonly waitPaint: () => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: RefreshControllerDeps) {
    this.host = deps.host;
    this.vendorRefreshUsable = deps.host.info.capabilities.vendorRefresh;
    this.setFlashPhase = deps.setFlashPhase;
    this.blackHoldMs = deps.blackHoldMs ?? 150;
    this.whiteHoldMs = deps.whiteHoldMs ?? 60;
    this.waitPaint = deps.waitPaint ?? defaultWaitPaint;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  getTurnsSinceFull(): number {
    return this.turnsSinceFull;
  }

  isVendorRefreshUsable(): boolean {
    return this.vendorRefreshUsable;
  }

  runTurn(options: {
    readonly isEink: boolean;
    readonly cadence: FullRefreshCadence;
    readonly swap: () => void | Promise<void>;
    readonly closedSheetCoveredHalfScreen?: boolean;
    readonly userPressedRefresh?: boolean;
    readonly countTurn?: boolean;
  }): Promise<void> {
    if (!options.isEink) {
      return Promise.resolve(options.swap());
    }

    const shouldCount = options.countTurn !== false && !options.userPressedRefresh;

    // Fast synchronous path when idle and no full refresh is triggered on this turn:
    // avoids async microtask lag on non-flashing turns/Back navigation while staying strictly serialized
    // whenever a 210ms software flash or vendor refresh is active (`inFlight`).
    if (!this.inFlight) {
      const nextCount = shouldCount ? this.turnsSinceFull + 1 : this.turnsSinceFull;
      const needNow =
        options.countTurn !== false &&
        options.cadence !== 0 &&
        (nextCount >= options.cadence ||
          Boolean(options.closedSheetCoveredHalfScreen) ||
          Boolean(options.userPressedRefresh));

      if (!needNow) {
        this.turnsSinceFull = nextCount;
        const syncOrAsync = options.swap();
        if (syncOrAsync && typeof (syncOrAsync as PromiseLike<void>).then === 'function') {
          this.inFlight = true;
          const tracked = Promise.resolve(syncOrAsync).finally(() => {
            this.inFlight = false;
          });
          this.pending = tracked.catch(() => {});
          return tracked;
        }
        return Promise.resolve();
      }
    }

    this.inFlight = true;
    let safeRun!: Promise<void>;
    const run = this.pending
      .then(
        () => this.executeEinkTurn(options),
        () => this.executeEinkTurn(options),
      )
      .finally(() => {
        if (this.pending === safeRun) {
          this.inFlight = false;
        }
      });
    safeRun = run.catch(() => {
      this.inFlight = false;
    });
    this.pending = safeRun;
    return run;
  }

  private async executeEinkTurn(options: {
    readonly isEink: boolean;
    readonly cadence: FullRefreshCadence;
    readonly swap: () => void | Promise<void>;
    readonly closedSheetCoveredHalfScreen?: boolean;
    readonly userPressedRefresh?: boolean;
    readonly countTurn?: boolean;
  }): Promise<void> {
    if (!options.isEink) {
      await options.swap();
      return;
    }

    if (options.countTurn === false) {
      await options.swap();
      return;
    }

    if (!options.userPressedRefresh) {
      this.turnsSinceFull += 1;
    }

    // ARCHITECTURE.md §9.4: `need = settings.fullRefreshEvery != off && (...)`
    const need =
      options.cadence !== 0 &&
      (this.turnsSinceFull >= options.cadence ||
        Boolean(options.closedSheetCoveredHalfScreen) ||
        Boolean(options.userPressedRefresh));

    if (!need) {
      await options.swap();
      return;
    }

    if (this.vendorRefreshUsable) {
      await options.swap();
      await this.waitPaint();
      let ok = false;
      try {
        ok = await this.host.device.fullRefresh();
      } catch {
        ok = false;
      }
      if (!ok) {
        this.vendorRefreshUsable = false;
        // Single-turn fallback without second swap
        this.setFlashPhase('black');
        await this.waitPaint();
        await this.sleep(this.blackHoldMs);
        this.setFlashPhase('white');
        await this.sleep(this.whiteHoldMs);
        this.setFlashPhase(null);
      }
    } else {
      // Pre-swap software flash: mount #000000 first so swap happens unseen underneath
      this.setFlashPhase('black');
      await this.waitPaint();
      await options.swap();
      await this.sleep(this.blackHoldMs);
      this.setFlashPhase('white');
      await this.sleep(this.whiteHoldMs);
      this.setFlashPhase(null);
    }

    this.turnsSinceFull = 0;
  }
}
