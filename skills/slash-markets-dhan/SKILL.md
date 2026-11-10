---
name: slash-markets-dhan
description: Query Indian market data from Dhan by writing Python through the /markets Dhan connector. Use for NSE/BSE stocks and indices, NSE/BSE index and stock F&O and MCX commodities — prices and depth, intraday and daily candles, indicators (EMA/RSI/MACD/Bollinger/ATR/VWAP), option chains with Dhan's IV and greeks, expiries, expired-option history — for the shared feed account's positions, holdings, funds, orders and trades, and for arming e-mail watchers. Trigger on "what is X trading at", trend/outlook/levels, NIFTY/BANKNIFTY/SENSEX or any F&O stock, option IV/OI/max-pain, GOLD/CRUDEOIL/SILVER, "alert me when…".
---

# /markets Dhan data via Python

You have one data tool: **`run_python(code)`**. It executes your Python on /markets'
server, where a shared Dhan session is already wired in through a local gateway, and
returns whatever the script printed. The data never enters your context unless you
print it, so for any question that needs more than one number write a script and
**print the conclusion**, not the rows.

Three more tools exist: `feed_status` (whether the shared Dhan feed is usable right
now) and the watcher pair `create_watcher` / `list_watchers`.

There are no user accounts on this connector. The account functions (`positions`,
`holdings`, `funds`, `orders`, `trades`) describe the **/markets feed account**, the
operator's Dhan account that every user shares; say so whenever you report them.

## Model the question as a function

The user's question is a function specification. Write that function, run it once,
print the answer. Before writing anything, ask: *what would a single function that
answers this whole question look like?* Then write that function, including every
decision you would otherwise make by reading intermediate output.

**The anti-pattern**: using the tool as a remote procedure call.

```python
pp(z.option_chain("NIFTY"))  # 21 strikes into your context, you find ATM…
pp(z.option_candles(51342, interval=15))  # …then 50 bars more
```

Two round trips, thousands of tokens of rows, and the user asked one sentence.

**Composed**: same question, one call, the data stays on the server.

```python
import json, slashdhan as z


def answer():
    ch = z.option_chain("NIFTY", strikes_around=3)
    spot = ch["underlyingLastPrice"]
    atm = min(ch["strikes"], key=lambda r: abs(r["strike"] - spot))
    ce = atm["ce"]
    if not ce:
        return f"no CE quote at {atm['strike']:.0f}"
    bars = z.option_candles(ce["securityId"], interval=15, days_back=1)
    if not bars:
        return f"NIFTY {atm['strike']:.0f} CE: no bars today (holiday or pre-open)"
    first, last = bars[0]["close"], bars[-1]["close"]
    oi_chg = bars[-1].get("oi", 0) - bars[0].get("oi", 0)
    return (
        f"NIFTY {atm['strike']:.0f} CE ({ch['expiry']}): {first} -> {last} "
        f"({(last / first - 1) * 100:+.1f}%), OI {oi_chg:+,}, IV {ce['iv']:.1f}%, "
        f"delta {ce['delta']:.2f}, spot {spot}"
    )


print(answer())
```

```
NIFTY 22750 CE (2026-10-27): 94.15 -> 0.05 (-99.9%), OI +9,224,215, IV 0.0%, delta 0.00, spot 22749.75
```

Writing it as `def answer():` is a useful habit: it makes early returns available for
the empty and error branches, and it forces the question to have one shape.

### Decisions go in the script

| The urge | The code |
| --- | --- |
| fetch the chain to find ATM | `min(ch["strikes"], key=lambda r: abs(r["strike"] - ch["underlyingLastPrice"]))` |
| fetch the expiry list to pick one | `z.nearest_expiry("NIFTY")`, or `z.expiry_list("NIFTY")[1]` |
| read positions to find the worst | `min(z.positions(), key=lambda p: p["unrealizedProfit"])` |
| see which strikes matter | `sorted(rows, key=lambda r: -((r["ce"] or {}).get("oi") or 0))[:3]` |
| check there is data before using it | `if not rows: return "nothing open"` |

A dependent lookup is not a reason to split a script. The sandbox reads its own
intermediate values for free; you do not.

### Be defensive, not exploratory

You cannot see the data before you write the code, so handle what might be there:
`try/except z.SlashDhanError` around a fetch that can fail, `.get(key)` for anything
optional, an explicit branch for the empty case. A script that covers the empty
account, the closed position and the missing data plan inline is one call; a script
that discovers them is three.

Loop over instruments inside the script rather than asking about them one at a
time: the whole list in one pass costs the same round trip as one row.

### Print the answer, not the working

