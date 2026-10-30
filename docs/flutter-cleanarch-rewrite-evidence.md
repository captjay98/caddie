# Flutter output-stack scaffold → full Clean Architecture (evidence)

Date: 2026-10-26. Toolchain: Flutter 3.44.8 / Dart 3.12.2 (via fvm
`~/fvm/versions/stable`), Bun 1.4.0 (`~/.bun/bin/bun`). Local verification only —
no deploys, no pushes, no paid sandbox calls.

## What changed

`stacks/flutter/` previously shipped a minimal, flat, `http`-only scaffold
(`lib/main.dart` + `lib/api.dart`, one direct dep, no codegen). It now ships a
small-but-real **Clean-Architecture** Flutter app modelled on the owner's real
apps (`onesecos/mobile`, `projavi/mobile`) and the
`onesecos/.opencode/skills/flutter-architecture/SKILL.md` rules: feature-first
`lib/{app,core,features,shared}`, Riverpod 3 `@riverpod` providers, a Dio
network client with an interceptor, go_router, a freezed + json_serializable
model generated via `build_runner`, flutter_secure_storage, and google_fonts —
all talking to the same Hono/Workers + D1 backend the scaffold already carried.

Files edited (only the Flutter stack + its guard test — no config, no migration
numbering, no ledgers):

- `stacks/flutter/scaffold.ts` — new `FLUTTER_FILES` manifest (the layered app
  source + the modified `caddie/setup.dart`); dropped the old flat `lib/api.dart`.
- `stacks/flutter/recipe.ts` — version `2.0.0` → `3.0.0`; documents that code
  generation runs inside `caddie/setup.dart`.
- `stacks/flutter/scaffold-lock.ts` — **GENERATED**; regenerated bun.lock,
  pubspec.lock (content-hashed) and the digest.
- `tests/flutter-scaffold.test.ts` — guard assertions updated to the new shape.

`stacks/flutter/digest.ts` was left unchanged (its hashing logic needed no edit).

## New `lib/` tree

```
lib/
├── main.dart                               # ProviderScope + App entry point
├── app/
│   ├── app.dart                            # MaterialApp.router ConsumerWidget
│   ├── router.dart                         # go_router as a @Riverpod(keepAlive) provider
│   └── theme.dart                          # Material 3 light/dark + google_fonts
├── core/
│   ├── config/api_config.dart              # base-URL resolution, token key, timeouts
│   ├── error/failures.dart                 # sealed Failure hierarchy + Result + DioException mapper
│   ├── network/
│   │   ├── dio_client.dart                 # configured Dio, @Riverpod(keepAlive), injectable buildDio()
│   │   └── auth_interceptor.dart           # bearer injection + 401 handling
│   └── storage/secure_storage_service.dart # flutter_secure_storage + sync token cache, keepAlive provider
├── features/
│   └── status/                             # one real feature with data/providers/presentation
│       ├── data/
│       │   ├── server_status.dart          # @freezed model (→ .freezed.dart / .g.dart)
│       │   ├── status_api.dart             # GET /api/health data source
│       │   └── status_repository.dart      # maps Failure → Result
│       ├── providers/status_providers.dart # @riverpod api/repository/serverStatus
│       └── presentation/
│           ├── status_screen.dart          # ConsumerWidget, composed from small widgets
│           └── widgets/status_card.dart     # pure-presentation result card
└── shared/
    └── widgets/async_value_view.dart       # reusable AsyncValue loading/error/data view
```

Plus `test/examples/widget_example_test.dart` (two examples, outside the gated
`test/app` folder) and the protected `caddie/setup.dart`.

## Dependencies added (pubspec.yaml)

Runtime: `flutter_riverpod ^3.0.0`, `riverpod_annotation ^3.0.0`, `dio ^5.7.0`,
`go_router ^16.0.0`, `freezed_annotation ^3.0.0`, `json_annotation ^4.9.0`,
`flutter_secure_storage ^9.2.2`, `google_fonts ^6.2.1`, `cupertino_icons ^1.0.8`
(replacing the single old `http` dep).

Dev / codegen: `build_runner ^2.4.13`, `riverpod_generator ^3.0.0`,
`freezed ^3.0.0`, `json_serializable ^6.8.0`.

All resolve against Dart 3.12.2; the regenerated `pubspec.lock` still pins the
SDK-bundled transitives the committed lock requires (`test_api 0.7.11`,
`vector_math 2.2.0`, etc.), so `--enforce-lockfile` is satisfied on 3.44.8.

## How codegen is wired (why it content-hashes deterministically)

freezed / json_serializable / riverpod `.freezed.dart` / `.g.dart` files are
**generated at build time, never committed**, so the content-hashed lockfiles
stay the single source of truth and the scaffold digest is over source only.
`caddie/setup.dart` (a protected runtime file the builder cannot edit) now, after
creating the Android/web projects, runs `flutter pub get` then
`dart run build_runner build`. It captures `pubspec.lock` before and restores it
after, so the codegen step never perturbs the locked install the recipe verifies
next — confirmed green across the refresh script's two idempotent `setup.dart`
passes ("leave both lockfiles unchanged").

## New digest

```
FLUTTER_SCAFFOLD_DIGEST = sha256:07aa2b63966fdaf432697eaf572cfb74d40080af4a71b23289c0c2bd1fbd2483
```

## Verification — LOCAL VERIFIED

Command (exact):

```sh
cd /Users/captjay98/projects/caddie-forge
export PATH="$HOME/.bun/bin:/Users/captjay98/fvm/versions/stable/bin:$PATH"
export FLUTTER=/Users/captjay98/fvm/versions/stable/bin/flutter
export KIROCREW_SCRATCH="$(mktemp -d)"; export TMPDIR="$KIROCREW_SCRATCH"
bun scripts/refresh-flutter-scaffold-lock.ts --check
```

`--check` exit 0 (LOCAL VERIFIED), tail:

```
OK: Flutter scaffold lockfiles are current (sha256:07aa2b63966fdaf432697eaf572cfb74d40080af4a71b23289c0c2bd1fbd2483); setup then locked installs, in the product's order, leave both lockfiles unchanged; setup.dart (android/, INTERNET once, Gradle capped, idempotent); examples (2 Flutter, 5 server); gate refuses the bare scaffold, passes with a builder test; flutter build web (main.dart.js 2.65 MB); server bundle + Workers check; flutter analyze clean
```

That single command proves, end to end: the content-hashed `pubspec.lock` +
`bun.lock` reproduce the install without rewriting either; `caddie/setup.dart`
(now including `flutter pub get` + `build_runner`) is idempotent and leaves the
lock untouched across two passes; the two Flutter example tests pass; the gate
refuses the bare scaffold and passes with a builder test; `flutter build web`
emits `main.dart.js` (2.65 MB); the Workers server bundle builds and passes
Caddie's check; and `flutter analyze` finds no issues (so all generated sources
compile cleanly).

`bun run typecheck` — exit 0 (LOCAL VERIFIED):

```
$ tsc --noEmit && bun --cwd=apps/app run check:types
$ tsc --noEmit
(exit 0)
```

`bun test tests/flutter-scaffold.test.ts` — **12 pass / 0 fail** (LOCAL VERIFIED):

```
12 pass
0 fail
95 expect() calls
Ran 12 tests across 1 file.
```

## Not verified here

A live build through Caddie's Flutter sandbox image (the recipe's
`availability` is left `"unverified"`, unchanged) — that is a paid/live step and
out of scope for this local task. The APK build was not run (`--apk` not passed);
`flutter build web`, analyze, example tests and both locked installs were all run
green by the `--check` above.
