// Momentum sniper for the pump.fun replay sprint.
//
// Idea: most pump.fun curves die flat, a few run hard. This bot only buys a
// coin once real buyers have already shown up (real SOL reserve building, the
// curve price up from its creation price, and the recent tape mostly buys),
// and it only risks a small probe on that first buy. A coin that keeps
// multiplying, price up from the probe — earns bigger pyramid adds; a coin
// that stalls never gets a second lamport. Exits run on a ladder: bank half
// on a quick pop, let the rest run with a trailing stop, and cut every loser
// at a fixed stop-loss. Nothing here reads
// the clock, the network, or any randomness: every decision is a pure
// function of the hello message and the batches the harness replays, so two
// runs of the same replay produce the same orders.
//
// Money flow per batch: the harness hands us a batch of chain events for one
// slot, plus the fills of orders we sent two slots earlier. We answer with
// at most max_orders_per_batch orders. A buy spends quote_lamports of SOL
// (curve fees included); a sell hands back tokens. The replay closes a
// position by itself when its curve completes, and flattens whatever is left
// when the data ends.
//
// Price of a coin, in lamports of SOL per token, is the ratio of its virtual
// reserves: virtual_quote_reserves / virtual_token_reserves. All ratios in
// this file are computed with bigint fixed-point math (scale 1_000_000) so
// no floating point ever leaks into an order decision.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---- sizing (all lamports) --------------------------------------------

// A probe is deliberately small: most coins die, so the first buy only
// risks the size cap. Winners earn bigger adds (see the pyramid below).
// A round trip of at least 0.01 SOL on 20 coins is the guardrail, so a
// probe is never taken below a 1 SOL real reserve (cap 0.01 SOL).
const PROBE_MAX_LAMPORTS = 20_000_000n; // 0.02 SOL
const ADD_1_MAX_LAMPORTS = 30_000_000n; // 0.03 SOL
const ADD_2_MAX_LAMPORTS = 50_000_000n; // 0.05 SOL
// Never buy when the size cap cannot fit at least this much.
const MIN_STAKE_LAMPORTS = 10_000_000n;

// ---- entry triggers -----------------------------------------------------
// A coin must have real buyers behind it before we touch it.
const MIN_TRADES_TO_ENTER = 3;
const MIN_REAL_SOL_TO_ENTER = 1_000_000_000n; // 1 SOL of real reserve
const HOT_REAL_SOL = 3_000_000_000n; // 3 SOL: strong inflow, buy on flow alone
const HOT_MIN_TRADES = 6;
// Price rise from creation, in fixed-point millionths (100_000 = 10%).
const ENTRY_RISE_FP = 100_000;
const HOT_RISE_FP = 400_000; // 40%: qualifies for the hotter stake
// Give up watching a coin that never triggers.
const CANDIDATE_MAX_AGE_SLOTS = 7_200;
// A coin that fades back under its creation price is dead money: drop it.
const FADE_FP = 970_000; // 97% of the creation price
// Entry also needs real buying pressure, not just a high print: at least
// this many of the coin's last 10 trades must be buys. A coin whose price
// is up only because early holders have not sold yet, while the tape is
// mostly sells, is distribution, not momentum.
const MIN_BUYS_LAST_10 = 10;
// Later in the window, lower the bar a little so the bot keeps finding coins.
const RELAX_AFTER_SLOTS = 100_000;
const ENTRY_RISE_FP_LATE = 80_000; // 8%

// ---- pyramid adds -------------------------------------------------------
// A coin that keeps running after the probe earns more size: the reserve
// must have multiplied (real buyers still arriving) and the price must be
// up from the probe. Losers never get a second lamport.
const ADD_1_RESERVE_X_FP = 2_000_000; // real reserve 2x the probe's
const ADD_1_PRICE_RISE_FP = 150_000; // price +15% from the probe
const ADD_2_RESERVE_X_FP = 4_000_000; // real reserve 4x the probe's
const ADD_2_PRICE_RISE_FP = 300_000; // price +30% from the probe

// ---- exits (basis points of gain vs cost, cost includes fees) -----------
// Tuned after the first dev grade (-2.05 SOL): the first version banked too
// late and cut too slow, so most coins bled back before the exits fired.
const TAKE_PROFIT_1_BPS = 250; // +25%: sell half the tokens
const TAKE_PROFIT_2_BPS = 600; // +60%: sell everything left
const TRAIL_TRIGGER_BPS = 250; // trailing stop arms once +25% was seen
const TRAIL_DROP_BPS = 200; // ...and fires after a 20-point fall from peak
const STOP_LOSS_BPS = -120; // -12%: cut the loser, no second chances
const MAX_HOLD_SLOTS = 3_600; // ~24 min of slots: stale coins get sold
const STALE_EXIT_BPS = 100; // ...unless they are already up 10%+
const SLIPPAGE_BPS = 10_000; // wide open: a rejected order is worse than slip

