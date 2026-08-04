//! Waggle: agent bounty escrow + staking + treasury, in one program.
//! Design doc: ../../README.md and ../../TOKENOMICS.md.
//! NOT COMPILED IN THIS ENVIRONMENT — no solana/anchor CLI available here.
//! Review as Rust source; verify with `anchor build && anchor test` before trusting it.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, Burn};

declare_id!("Wagg1eXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

pub const FEE_BPS: u64 = 300; // 3%
pub const BUYBACK_BURN_BPS_OF_FEE: u64 = 5000; // 50% of fee
pub const STAKER_REWARD_BPS_OF_FEE: u64 = 3000; // 30% of fee
pub const OPS_BPS_OF_FEE: u64 = 2000; // 20% of fee

#[program]
pub mod waggle {
    use super::*;

    /// Requester creates + funds escrow for a bounty. `nostr_event_id` links this
    /// account back to the kind:31900 event on the Buzz relay.
    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        nostr_event_id: [u8; 32],
        reward: u64,
        min_stake_tier: StakeTier,
        deadline: i64,
    ) -> Result<()> {
        require!(reward > 0, WaggleError::ZeroReward);
        let fee = reward.checked_mul(FEE_BPS).unwrap() / 10_000;
        let total = reward.checked_add(fee).ok_or(WaggleError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.requester_token_account.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.requester.to_account_info(),
                },
            ),
            total,
        )?;

        let bounty = &mut ctx.accounts.bounty;
        bounty.requester = ctx.accounts.requester.key();
        bounty.nostr_event_id = nostr_event_id;
        bounty.reward = reward;
        bounty.fee = fee;
        bounty.min_stake_tier = min_stake_tier;
        bounty.deadline = deadline;
        bounty.status = BountyStatus::Open;
        bounty.bump = ctx.bumps.bounty;
        Ok(())
    }

    /// Worker posts stake and is accepted by the requester off-chain-agreed bid;
    /// this ix is called by the requester naming the winning bidder.
    pub fn accept_bid(ctx: Context<AcceptBid>, stake_amount: u64) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(bounty.status == BountyStatus::Open, WaggleError::WrongStatus);
        require!(
            stake_meets_tier(stake_amount, bounty.min_stake_tier),
            WaggleError::InsufficientStake
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.worker_token_account.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.worker.to_account_info(),
                },
            ),
            stake_amount,
        )?;

        bounty.worker = ctx.accounts.worker.key();
        bounty.stake_amount = stake_amount;
        bounty.status = BountyStatus::InProgress;
        Ok(())
    }

    /// Requester approves delivered work; releases reward to worker, stake back to
    /// worker, and routes fee to treasury sub-accounts per TOKENOMICS.md split.
    pub fn approve_and_release(ctx: Context<ApproveAndRelease>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(bounty.status == BountyStatus::InProgress, WaggleError::WrongStatus);

        let seeds = &[b"bounty".as_ref(), bounty.nostr_event_id.as_ref(), &[bounty.bump]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.worker_token_account.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                signer,
            ),
            bounty.reward,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.worker_token_account.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                signer,
            ),
            bounty.stake_amount,
        )?;

        let buyback_cut = bounty.fee * BUYBACK_BURN_BPS_OF_FEE / 10_000;
        let staker_cut = bounty.fee * STAKER_REWARD_BPS_OF_FEE / 10_000;
        let ops_cut = bounty.fee - buyback_cut - staker_cut;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.treasury_buyback_account.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                signer,
            ),
            buyback_cut,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.treasury_staker_account.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                signer,
            ),
            staker_cut,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.treasury_ops_account.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                signer,
            ),
            ops_cut,
        )?;

        bounty.status = BountyStatus::Completed;
        Ok(())
    }

    /// Requester or worker flags a dispute; escrow freezes until arbitration.
    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(bounty.status == BountyStatus::InProgress, WaggleError::WrongStatus);
        bounty.status = BountyStatus::Disputed;
        Ok(())
    }

    /// Called once per Queen-tier arbiter vote. Simple 2-of-3 majority; each vote is
    /// its own tx so this doesn't need a big multisig account.
    pub fn arbitrate(ctx: Context<Arbitrate>, favors_worker: bool) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(bounty.status == BountyStatus::Disputed, WaggleError::WrongStatus);
        require!(
            ctx.accounts.arbiter_stake.tier == StakeTier::Queen,
            WaggleError::NotQueenTier
        );

        if favors_worker {
            bounty.votes_for_worker += 1;
        } else {
            bounty.votes_for_requester += 1;
        }

        if bounty.votes_for_worker >= 2 {
            bounty.status = BountyStatus::ResolvedForWorker;
        } else if bounty.votes_for_requester >= 2 {
            bounty.status = BountyStatus::ResolvedForRequester;
        }
        Ok(())
    }

    /// Bidder never delivered past deadline: stake is burned in full, reward+fee
    /// returns to requester.
    pub fn cancel_no_show(ctx: Context<CancelNoShow>) -> Result<()> {
        let bounty = &mut ctx.accounts.bounty;
        require!(bounty.status == BountyStatus::InProgress, WaggleError::WrongStatus);
        require!(Clock::get()?.unix_timestamp > bounty.deadline, WaggleError::NotExpired);

        let seeds = &[b"bounty".as_ref(), bounty.nostr_event_id.as_ref(), &[bounty.bump]];
        let signer = &[&seeds[..]];

        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                signer,
            ),
            bounty.stake_amount,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.requester_token_account.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                signer,
            ),
            bounty.reward + bounty.fee,
        )?;

        bounty.status = BountyStatus::Cancelled;
        Ok(())
    }

    /// Stake WAGGLE into Forager or Queen tier. Tier is derived from amount at the
    /// SDK layer; the program just records what was locked.
    pub fn stake(ctx: Context<StakeCtx>, amount: u64, tier: StakeTier) -> Result<()> {
        require!(
            stake_meets_tier(amount, tier),
            WaggleError::InsufficientStake
        );
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.staker_token_account.to_account_info(),
                    to: ctx.accounts.stake_pool_vault.to_account_info(),
                    authority: ctx.accounts.staker.to_account_info(),
                },
            ),
            amount,
        )?;
        let record = &mut ctx.accounts.arbiter_stake;
        record.owner = ctx.accounts.staker.key();
        record.amount = amount;
        record.tier = tier;
        Ok(())
    }
}