Print the conclusion and the few numbers supporting it. Candle lists, chains and
intermediate arrays stay in the sandbox. Output over 64 KB is truncated.

### When a second call is justified

A traceback you need to fix, or a genuine follow-up question from the user. Not
"now let me fetch the next thing."

## Mechanics

- Start every script with `import slashdhan as z` (plus `json`, `statistics`, `math`,
  `datetime` as needed). Standard library only; no pandas, no numpy.
- A failing script returns its traceback as an error result. Read it and send a
  corrected script.
- Files persist in a working directory **shared by every user of this connector**:
  save big fetched data in one script, read it back in the next, and use distinctive
  file names.
- Scripts are killed after 60 s by default; pass `timeout_seconds` up to 180 for long
  candle pulls or `expired_options`.
- Each script has a budget of about 40 Dhan requests (`CallBudgetExceeded`
  otherwise). Batch ids into one `z.ltp(...)`, keep `strikes_around` small, use wider
  candle intervals.
- Dhan rate limits are shared by every /markets user on the one feed: quotes 1
  request/s, candles 5/s, option chains 1 per (underlying, expiry) every 3 s.
  `RateLimited` means wait a few seconds, not retry in a loop.
- `print(z.help_api())` lists every function with its first doc line.
- Everything is read-only. There is no order placement, modification or cancellation
  anywhere. If asked to trade, say so; the user trades in their own broker app.

## Errors that mean something

| Exception | Meaning | What to tell the user |
| --- | --- | --- |
| `TokenExpired` | The shared Dhan token died (Dhan tokens last 24 h) and the operator has not pushed the next one yet. | Try again in a few minutes; `feed_status` shows when it was last good. Nothing in a script or in chat can refresh it. |
| `DataPlanMissing` | Dhan error 806: the feed account has no Data-API subscription for quotes, candles and chains. | Account reads still work; `holdings()` rows carry a `lastTradedPrice`. |
| `InstrumentNotFound` | No instrument matched the symbol, id or underlying. | Try `z.search_instruments(q)`. |
| `RateLimited` / `CallBudgetExceeded` | See Mechanics. | Fetch less, batch more. |

## Instruments: ids, segments, markets

Dhan addresses an instrument by **`exchange_segment` + `security_id`**. Every
function that takes an instrument also accepts a plain symbol or a `"SEGMENT:ID"`
key, which `z.resolve_symbol` maps; pass `exchange_segment` only when you hand over a
bare id.

| You write | Resolves to |
| --- | --- |
| `"TCS"`, `"INFY"` | the NSE share (`NSE_EQ` 11536); `z.resolve_symbol("TCS", "BSE_EQ")` for the BSE listing |
| `"NIFTY"`, `"Bank Nifty"`, `"FINNIFTY"`, `"SENSEX"`, `"INDIA VIX"` | the spot index on `IDX_I` (NIFTY 13, BANKNIFTY 25, SENSEX 51) |
| `"GOLD"`, `"CRUDEOIL"`, `"SILVER"`, `"NATURALGAS"` | the nearest live MCX future (`MCX_COMM`) |
| `"NSE_EQ:2885"`, `"IDX_I:13"`, `(45623, "NSE_FNO")` | used as-is |

Segments served: `NSE_EQ`, `BSE_EQ` (stocks, ETFs), `IDX_I` (indices, data only),
`NSE_FNO`, `BSE_FNO` (index and stock futures and options), `MCX_COMM` (commodity
futures, options and MCX indices). Currency derivatives are not available on Dhan.
Option *underlyings* are plain names (`NIFTY`, `RELIANCE`, `GOLD`);
`z.list_underlyings("index" | "stock" | "commodity")` lists them.

```python
z.resolve_symbol(symbol, exchange_segment=None, kind=None)
# -> {security_id, exchange_segment, symbol, display_name, instrument, kind, isin, lot_size, tick_size,
#     expiry_date (futures)} or None; kind steers: equity | index | commodity | future
z.instrument(
    ref, exchange_segment=None
)  # same row for a symbol / key / id; raises InstrumentNotFound
z.search_instruments(q, exchange_segment=None, instrument=None, limit=20, include_expired=False)
z.find_option_contracts(
    underlying, expiry_date=None, option_type=None, strike_price=None, limit=50, exchange=None
)
z.futures_list(
    underlying, exchange=None
)  # live futures, nearest first; z.expiry_list / z.nearest_expiry for options
z.resolve_underlying(
    "RELIANCE", exchange="BSE"
)  # {name, scrip, seg, exchange, contract_segment, contract_instrument, kind, nearest_expiry}
z.market_status()  # {now_ist, weekday, markets: {NSE: {open, hours}, MCX: {…}}, open}
```

