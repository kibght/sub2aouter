# Third-party integration

`integrations/infinite-canvas` tracks [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) as a Git submodule.

- Upstream license: AGPL-3.0
- Local integration patches: `scripts/apply-infinite-canvas-patches.mjs`
- Sub2 embedding integration: `scripts/apply-sub2-infinite-canvas-integration.mjs`
- Deployment and upgrade guide: `docs/infinite-canvas.md`

Do not commit local edits inside the submodule. Update the submodule pointer, apply the adapter in a disposable worktree, run all checks, and merge through the automated upgrade pull request.
