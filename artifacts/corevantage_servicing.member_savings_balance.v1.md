# Look up a member's savings balance

look up member {member_number} and read their current savings balance

**id** `corevantage_servicing.member_savings_balance` · **version** 1 · **approval** `draft` · **content hash** `10f12f3bda9a8384`

## Target

corevantage-servicing (web), tenant `meridian`
Entry point: http://127.0.0.1:4501/servicing/login.asp

## Inputs

| name | type | required | description | example |
| --- | --- | --- | --- | --- |
| `member_number` | string | yes | "Member Number" - bound from the value discovery typed for this run. | `100234` |

## Outputs

| name | type | description | extracted from |
| --- | --- | --- | --- |
| `savings_balance` | string | Read from the screen reached at the end of this capability. | text within "Accounts" (frame: mainfrm) [position 6] |

## Steps

1. **Click the Sign On button to proceed to the main application**
   - action: click button named "Sign On" within "Sign On CoreVantage Servicing 7.2"
   - risk: `safe`
   - checkpoint: screen shows textbox labelled "Operator ID" within "Operator ID is required."
2. **enter the operator ID into the required field**
   - action: fill textbox labelled "Operator ID" within "Operator ID is required." with "demo"
   - risk: `safe`
   - checkpoint: screen shows button named "Sign On" within "Operator ID is required."
3. **Click the Sign On button to proceed to the next screen**
   - action: click button named "Sign On" within "Operator ID is required."
   - risk: `safe`
   - checkpoint: screen shows textbox labelled "Member Number" within "Servicing > Member Search" (frame: mainfrm)
4. **enter the member number into the search field**
   - action: fill textbox labelled "Member Number" within "Servicing > Member Search" (frame: mainfrm) with {member_number}
   - risk: `safe`
   - checkpoint: screen shows button named "Search" within "Servicing > Member Search" (frame: mainfrm)
5. **Click the Search button to initiate the search for member 100234**
   - action: click button named "Search" within "Servicing > Member Search" (frame: mainfrm)
   - risk: `safe`
   - checkpoint: screen shows text within "Accounts" (frame: mainfrm) [position 6]

## Outcomes

_None declared. Replay treats anything other than reaching the final step's checkpoint as a hard failure — see REPORT.md §3 for the boundary between what discovery can infer and what a reviewer adds by hand._

## Provenance

- discovered by `ollama/qwen2.5:7b-instruct`
- discovery run: `1786836008257` at 2026-08-15T23:20:08.486Z
- steps pruned during compilation: 0
- human-edited since compilation: no