fn stake_meets_tier(amount: u64, tier: StakeTier) -> bool {
    match tier {
        StakeTier::None => true,
        StakeTier::Forager => amount >= 1_000 * 10u64.pow(9), // 1,000 WAGGLE
        StakeTier::Queen => amount >= 25_000 * 10u64.pow(9),  // 25,000 WAGGLE
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum StakeTier {
    None,
    Forager,
    Queen,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BountyStatus {
    Open,
    InProgress,
    Disputed,
    ResolvedForWorker,
    ResolvedForRequester,
    Completed,
    Cancelled,
}

#[account]
pub struct Bounty {
    pub requester: Pubkey,
    pub worker: Pubkey,
    pub nostr_event_id: [u8; 32],
    pub reward: u64,
    pub fee: u64,
    pub stake_amount: u64,
    pub min_stake_tier: StakeTier,
    pub deadline: i64,
    pub status: BountyStatus,
    pub votes_for_worker: u8,
    pub votes_for_requester: u8,
    pub bump: u8,
}

#[account]
pub struct ArbiterStake {
    pub owner: Pubkey,
    pub amount: u64,
    pub tier: StakeTier,
}

#[derive(Accounts)]
#[instruction(nostr_event_id: [u8; 32])]
pub struct CreateBounty<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        init,
        payer = requester,
        space = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 8 + 1 + 1 + 1 + 1,
        seeds = [b"bounty", nostr_event_id.as_ref()],
        bump
    )]
    pub bounty: Account<'info, Bounty>,
    #[account(mut)]
    pub requester_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptBid<'info> {
    #[account(mut)]
    pub bounty: Account<'info, Bounty>,
    #[account(mut)]
    pub worker: Signer<'info>,
    #[account(mut)]
    pub worker_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub stake_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ApproveAndRelease<'info> {
    #[account(mut, has_one = requester)]
    pub bounty: Account<'info, Bounty>,
    pub requester: Signer<'info>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub worker_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_buyback_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_staker_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury_ops_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    #[account(mut)]
    pub bounty: Account<'info, Bounty>,
    pub disputer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Arbitrate<'info> {
    #[account(mut)]
    pub bounty: Account<'info, Bounty>,
    pub arbiter: Signer<'info>,
    #[account(has_one = owner @ WaggleError::NotStakeOwner)]
    pub arbiter_stake: Account<'info, ArbiterStake>,
    /// CHECK: verified via has_one on arbiter_stake
    pub owner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelNoShow<'info> {
    #[account(mut, has_one = requester)]
    pub bounty: Account<'info, Bounty>,
    pub requester: Signer<'info>,
    #[account(mut)]
    pub requester_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub stake_vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct StakeCtx<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut)]
    pub staker_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub stake_pool_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + 32 + 8 + 1,
        seeds = [b"arbiter_stake", staker.key().as_ref()],
        bump
    )]
    pub arbiter_stake: Account<'info, ArbiterStake>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum WaggleError {
    #[msg("reward must be > 0")]
    ZeroReward,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("bounty is not in the required status for this action")]
    WrongStatus,
    #[msg("stake does not meet the bounty's minimum tier")]
    InsufficientStake,
    #[msg("arbiter is not Queen tier")]
    NotQueenTier,
    #[msg("deadline has not passed yet")]
    NotExpired,
    #[msg("stake account owner mismatch")]
    NotStakeOwner,
}
