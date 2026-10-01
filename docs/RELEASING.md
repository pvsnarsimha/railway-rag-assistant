# Release management

Problem this solves: fixes were lost and old code came back because changes were
applied as loose `.patch` files, deploys weren't tied to a known commit, and
nothing checked a change before it shipped. The rules below make "what is live,
and does it contain every fix?" a question with a checkable answer.

## The one path to production

```
feature branch -> pull request -> CI green -> merge to main -> Render auto-deploys main (only after CI passes)
                                                            -> tools/verify_deploy.py confirms the live commit
```

1. **`main` is the only deployable branch.** `render.yaml` pins `branch: main` and
   `autoDeployTrigger: checksPass`, so Render deploys a commit only once CI is green on it.
2. **No loose patches, no hand-edits on the server.** CI fails if `*.patch/.diff/.orig/.rej`
   appear in the repo root. Historic patches live in `docs/patch-archive/` for reference only.
3. **Every bug fix ships with a test** (`backend/tests/test_regressions.py` or beside the code).
   A fix without a test can vanish in the next merge unnoticed; one with a test turns CI red.
4. **Merge, don't overwrite.** Update a branch with `git merge origin/main`, never by copying
   files over from a zip/older checkout. Old code returns when an old tree is pasted over a new one.

### One-time GitHub settings (cannot be set from code)
Settings -> Branches -> add rule for `main`:
- Require a pull request before merging
- Require status checks to pass: **test** (from `CI`)
- Require branches to be up to date before merging
- Block force pushes and deletion

Settings -> Secrets and variables -> Actions -> Variables: add `APP_URL` (the Render URL) to
enable the production monitor.

## Versioning
Semantic versioning in the repo-root `VERSION` file. The running app reports it, plus the git commit it
was built from, at `/api/version`, `/healthz`, `/api/health` and in `X-App-Version` / `X-App-Commit`
response headers. "Is the new code live?" = compare that commit with the one you merged.

- patch (1.0.1): bug fixes
- minor (1.1.0): new features, backwards compatible
- major (2.0.0): breaking API/data changes

## Cutting a release
1. Add a `## [x.y.z] - date` section to `CHANGELOG.md`; bump `VERSION`; merge via PR.
2. `git tag vx.y.z && git push origin vx.y.z`
3. The **Release** workflow checks the tag equals `VERSION`, is on `main`, has a changelog entry,
   re-runs tests and the evaluation gate, then publishes a GitHub release with the changelog and
   the measured accuracy numbers.

## Verifying a deploy
```
python tools/verify_deploy.py --url https://<app>.onrender.com --expect-commit <sha>
```
Fails (exit 1) on: unreachable service, **stale commit/version still live**, empty chat answer,
latency over budget, 5xx rate over threshold. The same script runs every 15 minutes from
`.github/workflows/monitor.yml`.

## Rolling back
Render dashboard -> service -> Events -> *Rollback* to the previous deploy (instant, no rebuild), **or**
`git revert <bad-sha>` and merge (the right fix for the history). Do not roll back by resetting `main`
or force-pushing; that is exactly how fixes get lost. After either, run `verify_deploy.py` with the
expected commit.

## Data note
SQLite files are ephemeral on Render's free tier (reset every deploy). Delay-accuracy history, push
subscriptions and watches are lost on each release until a persistent disk or hosted DB is attached.
