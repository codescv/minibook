package dev.minibook.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.BeforeClass;
import org.junit.Test;

public class EinkDetectorTest {
    private static String rulesJson;

    @BeforeClass
    public static void loadRules() throws Exception {
        File assetFile = new File("src/main/assets/eink-devices.json");
        if (!assetFile.exists()) {
            assetFile = new File("app/src/main/assets/eink-devices.json");
        }
        rulesJson = new String(Files.readAllBytes(assetFile.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void detectsOnyxBoyueBigmeSupernoteAndMoaanDevices() {
        EinkDetector.DetectionResult onyx = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("ONYX", "ONYX", "BOOX Page", "page", "page", "qcom"),
            rulesJson,
            true
        );
        assertTrue(onyx.eink);
        assertEquals("onyx", onyx.vendor);
        assertEquals("vendor", onyx.refresh);

        EinkDetector.DetectionResult onyxNoSdk = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("ONYX", "ONYX", "BOOX Poke5", "poke5", "poke5", "qcom"),
            rulesJson,
            false
        );
        assertTrue(onyxNoSdk.eink);
        assertEquals("onyx", onyxNoSdk.vendor);
        assertEquals("software", onyxNoSdk.refresh);

        EinkDetector.DetectionResult meebook = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Haoqing", "Meebook", "M7", "m7", "m7", "rk3566"),
            rulesJson,
            false
        );
        assertTrue(meebook.eink);
        assertEquals("boyue", meebook.vendor);

        EinkDetector.DetectionResult bigme = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Bigme", "Bigme", "B751C", "b751c", "b751c", "mtk"),
            rulesJson,
            false
        );
        assertTrue(bigme.eink);
        assertEquals("bigme", bigme.vendor);

        EinkDetector.DetectionResult supernote = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Ratta", "Supernote", "Nomad A6 X2", "a6x2", "a6x2", "rk3566"),
            rulesJson,
            false
        );
        assertTrue(supernote.eink);
        assertEquals("supernote", supernote.vendor);

        EinkDetector.DetectionResult inkpalm = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Xiaomi", "Moaan", "InkPalm Plus", "inkpalm", "inkpalm", "rk3566"),
            rulesJson,
            false
        );
        assertTrue(inkpalm.eink);
        assertEquals("moaan", inkpalm.vendor);
    }

    @Test
    public void distinguishesHisenseEinkModelsFromHisenseLcdPhones() {
        // Hisense A9 E-Ink -> true
        EinkDetector.DetectionResult a9 = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Hisense", "Hisense", "Hisense A9", "HLTE556N", "HLTE556N", "qcom"),
            rulesJson,
            false
        );
        assertTrue(a9.eink);
        assertEquals("hisense", a9.vendor);

        // Hisense A5 Pro CC -> true
        EinkDetector.DetectionResult a5Pro = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Hisense", "Hisense", "A5 Pro CC", "hlte203t", "hlte203t", "unisoc"),
            rulesJson,
            false
        );
        assertTrue(a5Pro.eink);
        assertEquals("hisense", a5Pro.vendor);

        // Hisense Touch -> true
        EinkDetector.DetectionResult touch = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Hisense", "Hisense", "TOUCH", "hlte315", "hlte315", "qcom"),
            rulesJson,
            false
        );
        assertTrue(touch.eink);
        assertEquals("hisense", touch.vendor);

        // Hisense LCD phones MUST NOT be misclassified as E-Ink!
        EinkDetector.DetectionResult h50Lcd = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Hisense", "Hisense", "Hisense H50", "h50", "h50", "mtk"),
            rulesJson,
            false
        );
        assertFalse(h50Lcd.eink);
        assertNull(h50Lcd.vendor);

        EinkDetector.DetectionResult infinityLcd = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Hisense", "Hisense", "Hisense Infinity H60 5G", "h60", "h60", "dimensity"),
            rulesJson,
            false
        );
        assertFalse(infinityLcd.eink);
        assertNull(infinityLcd.vendor);
    }

    @Test
    public void detectsGenericEpdBoardsAndRejectsStandardLcdPhones() {
        EinkDetector.DetectionResult genericBoard = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Rockchip", "Android", "ReaderPad", "rk3566_eink", "rk3566_eink", "rk30board"),
            rulesJson,
            false
        );
        assertTrue(genericBoard.eink);
        assertEquals("generic", genericBoard.vendor);

        // Standard LCD flagship phones -> false
        EinkDetector.DetectionResult pixel = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Google", "google", "Pixel 9 Pro", "caiman", "caiman", "tensor"),
            rulesJson,
            false
        );
        assertFalse(pixel.eink);
        assertNull(pixel.vendor);

        EinkDetector.DetectionResult xiaomiLcd = EinkDetector.detectFromProps(
            new EinkDetector.BuildInfo("Xiaomi", "Xiaomi", "23127PN0CC", "houji", "houji", "qcom"),
            rulesJson,
            false
        );
        assertFalse(xiaomiLcd.eink);
        assertNull(xiaomiLcd.vendor);
    }
}
