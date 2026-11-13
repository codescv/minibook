package dev.minibook.app;

import android.content.Context;
import android.os.Build;
import androidx.annotation.Nullable;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Android E-Ink device detector (`ARCHITECTURE.md` §9.1).
 *
 * Evaluates `Build.MANUFACTURER`, `BRAND`, `MODEL`, `DEVICE`, `PRODUCT`, and `HARDWARE`
 * against `assets/eink-devices.json` (Onyx, Boyue/Meebook, Bigme, Hisense E-Ink model allowlist,
 * Moaan/InkPalm, iReader, Dasung, PocketBook, Tolino, Nook, Supernote, iFLYTEK, Kobo, Sony DPT,
 * and generic Rockchip/Allwinner `eink`/`epd` boards).
 */
public final class EinkDetector {
    private EinkDetector() {}

    public static final class BuildInfo {
        public final String manufacturer;
        public final String brand;
        public final String model;
        public final String device;
        public final String product;
        public final String hardware;

        public BuildInfo(
            @Nullable String manufacturer,
            @Nullable String brand,
            @Nullable String model,
            @Nullable String device,
            @Nullable String product,
            @Nullable String hardware
        ) {
            this.manufacturer = norm(manufacturer);
            this.brand = norm(brand);
            this.model = model != null ? model.trim() : "";
            this.device = norm(device);
            this.product = norm(product);
            this.hardware = norm(hardware);
        }

        private static String norm(@Nullable String s) {
            return s == null ? "" : s.trim().toLowerCase(Locale.US);
        }
    }

    public static final class DetectionResult {
        public final boolean eink;
        @Nullable public final String vendor;
        @Nullable public final String model;
        public final String refresh; // "vendor" | "software"

        public DetectionResult(
            boolean eink,
            @Nullable String vendor,
            @Nullable String model,
            String refresh
        ) {
            this.eink = eink;
            this.vendor = vendor;
            this.model = model;
            this.refresh = refresh;
        }
    }

    @Nullable private static volatile DetectionResult cached;

    public static DetectionResult detect(Context context) {
        DetectionResult hit = cached;
        if (hit != null) return hit;

        String rulesJson = loadAssetText(context, "eink-devices.json");
        BuildInfo build = new BuildInfo(
            Build.MANUFACTURER,
            Build.BRAND,
            Build.MODEL,
            Build.DEVICE,
            Build.PRODUCT,
            Build.HARDWARE
        );
        DetectionResult computed = detectFromProps(
            build,
            rulesJson,
            EinkRefresher.isVendorRefreshAvailable()
        );
        cached = computed;
        return computed;
    }

    public static DetectionResult detectFromProps(
        BuildInfo build,
        @Nullable String rulesJson,
        boolean vendorRefreshAvailable
    ) {
        String modelClean = build.model.isEmpty() ? null : build.model;
        String modelLower = build.model.toLowerCase(Locale.US);
        String makeAndBrand = build.manufacturer + " " + build.brand;
        String boardFields = build.device + " " + build.product + " " + build.hardware;

        if (rulesJson != null && !rulesJson.trim().isEmpty()) {
            try {
                JSONObject root = new JSONObject(rulesJson);
                JSONArray rules = root.optJSONArray("rules");
                if (rules != null) {
                    for (int i = 0; i < rules.length(); i++) {
                        JSONObject rule = rules.optJSONObject(i);
                        if (rule == null) continue;
                        if (matchesRule(rule, makeAndBrand, modelLower, boardFields)) {
                            String vendor = rule.optString("vendor", "generic");
                            boolean canVendorRefresh =
                                rule.optBoolean("supportsVendorRefresh", false) && vendorRefreshAvailable;
                            return new DetectionResult(
                                true,
                                vendor,
                                modelClean,
                                canVendorRefresh ? "vendor" : "software"
                            );
                        }
                    }
                }
            } catch (Exception ignored) {
                // Fall back to built-in rules below if JSON is malformed
            }
        }

        // Built-in fallback rules if asset file is absent
        if (makeAndBrand.contains("onyx")) {
            return new DetectionResult(
                true,
                "onyx",
                modelClean,
                vendorRefreshAvailable ? "vendor" : "software"
            );
        }
        if (containsAny(makeAndBrand, "boyue", "haoqing", "meebook", "likebook")) {
            return new DetectionResult(true, "boyue", modelClean, "software");
        }
        if (makeAndBrand.contains("bigme")) {
            return new DetectionResult(true, "bigme", modelClean, "software");
        }
        if (hasGenericEpdToken(boardFields)) {
            return new DetectionResult(true, "generic", modelClean, "software");
        }

        return new DetectionResult(false, null, modelClean, "software");
    }

