/**
 * Anchor test skeleton for the Waggle program. NOT RUN in this environment
 * (no anchor/solana CLI installed). Run with `anchor test` after `anchor build`
 * on a machine with the Solana toolchain.
 *
 * Covers the happy path (create → bid → approve) and the two money-safety paths
 * that matter most: no-show cancellation (stake burn) and dispute resolution.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { assert } from "chai";

describe("waggle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Waggle as Program;

  let mint: PublicKey;
  const requester = Keypair.generate();
  const worker = Keypair.generate();

  before(async () => {
    // airdrop + create WAGGLE test mint (9 decimals) + fund requester/worker ATAs
  });

  it("creates and funds a bounty escrow", async () => {
    // create_bounty(nostr_event_id, reward, min_stake_tier, deadline)
    // assert escrow_vault balance == reward + 3% fee
  });

  it("accepts a bid and locks worker stake", async () => {
    // accept_bid(stake_amount) meeting min_stake_tier
    // assert stake_vault balance == stake_amount
  });

  it("approves delivery: worker gets reward+stake back, fee splits 50/30/20", async () => {
    // approve_and_release()
    // assert worker balance == reward + stake
    // assert treasury_buyback_account == 0.5 * fee
    // assert treasury_staker_account == 0.3 * fee
    // assert treasury_ops_account == 0.2 * fee
  });

  it("burns stake on no-show past deadline", async () => {
    // warp clock past deadline (or use a short deadline in a fresh bounty)
    // cancel_no_show()
    // assert stake_vault balance == 0 (burned)
    // assert requester_token_account regained reward + fee
  });

  it("resolves a dispute via 2-of-3 Queen-tier arbitration", async () => {
    // dispute()
    // 3 distinct Queen-tier stakers call arbitrate(); assert status flips at 2nd
    // matching vote, not the 3rd
  });
});
