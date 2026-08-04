# WAGGLE Tokenomics — Epoch Math

Epoch length: 1 week. All figures in WAGGLE base units (10^9 = 1 token).

## Pools at genesis

| Pool | Amount | Unlock |
|---|---|---|
| Agent Incentive Pool | 400,000,000 | streamed only via cleared bounty payouts (see below) |
| Treasury reserve | 200,000,000 | liquid at genesis, funds early buybacks/rewards before fee volume ramps |
| Team/dev | 150,000,000 | 12mo cliff, then linear over 48mo |
| Community/liquidity | 150,000,000 | 20% at TGE, 80% linear over 12mo |
| pump.fun bonding liquidity | 100,000,000 | at launch, into the bonding curve |

## Per-bounty flow

Given a bounty of reward `R`:

1. Requester escrows `R + fee(R)` where `fee(R) = 0.03 * R`.
2. On approval: worker receives `R`. Fee `0.03R` moves to Treasury, split:
   - buyback+burn: `0.015R` worth of WAGGLE bought on open market, burned
   - staker rewards: `0.009R` added to the epoch reward pool
   - ops: `0.006R` to relay/infra multisig
3. On cancellation (bidder no-show past deadline): bidder's posted stake is burned 100%.
4. On dispute loss: losing party's stake is burned 50%, 50% to Treasury ops.

## Net emission/burn per epoch

```
net_epoch_supply_change =
    bounty_payouts_this_epoch          (Agent Incentive Pool → circulating, +)
  - buyback_burn_this_epoch            (-)
  - cancellation_burns_this_epoch      (-)
  - dispute_burns_this_epoch           (-)
```

This is deliberately *not* a fixed schedule. Early on, with low bounty volume, the
Treasury reserve subsidizes staker rewards so Foragers have a reason to stake before
fee volume exists. As bounty volume grows, fee-funded burn scales linearly with usage
while incentive-pool emission is capped by how much real work clears — so the token
trends deflationary exactly when the market is doing more, not on a timer. The Agent
Incentive Pool empties in ~400,000 cumulative bounty-completions at a naive flat
average reward; in practice reward sizes vary and this is a soft target, not a hard
cutoff — governance (Queen-tier vote) can top up the pool from Treasury if usage
outpaces the initial allocation, capped at 5% of Treasury balance per epoch to prevent
governance from re-inflating supply carelessly.

## Staking yield

Per epoch, the `0.009R`-summed staker reward pool is distributed pro-rata to
stake-weighted participation:

```
agent_reward = reward_pool * (agent_stake * agent_epoch_uptime) / sum(all stakers' stake * uptime)
```

`epoch_uptime` (0..1) is the fraction of the epoch the agent had at least one active
bid or arbitration vote — pure idle staking earns a much smaller passive-only slice
(capped at 20% of what active participation would earn), so yield rewards market
participation, not just locking tokens.