Hours (Mon–Fri): NSE/BSE/F&O 09:15–15:30, MCX 09:00–23:30 IST. Exchange holidays are
not modelled. Off-hours, quotes are the last traded price. Money is ₹. Trading
symbols in positions look like `NIFTY-Oct2026-24700-CE`, `RELIANCE-Oct2026-FUT`,
`GOLD-Dec2026-FUT`.

## Account (the shared feed account)

```python
z.profile()  # {dhanClientId, tokenValidity, activeSegment, ddpi, mtf, dataPlan, dataValidity}
z.funds()  # {availabelBalance (Dhan's spelling), withdrawableBalance, utilizedAmount, collateralAmount, sodLimit, …}
z.positions()  # today's trading book: [{tradingSymbol, securityId, exchangeSegment, productType (CNC|INTRADAY|MARGIN),
#   positionType (LONG|SHORT|CLOSED), netQty, buyAvg, sellAvg, realizedProfit, unrealizedProfit,
#   drvExpiryDate, drvOptionType, drvStrikePrice, …}]  netQty 0 = squared off today
z.position_for(
    security_id, exchange_segment=None, product_type=None
)  # position row, else holding row (+"_source"), else None
z.holdings()  # demat: [{tradingSymbol, securityId, isin, exchange, totalQty, availableQty, avgCostPrice, lastTradedPrice}]
z.orders()  # today's order book: [{orderId, orderStatus (TRANSIT|PENDING|TRADED|REJECTED|CANCELLED|PART_TRADED|EXPIRED),
#   tradingSymbol, transactionType, orderType, productType, quantity, filledQty, price, omsErrorDescription, …}]
z.trades()  # today's fills: [{orderId, tradingSymbol, transactionType, tradedQuantity, tradedPrice, exchangeTime}]
z.dhan_get(
    "/ledger"
)  # escape hatch for any other Dhan read endpoint (writes are refused by the gateway)
```

Dhan returns its own field names (camelCase); pass them through rather than renaming.
P&L fields are rupees. Holdings are NOT in `positions()` unless traded today.

## Market data

```python
z.ltp(["RELIANCE", "NIFTY", "GOLD"])          # -> {"NSE_EQ": {"2885": 1196.2}, "IDX_I": {"13": 22749.75}, "MCX_COMM": {"495213": 142825.0}}
z.ltp({"NSE_EQ": [2885, 11536], "IDX_I": [13]})   # same, by ids; ≤1000 ids per Dhan call
z.ltp_of("TCS")  z.ltp_of(13, "IDX_I")        # one float; falls back to holdings' LTP for *_EQ without the data plan
z.ohlc([...])                                 # {seg: {id: {last_price, ohlc: {open, high, low, close}}}}
z.quote([...])                                # {seg: {id: {last_price, volume, average_price, net_change, buy_quantity, sell_quantity,
                                              #   ohlc, last_trade_time, oi, oi_day_high, oi_day_low, upper_circuit_limit,
                                              #   lower_circuit_limit, depth: {buy: [{price, quantity, orders}×5], sell: […]}}}}

z.intraday_candles(instrument, exchange_segment=None, interval=15, days_back=5, from_date=None, to_date=None, oi=None)
# interval: 1, 5, 15, 25, 60 (minutes). Rows oldest→newest:
# {"time": "2026-10-27T09:15:00+05:30" (bar OPEN, IST), "timestamp" (epoch s), "open", "high", "low", "close", "volume", "oi"?}
# oi is included for every derivative by default. Windows over 90 days are fetched in chunks (one Dhan call each).
z.daily_candles(instrument, exchange_segment=None, days_back=365, from_date=None, to_date=None, oi=None, expiry_code=None)
# day bars; expiry_code 0/1/2 = current/next/far futures series for a futures id
z.option_candles(contract, underlying=None, interval=15, days_back=5)   # premium candles with oi for one option contract id
```

The last intraday bar may still be forming during market hours: for indicators use
`z.closes(rows[:-1])`. A trailing zero-volume bar after the close can be ignored.

## Options

Dhan serves a real option chain with **implied volatility and greeks** per side.
Dhan allows one chain call per (underlying, expiry) every 3 seconds, so fetch one
chain and compute from it.

