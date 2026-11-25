// Pump.fun Replay Sprint — Paper Bot, Real Ranking
// Entry: vedreal/pump-fun-replay-01
//
// Strategy: "snipe every new coin early, ride the runners, cut the dead".
//   - Snipe: buy a coin on the first batch where it has at least 2 trades
//     and its real SOL reserve reaches 1 SOL (so a >= 0.01 SOL buy fits
//     the harness cap), when the latest trade is a buy, and while the coin
//     is younger than ~24 minutes. There is no cap on the trade count:
//     the fastest coins pack their first trades into a single slot, and
//     batch-level analysis shows those fast coins average +36% forward
//     (slow coins ~0%) — a trade-count cap would exclude the winners.
//     Dev-data analysis (batch-realistic entry, trailing exit): buying
//     every qualifying new coin averaged +17% per trade before fees
//     (median -4%, 5% of trades above +100%).
//   - Chaser: separately, buy a coin whose real reserves have reached
//     30 SOL and whose price is still rising — the late migration run.
//     That band averaged +37% per trade in the same analysis.
//   - Exits are a single trailing stop: sell when the price falls 15%
//     below the peak since entry (the peak starts at the entry price, so
//     the trail doubles as the stop), plus an inactivity exit — no trade
//     for ~8 minutes means the coin is dead, sell and free the slot — and
//     a hard max hold of ~48 minutes.
//   - Portfolio guard: flatten everything past 30% drawdown from the peak
//     portfolio value and stay out for the rest of the replay. The
//     guardrail caps the maximum drawdown at 50%, so the flatten must
//     latch: resetting the peak and trading again would let repeated
//     30% drawdowns compound past 50%. There is no smaller drawdown halt
//     on new entries: a halt latches too early (with no new entries the
//     value can never recover), and this strategy's edge is a few big
//     runners paying for many small losers, so it must trade through
//     ordinary drawdowns. At most 5 open positions, no shorts, no leverage,
//     no randomness: every decision is a pure function of the harness
//     state, so the two grading executions agree byte for byte.
//
// Fees shape every number here: a round trip pays ~1.25% of size per leg in
// curve fees plus 105,000 lamports of tx fees per order, so entries are
// sized at most 0.15 SOL and never below the 0.01 SOL round-trip bar.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type Fill,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- config

const SOL = 1_000_000_000n; // lamports per SOL
const TARGET_BUY_LAMPORTS = 150_000_000n; // 0.15 SOL per entry
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL, the round-trip bar
const CASH_BUFFER_LAMPORTS = 20_000_000n; // 0.02 SOL kept back for exit fees
const MAX_POSITIONS = 5;
const MAX_NEW_BUYS_PER_BATCH = 5;

const WINDOW_TRADES = 5; // last trades kept per mint, for the latest-trade read
const MAX_SNIPE_AGE_SLOTS = 3600; // snipe only coins younger than ~24 minutes
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // 1 SOL: room to size in
const CHASER_MIN_REAL_RESERVE_LAMPORTS = 30_000_000_000n; // 30 SOL: migration run

const TRAIL_DROP_BPS = 1500; // -15% from the peak since entry: the only price exit
const INACTIVITY_EXIT_SLOTS = 1200; // ~8 minutes without a trade: coin is dead
const MAX_HOLD_SLOTS = 7200; // ~48 minutes, then exit no matter what
const REENTRY_COOLDOWN_SLOTS = 600; // ~4 minutes after an exit
const SLIPPAGE_BPS = 500; // 5% max slippage on entries
const SELL_SLIPPAGE_BPS = 2000; // 20% on exits: a dumping coin gaps fast, and
// a rejected exit that retries two slots later fills lower than a wide
// first attempt, so exits take the wide slippage up front
const FLATTEN_SLIPPAGE_BPS = 2000;

const DD_FLATTEN_BPS = 3000; // 30% drawdown: flatten everything, then reset
const MAX_SELL_REJECTS = 3; // then widen slippage and try again

// ---------------------------------------------------------------- per-mint tape

interface TradePoint {
  slot: number;
  price: number; // lamports per token unit (virtual SOL reserves are lamports)
  isBuy: boolean;
  solLamports: bigint;
}

interface MintTape {
  mint: string;
  createdSlot: number | null;
  firstSeenSlot: number;
  lastPrice: number;
  lastPriceSlot: number;
  /** Last WINDOW_TRADES trades, oldest first. */
  points: TradePoint[];
  trades: number;
  complete: boolean;
  cooldownUntilSlot: number;
}

function priceFromReserves(virtualSol: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualSol) / Number(virtualToken);
}

// ---------------------------------------------------------------- own positions