    private static boolean matchesRule(
        JSONObject rule,
        String makeAndBrand,
        String modelLower,
        String boardFields
    ) {
        JSONArray makeTokens = rule.optJSONArray("manufacturerOrBrandContains");
        JSONArray modelAllowlist = rule.optJSONArray("modelAllowlist");
        JSONArray modelContains = rule.optJSONArray("modelContains");
        JSONArray boardContains = rule.optJSONArray("deviceOrHardwareContains");

        boolean hasCondition = false;

        if (makeTokens != null && makeTokens.length() > 0) {
            hasCondition = true;
            if (!jsonArrayContainsSubstring(makeTokens, makeAndBrand)) {
                return false;
            }
        }

        if (modelAllowlist != null && modelAllowlist.length() > 0) {
            hasCondition = true;
            if (!matchesModelAllowlist(modelAllowlist, modelLower, boardFields)) {
                return false;
            }
        }

        if (modelContains != null && modelContains.length() > 0) {
            hasCondition = true;
            if (!jsonArrayContainsTokenOrSubstring(modelContains, modelLower + " " + boardFields)) {
                return false;
            }
        }

        if (boardContains != null && boardContains.length() > 0) {
            hasCondition = true;
            if (!matchesBoardTokens(boardContains, boardFields)) {
                return false;
            }
        }

        return hasCondition;
    }

    private static boolean jsonArrayContainsSubstring(JSONArray arr, String haystack) {
        for (int i = 0; i < arr.length(); i++) {
            String needle = arr.optString(i, "").trim().toLowerCase(Locale.US);
            if (!needle.isEmpty() && haystack.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    private static boolean jsonArrayContainsTokenOrSubstring(JSONArray arr, String haystack) {
        for (int i = 0; i < arr.length(); i++) {
            String needle = arr.optString(i, "").trim().toLowerCase(Locale.US);
            if (needle.isEmpty()) continue;
            if (needle.length() <= 2) {
                if (containsBoundedToken(haystack, needle)) return true;
            } else if (haystack.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Strict model allowlist matcher (used for Hisense, which also manufactures LCD phones/TVs).
     * Strips leading vendor word ("hisense ") and matches either exact model token/prefix
     * (e.g. "Hisense A9", "A5 Pro CC", "Touch", "HLTE556N") without matching "Hisense H50" or "Hisense E50".
     */
    private static boolean matchesModelAllowlist(
        JSONArray allowlist,
        String modelLower,
        String boardFields
    ) {
        String normalizedModel = modelLower
            .replace("hisense", " ")
            .replace('-', ' ')
            .replace('_', ' ')
            .replaceAll("\\s+", " ")
            .trim();

        for (int i = 0; i < allowlist.length(); i++) {
            String allowed = allowlist.optString(i, "").trim().toLowerCase(Locale.US);
            if (allowed.isEmpty()) continue;
            if (allowed.startsWith("hlte")) {
                if (normalizedModel.startsWith(allowed) || modelLower.contains(allowed) || boardFields.contains(allowed)) {
                    return true;
                }
            } else {
                if (normalizedModel.equals(allowed)
                    || normalizedModel.startsWith(allowed + " ")
                    || containsBoundedToken(normalizedModel, allowed)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean matchesBoardTokens(JSONArray tokens, String boardFields) {
        if (hasGenericEpdToken(boardFields)) {
            return true;
        }
        return jsonArrayContainsSubstring(tokens, boardFields);
    }

    private static boolean hasGenericEpdToken(String boardFields) {
        return containsBoundedToken(boardFields, "eink") || containsBoundedToken(boardFields, "epd");
    }

    private static boolean containsBoundedToken(String text, String token) {
        int idx = 0;
        while ((idx = text.indexOf(token, idx)) >= 0) {
            boolean startOk = idx == 0 || !Character.isLetterOrDigit(text.charAt(idx - 1));
            int after = idx + token.length();
            boolean endOk = after >= text.length() || !Character.isLetterOrDigit(text.charAt(after));
            if (startOk && endOk) {
                return true;
            }
            idx = after;
        }
        return false;
    }

    private static boolean containsAny(String haystack, String... needles) {
        for (String n : needles) {
            if (haystack.contains(n)) return true;
        }
        return false;
    }

    @Nullable
    private static String loadAssetText(Context context, String assetName) {
        try (InputStream in = context.getAssets().open(assetName);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
