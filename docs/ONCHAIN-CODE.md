# Game code on chain

The partner's original pitch: cut the code into chunks, store it as contract
bytecode, the browser pulls it from the chain and runs it. The idea comes from ChainROM
(`$Depth`) on Robinhood Chain.

## On Solana this is simpler than on EVM

Chunking is an EVM limitation (24 KB per contract), not the essence of the
idea. A Solana account holds **up to 10 MB**: verified by reading the
pump AMM program account of 10,240 KB, 276 ms latency, with a single
`getAccountInfo`.

So the game fits in **one account**, and no splitter is needed.

| What | Size | Deposit (real RPC data) |
|---|---|---|
| Game as is | 118 KB | 0.615 SOL |
| gzip | 43 KB | 0.223 SOL |
| **brotli** | **36 KB** | **0.190 SOL** |

Writing: a transaction is limited to 1232 bytes, so 36 KB is **42
transactions** at 0.000005 SOL each, 0.0002 SOL total.

**The deposit is refunded** when the account is closed. On EVM deployment gas
is never refunded.

## Account format

```
[0..3]   magic 'SFLY'
[4]      format version
[5]      encoding: 0 raw, 1 brotli
[6..9]   content length, uint32 LE
[10..41] content sha256
[42..]   bytes
```

The `sha256` in the header is what makes the claim meaningful: not "we
put the code on chain", but "here is the address, check the hash yourself".

## Tools

```bash
node onchain/write.js             # prepares payload.bin and prints the write plan
node onchain/verify.js <address>  # reads the account, compares the hash with the local file
onchain/loader.html               # reads the account in the browser, verifies, runs
```

`write.js` **does not sign transactions and holds no keys**: it only
prepares the payload and computes the cost. Signing is a separate step done by a person
with their own key.

The whole chain was verified locally: payload -> header parsing ->
sha256 check -> brotli decompression -> **byte-for-byte original** ->
the game runs, steps advance, the state hash is produced.

## What this does NOT give

**"Delete the site and the game stays" is false.** The loader lives
somewhere, and an RPC node is required. You can put the loader on IPFS or also
into an account, but some entry point is still needed. This must be said **before**
launch, not after someone checks.

**The code becomes verifiable, not the state.** The state is derived from the trade
log that our collector writes. Even with the code on chain, the game has nothing
to show without the collector.

To put the state on chain too, it would have to be written there every few
minutes - that is option B or C from `ONCHAIN-DEATH.md`, but for every
step, not just for deaths. A separate project.

## Honest wording

> The game code lives in a Solana account - here is the address, check the sha256 yourself.
> The state is derived from the trade log, and anyone can reproduce it
> independently and compare the hash.

Not acceptable:

> No server, no backend, no hosting. Delete the site - the game
> lives forever.

## When to do it

The code does not change after launch, so it can be put on chain
at any time. **Do not block the launch on this.** It is half a day of work,
most of which is already done: what is left is signing 42 transactions
with a real key.
