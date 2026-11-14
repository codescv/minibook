import {
  DEFAULT_APP_SETTINGS,
  KOKORO_DEFAULT_VOICES,
  MiniBookError,
  memoryByteSource,
  type AppSettings,
  type AttachedAudio,
  type BookId,
  type BookInspectHint,
  type BookMeta,
  type BookResource,
  type BookSession,
  type Bookmark,
  type BookmarkInput,
  type ByteSource,
  type DeviceInfo,
  type HostCapabilities,
  type HostEvent,
  type HostPlatform,
  type ImportSource,
  type ImportTicket,
  type InspectedBook,
  type KeyPolicy,
  type LibraryBook,
  type LibraryBookDetail,
  type PlatformHost,
  type ResolvedHref,
  type SavedPosition,
  type SearchHit,
  type SectionDoc,
  type SectionRef,
  type SectionText,
  type SleepTimerConfig,
  type SpeechEvent,
  type SpeechModelState,
  type SpeechModelStatus,
  type SpeechPlayer,
  type SpeechSession,
  type SpeechState,
  type StorageUsage,
  type SynthRequest,
  type SynthResult,
  type TocItem,
  type Unsubscribe,
  type Utterance,
  type Voice,
  type VoiceRef,
} from '@minibook/core';
import type { MockHostHooks, SearchFallbackSession } from './core-bridge';

export interface MockSectionFixture {
  readonly title: string;
  readonly xhtml: string;
  readonly css?: string;
  readonly lang?: string | null;
  readonly dir?: 'ltr' | 'rtl';
  readonly text: SectionText;
  readonly resources?: readonly string[];
  /** Optional byte-weight override (`sizeHint !== text.text.length`) for `[P1-F1]` testing. */
  readonly sizeHint?: number;
}

export interface MockBookFixture {
  readonly id: BookId;
  readonly meta: BookMeta;
  readonly fileName: string;
  readonly size: number;
  readonly hasCover: boolean;
  readonly coverSvg?: string;
  readonly addedAt: number;
  readonly openedAt: number | null;
  readonly finished: boolean;
  readonly fraction: number;
  readonly initialPosition?: SavedPosition;
  readonly toc: readonly TocItem[];
  readonly sections: readonly MockSectionFixture[];
  readonly resources?: Readonly<Record<string, { readonly mime: string; readonly bytes: Uint8Array }>>;
}

