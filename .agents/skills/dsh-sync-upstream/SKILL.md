---
name: dsh-sync-upstream
description: Use when asked to update the fork (github.com/niittymaa/deepseek-harness) with the main repository's changes, to pull or merge upstream, or to resolve conflicts from such a merge. Merges deepseek-ai/deepseek-harness master into the fork's master, resolves every conflict without asking, verifies locally without CI or Docker, and pushes.
---

# DSH Sync Upstream

The fork carries its own commits on top of `deepseek-ai/deepseek-harness`. An update brings every upstream commit into the fork's `master` with a merge commit, keeps the fork's behavior, and ends pushed. The agent resolves conflicts itself; it stops only where the procedure below says so.

The fork uses no CI and no Docker. GitHub Actions is disabled in the fork's repository settings, and the workflow and Docker files stay only so that merges stay clean. Do not delete, edit, run, or wait for them. All evidence is local.

## 1. Prepare

```sh
git status --short --branch        # must be master with a clean tree
git remote -v                      # origin = niittymaa fork, upstream = deepseek-ai
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git   # only when missing
git fetch upstream --tags
git fetch origin
git rev-list --left-right --count master...upstream/master   # fork-only vs upstream-only commits
```

When the tree is dirty, commit the user's pending work first if it is the user's requested work; otherwise stop and ask, since a merge must not mix unrelated changes. When `master` is behind `origin/master`, fast-forward it first (`git merge --ff-only origin/master`). Never rebase, reset, or force-push `master`: its history is published.

## 2. Merge

```sh
git merge --no-ff --no-edit upstream/master
git diff --name-only --diff-filter=U    # the conflicts to resolve
```

## 3. Resolve conflicts

Resolve every file before running any check. For each conflict, read both sides and the commits that made them before choosing:

```sh
git log --oneline upstream/master..master -- <file>   # the fork's commits on this file
git log --oneline master..upstream/master -- <file>   # upstream's commits on this file
git show <commit> -- <file>
```

The governing rule: **take upstream's structure, then re-apply the fork's intent onto it.** Upstream moves, renames, and refactors code; the fork's commits carry deliberate features and fixes, so do not drop either side.

- **Code** (`.ts`, `.tsx`, `.css`): when upstream moved or rewrote the block the fork changed, delete the fork's copy at the old location and re-apply the fork's change to upstream's new code. When both sides added independent items (imports, union members, list entries, tests), keep both. Never leave a behavior from either side silently lost.
- **Generated documentation** (`docs/event-producer-consumer*.md`, `docs/architecture*.md`, `docs/capability-seams*.md`, and other files `pnpm run gen-doc-graphs` writes): take upstream's side (`git checkout --theirs <file>`), then regenerate after all conflicts are resolved.
- **Translation records** (`*.i18n.yaml`): take either side; they are re-recorded in step 4.
- **Lockfile** (`pnpm-lock.yaml`): git usually merges it cleanly. On a conflict, take upstream's side and run `corepack pnpm install --no-frozen-lockfile` so the fork's packages are re-resolved into it.
- **`AGENTS.md` and other instruction files**: keep upstream's text and the fork's own lines (the `Pushing` paragraph and links to fork-only skills such as this one).
- **Workflow and Docker files** (`.github/`, `Dockerfile*`, `docker/`): take upstream's side. The fork does not use them.
- **A file deleted on one side and changed on the other**: if upstream deleted it, find where its content went (`git log --diff-filter=D --follow`) and move the fork's change there; if the fork deleted it, keep it deleted unless upstream's change is required by other upstream code.

Mark each resolved file with `git add <file>` and check that no markers remain: `git grep -nE '^(<<<<<<<|=======|>>>>>>>)( |$)'`.

Stop and ask the user only when the two sides contradict each other in behavior (both change the same rule in incompatible ways) and neither the commit messages nor the code show which one the user wants. Describe both behaviors and recommend one.

## 4. Regenerate and re-record

Install with the pnpm version `packageManager` in `package.json` names. A globally installed older pnpm rewrites `pnpm-lock.yaml` in its own format and fails on `overrides`; `corepack pnpm` runs the pinned one. Close the desktop app first, because a running Electron locks files the install replaces.

```sh
corepack pnpm -v                                     # must equal packageManager
CI=true corepack pnpm install --frozen-lockfile      # upstream may add dependencies
pnpm run gen-doc-graphs
pnpm run verify-translation-pairing
```

For each pair the check reports as out of sync, bring the other language along. Translate the changed section into the other side, keep the item counts and structure matching, then record the pair:

```sh
pnpm exec tsx scripts/verify-translation-pairing.ts --write <file of the pair> [...]
```

Record only pairs whose content you reviewed; never use `--all`.

## 5. Verify locally

Run these until they pass, fixing what the merge broke:

```sh
pnpm run build:artifacts && pnpm run build:check
pnpm exec tsx scripts/run-oxlint.ts <changed package dirs>
pnpm exec vitest run <packages whose files had conflicts or fork changes>
```

Choose test packages from the conflict list and from `git diff --stat upstream/master` (the fork's own changes). Coverage applies per file at 100% for the fork's packages (`--coverage --coverage.include='packages/<group>/<pkg>/src/**/*.ts'`). Failures from the local environment, such as a Windows symlink permission, are reported, not "fixed". When upstream's own tests fail independently of the fork, record which and why in the report instead of changing upstream code.

When the desktop app is part of the change, launch it with `pnpm dev:desktop` and check the affected feature in its window.

## 6. Commit and push

```sh
git commit --no-edit          # keeps the merge message; add the attribution trailer the session requires
git push origin master
```

The pre-commit and pre-push hooks run lint, whitespace, and typecheck; fix failures instead of skipping hooks. Upstream commits usually touch `.github/workflows/`, and GitHub refuses such a push ("without `workflow` scope") unless the credential carries that scope, even with Actions disabled. The `gh` credential may lack it (`gh auth status` lists the scopes) while Git Credential Manager holds one that has it; push through that one without prompting:

```sh
GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0 git -c credential.https://github.com.helper= -c credential.helper=manager push origin master
```

If that also fails, the user runs `gh auth refresh -h github.com -s workflow` once (an interactive browser sign-in) and the push is retried. Scan the merge's fork-side resolutions for credentials and personal paths before pushing.

## 7. Report

Report the commit counts merged, each conflict and how it was resolved, regenerated and re-recorded files, the checks run with results, and anything left for the user.
