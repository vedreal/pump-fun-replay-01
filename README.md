# pump-fun-replay-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vedreal/pump-fun-replay-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/vedreal/pump-fun-replay-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A sniper bot for the Pump.fun Replay Sprint: it trades 10 SOL of paper money on a 24h replay of Solana pump.fun bonding-curve activity. It buys every new coin on the first batch where it has at least 2 trades and its real SOL reserve can carry a 0.01 SOL buy, while the coin is younger than ~24 minutes, plus big coins (real reserves ≥ 30 SOL) whose price is still rising toward migration, and exits on a single trailing stop — 15% below the peak since entry — with an inactivity exit after ~8 minutes without a trade and a ~48-minute max hold, plus a 30% drawdown circuit breaker that flattens everything and stops trading to protect the 50% maximum-drawdown guardrail. At most 5 open positions, no shorts, no leverage, fully deterministic.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=f2pdfak6&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