function makeTextFromParagraphs(
  heading: string | null,
  paragraphs: readonly string[],
  lang: string | null = 'en',
): { xhtml: string; text: SectionText } {
  const blocks: Array<{ start: number; end: number; kind: 'h' | 'p'; lang: string | null }> = [];
  let acc = '';
  const parts: string[] = [];

  if (heading) {
    const s = acc.length;
    acc += heading;
    blocks.push({ start: s, end: acc.length, kind: 'h', lang });
    parts.push(`<h2>${escapeXml(heading)}</h2>`);
  }

  paragraphs.forEach((p, idx) => {
    const s = acc.length;
    acc += p;
    blocks.push({ start: s, end: acc.length, kind: 'p', lang });
    const cls = idx === 0 && heading ? ' class="mb-no-indent"' : '';
    parts.push(`<p${cls}>${escapeXml(p)}</p>`);
  });

  return {
    xhtml: parts.join('\n'),
    text: { text: acc, blocks },
  };
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PLATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160" width="240" height="160">
  <rect x="2" y="2" width="236" height="156" fill="#FFFFFF" stroke="#000000" stroke-width="3"/>
  <circle cx="120" cy="80" r="44" fill="none" stroke="#000000" stroke-width="3"/>
  <path d="M72 114 L120 42 L168 114 Z" fill="none" stroke="#000000" stroke-width="3"/>
</svg>`;

const COVER_SVG_DICKENS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300">
  <rect width="200" height="300" fill="#000000"/>
  <rect x="14" y="14" width="172" height="272" fill="none" stroke="#FFFFFF" stroke-width="2"/>
  <circle cx="100" cy="120" r="34" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
  <path d="M68 148 L100 92 L132 148 Z" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
</svg>`;

const COVER_SVG_LUXUN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300">
  <rect width="200" height="300" fill="#FFFFFF"/>
  <rect x="16" y="16" width="168" height="268" fill="none" stroke="#000000" stroke-width="3"/>
  <line x1="40" y1="90" x2="160" y2="90" stroke="#000000" stroke-width="3"/>
  <line x1="40" y1="210" x2="160" y2="210" stroke="#000000" stroke-width="3"/>
</svg>`;

export function buildDefaultMockFixtures(): MockBookFixture[] {
  const dickensCh1 = makeTextFromParagraphs(
    'I. The Period',
    [
      'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us, we were all going direct to Heaven, we were all going direct the other way.',
      'There were a king with a large jaw and a queen with a plain face, on the throne of England; there were a king with a large jaw and a queen with a fair face, on the throne of France. In both countries it was clearer than crystal to the lords of the State preserves of loaves and fishes, that things in general were settled for ever.',
      'It was the year of Our Lord one thousand seven hundred and seventy-five. Spiritual revelations were conceded to England at that favoured period, as at this. Mrs. Southcott had recently attained her five-and-twentieth blessed birthday, of whom a prophetic private in the Life Guards had heralded the sublime appearance by announcing that arrangements were made for the swallowing up of London and Westminster.',
      'France, less favoured on the whole as to matters spiritual than her sister of the shield and trident, rolled with exceeding smoothness down hill, making paper money and spending it. Under the guidance of her Christian pastors, she entertained herself, besides, with such humane achievements as sentencing a youth to have his hands cut off and his body burned alive because he had not kneeled down in the rain to do honour to a dirty procession of monks.',
      'In England, there was scarcely an amount of order and protection to justify much national boasting. Daring burglaries by armed men, and highway robberies, took place in the capital itself every night; families were publicly cautioned not to go out of town without removing their furniture to upholsterers warehouses for security.',
      'All these things, and a thousand like them, came to pass in and close upon the dear old year one thousand seven hundred and seventy-five. Environed by them, while the Woodman and the Farmer worked unheeded, those two of the large jaws, and those other two of the plain and the fair faces, trod with stir enough, and carried their divine rights with a high hand.',
    ],
    'en',
  );

  // Add an internal cross-reference link, an <img>, AND an XML-namespaced <svg><image xlink:href="mb-res:..."/></svg> cover plate (`[P1-U6]`)
  const dickensCh1Xhtml =
    dickensCh1.xhtml +
    `\n<figure data-mb-skip="" aria-hidden="true"><img src="mb-res:images/plate1.svg" alt="Engraved frontispiece" width="200" height="130"/></figure>` +
    `\n<div data-mb-skip="" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 240 160" width="120" height="80"><image width="240" height="160" xlink:href="mb-res:images/plate1.svg"/></svg></div>` +
    `\n<p data-mb-skip=""><a href="#" data-mb-loc="1:0">[Jump to Chapter II]</a> <a href="#" data-mb-ext="https://standardebooks.org">[External Edition]</a></p>`;

  const dickensCh2 = makeTextFromParagraphs(
    'II. The Mail',
    [
      'It was the Dover road that lay, on a Friday night late in November, before the first of the persons with whom this history has business. The Dover road lay, as to him, beyond the Dover mail, as it lumbered up Shooters Hill. He walked up hill in the mire by the side of the mail, as the rest of the passengers did; not because they had the least relish for walking exercise under the circumstances, but because the hill, and the harness, and the mud, and the mail, were all so heavy, that the horses had three times already come to a stop.',
      'With drooping heads and tremulous tails, they mashed their way through the thick mud, floundering and stumbling between whiles, as if they were falling to pieces at the larger joints. As often as the driver rested them and brought them to a stand, with a wary Wo-ho! so-ho-then! the near leader violently shook his head and everything upon it, like an unusually emphatic horse, denying that the coach could be got up the hill.',
      'Two other passengers, besides the one, were plodding up the hill by the side of the mail. All three were wrapped to the cheekbones and over the ears, and wore jack-boots. Not one of the three could have said, from anything he saw, what either of the other two was like; and each was hidden under almost as many wrappers from the eyes of the mind, as from the eyes of the body, of his two companions.',
    ],
    'en',
  );

  const dickensCh3 = makeTextFromParagraphs(
    'III. The Night Shadows',
    [
      'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other. A solemn consideration, when I enter a great city by night, that every one of those darkly clustered houses encloses its own secret; that every room in every one of them encloses its own secret; that every beating heart in the hundreds of thousands of breasts there, is, in some of its imaginings, a secret to the heart nearest it!',
      'Something of the awfulness, even of Death itself, is referable to this. No more can I turn the leaves of this dear book that I loved, and vainly hope in time to read it all. Better, looking mysteriously up at the light, and down at the dark, to ride on into the night.',
    ],
    'en',
  );

  // CJK + Ruby + Footnote skip-subtree fixture verifying I-TEXT 1-to-1 invariant
  const luxunHeading = '故乡';
  const luxunP1 = '我冒了严寒，回到相隔二千余里，别了二十余年的故乡去。';
  const luxunP2Before = '时候既然是深冬；渐近故乡时，天气又阴晦了，冷风吹进船舱中，呜呜的响，从篷隙向外一望，苍黄的天底下，远近横着几个萧索的荒村，没有一些';
  const luxunRubyBase = '活气';
  const luxunP2After = '。我的心禁不住悲凉起来了。';
  const luxunP2Counted = luxunP2Before + luxunRubyBase + luxunP2After;
  const luxunFullText = luxunHeading + luxunP1 + luxunP2Counted;
  const luxunSection: MockSectionFixture = {
    title: '故乡',
    lang: 'zh-CN',
    dir: 'ltr',
    xhtml: [
      `<h2>${luxunHeading}</h2>`,
      `<p class="mb-no-indent">${luxunP1}<sup data-mb-skip="">[1]</sup></p>`,
      `<p>${luxunP2Before}<ruby>${luxunRubyBase}<rt data-mb-skip="">かつき</rt></ruby>${luxunP2After}</p>`,
    ].join('\n'),
    text: {
      text: luxunFullText,
      blocks: [
        { start: 0, end: luxunHeading.length, kind: 'h', lang: 'zh-CN' },
        {
          start: luxunHeading.length,
          end: luxunHeading.length + luxunP1.length,
          kind: 'p',
          lang: 'zh-CN',
        },
        {
          start: luxunHeading.length + luxunP1.length,
          end: luxunFullText.length,
          kind: 'p',
          lang: 'zh-CN',
        },
      ],
    },
  };

  const calvinoCh1 = makeTextFromParagraphs(
    'Cities & Memory 1',
    [
      'Leaving there and proceeding for three days toward the east, you reach Diomira, a city with sixty silver domes, bronze statues of all the gods, streets paved with lead, a crystal theater, a golden cock that crows each morning on a tower.',
      'All these beauties will already be familiar to the visitor, who has seen them also in other cities. But the special quality of this city for the man who arrives there on a September evening, when the days are growing shorter and the multicolored lamps are lighted all at once at the doors of the food stalls, is that he feels envy toward those who now believe they have once before lived an evening identical to this and who think they were happy, that time.',
    ],
    'en',
  );

  const zhangdaiCh1 = makeTextFromParagraphs(
    '湖心亭看雪',
    [
      '崇祯五年十二月，余住西湖。大雪三日，湖中人鸟声俱绝。是日更定矣，余拏一小舟，拥毳衣炉火，独往湖心亭看雪。',
      '雾凇沆砀，天与云与山与水，上下一白。湖上影子，惟长堤一痕、湖心亭一点、与余舟一芥、舟中人两三粒而已。',
    ],
    'zh-CN',
  );

  // 42,000-character chapter testing virtual render units & bounded multicol width
  const longParas: string[] = [];
  const basePara =
    'In the quiet scriptorium by the northern sea, the chronicler measured each column with unhurried precision, leaving generous margins so the eye might rest upon the page without fatigue or haste. ';
  for (let i = 0; i < 220; i++) {
    longParas.push(`Paragraph ${i + 1}. ${basePara}`);
  }
  const longCh = makeTextFromParagraphs('The Northern Scriptorium', longParas, 'en');

  // Adversarial XSS probe chapter: verifies SectionFrame's 4-layer CSP blocks inline/tag scripts and remote loads
  const xssHeading = 'Security Probe';
  const xssBody = 'Clean readable prose rendered safely inside the isolated frame.';
  const xssSection: MockSectionFixture = {
    title: xssHeading,
    lang: 'en',
    dir: 'ltr',
    xhtml: [
      `<h2>${xssHeading}</h2>`,
      `<p class="mb-no-indent">${xssBody}</p>`,
      `<script data-mb-skip="">window.parent.__xssExecuted = true; window.__xssFrameExecuted = true;</script>`,
      `<img data-mb-skip="" src="https://evil.example.invalid/pixel.png" onerror="window.parent.__xssExecuted = true" alt=""/>`,
    ].join('\n'),
    text: {
      text: xssHeading + xssBody,
      blocks: [
        { start: 0, end: xssHeading.length, kind: 'h', lang: 'en' },
        { start: xssHeading.length, end: xssHeading.length + xssBody.length, kind: 'p', lang: 'en' },
      ],
    },
  };

  return [
    {
      id: 'b_dickens',
      meta: {
        title: 'A Tale of Two Cities',
        authors: ['Charles Dickens'],
        language: 'en',
        identifier: 'urn:uuid:dickens-two-cities',
        format: 'epub',
        direction: 'ltr',
        fixedLayout: false,
      },
      fileName: 'a-tale-of-two-cities.epub',
      size: 742_400,
      hasCover: true,
      coverSvg: COVER_SVG_DICKENS,
      addedAt: 1_762_000_000_000,
      openedAt: 1_763_000_000_000,
      finished: false,
      fraction: 0.62,
      toc: [
        { title: 'I. The Period', locator: { section: 0, offset: 0 }, children: [] },
        { title: 'II. The Mail', locator: { section: 1, offset: 0 }, children: [] },
        { title: 'III. The Night Shadows', locator: { section: 2, offset: 0 }, children: [] },
      ],
      sections: [
        {
          title: 'I. The Period',
          xhtml: dickensCh1Xhtml,
          lang: 'en',
          dir: 'ltr',
          text: dickensCh1.text,
          resources: ['images/plate1.svg'],
        },
        {
          title: 'II. The Mail',
          xhtml: dickensCh2.xhtml,
          lang: 'en',
          dir: 'ltr',
          text: dickensCh2.text,
        },
        {
          title: 'III. The Night Shadows',
          xhtml: dickensCh3.xhtml,
          lang: 'en',
          dir: 'ltr',
          text: dickensCh3.text,
        },
      ],
      resources: {
        'images/plate1.svg': {
          mime: 'image/svg+xml',
          bytes: new TextEncoder().encode(PLATE_SVG),
        },
      },
    },
    {
      id: 'b_luxun',
      meta: {
        title: '呐喊',
        authors: ['鲁迅'],
        language: 'zh-CN',
        identifier: 'urn:uuid:luxun-nahan',
        format: 'kf8',
        direction: 'ltr',
        fixedLayout: false,
      },
      fileName: 'nahan.azw3',
      size: 512_000,
      hasCover: true,
      coverSvg: COVER_SVG_LUXUN,
      addedAt: 1_762_100_000_000,
      openedAt: 1_762_900_000_000,
      finished: false,
      fraction: 0,
      toc: [{ title: '故乡', locator: { section: 0, offset: 0 }, children: [] }],
      sections: [luxunSection],
    },
    {
      id: 'b_calvino',
      meta: {
        title: 'Invisible Cities',
        authors: ['Italo Calvino'],
        language: 'en',
        identifier: 'urn:uuid:calvino-cities',
        format: 'epub',
        direction: 'ltr',
        fixedLayout: false,
      },
      fileName: 'invisible-cities.epub',
      size: 388_000,
      hasCover: false,
      addedAt: 1_761_800_000_000,
      openedAt: 1_762_500_000_000,
      finished: true,
      fraction: 1,
      toc: [{ title: 'Cities & Memory 1', locator: { section: 0, offset: 0 }, children: [] }],
      sections: [
        {
          title: 'Cities & Memory 1',
          xhtml: calvinoCh1.xhtml,
          lang: 'en',
          dir: 'ltr',
          text: calvinoCh1.text,
        },
      ],
    },
    {
      id: 'b_zhangdai',
      meta: {
        title: '陶庵梦忆',
        authors: ['〔明〕张岱'],
        language: 'zh-CN',
        identifier: null,
        format: 'txt',
        direction: 'ltr',
        fixedLayout: false,
      },
      fileName: 'taoan-mengyi.txt',
      size: 196_000,
      hasCover: false,
      addedAt: 1_761_500_000_000,
      openedAt: 1_762_200_000_000,
      finished: false,
      fraction: 0.45,
      toc: [{ title: '湖心亭看雪', locator: { section: 0, offset: 0 }, children: [] }],
      sections: [
        {
          title: '湖心亭看雪',
          xhtml: zhangdaiCh1.xhtml,
          lang: 'zh-CN',
          dir: 'ltr',
          text: zhangdaiCh1.text,
        },
      ],
    },
    {
      id: 'b_long40k',
      meta: {
        title: 'The Northern Scriptorium',
        authors: ['Aldus Manutius'],
        language: 'en',
        identifier: 'urn:uuid:long-40k',
        format: 'md',
        direction: 'ltr',
        fixedLayout: false,
      },
      fileName: 'scriptorium.md',
      size: 92_000,
      hasCover: false,
      addedAt: 1_761_200_000_000,
      openedAt: 1_761_900_000_000,
      finished: false,
      fraction: 0.12,
      toc: [{ title: 'The Northern Scriptorium', locator: { section: 0, offset: 0 }, children: [] }],
      sections: [
        {
          title: 'The Northern Scriptorium',
          xhtml: longCh.xhtml,
          lang: 'en',
          dir: 'ltr',
          text: longCh.text,
        },
      ],
    },
    {
      id: 'b_xss',
      meta: {
        title: 'Security Probe',
        authors: ['Adversarial Suite'],
        language: 'en',
        identifier: 'urn:uuid:xss-probe',
        format: 'epub',
        direction: 'ltr',
        fixedLayout: false,
      },
      fileName: 'xss-probe.epub',
      size: 16_384,
      hasCover: false,
      addedAt: 1_761_000_000_000,
      openedAt: null,
      finished: false,
      fraction: 0,
      toc: [{ title: 'Security Probe', locator: { section: 0, offset: 0 }, children: [] }],
      sections: [xssSection],
    },
  ];
}

