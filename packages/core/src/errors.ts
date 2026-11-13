import type { MiniBookErrorCode, MiniBookErrorShape } from './types.js';

/**
 * Error thrown across every MiniBook boundary (`ARCHITECTURE.md` §0).
 * Hosts serialise with `toShape()`; REST / Capacitor clients rebuild with `fromShape()`;
 * the UI switches exhaustively on `error.code`.
 */
export class MiniBookError extends Error implements MiniBookErrorShape {
  readonly code: MiniBookErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: MiniBookErrorCode,
    message: string,
    options?: { readonly details?: Readonly<Record<string, unknown>>; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MiniBookError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }

  toShape(): MiniBookErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  static fromShape(shape: MiniBookErrorShape): MiniBookError {
    return new MiniBookError(
      shape.code,
      shape.message,
      shape.details === undefined ? undefined : { details: { ...shape.details } },
    );
  }

  static wrap(error: unknown, fallbackCode: MiniBookErrorCode = 'corrupt-book'): MiniBookError {
    if (error instanceof MiniBookError) return error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return new MiniBookError('cancelled', error.message || 'Operation cancelled', { cause: error });
      }
      return new MiniBookError(fallbackCode, error.message, { cause: error });
    }
    return new MiniBookError(fallbackCode, String(error));
  }
}

export function isMiniBookError(value: unknown): value is MiniBookError {
  return value instanceof MiniBookError;
}
