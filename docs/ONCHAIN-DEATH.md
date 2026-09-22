# Recording deaths on chain: options

This question has been open since phase 5, and it blocks the one phrase we
cannot use yet: "the death is recorded on chain forever".

This document is not a decision, but three options with trade-offs, so there
is something to choose from.

## What already exists

`data/deaths-A.csv`, append-only, one row per generation:

```
gen,step,ts,seed,name,title,ageSteps,kills,bites,px,pxAth,lastSig
1,47230,1789758062500,0xca4fb142,Dolores Dumpetta X,The Unsold,
  47230,33,68,0.0000040316,0.0000242822,2E5qV9iR...
```

`lastSig` is the signature of the last transaction before the death. So the row
is already tied to a specific on-chain transaction, and anyone
can verify it by replaying the log (`tools/replay.js`).

**This is an honest, verifiable registry, but not an on-chain record.** It
sits on our disk, and we could rewrite it. That is exactly why
the "forever" wording is forbidden for now.

## What exactly is worth writing

The minimum that makes the claim meaningful (about 100 bytes):

| Field | Bytes | Why |
|---|---|---|
| `gen` | 2 | generation number |
| `seed` | 4 | the DNA is derived from it, i.e. the name and appearance |
| `deathSlot` | 8 | the slot in which she died |
| `lastSig` | 64 | signature of the last trade before the death |
| `stateHash` | 4 | simulation state hash at the moment of death |
| `ageSteps`, `kills`, `bites` | 12 | the epitaph |

`stateHash` is the key field. It makes the record verifiable: anyone
takes the log, runs `tools/replay.js` and must get
the same hash. Without it the chain would just hold our word.

## Option A: keeper wallet

Our process signs a transaction after every death.

- **gas**: a memo transaction on Solana is about 0.000005 SOL.
  At 20 deaths a day - under 0.01 SOL a month. Nothing.
- **simple**: the key lives with the collector, one `sendTransaction`
- **but**: centralized. We could skip a death, record a
  fake one, or stop paying. "Forever" here means "as long as
  we are honest", and that should be said plainly, not hidden.

The fastest path. The honesty rests on the record being **verifiable**:
a forgery shows up when the log is replayed.

## Option B: a contract with input validation

The contract accepts a record only if it is consistent: the next
generation after the previous one, the slot increases, the hash matches.

- **stronger**: the contract rejects nonsense records
- **but**: the contract cannot verify the *simulation*. It does not know
  whether the fly really died - only that the record is formally valid.
  So the keeper is still trusted, it is just harder for it to lie
  unnoticed.
- **cost**: contract development and audit, rent for the account

The middle option. Removes crude forgery, does not remove trust.

## Option C: any viewer can record

The death is derived from the log deterministically, so **anyone** can
compute it and record it first. The contract accepts the first
valid record for generation N.

- **strongest**: nobody has to trust us. If we do not record it,
  one of the viewers will - and that is exactly the property the
  narrative promises
- **but**: someone has to pay gas, either a small incentive from the
  treasury or goodwill. Plus it is more complex: the contract must
  check consistency more strictly, because the writer is untrusted
- **cost**: the most development

The most honest option, and the only one where "forever" is true without
footnotes.

## What needs to be decided

1. **Which option.** This decides whether to start phase 4 at all.
2. **Who holds the key** (A and B) or **who pays the incentive** (C).
3. **What to do with the history before the contract.** If the contract appears
   after launch, the first generations will only be in the CSV. Either
   record them in a batch, or honestly say that the registry starts
   at generation N.

## My recommendation

**A for launch, C as the goal.** Option A takes a day and already gives
more than the CSV: an on-chain record with a hash anyone can check.
C makes the claim unconditional, but it is a separate project, and doing
it before the token is even live is premature.

Wording that is acceptable with A, without lying:

> Every death is recorded on chain together with the state hash.
> The record is signed by the project's keeper, and anyone can verify it
> by replaying the event log.

Wording that is **not acceptable** with A:

> The death is recorded on chain forever, nobody can change it.
