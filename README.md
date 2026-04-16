# Simple IMC Visualizer

This is the first-pass visualizer for Prosperity-style logs.

## Scope

- Upload a raw `.log`, `.json`, or `.zip` bundle
- Select a product
- View:
  - 3 bid depth lines
  - 3 ask depth lines
  - optional mid-price line
  - toggleable trade overlays

## Trader Toggles

Because the provided log does not expose exact external trader IDs, the visualizer uses inferred groups:

- `OURS`
- `MAKER-LIKE`
- `SMALL TAKER`
- `BIG TAKER`
- `INFORMED-LIKE`
- `OTHER MARKET`

These are heuristic labels, not true bot identities.

## Usage

1. Open [index.html](./index.html) in a browser.
2. Upload a Prosperity log file or the zip bundle that contains it.
3. Choose a product from the dropdown.
4. Use the checkboxes to hide/show inferred trader groups.

## Notes

- The implementation is intentionally static and dependency-light:
  - Plotly for charting
  - JSZip for reading zipped uploads
- This version focuses only on the order book depth chart plus trader toggles.
- It can be extended later with timestamp inspectors, positions, PnL, and richer trader inference.