const FP_SCALE = 1_000_000n; // fixed-point scale for price ratios

/** Price of a curve as a fixed-point ratio (quote per token, x FP_SCALE). */
function priceFp(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * FP_SCALE) / virtualToken;
}

/** Value of `tokens` at the curve's current reserves, in lamports. */
function valueLamports(
  tokens: bigint,
  virtualQuote: bigint,
  virtualToken: bigint,
): bigint {
  if (virtualToken <= 0n || tokens <= 0n) return 0n;
  return (tokens * virtualQuote) / virtualToken;
}

interface CoinWatch {
  createdSlot: number;
  createPriceFp: bigint;
  peakFp: bigint;
  trades: number;
  // Sides of the last 10 trades, newest last: true = buy, false = sell.
  sides: boolean[];
  decided: boolean;
}

interface HeldCoin {
  buySlot: number;
  peakBps: number;
  tookProfit1: boolean;
  // Probe reference points, for sizing the pyramid adds.
  probeReserve: bigint;
  probePriceFp: bigint;
  adds: number;
}

// ---- bot state (all derived from the replay, reset every run) ----------

const watch = new Map<string, CoinWatch>();
const held = new Map<string, HeldCoin>();
let firstSlot = -1;

function noteCreate(mint: string, slot: number, createPrice: bigint): void {
  if (!watch.has(mint)) {
    watch.set(mint, { createdSlot: slot, createPriceFp: createPrice, peakFp: createPrice, trades: 0, sides: [], decided: false });
  }
}

function currentPriceFp(state: BotState, mint: string): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  return priceFp(curve.virtual_quote_reserves, curve.virtual_token_reserves);
}

