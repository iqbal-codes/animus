---
title: Remove gratuitous verifyCandidateDeployment alias
author: Muhammad
date: 2026-11-04
branch: factory/spec-140-integration
id: l-feb6fbba
scope: repo
status: active
src: agent
touches:
  - scripts/loop/qa-runner.ts
---

## Decided
- Removed gratuitous verifyCandidateDeployment alias from scripts/loop/qa-runner.ts because clean cutover prohibits gratuitous aliases without callers. Trail callers confirmed 0 references across the repository, so only canonical verifyDeployment is exposed.
## Tried and ruled out
- Retaining unused compatibility aliases without callers was ruled out because it violates clean cutover principles; only explicit runLocalLoop alias is retained for backwards compatibility.
## Watch out
- Do not add unneeded forward or backward aliases during module consolidation without callers. Preserve uncommitted .gitignore/.ignore.
