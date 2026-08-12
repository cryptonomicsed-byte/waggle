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
without the Solana toolchain).

**Build status of the fix in this repo (2026-08-12)**: `anchor build --no-idl`
succeeds — `target/deploy/waggle.so` (334KB) compiles clean and contains the
`VoteRecord` fix, on Solana platform-tools' pinned toolchain (cargo 1.75).
Getting there required real fixes beyond the double-vote patch itself: the
placeholder `declare_id!` was not a valid base58 pubkey, two pre-existing
functions had borrow-checker errors (`bounty` held `&mut` while
`ctx.accounts.bounty.to_account_info()` was re-borrowed inside CPI calls),
`overflow-checks` needed enabling, and several transitive deps in a freshly
generated `Cargo.lock` had rolled forward to edition2024/rustc-1.85
requirements the pinned 1.75 toolchain can't parse — all pinned down to
compatible versions (see `Cargo.lock`, now committed).

IDL generation (needed for `anchor test`'s TypeScript harness to construct
the `Program` client) does **not** work in this environment: anchor-syn
0.30.1's `idl-build` codepath hits `proc_macro2::Span::source_file()` not
existing on the pinned toolchain's rustc, and a *different* failure
("Failed to get program path") on a nightly rustc — both are upstream
anchor-syn/proc-macro2/toolchain incompatibilities, not bugs in this
program's Rust logic. `tests/waggle.ts`'s `arbitrate() double-vote guard`
block is written and ready but has not executed.

Net status: **code-reviewed correct, toolchain-compiled and confirmed
producing a real `.so` with the fix included, TS-test-unverified** pending
an environment where `anchor build`'s IDL step actually completes (e.g. a
Docker image pinned to the Anchor-blessed toolchain combination, or a newer
anchor-cli that has fixed the anchor-syn incompatibility).

No further development happens in this repository. Bondhive is the live
successor for bond/bounty enforcement mechanics in this ecosystem.