await runBot({
  onBatch(state, batch: Batch) {
    if (firstSlot < 0) firstSlot = batch.slot;
    const { caps } = state.hello;
    const txFee = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // Fold the batch's events into the watch list: new curves, trade counts.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        noteCreate(
          event.mint,
          event.slot,
          priceFp(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves)),
        );
      } else if (event.event === 'TradeEvent') {
        const w = watch.get(event.mint);
        if (w !== undefined) {
          w.trades += 1;
          w.sides.push(event.is_buy);
          if (w.sides.length > 10) w.sides.shift();
        }
      } else if (event.event === 'CompleteEvent') {
        watch.delete(event.mint);
        held.delete(event.mint);
      }
    }

    // Clean up held tracking for positions the harness closed for us
    // (curve completion / flattening): if we hold nothing there any more,
    // there is nothing left to manage.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // ---- exits first: manage what we already own ----------------------
    // Never stack a second sell on a mint that already has one in flight:
    // the harness would reject the over-sell for insufficient tokens.
    const sellPending = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') sellPending.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const info = held.get(mint);
      if (info === undefined) continue; // a position we did not open; leave it
      const value = valueLamports(
        holding.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      if (value <= txFee * 2n) continue; // dust: selling would burn the fee
      const cost = holding.cost_lamports;
      if (cost <= 0n) continue;
      const gainBps = Number(((value - cost) * 10_000n) / cost);
      if (gainBps > info.peakBps) info.peakBps = gainBps;

      let sellTokens = 0n;
      if (gainBps >= TAKE_PROFIT_2_BPS) {
        sellTokens = holding.token_amount; // full exit on a runner
      } else if (gainBps >= TAKE_PROFIT_1_BPS && !info.tookProfit1) {
        // Bank the whole pop at once: the half left riding in the earlier
        // version gave most of its gain back before the trail or the stop
        // fired, so the pop is worth more in hand than on the curve.
        sellTokens = holding.token_amount;
        info.tookProfit1 = true;
      } else if (info.peakBps >= TRAIL_TRIGGER_BPS && gainBps <= info.peakBps - TRAIL_DROP_BPS) {
        sellTokens = holding.token_amount; // gave back too much of the run
      } else if (gainBps <= STOP_LOSS_BPS) {
        sellTokens = holding.token_amount; // stop-loss: out, no debate
      } else if (batch.slot - info.buySlot > MAX_HOLD_SLOTS && gainBps < STALE_EXIT_BPS) {
        sellTokens = holding.token_amount; // stale coin, free the slot
      }
      if (sellTokens > 0n && orders.length < caps.max_orders_per_batch) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: sellTokens,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }

    // ---- entries: one fresh buy per coin, decided once -----------------
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    const lateWindow = batch.slot - firstSlot > RELAX_AFTER_SLOTS;
    const riseBar = lateWindow ? ENTRY_RISE_FP_LATE : ENTRY_RISE_FP;

    for (const event of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || openSlots <= 0) break;
      const mint = event.mint;
      const w = watch.get(mint);
      if (w === undefined || w.decided) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        watch.delete(mint);
        continue;
      }
      // Give up on coins that never catch a bid, or that faded already.
      const age = batch.slot - w.createdSlot;
      const nowPrice = currentPriceFp(state, mint);
      if (age > CANDIDATE_MAX_AGE_SLOTS) {
        watch.delete(mint);
        continue;
      }
      if (w.createPriceFp > 0n && nowPrice < (w.createPriceFp * BigInt(FADE_FP)) / FP_SCALE) {
        watch.delete(mint);
        continue;
      }

      const realSol = curve.real_quote_reserves;
      const riseFp =
        w.createPriceFp > 0n ? (nowPrice * FP_SCALE) / w.createPriceFp : 0n;
      if (nowPrice > w.peakFp) w.peakFp = nowPrice;
      // Only buy a coin still near its own highs: one that already dumped
      // 10%+ off its peak is a faded pump, not momentum.
      const nearHigh = nowPrice >= (w.peakFp * 900_000n) / FP_SCALE;
      let buyPressure = 0;
      for (const side of w.sides) if (side) buyPressure += 1;
      const momentumOk =
        nearHigh &&
        buyPressure >= MIN_BUYS_LAST_10 &&
        w.trades >= MIN_TRADES_TO_ENTER &&
        realSol >= MIN_REAL_SOL_TO_ENTER &&
        riseFp >= FP_SCALE + BigInt(riseBar);
      const flowOk =
        nearHigh &&
        buyPressure >= MIN_BUYS_LAST_10 &&
        w.trades >= HOT_MIN_TRADES &&
        realSol >= HOT_REAL_SOL;
      if (!momentumOk && !flowOk) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_STAKE_LAMPORTS) continue;
      // The probe is small on purpose: most coins die, so the first buy
      // risks at most 0.02 SOL (and at least the 0.01 SOL the guardrail
      // counts). A coin that proves itself earns its adds below.
      const stake = cap < PROBE_MAX_LAMPORTS ? cap : PROBE_MAX_LAMPORTS;
      if (free < stake + txFee) continue;

      w.decided = true;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: stake,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      free -= stake + txFee;
      openSlots -= 1;
    }

    // ---- pyramid adds: size into coins that keep running ---------------
    // Adding to a position costs no new position slot, only cash and one
    // order. Each add needs the real reserve to have multiplied since the
    // probe (fresh buyers still arriving) and the price up from the probe.
    for (const [mint, info] of held) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (info.adds >= 2) continue;
      const holding = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (holding === undefined || curve === undefined || curve.complete) continue;
      if (sellPending.has(mint)) continue;
      const want = info.adds === 0
        ? { reserveX: ADD_1_RESERVE_X_FP, rise: ADD_1_PRICE_RISE_FP, max: ADD_1_MAX_LAMPORTS }
        : { reserveX: ADD_2_RESERVE_X_FP, rise: ADD_2_PRICE_RISE_FP, max: ADD_2_MAX_LAMPORTS };
      if (info.probeReserve <= 0n) continue;
      const reserveOk =
        (curve.real_quote_reserves * FP_SCALE) / info.probeReserve >= BigInt(want.reserveX);
      const nowPrice = currentPriceFp(state, mint);
      const priceOk =
        info.probePriceFp > 0n &&
        (nowPrice * FP_SCALE) / info.probePriceFp >= FP_SCALE + BigInt(want.rise);
      if (!reserveOk || !priceOk) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_STAKE_LAMPORTS) continue;
      const stake = cap < want.max ? cap : want.max;
      if (free < stake + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: stake,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      free -= stake + txFee;
    }

    // ---- record buys that filled, so exits know their age and peak -----
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled' && state.positions.has(fill.mint)) {
        const info = held.get(fill.mint);
        if (info === undefined) {
          const curve = state.curves.get(fill.mint);
          held.set(fill.mint, {
            buySlot: fill.slot,
            peakBps: 0,
            tookProfit1: false,
            probeReserve: curve !== undefined ? curve.real_quote_reserves : 0n,
            probePriceFp: currentPriceFp(state, fill.mint),
            adds: 0,
          });
        } else {
          info.adds += 1;
        }
      }
    }

    return orders;
  },
});
