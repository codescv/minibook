import { MiniBookError, type MiniBookErrorShape } from '@minibook/core';

export type ApiEnvelope<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: MiniBookErrorShape };

export function okEnvelope<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data };
}

export function errorEnvelope(error: unknown): {
  readonly status: 400 | 401 | 404 | 408 | 413 | 500 | 502;
  readonly body: ApiEnvelope<never>;
} {
  const mb = MiniBookError.wrap(error, 'corrupt-book');
  const status = statusForErrorCode(mb.code);
  return {
    status,
    body: { ok: false, error: mb.toShape() },
  };
}

export function statusForErrorCode(
  code: MiniBookErrorShape['code'],
): 400 | 401 | 404 | 408 | 413 | 500 | 502 {
  switch (code) {
    case 'invalid-argument':
    case 'unsupported-format':
    case 'drm-protected':
    case 'corrupt-book':
    case 'unsupported':
      return 400;
    case 'speech-auth':
      return 401;
    case 'not-found':
      return 404;
    case 'too-large':
      return 413;
    case 'cancelled':
      return 408;
    case 'network':
    case 'speech-unavailable':
      return 502;
  }
}
