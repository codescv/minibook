package dev.minibook.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

/**
 * Edge-to-edge Capacitor `BridgeActivity` for Books (`dev.minibook.app`, `ARCHITECTURE.md` §6.3, §9.5, §10):
 *   - Registers `MiniBookPlugin` and routes `ACTION_VIEW` / `ACTION_SEND` book intents.
 *   - Injects constant hardware safe-area insets (`--m-safe-*` via `getInsetsIgnoringVisibility`)
 *     so immersive status/nav bar hiding in the reader causes zero page reflow (`UI_SPEC.md` §3.3).
 *   - Forces `WebSettings.setTextZoom(100)` so OS font scaling never breaks integer multicol geometry.
 *   - Enforces `FLAG_KEEP_SCREEN_ON` policy (never set on detected E-Ink displays).
 *   - Intercepts hardware Volume Up/Down in `dispatchKeyEvent` (`keyPolicy.volumePaging && !ReadAloudService.isAudible()`).
 *   - Routes Android back button/gesture to `window.__minibookHandleBack()`.
 */
public class MainActivity extends BridgeActivity {
    private static final int REQ_POST_NOTIFICATIONS = 1001;

    private final KeyPolicy keyPolicy = new KeyPolicy();
    private float safeTopDp = 0f;
    private float safeRightDp = 0f;
    private float safeBottomDp = 0f;
    private float safeLeftDp = 0f;
    private boolean einkDetected = false;

    public KeyPolicy getKeyPolicy() {
        return keyPolicy;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MiniBookPlugin.class);
        super.onCreate(savedInstanceState);
        this.keepRunning = true;

        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        einkDetected = EinkDetector.detect(this).eink;

        MiniBookPlugin.handleIncomingIntent(this, getIntent());
        MiniBookPlugin.scanDroppedInUserBooks(this);
        requestNotificationPermissionIfNeeded();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchBackToWebView();
            }
        });

        Window window = getWindow();
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setStatusBarContrastEnforced(false);
                window.setNavigationBarContrastEnforced(false);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode =
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                        ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                        : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }

            View decorView = window.getDecorView();
            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, decorView);
            if (controller != null) {
                controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }

            View content = findViewById(android.R.id.content);
            if (content != null) {
                content.setPadding(0, 0, 0, 0);
            }

            ViewCompat.setOnApplyWindowInsetsListener(decorView, (v, windowInsets) -> {
                // Ignore visibility so hiding status/nav bars in immersive Reader never mutates --m-safe-*!
                Insets bars = windowInsets.getInsetsIgnoringVisibility(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                );
                Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
                boolean kbVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
                float density = getResources().getDisplayMetrics().density;
                if (density <= 0f) density = 1f;

                safeTopDp = bars.top / density;
                safeRightDp = bars.right / density;
                // Keep --m-safe-bottom constant even when soft keyboard (IME) opens in Search sheet,
                // preventing reader pagination reflow (`UI_SPEC.md` §3.3).
                safeBottomDp = bars.bottom / density;
                safeLeftDp = bars.left / density;

                int imePadBottom = kbVisible && ime.bottom > bars.bottom ? ime.bottom : 0;
                v.setPadding(0, 0, 0, imePadBottom);
                if (content != null) {
                    content.setPadding(0, 0, 0, 0);
                }
                syncSafeAreaCssVars();

                return new WindowInsetsCompat.Builder(windowInsets)
                    .setInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(),
                        Insets.of(0, 0, 0, 0)
                    )
                    .build();
            });
            ViewCompat.requestApplyInsets(decorView);
        }

        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    syncSafeAreaCssVars();
                }

                @Override
                public void onPageLoaded(WebView view) {
                    syncSafeAreaCssVars();
                }
            });

            WebView webView = getBridge().getWebView();
            if (webView != null) {
                WebSettings webSettings = webView.getSettings();
                // Mandatory per ARCHITECTURE.md §6.3 & §10
                webSettings.setTextZoom(100);
                webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                webSettings.setMediaPlaybackRequiresUserGesture(false);
                webSettings.setDomStorageEnabled(true);
                webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
                webView.postDelayed(this::syncSafeAreaCssVars, 150);
                webView.postDelayed(this::syncSafeAreaCssVars, 600);
            }
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        KeyPolicy.Decision decision = keyPolicy.decide(
            event.getKeyCode(),
            event.getAction(),
            event.getRepeatCount(),
            ReadAloudService.isAudible()
        );
        if (decision != KeyPolicy.Decision.PASS_TO_SYSTEM) {
            String keyName = KeyPolicy.hardwareKeyName(decision);
            if (keyName != null) {
                MiniBookPlugin plugin = MiniBookPlugin.peekActiveInstance();
                if (plugin != null) {
                    plugin.emitHardwareKey(keyName);
                }
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    public void applyImmersiveMode(boolean enabled) {
        Window window = getWindow();
        if (window == null) return;
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller == null) return;
        if (enabled) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    public void applyKeepScreenOn(boolean enabled) {
        Window window = getWindow();
        if (window == null) return;
        // Never hold FLAG_KEEP_SCREEN_ON on E-Ink panels (`ARCHITECTURE.md` §10)
        if (enabled && !einkDetected) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        MiniBookPlugin.handleIncomingIntent(this, intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getWindow() != null) {
            ViewCompat.requestApplyInsets(getWindow().getDecorView());
        }
        syncSafeAreaCssVars();
        MiniBookPlugin.scanDroppedInUserBooks(this);
    }

    @Override
    public void onPause() {
        this.keepRunning = true;
        super.onPause();
        // Never stop ReadAloudService when leaving MainActivity
    }

    @Override
    public void onStop() {
        this.keepRunning = true;
        super.onStop();
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    REQ_POST_NOTIFICATIONS
                );
            }
        }
    }

    private void syncSafeAreaCssVars() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String js = String.format(
            Locale.US,
            "(function(){var r=document.documentElement.style;"
                + "r.setProperty('--m-safe-top','%.2fpx');"
                + "r.setProperty('--m-safe-right','%.2fpx');"
                + "r.setProperty('--m-safe-bottom','%.2fpx');"
                + "r.setProperty('--m-safe-left','%.2fpx');"
                + "})();",
            safeTopDp, safeRightDp, safeBottomDp, safeLeftDp
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void dispatchBackToWebView() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.post(() -> webView.evaluateJavascript(
                "(function(){try{return typeof window.__minibookHandleBack==='function'?Boolean(window.__minibookHandleBack()):false;}catch(e){return false;}})()",
                result -> {
                    if (!"true".equals(result)) {
                        moveTaskToBack(true);
                    }
                }
            ));
        } else {
            moveTaskToBack(true);
        }
    }
}