/**
 * Single-file multi-unit EPUB fixture (`75,000` counted chars across 2 virtual render units,
 * 5 anchored chapters at exact `0 / 15,000 / 30,000 / 45,000 / 60,000` char offsets = `0/20/40/60/80%`,
 * and `sizeHint = 42,000` bytes != `75,000` chars) for `[P1-F1]` verification.
 */
export function buildSingleFileFiveChapterFixture(): MockBookFixture {
  const CHAPTER_LEN = 15_000;
  const blocks: Array<{ start: number; end: number; kind: 'h' | 'p'; lang: string | null }> = [];
  const xhtmlParts: string[] = [];
  let acc = '';
  const toc: TocItem[] = [];

  for (let ch = 1; ch <= 5; ch++) {
    const chStart = acc.length;
    toc.push({
      title: `Chapter ${ch}: Part ${ch}`,
      locator: { section: 0, offset: chStart },
      children: [],
    });

    const heading = `Chapter ${ch}: Part ${ch}`;
    blocks.push({ start: acc.length, end: acc.length + heading.length, kind: 'h', lang: 'en' });
    acc += heading;
    xhtmlParts.push(`<h2 id="ch-${ch}">${escapeXml(heading)}</h2>`);

    const targetEnd = ch * CHAPTER_LEN;
    let pIdx = 1;
    while (acc.length < targetEnd) {
      const remaining = targetEnd - acc.length;
      const base = `Ch${ch}P${pIdx} anchorprose: steady typographic cadence across unified spine text. `;
      let para = '';
      while (para.length + base.length <= Math.min(remaining, 300)) {
        para += base;
      }
      if (para.length < Math.min(remaining, 300)) {
        const fillLen = Math.min(remaining, 300) - para.length;
        para += 'x'.repeat(Math.max(0, fillLen - 1)) + (fillLen > 0 ? '.' : '');
      }
      const s = acc.length;
      acc += para;
      blocks.push({ start: s, end: acc.length, kind: 'p', lang: 'en' });
      xhtmlParts.push(`<p>${escapeXml(para)}</p>`);
      pIdx += 1;
    }
  }

  return {
    id: 'b_single5',
    meta: {
      title: 'Five Anchored Chapters',
      authors: ['Single Spine Press'],
      language: 'en',
      identifier: 'urn:uuid:single-5ch',
      format: 'epub',
      direction: 'ltr',
      fixedLayout: false,
    },
    fileName: 'single-5ch.epub',
    size: 42_000,
    hasCover: false,
    addedAt: 1_762_000_000_000,
    openedAt: 1_762_100_000_000,
    finished: false,
    fraction: 0,
    toc,
    sections: [
      {
        title: 'Complete Text',
        xhtml: xhtmlParts.join('\n'),
        lang: 'en',
        dir: 'ltr',
        text: { text: acc, blocks },
        // Byte weight intentionally mismatches 75,000 counted characters!
        sizeHint: 42_000,
      },
    ],
  };
}

class MockBookSessionImpl implements SearchFallbackSession {
  readonly meta: BookMeta;
  readonly toc: readonly TocItem[];
  readonly spine: readonly SectionRef[];
  private readonly fixture: MockBookFixture;

