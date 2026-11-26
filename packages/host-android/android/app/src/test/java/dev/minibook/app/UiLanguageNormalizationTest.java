package dev.minibook.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class UiLanguageNormalizationTest {

    @Test
    public void normalizesSupportedLanguageTagsAndFallsBackToSystem() {
        assertEquals("", MiniBookPlugin.normalizeUiLanguageTag(null));
        assertEquals("", MiniBookPlugin.normalizeUiLanguageTag(""));
        assertEquals("", MiniBookPlugin.normalizeUiLanguageTag("   "));
        assertEquals("", MiniBookPlugin.normalizeUiLanguageTag("system"));
        assertEquals("", MiniBookPlugin.normalizeUiLanguageTag("SYSTEM"));
        assertEquals("zh-CN", MiniBookPlugin.normalizeUiLanguageTag("zh-CN"));
        assertEquals("zh-CN", MiniBookPlugin.normalizeUiLanguageTag("zh-Hans"));
        assertEquals("zh-CN", MiniBookPlugin.normalizeUiLanguageTag("zh"));
        assertEquals("ja", MiniBookPlugin.normalizeUiLanguageTag("ja"));
        assertEquals("ja", MiniBookPlugin.normalizeUiLanguageTag("ja-JP"));
        assertEquals("en", MiniBookPlugin.normalizeUiLanguageTag("en"));
        assertEquals("en", MiniBookPlugin.normalizeUiLanguageTag("en-US"));
        assertEquals("", MiniBookPlugin.normalizeUiLanguageTag("fr-FR"));
    }
}
