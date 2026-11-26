import type { ReactElement } from 'react';
import {
  FONT_SCALE_STEPS,
  type AppearanceMode,
  type BookFontFamily,
  type LineSpacingPreset,
  type MarginPreset,
  type ReadingTheme,
  type TextBoldnessStep,
} from '@minibook/core';
import { Segmented } from '../../components/Segmented';
import { Sheet } from '../../components/Sheet';
import { Stepper } from '../../components/Stepper';
import { Toggle } from '../../components/Toggle';
import { useHostContext } from '../../host/HostContext';
import { useT } from '../../i18n';

export interface AppearanceSheetProps {
  readonly open: boolean;
  readonly onClose: (coveredHalf: boolean) => void;
}

const SPACING_STEPS: readonly LineSpacingPreset[] = ['tight', 'normal', 'loose'];
const MARGIN_STEPS: readonly MarginPreset[] = ['narrow', 'medium', 'wide'];
const BOLDNESS_STEPS: readonly TextBoldnessStep[] = [0, 1, 2, 3];

const THEMES: ReadonlyArray<{ id: ReadingTheme; labelKey: 'themeOriginal' | 'themePaper' | 'themeCalm' | 'themeQuiet' }> = [
  { id: 'original', labelKey: 'themeOriginal' },
  { id: 'paper', labelKey: 'themePaper' },
  { id: 'calm', labelKey: 'themeCalm' },
  { id: 'quiet', labelKey: 'themeQuiet' },
];

/**
 * Appearance Sheet (`Aa` — `PRODUCT_DESIGN.md` §4.4 & `UI_SPEC.md` §4.4):
 * - Discrete steppers and toggles (`>= 44px`), zero continuous sliders.
 * - Normal mode: 4 `Aa` theme swatches + an orthogonal Appearance segmented control
 *   (Light / Dark / Match System, like Apple Books). Each theme has a Light and a Dark palette;
 *   picking a swatch changes ONLY `theme`, picking an appearance changes ONLY `appearanceMode`.
 * - E-Ink mode: replaces theme swatches with `Text boldness` (`0–3`) and clamps
 *   minimum font size to `100%` and minimum line spacing to `Normal` (`§8.4`).
 */
