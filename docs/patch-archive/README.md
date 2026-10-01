# Patch archive (historical, do not apply)

These `.patch` files were hand-applied fixes from before the release process in
[`../RELEASING.md`](../RELEASING.md). Every one is already contained in the
current code on `main`; they are kept only as a record. Re-applying any of them
risks reverting later work. Fixes now ship as reviewed commits with tests, and
CI fails if a loose patch file reappears in the repo root.