  constructor(fixture: MockBookFixture) {
    this.fixture = fixture;
    this.meta = fixture.meta;
    this.toc = fixture.toc;
    this.spine = fixture.sections.map((sec, idx) => ({
      index: idx,
      title: sec.title,
      linear: true,
      sizeHint: Math.max(1, sec.sizeHint ?? sec.text.text.length),
    }));
  }

  private splitUnits(sec: MockSectionFixture): SectionDoc[] {
    const MAX_CHARS = 40_000;
    if (sec.text.text.length <= MAX_CHARS) {
      return [
        {
          index: this.fixture.sections.indexOf(sec),
          unit: { start: 0, end: sec.text.text.length },
          unitIndex: 0,
          units: [{ start: 0, end: sec.text.text.length }],
          xhtml: sec.xhtml,
          css: sec.css ?? '',
          lang: sec.lang ?? this.meta.language,
          dir: sec.dir ?? this.meta.direction,
          text: sec.text,
          resources: sec.resources ?? [],
        },
      ];
    }

    // Split > 40,000-char section at block boundaries into <= 40,000-char virtual render units
    const sectionIdx = this.fixture.sections.indexOf(sec);
    const blockStrings = sec.xhtml.split('\n');
    const groups: Array<{ start: number; end: number; xhtmlParts: string[]; blocks: SectionText['blocks'][number][] }> = [];
    let current = { start: 0, end: 0, xhtmlParts: [] as string[], blocks: [] as SectionText['blocks'][number][] };

    sec.text.blocks.forEach((blk, idx) => {
      const blkLen = blk.end - blk.start;
      if (current.blocks.length > 0 && current.end - current.start + blkLen > MAX_CHARS) {
        groups.push(current);
        current = { start: blk.start, end: blk.start, xhtmlParts: [], blocks: [] };
      }
      current.end = blk.end;
      current.xhtmlParts.push(blockStrings[idx] ?? `<p>${escapeXml(sec.text.text.slice(blk.start, blk.end))}</p>`);
      current.blocks.push({
        start: blk.start - current.start,
        end: blk.end - current.start,
        kind: blk.kind,
        lang: blk.lang,
      });
    });
    if (current.blocks.length > 0) groups.push(current);

    const units = groups.map((g) => ({ start: g.start, end: g.end }));
    return groups.map((g, uIdx) => ({
      index: sectionIdx,
      unit: { start: g.start, end: g.end },
      unitIndex: uIdx,
      units,
      xhtml: g.xhtmlParts.join('\n'),
      css: sec.css ?? '',
      lang: sec.lang ?? this.meta.language,
      dir: sec.dir ?? this.meta.direction,
      text: {
        text: sec.text.text.slice(g.start, g.end),
        blocks: g.blocks,
      },
      resources: sec.resources ?? [],
    }));
  }

  async loadSection(index: number, unitIndex = 0): Promise<SectionDoc> {
    const sec = this.fixture.sections[index];
    if (!sec) {
      throw new MiniBookError('not-found', `Section ${index} not found`);
    }
    const units = this.splitUnits(sec);
    const clamped = Math.max(0, Math.min(units.length - 1, unitIndex));
    return units[clamped]!;
  }

  async loadSectionUnits(index: number): Promise<readonly SectionDoc[]> {
    const sec = this.fixture.sections[index];
    if (!sec) throw new MiniBookError('not-found', `Section ${index} not found`);
    return this.splitUnits(sec);
  }

  async loadSectionText(index: number): Promise<SectionText> {
    const sec = this.fixture.sections[index];
    if (!sec) throw new MiniBookError('not-found', `Section ${index} not found`);
    return sec.text;
  }

  async loadResource(href: string): Promise<BookResource> {
    const res = this.fixture.resources?.[href];
    if (!res) throw new MiniBookError('not-found', `Resource ${href} not found`);
    return res;
  }

  resolveHref(fromSection: number, href: string): ResolvedHref {
    if (/^https?:\/\/|^mailto:/i.test(href)) {
      return { external: href };
    }
    const m = href.match(/^(\d+):(\d+)$/);
    if (m) {
      return { section: Number(m[1]), offset: Number(m[2]) };
    }
    return { section: fromSection, offset: 0 };
  }

  async cover(): Promise<BookResource | null> {
    if (!this.fixture.hasCover || !this.fixture.coverSvg) return null;
    return {
      mime: 'image/svg+xml',
      bytes: new TextEncoder().encode(this.fixture.coverSvg),
    };
  }

