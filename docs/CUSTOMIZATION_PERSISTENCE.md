# Frontend and Infinite Canvas Customization Persistence

## Authoritative sources

Sub2 frontend visual customization is not maintained by editing generated releases. Its authoritative sources are:

- full files under `theme/apophis/files/`;
- exact marker/sentinel patches under `theme/apophis/patches/`;
- the ordered patch list in `theme/apophis/manifest.json`.

Sub2-to-Canvas integration is authoritative in:

- `scripts/infinite-canvas-integration/sub2-files/` for Sub2 files;
- `scripts/infinite-canvas-integration/canvas-files/` for Canvas-owned files;
- `scripts/apply-sub2-infinite-canvas-integration.mjs` for Sub2 routes, navigation, CSP, locale, backend routing and build integration;
- `scripts/apply-infinite-canvas-patches.mjs` for Canvas CSP nonce, router basename, embedded layout, bridge, image-workspace button and compatibility guards.

## Release behavior

A future upstream release cannot silently replace these customizations:

1. full-file overlays replace the upstream file with the authoritative themed file;
2. marker/sentinel patches fail closed when the upstream structure drifts;
3. Canvas integration check mode fails when routes, locale blocks, CSP, backend routing or build hooks drift;
4. Canvas patches run before typecheck and production build;
5. `latest` is not promoted unless the generated snapshot, tests, binary release and asset verification all pass.

## 2026-08-17 compatibility audit

The complete generation path was simulated against:

- Sub2API published Release `v0.1.177` (`4ad52642a1548c46533f458a60d30c192026795e`);
- Sub2API current `main` (`e330c243a8f142f8963d784916da0093ab7084ee`);
- Infinite Canvas published Release `v0.15.1` (`a2576d559ad765ba83e9563894adfbcd4e63405a`);
- Infinite Canvas current `main` (`b66936d891b82c2b51c1ed05e1a6eae3e31d4ca3`).

Results:

- 15 full-file theme overlays applied and rechecked;
- 76 ordered theme patches applied and rechecked;
- 8 Sub2 Canvas template files applied and rechecked;
- Canvas adapter applied idempotently to both the current Release and current upstream main;
- no marker drift or missing customization source was found.

The repository test `scripts/__tests__/customization-persistence.test.mjs` prevents tracked frontend or Canvas integration files from drifting away from their persistent sources.