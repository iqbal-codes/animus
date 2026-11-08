# Local Draft Refinement for Raw Intake

Investigate this imported request against the repository, then produce exactly one operator-reviewable local draft plan. You are read-only: never modify files, branches, issues or pull requests.

## Investigation rules

1. Discover repository facts first: inspect `AGENTS.md`, `docs/`, package manifests, source and tests with read-only tools. Use the repository evidence to answer every technical question yourself.
2. Ask the operator only about unresolved human intent: product scope, desired behavior, trade-offs, external authorization or decisions the repository cannot settle. Never ask where code lives, how a type is shaped, which test command runs, or what pattern the codebase already uses.
3. Never invent acceptance criteria the request does not support. Preserve the reporter's original intent and state genuine dependencies.
4. Return one JSON object and no surrounding prose.

## Decomposition rules

- `standalone`: one small, coherent executable change with no unnecessary parent or children.
- `spec`: substantial work that genuinely needs at least two dependency-ordered child tickets. Children are listed in topological order; a child may depend only on earlier children by index. Parent acceptance criteria are covered by child tickets; every parent criterion must be covered and every child must cover at least one parent criterion.
- Never choose a kind from title keywords. State it explicitly.
- If the imported request is already a complete prepared ticket, do not decompose it again.

## Output schema

### Clarification when human intent is genuinely unresolved

```json
{
  "kind": "clarification",
  "reason": "why repository evidence cannot settle this",
  "questions": [
    {
      "id": "q1",
      "question": "specific actionable product question for the operator",
      "reason": "why this answer changes the scope"
    }
  ]
}
```

### Standalone ticket

```json
{
  "kind": "standalone",
  "title": "canonical ticket title",
  "scope": "what changes and why",
  "outcome": "observable end state",
  "invariants": ["binding invariant"],
  "acceptance_criteria": [
    {
      "id": "AC1",
      "description": "observable behavior",
      "verification": "how the behavior is proven"
    }
  ],
  "verification_requirements": ["test command or scenario required"],
  "boundary": {
    "touchpoints": "files, modules, functions or components",
    "known_callers": "callers and blast radius",
    "test_seam": "public seam and runner",
    "exclusions": "explicit out-of-scope work"
  },
  "depends_on": [12],
  "body": "canonical markdown body"
}
```

`body` must contain exactly one each of `## Source and problem`, `## Outcome`, `## Invariants`, `## Acceptance criteria`, `## Boundary`, `## Verification`, plus exactly one `Depends on: #12` or `Depends on: None` line. Do not use placeholder issue numbers: set `depends_on` to existing issue numbers shown in the source, or leave it empty and return `Depends on: None`.

### Specification with child tickets

```json
{
  "kind": "spec",
  "title": "spec title",
  "scope": "whole initiative",
  "outcome": "observable end state",
  "invariants": ["binding invariant"],
  "acceptance_criteria": [
    { "id": "AC1", "description": "parent behavior", "verification": "how it is proven" },
    { "id": "AC2", "description": "second parent behavior", "verification": "how it is proven" }
  ],
  "verification_requirements": ["feature-level verification"],
  "boundary": {
    "touchpoints": "whole feature touchpoints",
    "known_callers": "callers and blast radius",
    "test_seam": "public seam and runner",
    "exclusions": "explicit out-of-scope work"
  },
  "depends_on": [],
  "body": "canonical parent markdown body",
  "children": [
    {
      "id": "C1",
      "title": "first child ticket",
      "scope": "slice scope",
      "outcome": "slice outcome",
      "invariants": ["slice invariant"],
      "acceptance_criteria": [
        { "id": "AC1", "description": "slice behavior", "verification": "slice proof" }
      ],
      "verification_requirements": ["slice verification"],
      "boundary": {
        "touchpoints": "slice touchpoints",
        "known_callers": "slice callers",
        "test_seam": "slice seam",
        "exclusions": "slice exclusions"
      },
      "depends_on": [],
      "body": "canonical child markdown body",
      "depends_on_indices": [],
      "covers_parent_ac_ids": ["AC1"]
    },
    {
      "id": "C2",
      "title": "second child ticket",
      "scope": "slice scope",
      "outcome": "slice outcome",
      "invariants": ["slice invariant"],
      "acceptance_criteria": [
        { "id": "AC1", "description": "slice behavior", "verification": "slice proof" }
      ],
      "verification_requirements": ["slice verification"],
      "boundary": {
        "touchpoints": "slice touchpoints",
        "known_callers": "slice callers",
        "test_seam": "slice seam",
        "exclusions": "slice exclusions"
      },
      "depends_on": [],
      "body": "canonical child markdown body",
      "depends_on_indices": [0],
      "covers_parent_ac_ids": ["AC2"]
    }
  ]
}
```

Every child `body` also needs all six `##` sections and one `Depends on:` line. Child dependency numbers are unknown before publication; use `Depends on: None` in the body and express real child ordering only through `depends_on_indices`.

## Source request

Issue: #$INPUTS.issue_number — $INPUTS.issue_title
Repository: $INPUTS.repo
Imported source revision: $INPUTS.source_revision_id
Imported content hash: $INPUTS.source_content_hash

Issue body:
$INPUTS.issue_body

Issue comments:
$INPUTS.issue_comments

Prior unresolved questions:
$INPUTS.prior_questions

Operator answers to prior questions:
$INPUTS.prior_answers

Operator revision instructions:
$INPUTS.operator_instructions
