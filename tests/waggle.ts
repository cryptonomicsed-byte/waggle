/**
 * Anchor tests for the Waggle program. Run with `anchor test` on a machine
 * with the Solana + Anchor toolchain (`anchor build` first).
 *
 * The double-vote regression test (`arbitrate() rejects a second vote from
 * the same arbiter`) is the priority coverage here — it is the reason this
 * suite exists in this pass. The other lifecycle tests remain as documented
 * scaffolding (`it.skip`) since implementing them is a separate pass; do not
 * read a skipped test as "passing".
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("waggle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Waggle as Program;
  const connection = provider.connection;

  let mint: PublicKey;
  const requester = Keypair.generate();
  const worker = Keypair.generate();
  // Three distinct Queen-tier arbiters for the 2-of-3 quorum tests.
  const arbiterA = Keypair.generate();
  const arbiterB = Keypair.generate();
  const arbiterC = Keypair.generate();

  const QUEEN_TIER_AMOUNT = new BN(25_000).mul(new BN(10).pow(new BN(9)));

  async function airdrop(pubkey: PublicKey, sol = 5) {
    const sig = await connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function fundedAta(owner: Keypair, amount: bigint) {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      requester, // payer (already airdropped)
      mint,
      owner.publicKey
    );
    if (amount > 0n) {
      await mintTo(connection, requester, mint, ata.address, requester, amount);
    }
    return ata.address;
  }

  async function openQueenStake(owner: Keypair) {
    const ownerAta = await fundedAta(owner, BigInt(QUEEN_TIER_AMOUNT.toString()));
    const [stakePoolVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("stake_pool_vault")],
      program.programId
    );
    const [arbiterStake] = PublicKey.findProgramAddressSync(
      [Buffer.from("arbiter_stake"), owner.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .openStakeAccount(QUEEN_TIER_AMOUNT, { queen: {} })
      .accounts({
        staker: owner.publicKey,
        arbiterStake,
        stakerTokenAccount: ownerAta,
        stakePoolVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    return arbiterStake;
  }

  before(async () => {
    await Promise.all(
      [requester, worker, arbiterA, arbiterB, arbiterC].map((kp) => airdrop(kp.publicKey))
    );
    mint = await createMint(connection, requester, requester.publicKey, null, 9);
  });

  it.skip("creates and funds a bounty escrow", async () => {
    // create_bounty(nostr_event_id, reward, min_stake_tier, deadline)
    // assert escrow_vault balance == reward + 3% fee
  });

  it.skip("accepts a bid and locks worker stake", async () => {
    // accept_bid(stake_amount) meeting min_stake_tier
    // assert stake_vault balance == stake_amount
  });

  it.skip("approves delivery: worker gets reward+stake back, fee splits 50/30/20", async () => {
    // approve_and_release()
    // assert worker balance == reward + stake
    // assert treasury_buyback_account == 0.5 * fee
    // assert treasury_staker_account == 0.3 * fee
    // assert treasury_ops_account == 0.2 * fee
  });

  it.skip("burns stake on no-show past deadline", async () => {
    // warp clock past deadline (or use a short deadline in a fresh bounty)
    // cancel_no_show()
    // assert stake_vault balance == 0 (burned)
    // assert requester_token_account regained reward + fee
  });

  describe("arbitrate() double-vote guard", () => {
    // Every test in this block builds its own bounty (via a fresh
    // nostr_event_id) so arbiterA's vote_record PDA never collides across
    // tests: the PDA is seeded on (bounty, arbiter), so a fresh bounty means
    // a fresh, un-voted PDA for the same arbiter keypair.
    async function disputedBounty(): Promise<PublicKey> {
      const nostrEventId = anchor.web3.Keypair.generate().publicKey.toBytes(); // 32 random bytes, stand-in id
      const [bounty] = PublicKey.findProgramAddressSync(
        [Buffer.from("bounty"), Buffer.from(nostrEventId)],
        program.programId
      );
      const requesterAta = await fundedAta(requester, 1_000_000_000_000n);
      const [escrowVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_vault"), Buffer.from(nostrEventId)],
        program.programId
      );
      await program.methods
        .createBounty(Array.from(nostrEventId), new BN(1_000_000_000), { none: {} }, new BN(9_999_999_999))
        .accounts({
          requester: requester.publicKey,
          bounty,
          requesterTokenAccount: requesterAta,
          escrowVault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([requester])
        .rpc();

      await program.methods
        .dispute()
        .accounts({ bounty, disputer: requester.publicKey })
        .signers([requester])
        .rpc();

      return bounty;
    }

    async function voteRecordPda(bounty: PublicKey, arbiter: Keypair) {
      const [voteRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from("vote"), bounty.toBuffer(), arbiter.publicKey.toBuffer()],
        program.programId
      );
      return voteRecord;
    }

    async function castVote(bounty: PublicKey, arbiter: Keypair, favorsWorker: boolean) {
      const arbiterStake = await openQueenStake(arbiter).catch(async () => {
        // Already staked in a prior test in this block — derive the existing PDA.
        const [existing] = PublicKey.findProgramAddressSync(
          [Buffer.from("arbiter_stake"), arbiter.publicKey.toBuffer()],
          program.programId
        );
        return existing;
      });
      const voteRecord = await voteRecordPda(bounty, arbiter);
      return program.methods
        .arbitrate(favorsWorker)
        .accounts({
          bounty,
          arbiter: arbiter.publicKey,
          arbiterStake,
          owner: arbiter.publicKey,
          voteRecord,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter])
        .rpc();
    }

    it("rejects a second arbitrate() call from the same arbiter on the same bounty", async () => {
      const bounty = await disputedBounty();

      // First vote succeeds and is recorded.
      await castVote(bounty, arbiterA, true);
      let bountyAcct: any = await program.account.bounty.fetch(bounty);
      assert.equal(bountyAcct.votesForWorker, 1);

      // Second vote from the SAME arbiter on the SAME bounty must fail: the
      // vote_record PDA already exists, so `init` on it errors before
      // votes_for_worker/votes_for_requester can be mutated again.
      let threw = false;
      try {
        await castVote(bounty, arbiterA, true);
      } catch (err) {
        threw = true;
      }
      assert.isTrue(threw, "expected the second arbitrate() call to be rejected");

      // Vote count must be unchanged — this is the actual regression: before
      // the fix, this second call would have incremented votes_for_worker to
      // 2 and flipped the bounty to ResolvedForWorker off a single signer.
      bountyAcct = await program.account.bounty.fetch(bounty);
      assert.equal(bountyAcct.votesForWorker, 1);
      assert.notEqual(Object.keys(bountyAcct.status)[0], "resolvedForWorker");
    });

    it("still resolves at 2-of-3 with three distinct arbiters", async () => {
      const bounty = await disputedBounty();

      await castVote(bounty, arbiterA, true);
      let bountyAcct: any = await program.account.bounty.fetch(bounty);
      assert.equal(bountyAcct.votesForWorker, 1);
      assert.notEqual(Object.keys(bountyAcct.status)[0], "resolvedForWorker");

      await castVote(bounty, arbiterB, true);
      bountyAcct = await program.account.bounty.fetch(bounty);
      assert.equal(bountyAcct.votesForWorker, 2);
      assert.equal(Object.keys(bountyAcct.status)[0], "resolvedForWorker");

      // Third, distinct arbiter can still vote (their own fresh PDA) even
      // though quorum is already reached — the guard is per-arbiter, not a
      // blanket "bounty already resolved" lock, matching the pre-existing
      // (unchanged) resolution logic.
      await castVote(bounty, arbiterC, false);
      bountyAcct = await program.account.bounty.fetch(bounty);
      assert.equal(bountyAcct.votesForRequester, 1);
    });
  });
});