export function AppearanceSheet({ open, onClose }: AppearanceSheetProps): ReactElement | null {
  const t = useT();
  const { settings, isEink, updateSettings } = useHostContext();

  const allowedScales = isEink
    ? FONT_SCALE_STEPS.filter((s) => s >= 100)
    : FONT_SCALE_STEPS;
  const currentScale = isEink ? Math.max(100, settings.fontScale) : settings.fontScale;
  const scaleIdx = Math.max(
    0,
    allowedScales.findIndex((s) => s >= currentScale),
  );

  const allowedSpacing = isEink
    ? (['normal', 'loose'] as const)
    : SPACING_STEPS;
  const currentSpacing =
    isEink && settings.lineSpacing === 'tight' ? 'normal' : settings.lineSpacing;
  const spacingIdx = Math.max(0, allowedSpacing.indexOf(currentSpacing));

  const marginIdx = Math.max(0, MARGIN_STEPS.indexOf(settings.margins));
  const boldIdx = Math.max(0, BOLDNESS_STEPS.indexOf(settings.textBoldness));

  const spacingLabel =
    currentSpacing === 'tight'
      ? t('spacingTight')
      : currentSpacing === 'loose'
        ? t('spacingLoose')
        : t('spacingNormal');

  const marginLabel =
    settings.margins === 'narrow'
      ? t('marginNarrow')
      : settings.margins === 'wide'
        ? t('marginWide')
        : t('marginMedium');

  return (
    <Sheet open={open} label={t('appearance')} onClose={onClose}>
      <Stepper
        wide
        valueLabel={`Aa ${allowedScales[scaleIdx] ?? 100}%`}
        decText="A−"
        incText="A+"
        canDecrement={scaleIdx > 0}
        canIncrement={scaleIdx < allowedScales.length - 1}
        decrementLabel={t('decreaseTextSize')}
        incrementLabel={t('increaseTextSize')}
        onDecrement={() => {
          const prev = allowedScales[Math.max(0, scaleIdx - 1)];
          if (prev !== undefined) void updateSettings({ fontScale: prev });
        }}
        onIncrement={() => {
          const next = allowedScales[Math.min(allowedScales.length - 1, scaleIdx + 1)];
          if (next !== undefined) void updateSettings({ fontScale: next });
        }}
      />

      <Segmented<BookFontFamily>
        label={t('fontFamily')}
        value={settings.fontFamily}
        options={[
          { value: 'original', label: t('fontOriginal') },
          { value: 'serif', label: t('fontSerif') },
          { value: 'sans', label: t('fontSans') },
        ]}
        onChange={(fontFamily) => {
          void updateSettings({ fontFamily });
        }}
      />

      {isEink ? (
        <div className="mb-sheet-row">
          <span className="mb-sheet-label">{t('textBoldness')}</span>
          <Stepper
            valueLabel={String(settings.textBoldness)}
            canDecrement={boldIdx > 0}
            canIncrement={boldIdx < BOLDNESS_STEPS.length - 1}
            decrementLabel={t('decreaseBoldness')}
            incrementLabel={t('increaseBoldness')}
            onDecrement={() => {
              const next = BOLDNESS_STEPS[Math.max(0, boldIdx - 1)];
              if (next !== undefined) void updateSettings({ textBoldness: next });
            }}
            onIncrement={() => {
              const next = BOLDNESS_STEPS[Math.min(BOLDNESS_STEPS.length - 1, boldIdx + 1)];
              if (next !== undefined) void updateSettings({ textBoldness: next });
            }}
          />
        </div>
      ) : (
        <>
          <Segmented<AppearanceMode>
            label={t('appearanceMode')}
            value={settings.appearanceMode}
            options={[
              { value: 'light', label: t('appearanceLight') },
              { value: 'dark', label: t('appearanceDark') },
              { value: 'system', label: t('appearanceSystem') },
            ]}
            onChange={(appearanceMode) => {
              void updateSettings({ appearanceMode, matchSystemTheme: appearanceMode === 'system' });
            }}
          />

          <div className="mb-swatches" role="radiogroup" aria-label={t('readingTheme')}>
            {THEMES.map((th) => {
              const active = settings.theme === th.id;
              return (
                <button
                  key={th.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={t(th.labelKey)}
                  data-swatch={th.id}
                  data-active={active ? 'true' : undefined}
                  className="mb-swatch"
                  onClick={() => {
                    void updateSettings({ theme: th.id });
                  }}
                >
                  <span>Aa</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="mb-sheet-row">
        <span className="mb-sheet-label">{t('lineSpacing')}</span>
        <Stepper
          valueLabel={spacingLabel}
          canDecrement={spacingIdx > 0}
          canIncrement={spacingIdx < allowedSpacing.length - 1}
          decrementLabel={t('tighterLineSpacing')}
          incrementLabel={t('looserLineSpacing')}
          onDecrement={() => {
            const next = allowedSpacing[Math.max(0, spacingIdx - 1)];
            if (next) void updateSettings({ lineSpacing: next });
          }}
          onIncrement={() => {
            const next = allowedSpacing[Math.min(allowedSpacing.length - 1, spacingIdx + 1)];
            if (next) void updateSettings({ lineSpacing: next });
          }}
        />
      </div>

      <div className="mb-sheet-row">
        <span className="mb-sheet-label">{t('margins')}</span>
        <Stepper
          valueLabel={marginLabel}
          canDecrement={marginIdx > 0}
          canIncrement={marginIdx < MARGIN_STEPS.length - 1}
          decrementLabel={t('narrowerMargins')}
          incrementLabel={t('widerMargins')}
          onDecrement={() => {
            const next = MARGIN_STEPS[Math.max(0, marginIdx - 1)];
            if (next) void updateSettings({ margins: next });
          }}
          onIncrement={() => {
            const next = MARGIN_STEPS[Math.min(MARGIN_STEPS.length - 1, marginIdx + 1)];
            if (next) void updateSettings({ margins: next });
          }}
        />
      </div>

      <div className="mb-sheet-row">
        <span className="mb-sheet-label">{t('justifyText')}</span>
        <Toggle
          label={t('justifyText')}
          checked={settings.justify}
          isEink={isEink}
          onText={t('on')}
          offText={t('off')}
          onChange={(justify) => {
            void updateSettings({ justify });
          }}
        />
      </div>
    </Sheet>
  );
}
