"""
Waggle reference "forager" agent.

Minimal example of what any Buzz-resident agent needs to participate in the bounty
market: watch a relay for kind:31900 bounties, decide whether to bid, and on
acceptance, deliver. This is intentionally dumb (keyword-match bidding) — it exists
to prove the event/escrow flow end-to-end, not to be a good bounty-hunter.

Not run/tested in this environment (no network access, no relay, no funded devnet
wallet here). Requires: pip install pynostr solders solana anchorpy
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from dataclasses import dataclass

BOUNTY_KIND = 31900
BID_KIND = 31901
DELIVERY_KIND = 31902

MIN_REWARD = 1_000 * 10**9  # ignore anything under 1,000 WAGGLE, not worth the stake lockup


@dataclass
class ForagerConfig:
    relay_url: str
    nostr_privkey_hex: str
    solana_keypair_path: str
    interested_keywords: tuple[str, ...] = ("refactor", "bugfix", "docs", "test")


class ForagerAgent:
    """Watches a relay, bids on bounties that match its keywords, delivers on accept."""

    def __init__(self, config: ForagerConfig):
        self.config = config
        self._seen_bounty_ids: set[str] = set()

    def _wants(self, bounty_content: str, tags: list[list[str]]) -> bool:
        reward = next((int(t[1]) for t in tags if t[0] == "reward"), 0)
        if reward < MIN_REWARD:
            return False
        text = bounty_content.lower()
        return any(k in text for k in self.config.interested_keywords)

    async def on_bounty_event(self, event: dict) -> None:
        if event["id"] in self._seen_bounty_ids:
            return
        self._seen_bounty_ids.add(event["id"])

        if not self._wants(event["content"], event["tags"]):
            return

        escrow = next((t[1] for t in event["tags"] if t[0] == "escrow_account"), None)
        if escrow is None:
            return  # unfunded posting, per NIP-WAGGLE this should be ignored

        stake_tx = await self._post_stake(escrow)
        bid = self._build_bid_event(event, stake_tx)
        await self._publish(bid)

    async def _post_stake(self, escrow_account: str) -> str:
        """Would call the on-chain `accept_bid` instruction via anchorpy here."""
        raise NotImplementedError("wire up anchorpy client against a real devnet deploy")

    def _build_bid_event(self, bounty_event: dict, stake_tx: str) -> dict:
        requester_pubkey = bounty_event["pubkey"]
        unsigned = {
            "kind": BID_KIND,
            "created_at": int(time.time()),
            "tags": [
                ["e", bounty_event["id"], "", "bounty"],
                ["p", requester_pubkey],
                ["stake_tx", stake_tx],
                ["eta", str(int(time.time()) + 3600 * 6)],
            ],
            "content": "Forager agent bid: matches keyword profile, ETA 6h.",
        }
        return unsigned  # signing omitted; wire to pynostr's EventSigner in a real deploy

    async def _publish(self, event: dict) -> None:
        raise NotImplementedError("wire up a relay connection (pynostr RelayManager)")

    async def run_forever(self) -> None:
        """Subscribe to kind:31900 on self.config.relay_url and call on_bounty_event
        for each. Left as a stub — the point of this file is the decision logic
        above, not a production relay client."""
        raise NotImplementedError


if __name__ == "__main__":
    cfg = ForagerConfig(
        relay_url="wss://relay.example/buzz",
        nostr_privkey_hex="<hex privkey>",
        solana_keypair_path="~/.config/solana/id.json",
    )
    agent = ForagerAgent(cfg)
    asyncio.run(agent.run_forever())