  async *searchFallback(query: string, signal?: AbortSignal): AsyncGenerator<SearchHit, void, void> {
    const needle = query.normalize('NFKC').toLowerCase();
    if (!needle) return;
    for (let sIdx = 0; sIdx < this.fixture.sections.length; sIdx++) {
      if (signal?.aborted) return;
      const sec = this.fixture.sections[sIdx]!;
      const hay = sec.text.text.normalize('NFKC').toLowerCase();
      let pos = 0;
      while (pos < hay.length) {
        const idx = hay.indexOf(needle, pos);
        if (idx < 0) break;
        const snipStart = Math.max(0, idx - 24);
        const snipEnd = Math.min(sec.text.text.length, idx + needle.length + 32);
        yield {
          locator: { section: sIdx, offset: idx },
          length: needle.length,
          snippet: sec.text.text.slice(snipStart, snipEnd),
          chapterTitle: sec.title,
        };
        pos = idx + Math.max(1, needle.length);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  close(): void {}
}

export interface MockPlatformHostOptions {
  readonly platform?: HostPlatform;
  readonly appVersion?: string;
  readonly capabilities?: Partial<HostCapabilities>;
  readonly device?: Partial<DeviceInfo>;
  readonly initialSettings?: Partial<AppSettings>;
  readonly initialModelStatus?: Partial<SpeechModelStatus>;
  readonly books?: readonly MockBookFixture[];
  readonly extraShelfBooks?: number;
  readonly synthDelayMs?: number;
  readonly synthRtf?: number;
}

export class MockPlatformHost implements PlatformHost, MockHostHooks {
  readonly __isMockHost = true as const;
  readonly info: PlatformHost['info'];
  private settingsData: AppSettings;
  private readonly secrets = new Map<string, string>();
  private readonly books = new Map<BookId, MockBookFixture>();
  private readonly positions = new Map<BookId, SavedPosition>();
  private readonly bookmarks = new Map<BookId, Bookmark[]>();
  private readonly listeners = new Set<(e: HostEvent) => void>();
  private pendingImports: ImportSource[] = [];
  private speechCacheBytes = 12_582_912;
  private synthDelayMs: number;
  private synthRtf: number;
  private modelStatus: SpeechModelStatus;
  private readonly downloadedModelVariants = new Set<string>();

  public lastKeyPolicy: KeyPolicy = { volumePaging: false };
  public immersiveEnabled = false;
  public keepScreenOnEnabled = false;
  public fullRefreshCallCount = 0;
  public fullRefreshResult = true;
  public externalOpenedUrls: string[] = [];
  public sharedBookIds: BookId[] = [];

  constructor(options?: MockPlatformHostOptions) {
    const platform = options?.platform ?? 'desktop';
    const isAndroid = platform === 'android';
    const einkDetected = options?.capabilities?.einkDetected ?? options?.device?.eink ?? false;

    this.info = {
      platform,
      appVersion: options?.appVersion ?? '0.2.4',
      capabilities: {
        nativeSpeechQueue: platform !== 'desktop',
        volumeKeyPaging: isAndroid,
        vendorRefresh: false,
        einkDetected,
        filePicker: true,
        openWith: platform !== 'desktop',
        onDeviceNeuralSpeech: true,
        ...options?.capabilities,
      },
      device: {
        eink: einkDetected,
        vendor: einkDetected ? 'onyx' : null,
        model: einkDetected ? 'BOOX Poke5' : null,
        refresh: options?.capabilities?.vendorRefresh ? 'vendor' : 'software',
        ...options?.device,
      },
    };

    this.settingsData = {
      ...DEFAULT_APP_SETTINGS,
      ...options?.initialSettings,
    };
    this.synthDelayMs = options?.synthDelayMs ?? 15;
    this.synthRtf = options?.synthRtf ?? 0.25;

    const defaultVariant =
      platform === 'ios'
        ? 'coreml'
        : this.settingsData.kokoroPrecision === 'fp32'
          ? 'onnx-fp32'
          : this.settingsData.kokoroPrecision === 'q8'
            ? 'onnx-q8'
            : platform === 'android'
              ? 'onnx-q8'
              : 'onnx-fp32';
    const defaultTotalBytes =
      defaultVariant === 'coreml'
        ? 87_133_611
        : defaultVariant === 'onnx-q8'
          ? 132_056_757
          : 344_069_602;
    const defaultBackend =
      platform === 'ios' ? 'coreml-cpu' : platform === 'android' ? 'ort-cpu' : 'webgpu';
    const initState = options?.initialModelStatus?.state ?? 'absent';
    this.modelStatus = {
      id: 'kokoro-v1.1-zh',
      state: initState,
      variant: defaultVariant,
      backend: defaultBackend,
      bytesDone: initState === 'ready' ? defaultTotalBytes : 0,
      bytesTotal: defaultTotalBytes,
      installedBytes: initState === 'ready' ? defaultTotalBytes : 0,
      installedVoices: initState === 'ready' ? [...KOKORO_DEFAULT_VOICES] : [],
      source: 'huggingface.co',
      ...options?.initialModelStatus,
    };
    if (this.modelStatus.state === 'ready') {
      this.downloadedModelVariants.add(this.modelStatus.variant);
    }
    if (!this.info.capabilities.onDeviceNeuralSpeech) {
      delete (this.speech as { models?: unknown }).models;
    }

    const initialBooks = options?.books ?? buildDefaultMockFixtures();
    for (const b of initialBooks) {
      this.books.set(b.id, b);
      if (b.initialPosition) {
        this.positions.set(b.id, b.initialPosition);
      }
    }

    const extra = options?.extraShelfBooks ?? 0;
    for (let i = 1; i <= extra; i++) {
      const id = `b_extra_${i}`;
      const ch = makeTextFromParagraphs(
        `Chapter 1`,
        [`Collected essays volume ${i}, set in quiet serif typography with generous margins.`],
        'en',
      );
      this.books.set(id, {
        id,
        meta: {
          title: `Collected Essays Vol. ${i}`,
          authors: ['M. de Montaigne'],
          language: 'en',
          identifier: `urn:uuid:extra-${i}`,
          format: 'txt',
          direction: 'ltr',
          fixedLayout: false,
        },
        fileName: `essays-${i}.txt`,
        size: 120_000 + i * 1024,
        hasCover: false,
        addedAt: 1_760_000_000_000 - i * 1000,
        openedAt: 1_760_500_000_000 - i * 1000,
        finished: i % 4 === 0,
        fraction: i % 4 === 0 ? 1 : i % 3 === 0 ? 0 : 0.25,
        toc: [{ title: 'Chapter 1', locator: { section: 0, offset: 0 }, children: [] }],
        sections: [{ title: 'Chapter 1', xhtml: ch.xhtml, text: ch.text, lang: 'en', dir: 'ltr' }],
      });
    }
  }

  queuePickedSources(sources: ImportSource[]): void {
    this.pendingImports.push(...sources);
  }

  emitEvent(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  setSynthSimulation(opts: { delayMs?: number; rtf?: number }): void {
    if (opts.delayMs !== undefined) this.synthDelayMs = opts.delayMs;
    if (opts.rtf !== undefined) this.synthRtf = opts.rtf;
  }

  getModelStatus(): SpeechModelStatus {
    return this.modelStatus;
  }

  setModelStatus(patch: Partial<SpeechModelStatus>, emit = true): SpeechModelStatus {
    this.modelStatus = {
      ...this.modelStatus,
      ...patch,
    };
    if (this.modelStatus.state === 'ready') {
      this.downloadedModelVariants.add(this.modelStatus.variant);
    }
    if (emit) {
      this.emitEvent({ type: 'speech-model', status: this.modelStatus });
    }
    return this.modelStatus;
  }

  async openMockSession(bookId: BookId): Promise<BookSession> {
    const b = this.books.get(bookId);
    if (!b) throw new MiniBookError('not-found', `Book ${bookId} not found`);
    return new MockBookSessionImpl(b);
  }

  async inspectMockSource(src: ImportSource, _hint: BookInspectHint): Promise<InspectedBook> {
    const raw = await src.bytes.read(0, Math.min(src.size, 65_536));
    const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    if (src.name.toLowerCase().includes('drm') || text.startsWith('DRMBOOK')) {
      throw new MiniBookError('drm-protected', 'This book is copy-protected and cannot be opened.');
    }
    if (src.name.toLowerCase().endsWith('.pdf') || text.startsWith('%PDF')) {
      throw new MiniBookError('unsupported-format', 'Not a readable book.');
    }
    const title = src.name.replace(/\.[^.]+$/, '') || 'Imported Book';
    const built = makeTextFromParagraphs(
      title,
      text
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      'en',
    );
    const meta: BookMeta = {
      title,
      authors: ['Imported Author'],
      language: 'en',
      identifier: null,
      format: src.name.endsWith('.md') ? 'md' : 'txt',
      direction: 'ltr',
      fixedLayout: false,
    };
    return {
      meta,
      cover: null,
      index: {
        kind: meta.format === 'md' ? 'md' : 'txt',
        encoding: 'utf-8',
        meta,
        toc: [{ title, locator: { section: 0, offset: 0 }, children: [] }],
        spine: [{ index: 0, title, linear: true, sizeHint: Math.max(1, built.text.text.length) }],
        chapters: [
          {
            index: 0,
            title,
            byteStart: 0,
            byteEnd: src.size,
            charCount: built.text.text.length,
            hasHeadingLine: false,
          },
        ],
      },
    };
  }

  readonly library: PlatformHost['library'] = {
    list: async () => {
      const items = [...this.books.values()].map((b): LibraryBook => ({
        id: b.id,
        title: b.meta.title,
        authors: b.meta.authors,
        language: b.meta.language,
        format: b.meta.format,
        fileName: b.fileName,
        size: b.size,
        hasCover: b.hasCover,
        addedAt: b.addedAt,
        openedAt: b.openedAt,
        finished: b.finished,
        fraction: b.fraction,
      }));
      items.sort((a, b) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt));
      return items;
    },
    get: async (id) => {
      const b = this.books.get(id);
      if (!b) return null;
      return {
        id: b.id,
        title: b.meta.title,
        authors: b.meta.authors,
        language: b.meta.language,
        format: b.meta.format,
        fileName: b.fileName,
        size: b.size,
        hasCover: b.hasCover,
        addedAt: b.addedAt,
        openedAt: b.openedAt,
        finished: b.finished,
        fraction: b.fraction,
        index: {
          kind: 'txt',
          encoding: 'utf-8',
          meta: b.meta,
          toc: b.toc,
          spine: b.sections.map((s, idx) => ({
            index: idx,
            title: s.title,
            linear: true,
            sizeHint: Math.max(1, s.text.text.length),
          })),
          chapters: [],
        },
      };
    },
    beginImport: async (src) => {
      const ticketId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const id = `b_imp_${src.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
      return {
        ticketId,
        bookId: id,
        putDerived: async () => {},
        abort: async () => {},
      } satisfies ImportTicket;
    },
    commitImport: async (ticket, inspected) => {
      const id = ticket.bookId ?? `b_${Date.now()}`;
      const now = Date.now();
      const ch = makeTextFromParagraphs(
        inspected.meta.title,
        ['Imported book content ready for reading and Read Aloud.'],
        inspected.meta.language,
      );
      const fixture: MockBookFixture = {
        id,
        meta: inspected.meta,
        fileName: `${inspected.meta.title}.txt`,
        size: 16_384,
        hasCover: Boolean(inspected.cover),
        addedAt: now,
        openedAt: now,
        finished: false,
        fraction: 0,
        toc: inspected.index.toc,
        sections: [
          {
            title: inspected.meta.title,
            xhtml: ch.xhtml,
            text: ch.text,
            lang: inspected.meta.language,
            dir: inspected.meta.direction,
          },
        ],
      };
      this.books.set(id, fixture);
      this.emitEvent({ type: 'library-changed', bookId: id });
      return {
        id,
        title: fixture.meta.title,
        authors: fixture.meta.authors,
        language: fixture.meta.language,
        format: fixture.meta.format,
        fileName: fixture.fileName,
        size: fixture.size,
        hasCover: fixture.hasCover,
        addedAt: fixture.addedAt,
        openedAt: fixture.openedAt,
        finished: false,
        fraction: 0,
      };
    },
    remove: async (id) => {
      this.books.delete(id);
      this.positions.delete(id);
      this.bookmarks.delete(id);
      this.emitEvent({ type: 'library-changed', bookId: id });
    },
    setFinished: async (id, finished) => {
      const existing = this.books.get(id);
      if (!existing) return;
      this.books.set(id, {
        ...existing,
        finished,
        fraction: finished ? 1 : existing.fraction >= 1 ? 0 : existing.fraction,
      });
      this.emitEvent({ type: 'library-changed', bookId: id });
    },
    markOpened: async (id, openedAt = Date.now()) => {
      const existing = this.books.get(id);
      if (!existing) return;
      this.books.set(id, { ...existing, openedAt });
    },
    shareFile: async (id) => {
      this.sharedBookIds.push(id);
    },
    coverUrl: (id) => {
      const b = this.books.get(id);
      if (!b || !b.hasCover || !b.coverSvg) return null;
      return `data:image/svg+xml;utf8,${encodeURIComponent(b.coverSvg)}`;
    },
  };

  readonly files: PlatformHost['files'] = {
    pickBooks: async () => {
      if (this.pendingImports.length > 0) {
        const out = [...this.pendingImports];
        this.pendingImports = [];
        return out;
      }
      return [];
    },
    byteSource: (_bookId): ByteSource => memoryByteSource(new Uint8Array(0)),
    openExternal: async (url) => {
      this.externalOpenedUrls.push(url);
    },
  };

  readonly state: PlatformHost['state'] = {
    getPosition: async (bookId) => this.positions.get(bookId) ?? null,
    savePosition: async (bookId, pos) => {
      this.positions.set(bookId, pos);
      const b = this.books.get(bookId);
      if (b) {
        this.books.set(bookId, { ...b, fraction: pos.fraction, openedAt: pos.updatedAt });
      }
    },
    listBookmarks: async (bookId) => [...(this.bookmarks.get(bookId) ?? [])],
    addBookmark: async (bookId, input: BookmarkInput) => {
      const list = this.bookmarks.get(bookId) ?? [];
      const existing = list.find((bm) => bm.section === input.section && bm.offset === input.offset);
      if (existing) return existing;
      const created: Bookmark = {
        id: `bm_${Date.now()}_${list.length + 1}`,
        bookId,
        section: input.section,
        offset: input.offset,
        fraction: input.fraction,
        label: input.label,
        createdAt: Date.now(),
      };
      this.bookmarks.set(bookId, [...list, created]);
      return created;
    },
    removeBookmark: async (bookId, bookmarkId) => {
      const list = this.bookmarks.get(bookId) ?? [];
      this.bookmarks.set(
        bookId,
        list.filter((b) => b.id !== bookmarkId),
      );
    },
  };

  readonly settings: PlatformHost['settings'] = {
    get: async () => this.settingsData,
    update: async (patch) => {
      this.settingsData = { ...this.settingsData, ...patch };
      if (this.info.platform !== 'ios' && patch && 'kokoroPrecision' in patch) {
        const nextVariant = this.settingsData.kokoroPrecision === 'fp32' ? 'onnx-fp32' : 'onnx-q8';
        const nextTotal = nextVariant === 'onnx-fp32' ? 344_069_602 : 132_056_757;
        const voices = this.modelStatus.installedVoices;
        const altVariant = nextVariant === 'onnx-fp32' ? 'onnx-q8' : 'onnx-fp32';
        if (this.downloadedModelVariants.has(nextVariant) && voices.length > 0) {
          this.modelStatus = {
            ...this.modelStatus,
            state: 'ready',
            variant: nextVariant,
            bytesDone: nextTotal,
            bytesTotal: nextTotal,
            installedBytes: nextTotal,
          };
        } else if (this.downloadedModelVariants.has(altVariant) && voices.length > 0) {
          // Keep the already-downloaded serving variant `ready` until the new variant finishes downloading!
          const altTotal = altVariant === 'onnx-fp32' ? 344_069_602 : 132_056_757;
          this.modelStatus = {
            ...this.modelStatus,
            state: 'ready',
            variant: altVariant,
            bytesDone: altTotal,
            bytesTotal: altTotal,
            installedBytes: altTotal,
          };
        } else if (this.modelStatus.variant !== nextVariant) {
          const voicesBytes = voices.length * 522_240;
          this.modelStatus = {
            ...this.modelStatus,
            state: 'absent',
            variant: nextVariant,
            bytesDone: voicesBytes,
            bytesTotal: nextTotal,
          };
        }
        this.emitEvent({ type: 'speech-model', status: this.modelStatus });
      }
      return this.settingsData;
    },
    setSecret: async (name, value) => {
      if (value === null) this.secrets.delete(name);
      else this.secrets.set(name, value);
    },
    hasSecret: async (name) => this.secrets.has(name),
    storageUsage: async (): Promise<StorageUsage> => {
      let booksBytes = 0;
      for (const b of this.books.values()) booksBytes += b.size;
      return {
        booksBytes,
        speechCacheBytes: this.speechCacheBytes,
        modelsBytes: this.modelStatus.installedBytes,
      };
    },
  };

  readonly speech: PlatformHost['speech'] = {
    synthesize: async (req: SynthRequest, signal?: AbortSignal): Promise<SynthResult> => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.synthDelayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new MiniBookError('cancelled', 'Aborted'));
          },
          { once: true },
        );
      });
      const durationMs = Math.max(600, req.text.length * 60);
      const synthMs = Math.round(durationMs * this.synthRtf);
      return {
        ref: `data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=`,
        mime: 'audio/wav',
        durationMs,
        synthMs,
        bytes: 44,
      };
    },
    listRemoteVoices: async (engine) => {
      if (engine === 'edge') {
        return [
          {
            id: 'en-US-AvaMultilingualNeural',
            provider: 'edge',
            name: 'Ava Natural',
            lang: 'en-US',
            quality: 'neural',
            local: false,
          },
          {
            id: 'zh-CN-XiaoxiaoNeural',
            provider: 'edge',
            name: 'Xiaoxiao Natural',
            lang: 'zh-CN',
            quality: 'neural',
            local: false,
          },
        ];
      }
      return [
        {
          id: 'qwen-default',
          provider: 'openai',
          name: 'Qwen Voice',
          lang: 'zh-CN',
          quality: 'remote',
          local: false,
        },
      ];
    },
    clearCache: async () => {
      this.speechCacheBytes = 0;
    },
    cacheSize: async () => this.speechCacheBytes,
    models: {
      status: async () => this.modelStatus,
      download: async (_id, opts) => {
        const rawOpts = opts as
          | {
              readonly voices?: readonly string[];
              readonly variant?: SpeechModelStatus['variant'];
              readonly source?: AppSettings['modelDownloadSource'];
              readonly mirrorBaseUrl?: string | null;
            }
          | undefined;
        if (rawOpts?.source !== undefined) {
          this.settingsData = {
            ...this.settingsData,
            modelDownloadSource: rawOpts.source,
            ...(rawOpts.mirrorBaseUrl !== undefined
              ? { modelMirrorBaseUrl: rawOpts.mirrorBaseUrl }
              : {}),
          };
        }
        const targetVariant =
          rawOpts?.variant ??
          (this.info.platform === 'ios'
            ? 'coreml'
            : this.settingsData.kokoroPrecision === 'fp32'
              ? 'onnx-fp32'
              : this.settingsData.kokoroPrecision === 'q8'
                ? 'onnx-q8'
                : this.modelStatus.variant);
        const targetTotal =
          targetVariant === 'coreml'
            ? 87_133_611
            : targetVariant === 'onnx-q8'
              ? 132_056_757
              : 344_069_602;
        const extraVoices = rawOpts?.voices ?? [];
        const baseVoices =
          this.modelStatus.installedVoices.length > 0
            ? this.modelStatus.installedVoices
            : [...KOKORO_DEFAULT_VOICES];
        const mergedVoices = Array.from(new Set([...baseVoices, ...extraVoices]));
        const sourceLabel =
          this.settingsData.modelDownloadSource === 'custom' && this.settingsData.modelMirrorBaseUrl
            ? this.settingsData.modelMirrorBaseUrl
            : this.settingsData.modelDownloadSource === 'hf-mirror'
              ? 'hf-mirror.com'
              : 'huggingface.co';
        if (this.modelStatus.state === 'downloading' && this.modelStatus.variant === targetVariant) {
          this.modelStatus = {
            ...this.modelStatus,
            source: sourceLabel,
          };
          this.emitEvent({ type: 'speech-model', status: this.modelStatus });
          return this.modelStatus;
        }
        const { error: _prevErr, ...restReady } = this.modelStatus;
        this.downloadedModelVariants.add(targetVariant);
        this.modelStatus = {
          ...restReady,
          state: 'ready',
          variant: targetVariant,
          bytesDone: targetTotal,
          bytesTotal: targetTotal,
          installedBytes: targetTotal,
          installedVoices: mergedVoices,
          source: sourceLabel,
        };
        this.emitEvent({ type: 'speech-model', status: this.modelStatus });
        return this.modelStatus;
      },
      pause: async () => {
        if (this.downloadedModelVariants.size > 0 && this.modelStatus.installedVoices.length > 0) {
          const servingVariant = [...this.downloadedModelVariants][0]! as SpeechModelStatus['variant'];
          const servingTotal =
            servingVariant === 'coreml'
              ? 87_133_611
              : servingVariant === 'onnx-q8'
                ? 132_056_757
                : 344_069_602;
          this.modelStatus = {
            ...this.modelStatus,
            state: 'ready',
            variant: servingVariant,
            bytesDone: servingTotal,
            bytesTotal: servingTotal,
            installedBytes: servingTotal,
          };
        } else {
          this.modelStatus = {
            ...this.modelStatus,
            state: 'paused',
          };
        }
        this.emitEvent({ type: 'speech-model', status: this.modelStatus });
        return this.modelStatus;
      },
      remove: async () => {
        const { error: _prevErr, ...restRemoved } = this.modelStatus;
        this.downloadedModelVariants.clear();
        this.modelStatus = {
          ...restRemoved,
          state: 'absent',
          bytesDone: 0,
          installedBytes: 0,
          installedVoices: [],
        };
        this.emitEvent({ type: 'speech-model', status: this.modelStatus });
      },
    },
  };

  readonly device: PlatformHost['device'] = {
    setImmersive: async (enabled) => {
      this.immersiveEnabled = enabled;
    },
    setKeepScreenOn: async (enabled) => {
      this.keepScreenOnEnabled = enabled;
    },
    fullRefresh: async () => {
      this.fullRefreshCallCount += 1;
      return this.fullRefreshResult;
    },
    setKeyPolicy: async (policy) => {
      this.lastKeyPolicy = policy;
    },
  };

  subscribe(listener: (event: HostEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function createMockPlatformHost(options?: MockPlatformHostOptions): MockPlatformHost {
  return new MockPlatformHost(options);
}

/**
 * Deterministic controllable `SpeechPlayer` for unit tests and Playwright E2E tests.
 */
export class MockSpeechPlayer implements SpeechPlayer {
  readonly capabilities = {
    nativeQueue: false,
    wordEvents: true,
  } as const;

  private session: SpeechSession | null = null;
  private queue: Utterance[] = [];
  private attached = new Map<string, AttachedAudio>();
  private currentIdx = 0;
  private status: SpeechState['status'] = 'idle';
  private rate = 1.0;
  private voice: VoiceRef | null = null;
  private usingFallback = false;
  private sleepTimer: SleepTimerConfig = { mode: 'off' };
  private readonly listeners = new Set<(e: SpeechEvent) => void>();
  private readonly customVoices: Voice[];

  constructor(voices?: Voice[]) {
    this.customVoices = voices ?? [
      {
        id: 'sys-en-samantha',
        engine: 'System',
        provider: 'system',
        name: 'Samantha',
        lang: 'en-US',
        quality: 'enhanced',
        local: true,
      },
      {
        id: 'sherpa-zh-yunxi',
        engine: 'sherpa-onnx',
        provider: 'system',
        name: 'Yunxi',
        lang: 'zh-CN',
        quality: 'neural',
        local: true,
      },
      {
        id: 'sys-zh-tingting',
        engine: 'System',
        provider: 'system',
        name: 'Tingting',
        lang: 'zh-CN',
        quality: 'compact',
        local: true,
      },
      {
        id: 'sys-ja-kyoko',
        engine: 'System',
        provider: 'system',
        name: 'Kyoko',
        lang: 'ja-JP',
        quality: 'enhanced',
        local: true,
      },
    ];
  }

  async listVoices(): Promise<Voice[]> {
    return [...this.customVoices];
  }

  async load(session: SpeechSession): Promise<void> {
    this.session = session;
    this.queue = [];
    this.attached.clear();
    this.currentIdx = 0;
    this.status = 'idle';
    this.rate = session.rate;
    this.voice = session.voice;
    this.usingFallback = false;
    this.emitState();
  }

  enqueue(items: readonly Utterance[], opts?: { readonly replaceFromId?: string }): void {
    if (opts?.replaceFromId) {
      const idx = this.queue.findIndex((u) => u.id === opts.replaceFromId);
      if (idx >= 0) {
        this.queue = [...this.queue.slice(0, idx), ...items];
        if (this.currentIdx >= this.queue.length && this.queue.length > 0) {
          this.currentIdx = idx;
        }
        return;
      }
    }
    const indexById = new Map<string, number>();
    for (let i = 0; i < this.queue.length; i++) {
      indexById.set(this.queue[i]!.id, i);
    }
    for (const item of items) {
      const existingIdx = indexById.get(item.id);
      if (existingIdx !== undefined) {
        this.queue[existingIdx] = item;
      } else {
        indexById.set(item.id, this.queue.length);
        this.queue.push(item);
      }
    }
  }

  attachAudio(id: string, audio: AttachedAudio): void {
    this.attached.set(id, audio);
    if (this.status === 'buffering' && this.currentUtterance()?.id === id) {
      this.status = 'playing';
      this.emitState();
      this.emitCurrentStart();
    }
  }

  play(): void {
    if (!this.session || this.queue.length === 0) return;
    const cur = this.currentUtterance();
    if (!cur) return;
    if (this.voice?.kind !== 'system' && !this.attached.has(cur.id) && !this.usingFallback) {
      this.status = 'buffering';
      this.emitState();
      return;
    }
    this.status = 'playing';
    this.emitState();
    this.emitCurrentStart();
  }

  pause(): void {
    if (this.status === 'playing' || this.status === 'buffering') {
      this.status = 'paused';
      this.emitState();
    }
  }

  stop(): void {
    this.status = 'idle';
    this.queue = [];
    this.currentIdx = 0;
    this.emit({ type: 'speech-ended', reason: 'stopped' });
    this.emitState();
  }

  seekTo(id: string): void {
    const idx = this.queue.findIndex((u) => u.id === id);
    if (idx < 0) return;
    this.currentIdx = idx;
    if (this.status === 'playing' || this.status === 'buffering') {
      this.play();
    } else {
      this.emitState();
    }
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(3.0, Math.round(rate * 10) / 10));
    this.emitState();
  }

  private static isSameVoice(a: VoiceRef | null, b: VoiceRef): boolean {
    if (!a || a.kind !== b.kind || a.voiceId !== b.voiceId) return false;
    if (a.kind === 'system' && b.kind === 'system') return (a.engine ?? null) === (b.engine ?? null);
    if ((a.kind === 'openai' && b.kind === 'openai') || (a.kind === 'qwen' && b.kind === 'qwen')) {
      return a.model === b.model;
    }
    return true;
  }

  setVoice(voice: VoiceRef): void {
    const wasActive = this.status === 'playing' || this.status === 'buffering';
    if (!MockSpeechPlayer.isSameVoice(this.voice, voice)) {
      this.attached.clear();
    }
    this.voice = voice;
    this.usingFallback = false;
    if (wasActive) {
      this.play();
    } else {
      this.emitState();
    }
  }

  setSleepTimer(timer: SleepTimerConfig): void {
    this.sleepTimer = timer;
    this.emit({
      type: 'sleep-timer',
      mode: timer.mode,
      ...(timer.minutes !== undefined ? { remainingMs: timer.minutes * 60_000 } : {}),
    });
    this.emitState();
  }

  async getState(): Promise<SpeechState> {
    return this.snapshotState();
  }

  subscribe(listener: (event: SpeechEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- Test helpers to deterministically step sentences, words, fallbacks & sleep timer ---

  getQueue(): readonly Utterance[] {
    return this.queue;
  }

  currentUtterance(): Utterance | null {
    return this.queue[this.currentIdx] ?? null;
  }

  emitWordBoundary(start: number, end: number, timeMs = 100): void {
    const cur = this.currentUtterance();
    if (!cur) return;
    this.emit({
      type: 'utterance-word',
      id: cur.id,
      start,
      end,
      timeMs,
    });
  }

  advanceToNextUtterance(): void {
    const prev = this.currentUtterance();
    if (prev) {
      this.emit({ type: 'utterance-done', id: prev.id });
    }
    if (this.sleepTimer.mode === 'minutes' && this.sleepTimer.minutes === 0) {
      this.status = 'paused';
      this.sleepTimer = { mode: 'off' };
      this.emit({ type: 'sleep-timer', mode: 'off', expired: true });
      this.emit({ type: 'speech-ended', reason: 'sleep-timer' });
      this.emitState();
      return;
    }
    if (this.currentIdx + 1 >= this.queue.length) {
      this.status = 'ended-of-buffer';
      this.emit({ type: 'speech-ended', reason: 'completed' });
      this.emitState();
      return;
    }
    this.currentIdx += 1;
    const remaining = this.queue.length - this.currentIdx;
    if (remaining <= 20) {
      this.emit({ type: 'queue-low', remaining });
    }
    if (this.status === 'playing' || this.status === 'buffering') {
      this.play();
    }
  }

  triggerFallback(reason = 'timeout'): void {
    const cur = this.currentUtterance();
    this.usingFallback = true;
    this.status = 'playing';
    this.emit({
      type: 'speech-fallback',
      reason,
      ...(cur ? { utteranceId: cur.id } : {}),
    });
    this.emitState();
    this.emitCurrentStart();
  }

  private emitCurrentStart(): void {
    const cur = this.currentUtterance();
    if (!cur) return;
    this.emit({
      type: 'utterance-start',
      id: cur.id,
      section: cur.section,
      start: cur.start,
      end: cur.end,
      usingFallback: this.usingFallback,
    });
  }

  private snapshotState(): SpeechState {
    const cur = this.currentUtterance();
    return {
      status: this.status,
      bookId: this.session?.bookId ?? null,
      currentUtteranceId: cur?.id ?? null,
      section: cur?.section ?? null,
      offset: cur?.start ?? null,
      rate: this.rate,
      voice: this.voice,
      usingFallback: this.usingFallback,
      sleepTimer: {
        mode: this.sleepTimer.mode,
        ...(this.sleepTimer.minutes !== undefined
          ? { remainingMs: this.sleepTimer.minutes * 60_000 }
          : {}),
      },
    };
  }

  private emitState(): void {
    this.emit({ type: 'speech-state', state: this.snapshotState() });
  }

  private emit(e: SpeechEvent): void {
    for (const l of this.listeners) l(e);
  }
}

export function createMockSpeechPlayer(voices?: Voice[]): MockSpeechPlayer {
  return new MockSpeechPlayer(voices);
}
