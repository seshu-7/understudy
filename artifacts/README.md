# artifacts

Saved capabilities. One JSON file per capability, committed so a reviewer can
read the schema output without running anything. Each `.json` has a matching
`.md` alongside it: the human-readable render (`src/artifact/render.ts`) a
reviewer reads before flipping `approval` from `draft` to `approved`.

`corevantage_servicing.member_savings_balance.v1.json` is the first real
one, compiled by `npm run compile` from a genuine discovery run
([`evidence/discovery-1786836008257/`](../evidence/discovery-1786836008257/)).
It's not hand-written or built from a fixture.

`corevantage_servicing.member_savings_balance.northstar.v1.json` is the same
capability reused against a second real tenant, not re-recorded. It was
produced by `npm run overlay` (`src/artifact/overlay.ts`) from the file
above, with the member-search button's name rewritten from "Search"
(meridian) to "Find Member" (northstar) and the target binding pointed at
northstar's own server. REPORT.md §4 has the full write-up, including what
actually happens to the *un*-overlaid capability against the same tenant.

A capability is a build output, not a transcript. It carries a content hash
over its semantic parts (steps, parameters, outcomes), excluding provenance
and approval state, so two capabilities that compile or overlay to the same
program hash identically. Two that don't, don't. That's a real check, not an
eyeball comparison of two JSON files.

Naming: `<app>.<capability-name>.v<version>.json`, or
`<app>.<capability-name>.<tenant>.v<version>.json` for a capability produced
by `npm run overlay` rather than `npm run compile`.

Every artifact is `draft` until explicitly approved. Unattended replay of a
`draft` capability is refused by policy. `npm run overlay`'s output always
starts `draft` regardless of the source capability's approval state, for the
same reason: nobody has reviewed the overlaid descriptors yet.
