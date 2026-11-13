import { create } from 'zustand';
import {
  MiniBookError,
  type BookFormat,
  type ImportSource,
  type PlatformHost,
} from '@minibook/core';
import { inspectBookWithHost } from '../host/core-bridge';
import { resolveLocale, translate } from '../i18n';

export interface ImportTileItem {
  readonly key: string;
  readonly name: string;
  readonly status: 'importing' | 'error';
  readonly stepLabel?: string;
  readonly errorMessage?: string;
}

interface ImportStoreState {
  items: ImportTileItem[];
  upsert(item: ImportTileItem): void;
  remove(key: string): void;
  reset(): void;
}

export const useImportStore = create<ImportStoreState>((set) => ({
  items: [],
  upsert(item) {
    set((s) => {
      const idx = s.items.findIndex((x) => x.key === item.key);
      if (idx < 0) return { items: [item, ...s.items] };
      const copy = [...s.items];
      copy[idx] = item;
      return { items: copy };
    });
  },
  remove(key) {
    set((s) => ({ items: s.items.filter((x) => x.key !== key) }));
  },
  reset() {
    set({ items: [] });
  },
}));

export function fileToImportSource(file: File): ImportSource {
  return {
    name: file.name,
    size: file.size,
    bytes: {
      size: file.size,
      async read(offset: number, length: number): Promise<Uint8Array> {
        const start = Math.max(0, Math.min(file.size, offset));
        const end = Math.max(start, Math.min(file.size, start + Math.max(0, length)));
        const buf = await file.slice(start, end).arrayBuffer();
        return new Uint8Array(buf);
      },
      async readAll(): Promise<Uint8Array> {
        const buf = await file.arrayBuffer();
        return new Uint8Array(buf);
      },
    },
  };
}

function mapImportErrorMessage(err: unknown): string {
  const locale = resolveLocale();
  const wrapped = MiniBookError.wrap(err, 'corrupt-book');
  switch (wrapped.code) {
    case 'drm-protected':
      return translate(locale, 'errorDrm');
    case 'unsupported-format':
      return translate(locale, 'errorUnsupported');
    case 'too-large':
      return translate(locale, 'errorTooLarge');
    default:
      return translate(locale, 'errorCorrupt');
  }
}

export function formatBookFormatLabel(fmt: BookFormat): string {
  switch (fmt) {
    case 'epub':
      return 'EPUB';
    case 'kf8':
      return 'AZW3 (KF8)';
    case 'mobi':
      return 'MOBI';
    case 'fb2':
      return 'FB2';
    case 'md':
      return 'Markdown';
    case 'txt':
      return 'TXT';
  }
}

export class ImportController {
  private readonly host: PlatformHost;
  private lastProgressUpdateMs = 0;

  constructor(host: PlatformHost) {
    this.host = host;
  }

  async pickAndImport(isEink: boolean, onImported?: () => void): Promise<void> {
    const picked = await this.host.files.pickBooks();
    if (picked.length === 0) return;
    await this.importSources(picked, isEink, onImported);
  }

  async importDroppedFiles(
    fileList: FileList | readonly File[],
    isEink: boolean,
    onImported?: () => void,
  ): Promise<void> {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const sources = files.map(fileToImportSource);
    await this.importSources(sources, isEink, onImported);
  }

  async importSources(
    sources: readonly ImportSource[],
    isEink: boolean,
    onImported?: () => void,
  ): Promise<void> {
    const locale = resolveLocale();
    const total = sources.length;

    for (let i = 0; i < total; i++) {
      const src = sources[i]!;
      const key = `imp_${Date.now()}_${i}`;
      const now = Date.now();
      const canEmitStep = !isEink || now - this.lastProgressUpdateMs >= 1000 || i === 0;
      if (canEmitStep) {
        this.lastProgressUpdateMs = now;
      }

      useImportStore.getState().upsert({
        key,
        name: src.name,
        status: 'importing',
        stepLabel: `${translate(locale, 'importing')} ${i + 1} / ${total}`,
      });

      let ticket: Awaited<ReturnType<PlatformHost['library']['beginImport']>> | null = null;
      try {
        ticket = await this.host.library.beginImport(src);
        const activeTicket = ticket;
        const inspected = await inspectBookWithHost(this.host, src, {
          fileName: src.name,
          putDerived: (name, chunk) => activeTicket.putDerived(name, chunk),
        });
        await this.host.library.commitImport(ticket, inspected);
        useImportStore.getState().remove(key);
        onImported?.();
      } catch (err) {
        if (ticket) {
          await ticket.abort().catch(() => {});
        }
        useImportStore.getState().upsert({
          key,
          name: src.name,
          status: 'error',
          errorMessage: mapImportErrorMessage(err),
        });
      }
    }
  }
}
