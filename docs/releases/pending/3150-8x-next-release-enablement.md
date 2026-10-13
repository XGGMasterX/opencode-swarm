---
issue: 3150
title: 8.x next-line release enablement — heal the uninstallable next dist-tag
---

## What changed (8.x `next` line only)

The 8.0.x-beta packages on the npm `next` dist-tag have been uninstallable
since March (`@opencode-swarm/core@8.0.0-beta.0` published a `workspace:*`
dependency spec). The source-side fix landed earlier (#3163), but no corrected
release could ever ship: the automated release path mis-versioned
(release-please swept the resurrected, tag-less `next` branch's entire history
and proposed 9.0.0-beta.0 — PR #3173, closed unmerged), a force-publish retry
would no-op because committed versions still equal the published broken ones,
and the publish steps masked every publish failure.

This release enables the healing release through the repo's own machinery:

- **release-please config**: root-level `bootstrap-sha` bounds the bootstrap
  sweep past the last BREAKING commit (no more 9.0.0-beta.0 mis-proposal);
  per-component tags plus a `linked-versions` lockstep group (all four
  packages release together at one version — tags render as
  `<component>-v<version>`, e.g. `core-v8.0.2-beta.0`); the dead `branches`
  config array is removed (nothing consumed it).
- **publish workflow**: publish steps now fail loudly (`set -eo pipefail` +
  explicit `exit 1`); the E403/already-exists skip tolerance applies only to
  explicit `force_publish` retries.

## User-visible effect

Once the next release PR merges and publishes, `npm i opencode-swarm@next`
(and the bun equivalent) installs successfully again; the broken betas are
then deprecated (`npm deprecate @opencode-swarm/core@8.0.0-beta.0 …`).

## Notes

- The healing release proposes **8.0.2-beta.0 for all four packages**
  (lockstep), advancing every package past its published version.
- Every future `next`-line release re-releases all four packages together
  (linked-versions semantics — intended).
