# Devnet Deploy Plan

Ordered so each step is independently checkable before moving on — no step assumes
a later one already went right.

## 0. Prerequisites (in progress — see toolchain install)
- [ ] `solana --version` works
- [ ] `avm install latest && avm use latest` → `anchor --version` works
- [ ] `solana config set --url devnet`
- [ ] `solana-keygen new` (or reuse existing) → this is the deploy authority, **not**
      any real-funds wallet — treat it as disposable/devnet-only
- [ ] `solana airdrop 2` (devnet faucet) — repeat as needed for deploy rent + test tx fees

## 1. Compile
- [ ] `anchor build` from `~/waggle` — first real compiler check of `lib.rs`
- [ ] Fix whatever the compiler finds (expect at minimum: `ctx.bumps.bounty` API
      surface may differ by anchor-lang version pinned; `init_if_needed` requires
      the `init-if-needed` Cargo feature on anchor-lang, which is NOT currently in
      `Cargo.toml` — this alone will fail the first build)
- [ ] `anchor keys list` → copy the generated program id
- [ ] Replace the placeholder in `declare_id!()` in `lib.rs` AND `Anchor.toml`
      `[programs.localnet]` with the real generated id (`anchor keys sync` does
      this automatically)

## 2. Localnet test pass (before spending any devnet SOL)
- [ ] `anchor test` — runs a local validator automatically, no devnet cost
- [ ] Fill in the test bodies in `tests/waggle.ts` (currently skeleton/commented) —
      mint creation, ATA setup, the 5 documented scenarios
- [ ] Get to green on localnet first. This is the real "does the money math work"
      gate — devnet is just localnet with latency and a public explorer, not a
      different correctness bar.

## 3. Devnet deploy
- [ ] `anchor deploy --provider.cluster devnet`
- [ ] Create the devnet WAGGLE test mint (9 decimals) via `spl-token create-token`
      — this is a throwaway devnet mint, unrelated to any future real mint
- [ ] Re-run the same test suite against `--provider.cluster devnet` to confirm
      behavior matches localnet under real network conditions (confirmation
      latency, rent-exemption edge cases)

## 4. Buyback instruction (once BUYBACK_SWAP.md lands in code)
- [ ] Deploy the updated program with `execute_sol_buyback` + `deposit_sol_to_buyback_vault`
- [ ] Test against devnet Jupiter (Jupiter has a devnet-compatible quote/swap path;
      confirm current endpoint before relying on it — this shifts over time)
- [ ] Confirm slippage-cap (`min_waggle_out`) actually reverts on a bad quote —
      this is a safety property, not just a happy-path check

## 5. What this plan explicitly does NOT include
- No mainnet deploy step. No pump.fun launch step. No real-fund wallet anywhere in
  this plan — every keypair here is devnet-disposable.
- Going from "devnet green" to "mainnet" is a separate, later decision requiring
  your explicit go-ahead per the scope you set: design + local/devnet scaffold
  only, right now.

## Known risk going in
`init_if_needed` on the `ArbiterStake` account in `stake()` is a known Anchor
footgun — it re-runs init logic if the account already exists unless guarded, which
can let a staker reset their `amount`/`tier` unexpectedly on a second stake call
instead of accumulating. Flagging now so it's not a surprise at compile/test time —
likely fix is splitting `stake` into `open_stake_account` (init) and `add_stake`
(mut, no init) instead of one `init_if_needed` entry point.
