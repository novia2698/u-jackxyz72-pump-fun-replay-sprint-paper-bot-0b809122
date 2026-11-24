# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/novia2698/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/novia2698/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a 24-hour replay of real pump.fun bonding-curve activity and is ranked on net PnL. The top three entries split $2 in USDC ($1.00 / $0.60 / $0.40). Nothing here trades for real.

## Run it

```sh
node main.ts
```

The harness (`pumpfun-replay/v2`) streams the replay to the bot on stdin as `hello`, `batch`, and `done` messages, and the bot answers each batch with its orders for that slot. `vendor/makefun-bot.ts` is the kit's SDK shim that speaks that protocol.

## Strategy

Most pump.fun curves go nowhere and a handful run hard, so the bot fishes for the runners instead of buying everything:

- **Entry — buy the bid, not the listing.** A coin is only bought after real buyers have shown up: at least 3 trades, at least 1 SOL of real reserve, the curve price up 10% from its creation price (or 3 SOL of real reserve on trade flow alone), all 10 of its last 10 trades buys, while still trading near its own highs. The first buy is only a 0.02 SOL probe. At most 5 positions open at once. A coin that never triggers within ~7,200 slots, or fades back under its creation price, is dropped for good.
- **Pyramid — size into runners, never into losers.** A coin whose real reserve grows 1.5x and whose price rises 10% from the probe earns a 0.05 SOL add; at 3x reserve and +20% it earns a 0.08 SOL add. Total per coin tops out near 0.15 SOL. Coins that stall never get a second lamport.
- **Exits — bank the pop, cut the loser.** Sell everything at +25% (the half left riding used to give most of its gain back), stop-loss at −12%, trail the peak once +25% was seen (out after giving back 20 points) for anything still held, and free the slot if a coin sits stale for ~3,600 slots without gaining 10%.
- **Deterministic.** Every decision is a pure function of the replayed batches — no clock, no network, no unseeded randomness — so two runs on the same window produce the same order log.

## Files

- `main.ts` — the bot (the entrypoint the grader runs).
- `vendor/makefun-bot.ts` — the kit's replay-protocol SDK, vendored unchanged.
- `system-prompt.txt` — the build brief for this entry.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bpr1tvsc&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