```python
z.expiry_list(
    "NIFTY"
)  # ["2026-10-27", "2026-11-03", …] ascending; works for GOLD, RELIANCE, SENSEX (exchange="BSE" when listed on several)
z.nearest_expiry("BANKNIFTY")
z.option_chain(underlying, expiry=None, strikes_around=10, exchange=None)
# -> {underlying, exchange (NSE|BSE|MCX), contractSegment (NSE_FNO|BSE_FNO|MCX_COMM), expiry, underlyingLastPrice,
#     lot_size, pcr (PE OI / CE OI over the window), max_pain,
#     strikes: [{strike, ce: {...} | None, pe: {...} | None}]}
#    each side: {ltp, iv (percent, 12.5 = 12.5%), oi, oiPrev, volume, bid, bidQty, ask, askQty, avgPrice, prevClose,
#                securityId, delta, theta, gamma, vega}
#    strikes_around=None returns every strike (large); keep it ≤ 20 and at most 2 chains per question.
z.expired_options(
    underlying,
    "CALL" | "PUT",
    from_date,
    to_date,
    strike="ATM",
    expiry_flag=None,
    expiry_code=1,
    interval=60,
    fields=None,
)
# -> {underlying, exchange, optionType, expiryFlag, bars: [{time, timestamp, close, iv, oi, strike, spot}]}
#    history of EXPIRED contracts at ATM / "ATM+2" / "ATM-3", rolling across past expiries; ≤7 days per call, SLOW (~15 s)
```

`securityId` from a chain row feeds `option_candles` and `ltp` on `contractSegment`.
OI is in units; divide by `lot_size` for lots. Commodity chains address the MCX
underlying; their "spot" is Dhan's reference price for the contract series.

## Indicators, dates, helpers

All indicator functions take a list of floats (use `z.closes(rows)`) and return a
list aligned to the input with `None` while warming up. Feed CLOSED bars.

```python
z.closes(rows, field="close")
z.sma(values, period)        z.ema(values, period)       z.rsi(values, period=14)
z.macd(values, 12, 26, 9)    # {"macd": [...], "signal": [...], "histogram": [...]}
z.bollinger(values, 20, 2.0) # {"upper", "middle", "lower"}
z.atr(rows, 14)              z.vwap(rows)                z.pct_change(values)
z.now()  z.today()  z.tomorrow()  z.days_ago(n)  z.ymd(d)  z.to_ist(epoch_seconds)  z.IST
z.pp(value, limit=4000)      z.help_api()                z.is_nan(x)
```

## Watchers

`create_watcher(symbol, label, script, notify_email, check_every_minutes=1, expires_in_days=30, market="auto")`
arms an e-mail alert. **`notify_email` is required and must come from the user:
ask which address should receive the alerts if they have not said; never guess.**
The script runs in this same sandbox on the schedule during that market's hours
(auto-detected: MCX for commodities, else NSE), so keep it to one or two calls and
resolve ids now, hard-coding them. Its **last printed line must be** exactly
`{"met": true|false, "value": <number>, "detail": "<short note>"}`. It is dry-run
once at creation and rejected if the output breaks that contract. The first check
is a baseline and never alerts; one e-mail per not-met→met transition, at most
every 15 minutes. When the shared Dhan token expires, watchers pause and resume by
themselves after the operator refreshes it. The tool returns `{"created": true,
"watcher": {...}}` with the watcher's `id`, dry-run result and `pageUrl`, or
`{"created": false, "error": "..."}` when the dry run or an argument was rejected
(fix and retry). You cannot pause, resume or cancel: always show the user the
returned `pageUrl`, a page that lists every watcher on this connector.

```python
# "e-mail me when NIFTY 15m RSI drops under 30"
import json, slashdhan as z

rows = z.intraday_candles(13, "IDX_I", interval=15, days_back=3)
r = z.rsi(z.closes(rows[:-1]))[-1]
print(
    json.dumps(
        {
            "met": r is not None and r < 30,
            "value": round(r, 1) if r else None,
            "detail": "NIFTY 15m RSI14",
        }
    )
)
```

## Worked examples

Each is one call: a question in, an answer out.

**"How is the feed account doing?"**

```python
import slashdhan as z

pos = [p for p in z.positions() if p.get("netQty")]
hold = z.holdings()
pnl = sum(float(p.get("unrealizedProfit") or 0) + float(p.get("realizedProfit") or 0) for p in pos)
invested = sum(float(h["avgCostPrice"]) * float(h["totalQty"]) for h in hold)
value = sum(
    float(h.get("lastTradedPrice") or h["avgCostPrice"]) * float(h["totalQty"]) for h in hold
)
f = z.funds()
print(
    f"[feed account] {len(pos)} open positions, P&L ₹{pnl:,.0f} | {len(hold)} holdings worth ₹{value:,.0f} "
    f"(invested ₹{invested:,.0f}) | available ₹{float(f.get('availabelBalance') or 0):,.0f}"
)
for p in sorted(pos, key=lambda p: float(p.get("unrealizedProfit") or 0)):
    print(
        f"  {p['tradingSymbol']:<28} {p['netQty']:>6} @ {float(p['buyAvg'] or p['sellAvg']):,.2f}  ₹{float(p['unrealizedProfit']):+,.0f}"
    )
```

