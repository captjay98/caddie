# forge_flutter_template

Flutter client paired with the proven Hono API (the react-hono stack). The
API base is configurable at build time; no credentials, signing material, or
platform secrets are ever part of this template.

## Commands (the recipe's contract)

```sh
flutter pub get            # resolve packages
flutter test               # widget tests (real loopback HTTP server in-process)
flutter build apk --debug \
  --dart-define=CADDIE_API_BASE=http://10.0.2.2:8080   # real debug APK
flutter emulators --launch caddie-test                 # emulator under test
```

- `10.0.2.2` is the Android-emulator alias for the host loopback; set
  `CADDIE_API_BASE` to wherever the API actually runs.
- The Android host folder (`android/`) is generated at first build:
  `flutter create --platforms=android --org dev.forge --project-name
  forge_flutter_template .` — recipe templates do not vendor platform trees.
- Evidence bar: a real debug APK launched on an emulator with an interaction
  capture (`scripts/capture-android.ts` from the Caddie repo drives adb). A
  Flutter-web screenshot is never a substitute.
- Signing stays a user-project concern: generated code carries no platform
  credentials and never copies signing material from any user project.
