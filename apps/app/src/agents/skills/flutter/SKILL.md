# Flutter stack skill (P15d v1)

Build and verify Flutter apps with a proven Hono API backend in the sandbox.

## Discipline

- Real device evidence only: debug APK install + emulator interaction
  (screens/video through the emulator), never a web-render screenshot.
- `flutter test` green, then widget-level checks on the emulator.
- Platform credentials (signing keys, API tokens) never enter the template or
  the generated code; the user's signing material is never copied.
- The default backend is the proven Hono API; alternative pairings need their
  own contract test before use.
- Report exact flutter/adb commands, exit codes, and the emulator interaction
  receipt (session id, duration).
