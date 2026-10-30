# Flutter toolchain for the scaffold-lock check

How to run `scripts/refresh-flutter-scaffold-lock.ts` locally (and in CI) against
the Flutter SDK the committed scaffold lock was generated with. `flutter`/`dart`
are **not** on the agent-shell PATH on this machine; they live under `fvm`.

## The SDK the committed lock matches: Flutter 3.44.8 (Dart 3.12.2)

`stacks/flutter/scaffold-lock.ts` pins SDK-bundled transitives
(`matcher 0.12.19`, `meta 1.18.0`, `test_api 0.7.11`, `vector_math 2.2.0`) and
declares `dart: ">=3.12.0 <4.0.0"`. That is **Flutter 3.44.8 / Dart 3.12.2**,
which `fvm` exposes as its `stable` version directory:

```
/Users/captjay98/fvm/versions/stable/bin/flutter   # Flutter 3.44.8
/Users/captjay98/fvm/versions/stable/bin/dart       # Dart 3.12.2
```

> `fvm list` prints 3.44.8 only via the `stable` row — there is no literal
> `~/fvm/versions/3.44.8` directory, so point FLUTTER at `.../versions/stable/bin/flutter`.

## Command that makes `--check` exit 0

The script reads `FLUTTER=<flutter binary>` for its own top-level calls and
derives `dart` as `dirname($FLUTTER)/dart`. But `caddie/setup.dart`,
`caddie/run-tests.sh`, and the recipe steps shell out to **bare** `flutter`/`dart`,
and the script invokes `bun` as subprocesses — so the fvm SDK bin dir **and** a
real `bun` must also be on `PATH`. The mise `bun` shim has no pinned version and
fails; use `~/.bun/bin/bun` (Bun 1.4.0, the lockfile writer).

```sh
cd /Users/captjay98/projects/caddie-forge
export PATH="$HOME/.bun/bin:/Users/captjay98/fvm/versions/stable/bin:$PATH"
export FLUTTER=/Users/captjay98/fvm/versions/stable/bin/flutter
export KIROCREW_SCRATCH="$(mktemp -d)"   # avoids an EPERM-lstat on the default scratch dir
export TMPDIR="$KIROCREW_SCRATCH"
bun scripts/refresh-flutter-scaffold-lock.ts --check
```

Earlier pre-rewrite verification: 2026-10-26. Exit 0, digest
`sha256:a7ee7e6d9c8aa98a5ea38d1d5521eac1fada7ad41506d5c54443776757af1661`,
`flutter build web` main.dart.js 1.73 MB, `flutter analyze` clean, both lockfiles
unchanged by the locked installs.

After the Clean Architecture rewrite, the recovery session re-ran the same
`--check` command successfully. Current digest:
`sha256:07aa2b63966fdaf432697eaf572cfb74d40080af4a71b23289c0c2bd1fbd2483`.
The web build is now 2.65 MB; analysis is clean, both locked installs remain
unchanged, and the bare scaffold still fails the app-test gate. See
[recovery evidence](plans/2026-10-26-stopped-session-recovery.md). This remains
local toolchain evidence, not proof of a live Flutter sandbox build or APK.

## Why not Flutter 3.47.1

`fvm` also caches Flutter 3.47.1 (Dart 3.13.1). Running `--check` against it
**fails** at `flutter pub get --enforce-lockfile`: 3.47.1's bundled SDK resolves
newer transitives (`matcher 0.12.20`, `meta 1.19.0`, `test_api 0.7.12`,
`vector_math 2.4.3`) than the committed lock pins, so the frozen install cannot
be satisfied. Moving the scaffold to 3.47.1 means **regenerating** the lock
(run the script without `--check`) and re-proving the stack — a separate task,
not a toolchain-wiring fix.
