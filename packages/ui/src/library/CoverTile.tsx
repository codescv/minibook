import { useRef, type MouseEvent, type ReactElement } from 'react';
import type { LibraryBook } from '@minibook/core';
import { useT } from '../i18n';
import type { ImportTileItem } from './ImportController';

export interface CoverTileProps {
  readonly book: LibraryBook;
  readonly coverUrl: string | null;
  readonly isEink: boolean;
  readonly onOpen: (bookId: string) => void;
  readonly onContextAction: (bookId: string) => void;
}

export function CoverTile({
  book,
  coverUrl,
  isEink,
  onOpen,
  onContextAction,
}: CoverTileProps): ReactElement {
  const t = useT();
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  const rawFraction =
    typeof book.fraction === 'number' && Number.isFinite(book.fraction) ? book.fraction : 0;
  const pct = Math.max(1, Math.min(99, Math.round(rawFraction * 100)));
  const isFinished = Boolean(book.finished) || rawFraction >= 0.995;
  const isUnread = !isFinished && rawFraction <= 0.001;

  const statusA11y = isFinished
    ? t('statusFinished')
    : isUnread
      ? t('statusNew')
      : `${pct} percent`;
  const authors = Array.isArray(book.authors) ? book.authors : [];
  const authorText = authors.join(', ');
  const ariaLabel = authorText
    ? `${book.title}, ${authorText}, ${statusA11y}`
    : `${book.title}, ${statusA11y}`;

  const clearPress = (): void => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    clearPress();
    onContextAction(book.id);
  };

  return (
    <article
      className="mb-cover-item"
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onOpen(book.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(book.id);
        }
      }}
      onContextMenu={handleContextMenu}
      onPointerDown={() => {
        longPressed.current = false;
        clearPress();
        pressTimer.current = setTimeout(() => {
          longPressed.current = true;
          onContextAction(book.id);
        }, 480);
      }}
      onPointerUp={clearPress}
      onPointerCancel={clearPress}
      onPointerLeave={clearPress}
    >
      {coverUrl ? (
        <div className="mb-cover-art">
          <div className="mb-cover-spine" aria-hidden="true" />
          <img src={coverUrl} alt="" loading="lazy" />
        </div>
      ) : (
        <div className="mb-cover-art mb-cover-typographic">
          <div className="mb-cover-typographic-frame">
            <div className="mb-cover-typographic-title">{book.title}</div>
            <svg
              width="24"
              height={isEink ? '2' : '1'}
              viewBox={`0 0 24 ${isEink ? 2 : 1}`}
              shapeRendering="crispEdges"
              aria-hidden="true"
            >
              <rect
                x="0"
                y="0"
                width="24"
                height={isEink ? '2' : '1'}
                fill="currentColor"
                shapeRendering="crispEdges"
              />
            </svg>
            {authorText && (
              <div className="mb-cover-typographic-author">{authorText}</div>
            )}
          </div>
        </div>
      )}

      <div className="mb-cover-status">
        {isFinished ? (
          <span>{t('statusFinished')}</span>
        ) : isUnread ? (
          <span>{t('statusNew')}</span>
        ) : isEink ? (
          <span>{pct} %</span>
        ) : (
          <>
            <div className="mb-progress-track" aria-hidden="true">
              <div className="mb-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span>{pct}%</span>
          </>
        )}
      </div>
    </article>
  );
}

export function ImportStatusTile({
  item,
  onDismiss,
}: {
  readonly item: ImportTileItem;
  readonly onDismiss: (key: string) => void;
}): ReactElement {
  return (
    <article
      className="mb-cover-item"
      role={item.status === 'error' ? 'button' : 'status'}
      tabIndex={item.status === 'error' ? 0 : -1}
      aria-label={item.errorMessage ? `${item.name}: ${item.errorMessage}` : item.stepLabel}
      onClick={() => {
        if (item.status === 'error') onDismiss(item.key);
      }}
    >
      <div className="mb-cover-art mb-cover-typographic">
        <div className="mb-cover-typographic-frame">
          <div className="mb-cover-typographic-title">{item.name}</div>
          <div className="mb-cover-typographic-rule" />
          <div className="mb-cover-typographic-author">
            {item.status === 'error' ? item.errorMessage : item.stepLabel}
          </div>
        </div>
      </div>
      <div className="mb-cover-status">
        <span>{item.status === 'error' ? '✕' : item.stepLabel}</span>
      </div>
    </article>
  );
}
