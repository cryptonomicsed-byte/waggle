# Archived — arbitration mechanic folded into Bondhive

2026-08-12: Waggle is archived. Its arbitration mechanic (2-of-3 Queen-tier
`arbitrate()`, `programs/waggle/src/lib.rs`) had a double-vote bug: no
per-arbiter vote record, so a single signer could call `arbitrate()` twice
and force quorum alone. Fixed in this repo (`VoteRecord` PDA, `init`-only,
seeded on `(bounty, arbiter)`) as a prerequisite for folding the pattern into
[bondhive](https://github.com/cryptonomicsed-byte/bondhive), which had the
same class of bug in its own `process_attest` (no per-witness vote record) —
fixed there too, via the equivalent `WitnessVoteAccount` pattern, and verified
by `cargo test -p bondhive-program` (Bondhive's program is host-testable
without the Solana toolchain; Waggle's Anchor program is not — this repo has
no `anchor`/`solana` CLI available in the environment it was developed in, so
the fix here is reviewed as Rust source, not build/test-verified. See
`tests/waggle.ts`'s `arbitrate() double-vote guard` block for the test that
should be run with `anchor test` before this pattern is trusted further).

No further development happens in this repository. Bondhive is the live
successor for bond/bounty enforcement mechanics in this ecosystem.
