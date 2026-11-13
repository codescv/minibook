package dev.minibook.app;

import android.view.View;
import androidx.annotation.Nullable;
import java.lang.reflect.Method;

/**
 * Vendor full-quality (GC) E-Ink display refresh via reflection on Onyx `EpdController`
 * (`ARCHITECTURE.md` §9.4 — zero vendor AAR dependency; any error safely returns `false`
 * so the UI `RefreshController` falls back to the universal software `#000 -> #fff` flash).
 */
public final class EinkRefresher {
    private static final String ONYX_EPD_CLASS = "com.onyx.android.sdk.api.device.epd.EpdController";
    private static final String ONYX_UPDATE_MODE_CLASS = "com.onyx.android.sdk.api.device.epd.UpdateMode";

    private EinkRefresher() {}

    public static boolean isVendorRefreshAvailable() {
        try {
            Class.forName(ONYX_EPD_CLASS);
            Class.forName(ONYX_UPDATE_MODE_CLASS);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean performFullRefresh(@Nullable View targetView) {
        if (targetView == null) {
            return false;
        }
        try {
            Class<?> epdClass = Class.forName(ONYX_EPD_CLASS);
            Class<?> modeClass = Class.forName(ONYX_UPDATE_MODE_CLASS);

            Object gcMode = findEnumConstant(modeClass, "GC");
            if (gcMode == null) {
                gcMode = findEnumConstant(modeClass, "REGAL");
            }
            if (gcMode == null) {
                return false;
            }

            Method invalidate = epdClass.getMethod("invalidate", View.class, modeClass);
            invalidate.invoke(null, targetView, gcMode);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    @Nullable
    private static Object findEnumConstant(Class<?> enumClass, String name) {
        Object[] constants = enumClass.getEnumConstants();
        if (constants == null) return null;
        for (Object c : constants) {
            if (c instanceof Enum<?> && name.equals(((Enum<?>) c).name())) {
                return c;
            }
        }
        return null;
    }
}
