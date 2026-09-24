---
name: capacitor-mobile-quality
description: Use when building or reviewing Capacitor mobile apps (React + Vite in a WebView) — native-feeling WebView UX (safe-area insets, touch hygiene, gestures) and iOS/Android build verification checklists. Loaded by the android-capacitor-specialist and ios-capacitor-specialist agents.
---

# Capacitor Mobile Quality

This skill provides comprehensive mobile UX rules and build verification checklists for Capacitor apps.

## 1. WebView UX Engineering Principles

To make a Capacitor web app feel like a truly native mobile app, enforce these CSS and HTML rules:

### Safe Area Insets
Ensure the app doesn't underlap the notch or the home indicator.
- HTML: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`
- CSS:
  ```css
  body {
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
  ```

### Touch Hygiene & Gestures
Prevent web-like text selection and highlight colors.
```css
* {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
input, textarea {
  -webkit-user-select: auto;
  user-select: auto;
}
body {
  overscroll-behavior-y: none;
  touch-action: manipulation;
}
```
Ensure all touch targets (buttons, links) are at least 48x48px.

### Font Size (iOS Zoom Prevention)
Ensure input fields have a font size of at least `16px`. Otherwise, iOS Safari/WebView will auto-zoom the page when the input is focused, breaking the layout.

## 2. Hardware and Gesture Back Button (Android)

Android users expect the hardware or swipe back gesture to navigate back in the app, or close modals, not exit the app abruptly.
```javascript
import { App } from '@capacitor/app';

App.addListener('backButton', ({ canGoBack }) => {
  if (canGoBack) {
    window.history.back();
  } else {
    App.exitApp();
  }
});
```

## 3. Plugins Configuration

- **Keyboard (`@capacitor/keyboard`)**: Avoid layout crushing when the keyboard opens. Often requires setting `resizeOnFullScreen` or explicitly handling layout shifts.
- **Status Bar (`@capacitor/status-bar`)**: Match the status bar background to the app theme.
- **Splash Screen (`@capacitor/splash-screen`)**: Hide the splash screen only after the initial React render is complete to prevent a white flash.
- **Haptics (`@capacitor/haptics`)**: Trigger light haptic feedback on important button presses.
- **Network (`@capacitor/network`)**: Listen for offline events and show offline UI states.

## 4. Headless Build Validation

Validate Capacitor changes using this two-tier approach to avoid unnecessary heavy builds:

- **Tier 1: Fast Web Sync** (Default for UI/CSS/text/views): `npm run build && npx cap sync <platform>`. Skip native compilation.
- **Tier 2: Heavy Native Build** (Run ONLY when native code, Gradle/Podfile/manifest, Capacitor plugins in package.json, or `capacitor.config.ts` are touched):

### Android (Tier 2 only)
```bash
cd android && ./gradlew assembleDebug
```

### iOS (Tier 2 only)
```bash
cd ios/App && xcodebuild -workspace App.xcworkspace -scheme App -configuration Debug -sdk iphonesimulator clean build
```
