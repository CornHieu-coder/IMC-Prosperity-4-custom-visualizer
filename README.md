# Simple IMC Visualizer

This is a lightweight visualizer for Prosperity-style logs with order book depth lines and behavior-based trader overlays.

## Scope

- Upload a raw `.log`, `.json`, or `.zip` bundle
- Select a product
- View:
  - 3 bid depth lines
  - 3 ask depth lines
  - optional mid-price line
  - toggleable trade overlays

## How Trader Categorization Works

The log file does not expose true external bot IDs, so the visualizer does **not** identify named traders. Instead, it groups anonymous market flow into behavior-based categories.

The pipeline is:

1. Parse the book snapshot from `activitiesLog`.
2. Parse anonymous market trades from the log state.
3. Parse optional fair values from custom JSON stored in `traderData`.
4. Build **meta-trades** by combining anonymous trades that share:
   - the same product
   - the same timestamp
   - the same inferred side
5. Measure each meta-trade on two axes:
   - **Aggression**
   - **Impact**
6. Apply the final category matrix.

## Pre-Processing

### True Price / Fair Value

If your bot writes a JSON object into `traderData` like:

```json
{
  "type": "CUSTOM_METRICS",
  "fair_values": {
    "ASH_COATED_OSMIUM": 10000.0,
    "INTARIAN_PEPPER_ROOT": 12003.5
  }
}
```

the visualizer will read those values and store them in `window.truePrices`.

This gives the classifier a reference for deciding whether a trade moved the market **toward** or **away from** fair value.

If the uploaded log does not contain fair values, the visualizer still works, but the informed/uninformed split relies more heavily on the book-based signal described below.

### Meta-Trades

Anonymous market prints are first combined into **meta-trades** so that one iceberg-style action does not appear as many unrelated small trades.

Each aggressive meta-trade combines raw anonymous trades with the same:

- product
- timestamp
- inferred side

Important exception:

- trades executed strictly **inside the spread** are isolated immediately and kept separate as passive `MAKER-LIKE` prints

This prevents passive fills from being merged into aggressive sweeps and polluting the taker volume or VWAP.

### Wall Mid

The visualizer computes a `Wall Mid` for each timestamp:

- find the first bid level with volume `>= 15`
- find the first ask level with volume `>= 15`
- take the midpoint between those two prices

This is meant to track the heavier, more meaningful book structure rather than just the top-of-book mid.

## The Two Classification Axes

### 1. Aggression

Aggression asks: **how deep did the trade push into the book?**

The visualizer looks at the pre-trade book and checks the worst execution price inside the meta-trade:

- if the trade only touches Level 1, aggression is `low`
- if the trade reaches Level 2 or Level 3, aggression is `high`

So a trade that consumes the top level and keeps going deeper is treated as more forceful.

### 2. Impact

Impact asks: **did this trade actually matter structurally?**

A meta-trade is treated as `high impact` if either of these is true:

- the market moves **toward fair value**
- the `Wall Mid` shifts by at least `0.5` in the trade direction over the next few rows

Otherwise it is treated as `low impact`.

In practice:

- if a buy helps pull price toward fair value, that is high impact
- if a sell pushes the heavier book structure down in a meaningful way, that is also high impact

## Final Category Matrix

After measuring aggression and impact, the visualizer applies this matrix.

### `OURS`

Exact fills where buyer or seller is `SUBMISSION`.

This is the only category that is not inferred.

### `MAKER-LIKE`

Trades executed strictly inside the displayed bid/ask spread.

These are isolated before aggressive aggregation and shown separately because they look passive rather than sweepy.

### `TOXIC WHALE`

High aggression + high impact

Interpretation:

- the trade pushed deep into the book
- and it also moved price structure in a meaningful way

This is the strongest form of aggressive informed flow in the current model.

### `STEALTH INFORMED`

Low aggression + high impact

Interpretation:

- the trade did not need to sweep deeply
- but it still managed to move the market structurally

This is the “small but smart” bucket.

### `INVENTORY DUMPER`

High aggression + low impact

Interpretation:

- the trade consumed real liquidity
- but it did not produce strong structural follow-through

This is meant to capture large urgent flow that looks more forced than informed.

### `NOISE TRADER`

Low aggression + low impact

Interpretation:

- not especially deep into the book
- not especially meaningful afterward

This is the fallback bucket for low-information anonymous flow.

## Practical Notes

- These labels are **heuristics**, not true identities.
- The classifier is strongest when the uploaded log contains `fair_values`.
- Without fair values, the visualizer can still categorize flow, but it leans more on `Wall Mid` movement than on true-price alignment.
- Sparse market-trade logs can naturally produce very few informed or dumper labels.

## Usage

1. Open [index.html](./index.html) in a browser.
2. Upload a Prosperity log file or the zip bundle that contains it.
3. Choose a product from the dropdown.
4. Use the checkboxes to hide/show inferred trader groups.

## Notes

- The implementation is intentionally static and dependency-light:
  - Plotly for charting
  - JSZip for reading zipped uploads
- This version focuses on the order book depth chart plus trader toggles.
- It can be extended later with timestamp inspectors, positions, PnL, and richer trader inference.
