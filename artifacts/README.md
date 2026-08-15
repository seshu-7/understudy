# artifacts

Saved capabilities. One JSON file per capability, committed so a reviewer can
read the schema output without running anything. Each `.json` has a matching
`.md` alongside it - the human-readable render (`src/artifact/render.ts`) a
reviewer actually reads before flipping `approval` from `draft` to `approved`.

`corevantage_servicing.member_savings_balance.v1.json` is the first real one:
compiled by `npm run compile` from a genuine discovery run
([`evidence/discovery-1786836008257/`](../evidence/discovery-1786836008257/)),
not hand-written or built from a fixture.

A capability is a build output, not a transcript. It carries a content hash
over its semantic parts — steps, parameters, outcomes — excluding provenance
and approval state, so two capabilities recorded independently that compile to
the same program hash identically. That is what makes the cross-model
comparison in `evidence/` a real check rather than an eyeball exercise.

Naming: `<app>.<capability-name>.v<version>.json`

Every artifact is `draft` until explicitly approved. Unattended replay of a
`draft` capability is refused by policy.