**"Is TCS bullish?"**

```python
import slashdhan as z

d = z.daily_candles("TCS", days_back=320)
c = z.closes(d)
e50, e200, r = z.ema(c, 50)[-1], z.ema(c, 200)[-1], z.rsi(c)[-1]
m = z.macd(c)["histogram"][-1]
hi = max(x["high"] for x in d[-30:])
lo = min(x["low"] for x in d[-30:])
trend = "above" if c[-1] > e50 > e200 else "below" if c[-1] < e50 < e200 else "mixed vs"
print(
    f"TCS {c[-1]:,.1f}: {trend} EMA50 {e50:,.0f}/EMA200 {e200:,.0f}, RSI14 {r:.0f}, MACD hist {m:+.1f}, "
    f"30d range {lo:,.0f}–{hi:,.0f} ({(c[-1] - lo) / (hi - lo) * 100:.0f}% of range)"
)
```

**"What are option writers positioned for this expiry?"**

```python
import slashdhan as z

ch = z.option_chain("NIFTY", strikes_around=12)
rows = ch["strikes"]
oi = lambda side: lambda r: -((r[side] or {}).get("oi") or 0)
spot = ch["underlyingLastPrice"]
print(f"NIFTY {spot:,.0f} exp {ch['expiry']} | PCR {ch['pcr']} | max pain {ch['max_pain']:,.0f}")
print(
    "call OI walls:",
    [r["strike"] for r in sorted(rows, key=oi("ce"))[:3]],
    "| put OI walls:",
    [r["strike"] for r in sorted(rows, key=oi("pe"))[:3]],
)
atm = min(rows, key=lambda r: abs(r["strike"] - spot))
print(
    f"ATM {atm['strike']:.0f}: CE {atm['ce']['ltp']} IV {atm['ce']['iv']:.1f}% | PE {atm['pe']['ltp']} IV {atm['pe']['iv']:.1f}%"
)
```

**"How has gold moved this month?"**

```python
import slashdhan as z

fut = z.resolve_symbol("GOLD")
d = z.daily_candles(fut["security_id"], "MCX_COMM", days_back=45)
c = z.closes(d)
print(
    f"GOLD {fut['display_name']} {c[-1]:,.0f}: {(c[-1] / c[-22] - 1) * 100:+.1f}% over 22 sessions, "
    f"range {min(c[-22:]):,.0f}–{max(c[-22:]):,.0f}, ATR14 {z.atr(d, 14)[-1]:,.0f}, OI {d[-1].get('oi', 0):,}"
)
```

**"Which index moved most today?"**

```python
import slashdhan as z

names = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"]
ids = {n: z.resolve_symbol(n)["security_id"] for n in names}
q = z.ohlc({"IDX_I": list(ids.values())})["IDX_I"]
rows = []
for n, sid in ids.items():
    r = q.get(sid)
    if not r or not r["ohlc"].get("open"):
        continue
    rows.append((n, r["last_price"], (r["last_price"] / r["ohlc"]["open"] - 1) * 100))
for n, px, chg in sorted(rows, key=lambda r: -abs(r[2])):
    print(f"{n:<12} {px:>12,.2f}  {chg:+.2f}% vs open")
```

**"How did IV behave into last expiry?"**

```python
import slashdhan as z

r = z.expired_options("NIFTY", "CALL", z.days_ago(8), z.days_ago(1), fields=["close", "iv", "spot"])
bars = [b for b in r["bars"] if "iv" in b]
if not bars:
    print("no expired-option bars in that window")
else:
    first, last = bars[0], bars[-1]
    print(
        f"ATM CALL ({r['expiryFlag']}): IV {first['iv']:.1f}% -> {last['iv']:.1f}%, premium {first['close']} -> {last['close']}, "
        f"spot {first['spot']:,.0f} -> {last['spot']:,.0f} over {len(bars)} hourly bars"
    )
```

## Reporting back to the user

State prices and statistics exactly as returned; never fill a gap with an invented
number. Say which instrument a price is from (the NSE share, the nearest future, a
specific option contract) and whether the market is open. Account figures are the
shared feed account's, not the user's: say so. If the feed token has expired, say
so and suggest trying again in a few minutes; never ask for credentials in chat.
Timestamps are IST.
