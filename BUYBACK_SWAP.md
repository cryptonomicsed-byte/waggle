# Buyback Swap — Design

Current state: `approve_and_release` moves the buyback-cut of each bounty fee into
`treasury_buyback_account`, a plain WAGGLE token account. That's correct as far as it
goes, but it means the "buyback" is really just "fee sits in a WAGGLE account" —
there's no swap happening, because the fee is already collected *in* WAGGLE, not in
SOL/USDC. A buyback only means something if the thing being bought back was paid for
in something else first. So the real design question is: where does non-WAGGLE money
enter the system at all, and that's where the swap belongs.

## Where real buyback pressure comes from

Two sources, handled differently:

1. **Bounty fees** (in-program, already WAGGLE) — these don't need a swap. "Buyback"
   for this slice just means burn-on-receipt instead of holding it, since burning
   WAGGLE you already collected in WAGGLE has the identical supply effect as
   buying WAGGLE with WAGGLE and burning it. **Decision: skip the swap for this
   leg entirely, just burn directly in `approve_and_release`.** This removes a
   whole unnecessary CPI hop and is strictly safer (no slippage, no swap-account
   attack surface) for money that's already in the target asset.

2. **pump.fun bonding-curve trading fees** (in SOL, paid to the token creator/
   treasury via pump.fun's own creator-fee mechanism) — this is real external
   revenue in a different asset, and *this* is where an actual swap belongs:
   SOL → WAGGLE on the open market, then burn.

So the fix to `lib.rs` is two changes, not one:
- `approve_and_release`: replace the `treasury_buyback_account` transfer with a
  direct `token::burn` CPI (same accounts, minus needing a destination — just burns
  from escrow_vault straight to the mint). Simpler, cheaper, no swap risk.
- New instruction `execute_sol_buyback`: permissionless (anyone can call it, keeper
  or cron job), takes SOL sitting in a `treasury_sol_vault` PDA (funded by pump.fun
  creator-fee claims, routed there off-chain since pump.fun fee claims aren't a CPI
  Waggle controls) and swaps it for WAGGLE via Jupiter's CPI, then burns the output.

## `execute_sol_buyback` — accounts and flow

```rust
pub fn execute_sol_buyback(ctx: Context<ExecuteSolBuyback>, sol_amount: u64, min_waggle_out: u64) -> Result<()> {
    // 1. CPI into Jupiter's swap program (route computed off-chain by a keeper via
    //    Jupiter's quote API, passed in as ix data / remaining_accounts — this is
    //    the standard Jupiter CPI integration shape, see jup-ag/jupiter-cpi-example).
    // 2. min_waggle_out enforces slippage protection; tx fails if the route
    //    returns less (front-running/sandwich protection, capped loss per call).
    // 3. On success, burn 100% of the WAGGLE received — no intermediate holding.
    // 4. Emit a BuybackExecuted event (sol_in, waggle_burned) for the Nostr-side
    //    treasury dashboard to index.
}
```

Design constraints:
- **Permissionless + capped.** Anyone can call it (keeper bot, or literally any
  agent — burning is always good for existing holders, no reason to gate it), but
  each call has a max `sol_amount` pulled from the vault per call (e.g. 10% of
  vault balance) so a single call can't be manipulated into an outsized,
  bad-price swap against a thin route.
- **No custody risk beyond the vault itself.** The SOL vault is a PDA owned by the
  program; Jupiter CPI is a well-audited, widely-integrated swap aggregator, not a
  bespoke AMM Waggle would have to trust blindly. Still: **use Jupiter's official
  CPI example structure verbatim rather than hand-rolling instruction data
  encoding** — this class of integration is exactly where "roll your own" produces
  vulnerable code.
- **Where pump.fun fees land in the SOL vault**: pump.fun creator-fee claims are a
  separate pump.fun-side instruction, not something Waggle's program calls into.
  The realistic flow is: a keeper claims creator fees from pump.fun to a treasury
  wallet, then a small `deposit_sol_to_buyback_vault` instruction moves them into
  the PDA vault Waggle's program controls. That hop is intentionally simple (a
  System Program transfer) — no reason to make it more complex than "move SOL into
  a PDA."

## Net effect on TOKENOMICS.md

This changes one line: the 50% "buyback+burn" fee-cut described in TOKENOMICS.md is
now literally a direct burn (no swap) for the bounty-fee leg, and the swap machinery
above applies only to the pump.fun trading-fee leg, which is new revenue on top of
what TOKENOMICS.md already modeled — net more deflationary than originally spec'd,
not less. No numbers in TOKENOMICS.md need to change, just the mechanism description.

## Status

Design only. Not implemented in `lib.rs` yet — pending the toolchain build so the
direct-burn change and the new instruction can be written and compiled against a
real anchor-lang/anchor-spl version rather than typed blind. Flagged as the next
code change once `anchor build` is green.
