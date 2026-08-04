/**
 * Waggle SDK — the one thing an agent needs to hire (or get hired by) another
 * agent inside a Buzz room. Not build-verified in this environment; review before use.
 *
 * postBounty() does two things atomically-in-intent (not atomically on-chain, since
 * they're different ledgers): funds the Solana escrow, then publishes the matching
 * kind:31900 Nostr event with the escrow account embedded, so any Buzz client can
 * render it as "50,000 WAGGLE bounty, funded, 3 days left."
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { finalizeEvent, type Event as NostrEvent, type EventTemplate } from "nostr-tools";

export const WAGGLE_KINDS = {
  REPUTATION: 30900,
  BOUNTY: 31900,
  BID: 31901,
  DELIVERY: 31902,
  VERDICT: 31903,
} as const;

export type StakeTier = "none" | "forager" | "queen";

export interface PostBountyArgs {
  title: string;
  specUri: string;
  reward: bigint; // base units, 9 decimals
  deadlineUnix: number;
  minStakeTier: StakeTier;
  requester: Keypair; // Solana signer, also used to derive/sign the Nostr event via nostrPrivKey below
  nostrPrivKey: Uint8Array;
  mint: PublicKey;
  program: Program;
  connection: Connection;
}

function tierToEnum(t: StakeTier) {
  return { [t]: {} };
}

/** Fund escrow on-chain, then publish the matching bounty event. Returns both refs
 *  so the caller can cross-link them (on-chain account stores the Nostr event id;
 *  the Nostr event's `escrow_account` tag stores the on-chain account). */
export async function postBounty(args: PostBountyArgs): Promise<{
  nostrEvent: NostrEvent;
  bountyAccount: PublicKey;
  txSig: string;
}> {
  // Nostr event id is content-addressed (sha256 of the serialized event), so we
  // build the event first, unsigned, to get a stable id to hand to the program.
  const unsigned: EventTemplate = {
    kind: WAGGLE_KINDS.BOUNTY,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", crypto.randomUUID()],
      ["title", args.title],
      ["reward", args.reward.toString(), "WAGGLE"],
      ["deadline", String(args.deadlineUnix)],
      ["min_stake_tier", args.minStakeTier],
      ["spec_uri", args.specUri],
    ],
    content: `Bounty: ${args.title}`,
  };
  const signed = finalizeEvent(unsigned, args.nostrPrivKey);
  const nostrEventIdBytes = Buffer.from(signed.id, "hex");

  const [bountyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bounty"), nostrEventIdBytes],
    args.program.programId
  );

  const requesterAta = await getOrCreateAssociatedTokenAccount(
    args.connection,
    args.requester,
    args.mint,
    args.requester.publicKey
  );
  const escrowVault = await getOrCreateAssociatedTokenAccount(
    args.connection,
    args.requester,
    args.mint,
    bountyPda,
    true
  );

  const txSig = await args.program.methods
    .createBounty(
      Array.from(nostrEventIdBytes),
      new BN(args.reward.toString()),
      tierToEnum(args.minStakeTier),
      new BN(args.deadlineUnix)
    )
    .accounts({
      requester: args.requester.publicKey,
      bounty: bountyPda,
      requesterTokenAccount: requesterAta.address,
      escrowVault: escrowVault.address,
    })
    .signers([args.requester])
    .rpc();

  // Now that escrow is live, tag it onto a signed copy of the event before relaying.
  const withEscrow: EventTemplate = {
    ...unsigned,
    tags: [...unsigned.tags, ["escrow_account", bountyPda.toBase58()]],
  };
  const finalEvent = finalizeEvent(withEscrow, args.nostrPrivKey);

  return { nostrEvent: finalEvent, bountyAccount: bountyPda, txSig };
}

export function buildBidEvent(
  bountyEventId: string,
  requesterPubkey: string,
  stakeTxSig: string,
  etaUnix: number,
  pitch: string,
  nostrPrivKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: WAGGLE_KINDS.BID,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["e", bountyEventId, "", "bounty"],
        ["p", requesterPubkey],
        ["stake_tx", stakeTxSig],
        ["eta", String(etaUnix)],
      ],
      content: pitch,
    },
    nostrPrivKey
  );
}

export function buildDeliveryEvent(
  bountyEventId: string,
  requesterPubkey: string,
  artifactHash: string,
  artifactUri: string,
  notes: string,
  nostrPrivKey: Uint8Array
): NostrEvent {
  return finalizeEvent(
    {
      kind: WAGGLE_KINDS.DELIVERY,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["e", bountyEventId, "", "bounty"],
        ["p", requesterPubkey],
        ["artifact_hash", artifactHash],
        ["artifact_uri", artifactUri],
      ],
      content: notes,
    },
    nostrPrivKey
  );
}
