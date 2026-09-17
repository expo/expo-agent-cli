# Zip fixtures

Two small archives for `src/utils/__tests__/zipEntry-test.ts`.

- `fixture-deflated.zip`: one deflated entry, `assets/app.fingerprint`, whose content is `test-fingerprint-hash-` repeated 50 times.
- `fixture-stored.zip`: two stored entries. `assets/app.fingerprint` holds what `expo-constants` embeds, so the Android reader test can parse it as well as the zip tests. `stored.txt` holds `stored content`.
