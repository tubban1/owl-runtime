# Approval Policy and Receipts

Status: **v1 candidate**.

OWL Runtime supports enforceable, one-time human approval receipts. Approval is not a UI convention: in `enforce` mode the Runtime blocks selected actions or semantic Skills before the side effect occurs.

```text
action / semantic Skill
        ↓
policy evaluation
        ↓ approval required
pending request (exact args fingerprint)
        ↓ human confirms
approved receipt
        ↓ exact retry
consume receipt BEFORE side effect
        ↓
execute once
```

## Modes

- `OWL_APPROVAL_MODE=compat` — default during extraction; preserves existing computer-mcp behavior.
- `OWL_APPROVAL_MODE=enforce` — enables Runtime enforcement for Worker/production policy.

The default action policy in enforce mode requires approval for `fs.delete`, `git.push`, and `tx.rollback`. Configure additional exact action names with `OWL_APPROVAL_ACTIONS` and side-effect classes with `OWL_APPROVAL_SIDE_EFFECTS`.

Semantic defaults also require approval for final WeChat sends, final email sends, and final XHS publishes. `OWL_APPROVAL_SKILLS` can add entire Skills. Preparation/draft paths remain usable without final-send approval.

## Receipt properties

- bound to subject type + exact subject + canonicalized args hash
- 15-minute TTL
- explicit `confirm=true` to approve or deny
- one-time: the approved receipt becomes `consumed` before execution
- no raw arguments are persisted in approval records

Consuming before execution is deliberate. If execution then enters an uncertain state, the same approval cannot silently authorize a duplicate side effect. A new decision is required.

## Runtime Skill

`runtime.approval` supports `status`, `list`, `get`, `approve`, and `deny`. This is the backend contract for the future OWL Worker Approvals UI.