interface OwnPosition {
  mint: string;
  tokens: bigint;
  costLamports: bigint;
  entryPrice: number; // lamports per token unit, from the buy fill
  entrySlot: number;
  peakPrice: number;
  pendingSell: boolean;
  sellRejects: number;
  sellSlippageBps: number;
}

// ---------------------------------------------------------------- bot state

class Strategy {
  readonly tapes = new Map<string, MintTape>();
  readonly positions = new Map<string, OwnPosition>();
  peakValueLamports = 10_000_000_000n; // 10 SOL starting capital
  flattening = false;

  tapeFor(mint: string, slot: number): MintTape {
    let t = this.tapes.get(mint);
    if (t === undefined) {
      t = {
        mint,
        createdSlot: null,
        firstSeenSlot: slot,
        lastPrice: 0,
        lastPriceSlot: slot,
        points: [],
        trades: 0,
        complete: false,
        cooldownUntilSlot: 0,
      };
      this.tapes.set(mint, t);
    }
    return t;
  }

  /** Fold one slot's chain events into the tapes. */
  noteEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = this.tapeFor(e.mint, e.slot);
        t.createdSlot = e.slot;
        t.lastPrice = priceFromReserves(
          BigInt(e.virtual_sol_reserves),
          BigInt(e.virtual_token_reserves),
        );
        t.lastPriceSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = this.tapeFor(e.mint, e.slot);
        const price = priceFromReserves(
          BigInt(e.virtual_sol_reserves),
          BigInt(e.virtual_token_reserves),
        );
        t.lastPrice = price;
        t.lastPriceSlot = e.slot;
        t.trades += 1;
        t.points.push({
          slot: e.slot,
          price,
          isBuy: e.is_buy,
          solLamports: BigInt(e.sol_amount),
        });
        if (t.points.length > WINDOW_TRADES) t.points.shift();
      } else {
        const t = this.tapeFor(e.mint, e.slot);
        t.complete = true;
      }
    }
    // Marks refresh the price of every held mint even on quiet slots.
    for (const m of batch.marks) {
      const t = this.tapes.get(m.mint);
      if (t === undefined) continue;
      if (m.slot < t.lastPriceSlot) continue;
      t.lastPrice = priceFromReserves(
        BigInt(m.virtual_quote_reserves),
        BigInt(m.virtual_token_reserves),
      );
      t.lastPriceSlot = m.slot;
    }
  }

  // ------------------------------------------------------------ fills

  /** client_id -> what the order was, so fills can be attributed. */
  readonly orderInfo = new Map<string, { side: 'buy' | 'sell'; mint: string }>();
  /** Mints with a buy still in flight. */
  readonly pendingBuys = new Set<string>();
  private buyCount = new Map<string, number>();
  private sellCount = new Map<string, number>();

  nextClientId(side: 'buy' | 'sell', mint: string): string {
    const counts = side === 'buy' ? this.buyCount : this.sellCount;
    const n = (counts.get(mint) ?? 0) + 1;
    counts.set(mint, n);
    const id = `${side === 'buy' ? 'b' : 's'}${n}-${mint}`;
    this.orderInfo.set(id, { side, mint });
    return id;
  }

  /** Fold this batch's fills into the own-position book. */
  applyFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // A harness close (complete / flatten / writeoff): the position is
        // gone whatever it was; keep the mint cooling off.
        const pos = this.positions.get(f.mint);
        if (pos !== undefined) {
          this.positions.delete(f.mint);
          const t = this.tapes.get(f.mint);
          if (t !== undefined) t.cooldownUntilSlot = batch.slot + REENTRY_COOLDOWN_SLOTS;
        }
        continue;
      }
      const info = this.orderInfo.get(f.client_id);
      if (info === undefined) continue;
      this.orderInfo.delete(f.client_id);
      if (info.side === 'buy') {
        this.pendingBuys.delete(info.mint);
        if (f.status !== 'filled') continue;
        const tokens = BigInt(f.token_amount);
        const spent = BigInt(f.quote_lamports);
        if (tokens === 0n || spent === 0n) continue;
        const entryPrice = Number(spent) / Number(tokens);
        this.positions.set(info.mint, {
          mint: info.mint,
          tokens,
          costLamports: spent,
          entryPrice,
          entrySlot: f.slot,
          peakPrice: entryPrice,
          pendingSell: false,
          sellRejects: 0,
          sellSlippageBps: SELL_SLIPPAGE_BPS,
        });
      } else {
        const pos = this.positions.get(info.mint);
        if (pos === undefined) continue;
        pos.pendingSell = false;
        if (f.status === 'filled') {
          const sold = BigInt(f.token_amount);
          pos.tokens -= sold;
          pos.sellRejects = 0;
          pos.sellSlippageBps = SELL_SLIPPAGE_BPS;
          if (pos.tokens <= 0n) {
            this.positions.delete(info.mint);
            const t = this.tapes.get(info.mint);
            if (t !== undefined) t.cooldownUntilSlot = batch.slot + REENTRY_COOLDOWN_SLOTS;
          }
        } else if (f.status === 'rejected') {
          pos.sellRejects += 1;
          if (pos.sellRejects >= MAX_SELL_REJECTS) pos.sellSlippageBps = 3000;
        }
        // A failed sell (tx fee paid, nothing traded) just retries next batch.
      }
    }
  }

  /** Drop book positions the harness already closed; clamp to settled size. */
  reconcile(state: BotState): void {
    for (const [mint, pos] of this.positions) {
      const held = state.positions.get(mint);
      if (held === undefined) {
        // Closed by the harness without a fill we saw (e.g. complete).
        this.positions.delete(mint);
        const t = this.tapes.get(mint);
        if (t !== undefined) t.cooldownUntilSlot = state.slot + REENTRY_COOLDOWN_SLOTS;
      } else if (held.token_amount < pos.tokens) {
        pos.tokens = held.token_amount;
      }
    }
  }

  // ------------------------------------------------------------ valuation

  /** Cash plus marked positions, in lamports. Prices here are lamports
   *  per token unit (virtual SOL reserves are denominated in lamports),
   *  so tokens * price is already lamports: no scaling. */
  portfolioValue(state: BotState): bigint {
    let value = state.cash;
    for (const pos of this.positions.values()) {
      const t = this.tapes.get(pos.mint);
      const price = t !== undefined && t.lastPrice > 0 ? t.lastPrice : pos.entryPrice;
      value += BigInt(Math.round(Number(pos.tokens) * price));
    }
    return value;
  }

  // ------------------------------------------------------------ exits

  /** Sell orders for positions whose exit rule fired this batch. The only
   *  price exit is the trailing stop: 15% below the peak since entry. */
  decideExits(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    for (const pos of this.positions.values()) {
      if (pos.pendingSell) continue;
      const t = this.tapes.get(pos.mint);
      const price = t !== undefined ? t.lastPrice : 0;
      if (price > 0 && price > pos.peakPrice) pos.peakPrice = price;
      const age = batch.slot - pos.entrySlot;

      let sellTokens: bigint | null = null;
      if (this.flattening) {
        sellTokens = pos.tokens;
      } else if (age >= MAX_HOLD_SLOTS) {
        sellTokens = pos.tokens;
      } else if (price > 0 && price <= pos.peakPrice * (1 - TRAIL_DROP_BPS / 10000)) {
        sellTokens = pos.tokens;
      } else {
        // Inactivity exit: no trade on this mint for a while means the coin
        // is dead or quiet; sell and free the slot for the next new coin.
        const lastTrade = t !== undefined && t.points.length > 0
          ? t.points[t.points.length - 1].slot
          : pos.entrySlot;
        if (batch.slot - lastTrade > INACTIVITY_EXIT_SLOTS) sellTokens = pos.tokens;
      }
      if (sellTokens !== null && sellTokens > 0n) {
        if (sellTokens > pos.tokens) sellTokens = pos.tokens;
        const held = state.positions.get(pos.mint);
        if (held !== undefined && sellTokens > held.token_amount) sellTokens = held.token_amount;
        if (sellTokens <= 0n) continue;
        pos.pendingSell = true;
        orders.push({
          side: 'sell',
          client_id: this.nextClientId('sell', pos.mint),
          mint: pos.mint,
          token_amount: sellTokens,
          max_slippage_bps: this.flattening ? FLATTEN_SLIPPAGE_BPS : pos.sellSlippageBps,
        });
      }
    }
    // Circuit-breaker note: the flatten LATCHES on purpose. The guardrail
    // caps the maximum drawdown at 50% of the peak portfolio value, so once
    // the book is flattened at -30% the bot stays out for the rest of the
    // replay; resetting the peak and trading again would let repeated
    // 30% drawdowns compound past the 50% guardrail.
    return orders;
  }

  // ------------------------------------------------------------ entries

  /** Mints already entered by the chaser branch (once per mint). */
  readonly chaserEntered = new Set<string>();

  /** Mints already entered by the snipe branch (once per mint). Without
   *  this, a coin that exits and stays young would be re-bought after the
   *  cooldown — and re-entries of a coin that already dumped lose just as
   *  much as first entries, so they only add bleed. */
  readonly snipeEntered = new Set<string>();

  /** Buy orders for fresh coins seen in this batch: the snipe branch takes
   *  a coin on its 2nd-4th trade once its real reserve can carry a
   *  0.01 SOL buy; the chaser branch takes a big coin (real reserves
   *  >= 30 SOL) whose price is still rising. */
  decideEntries(state: BotState, batch: Batch, touched: Set<string>): OrderInput[] {
    const orders: OrderInput[] = [];
    if (this.flattening) return orders;
    const value = this.portfolioValue(state);
    if (value > this.peakValueLamports) this.peakValueLamports = value;
    const ddBps = Number(((this.peakValueLamports - value) * 10000n) / this.peakValueLamports);
    if (ddBps >= DD_FLATTEN_BPS) {
      this.flattening = true;
      return orders;
    }
    if (this.positions.size + this.pendingBuys.size >= MAX_POSITIONS) return orders;

    for (const mint of touched) {
      if (orders.length >= MAX_NEW_BUYS_PER_BATCH) break;
      if (this.positions.has(mint) || this.pendingBuys.has(mint)) continue;
      const t = this.tapes.get(mint);
      if (t === undefined || t.complete) continue;
      if (batch.slot < t.cooldownUntilSlot) continue;
      const lastPoint = t.points.length > 0 ? t.points[t.points.length - 1] : null;
      if (lastPoint === null || !lastPoint.isBuy) continue; // never buy a dump
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;

      // Branch 1 — snipe: at least 2 trades, coin still young, real reserve
      // big enough to size. There is deliberately NO cap on the trade count:
      // the fastest coins pack their first 5+ trades into a single slot, so
      // a trade-count cap would exclude exactly the winners (batch-level
      // analysis: fast coins average +36% forward, slow coins ~0%).
      const age = t.createdSlot !== null ? batch.slot - t.createdSlot : batch.slot - t.firstSeenSlot;
      const isSnipe =
        !this.snipeEntered.has(mint) &&
        t.trades >= 2 &&
        age <= MAX_SNIPE_AGE_SLOTS &&
        curve.real_quote_reserves >= MIN_REAL_RESERVE_LAMPORTS;
      const prevPoint = t.points.length > 1 ? t.points[t.points.length - 2] : null;
      const isChaser =
        !this.chaserEntered.has(mint) &&
        curve.real_quote_reserves >= CHASER_MIN_REAL_RESERVE_LAMPORTS &&
        prevPoint !== null &&
        lastPoint.price > prevPoint.price;
      if (!isSnipe && !isChaser) continue;

      const cap = state.maxBuyLamports(mint);
      let size = TARGET_BUY_LAMPORTS;
      if (size > cap) size = cap;
      const free = state.freeCashLamports() - CASH_BUFFER_LAMPORTS;
      if (size > free) size = free;
      if (size < MIN_BUY_LAMPORTS) continue;

      if (isSnipe) this.snipeEntered.add(mint);
      if (isChaser) this.chaserEntered.add(mint);
      this.pendingBuys.add(mint);
      orders.push({
        side: 'buy',
        client_id: this.nextClientId('buy', mint),
        mint,
        quote_lamports: size,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      if (this.positions.size + this.pendingBuys.size >= MAX_POSITIONS) break;
    }
    return orders;
  }
}

// ---------------------------------------------------------------- the run

const strategy = new Strategy();

await runBot({
  onHello(state: BotState): void {
    console.error(
      `pump-fun-replay-01: hello, capital ${state.hello.capital.lamports} lamports, ` +
        `max ${state.hello.caps.max_open_positions} positions, seed ${state.hello.seed}`,
    );
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    strategy.noteEvents(batch);
    strategy.applyFills(batch);
    strategy.reconcile(state);

    // Drawdown guard on the marked portfolio value.
    const value = strategy.portfolioValue(state);
    if (value > strategy.peakValueLamports) strategy.peakValueLamports = value;
    const ddBps = Number(
      ((strategy.peakValueLamports - value) * 10000n) / strategy.peakValueLamports,
    );
    if (ddBps >= DD_FLATTEN_BPS) strategy.flattening = true;

    const exits = strategy.decideExits(state, batch);

    // Only mints that actually traded this batch can be fresh entries.
    const touched = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'TradeEvent') touched.add(e.mint);
    }
    const entries = strategy.decideEntries(state, batch, touched);

    return [...exits, ...entries];
  },

  onDone(state: BotState): void {
    const value = strategy.portfolioValue(state);
    console.error(
      `pump-fun-replay-01: done, cash ${state.cash} lamports, ` +
        `portfolio ${value} lamports, peak ${strategy.peakValueLamports}, ` +
        `open positions ${strategy.positions.size}`,
    );
  },
});

