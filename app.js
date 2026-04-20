const GROUP_META = {
  ours: {
    label: "OURS",
    description: "Exact fills by SUBMISSION.",
    color: "#facc15",
    defaultEnabled: true,
  },
  makerLike: {
    label: "MAKER-LIKE",
    description: "Meta-trades executed strictly inside the displayed spread.",
    color: "#a78bfa",
    defaultEnabled: true,
  },
  toxicWhale: {
    label: "TOXIC WHALE",
    description: "High-aggression meta-trades that structurally move price.",
    color: "#22c55e",
    defaultEnabled: true,
  },
  stealthInformed: {
    label: "STEALTH INFORMED",
    description: "Low-aggression meta-trades with strong structural impact.",
    color: "#14b8a6",
    defaultEnabled: true,
  },
  inventoryDumper: {
    label: "INVENTORY DUMPER",
    description: "High-aggression meta-trades with weak structural impact.",
    color: "#ff6b6b",
    defaultEnabled: true,
  },
  noiseTrader: {
    label: "NOISE TRADER",
    description: "Low-aggression meta-trades with low impact.",
    color: "#e5e7eb",
    defaultEnabled: false,
  },
};

const DEPTH_COLORS = {
  bid: ["#60a5fa", "#3b82f6", "#1d4ed8"],
  ask: ["#fda4af", "#fb7185", "#e11d48"],
  mid: "#cbd5e1",
  fair: "#f59e0b",
};

const MIN_DEPTH_POINTS_TO_RENDER = 25;
const WALL_VOLUME_THRESHOLD = 15;
const WALL_MID_LOOKAHEAD = 5;
const WALL_MID_SHIFT_THRESHOLD = 0.5;
const TRUE_PRICE_FIELDS = ["fair_values", "fairValues", "true_prices", "truePrices"];
const EPSILON = 1e-9;

const appState = {
  parsed: null,
  activeProduct: "",
  visibleGroups: new Set(
    Object.entries(GROUP_META)
      .filter(([, meta]) => meta.defaultEnabled)
      .map(([key]) => key),
  ),
};

const dom = {
  fileInput: document.getElementById("file-input"),
  productSelect: document.getElementById("product-select"),
  showMidToggle: document.getElementById("show-mid-toggle"),
  showFairToggle: document.getElementById("show-fair-toggle"),
  showDepthToggle: document.getElementById("show-depth-toggle"),
  groupToggles: document.getElementById("group-toggles"),
  toggleSummary: document.getElementById("toggle-summary"),
  loadedFileStat: document.getElementById("loaded-file-stat"),
  productCountStat: document.getElementById("product-count-stat"),
  tradeCountStat: document.getElementById("trade-count-stat"),
  statusStat: document.getElementById("status-stat"),
  chart: document.getElementById("chart"),
};

window.truePrices = {};

bootstrap();

function bootstrap() {
  renderToggleControls();
  bindEvents();
  Plotly.newPlot(
    dom.chart,
    [],
    buildLayout("Load a Prosperity log to begin"),
    { responsive: true, displaylogo: false },
  );
}

function bindEvents() {
  dom.fileInput.addEventListener("change", handleFileUpload);
  dom.productSelect.addEventListener("change", () => {
    appState.activeProduct = dom.productSelect.value;
    render();
  });
  dom.showMidToggle.addEventListener("change", render);
  dom.showFairToggle.addEventListener("change", render);
  dom.showDepthToggle.addEventListener("change", render);
}

async function handleFileUpload(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  try {
    updateStatus(`Loading ${file.name}...`);
    const text = await readInputFile(file);
    const parsed = parseProsperityPayload(text, file.name);

    appState.parsed = parsed;
    appState.activeProduct = parsed.products[0] || "";

    populateProductSelect(parsed.products);
    updateStatsAfterLoad(parsed);
    render();
  } catch (error) {
    console.error(error);
    updateStatus(`Failed to parse file: ${error.message}`);
    Plotly.react(dom.chart, [], buildLayout("Failed to parse input file"), {
      responsive: true,
      displaylogo: false,
    });
  }
}

async function readInputFile(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "zip") {
    const zip = await JSZip.loadAsync(file);
    const fileNames = Object.keys(zip.files);
    const candidateName =
      fileNames.find((name) => name.endsWith(".log")) ||
      fileNames.find((name) => name.endsWith(".json"));
    if (!candidateName) {
      throw new Error("Zip archive does not contain a .log or .json file.");
    }
    return zip.files[candidateName].async("string");
  }

  return file.text();
}

function parseProsperityPayload(text, sourceName) {
  const payload = JSON.parse(text);
  if (!payload.activitiesLog) {
    throw new Error("File does not look like a Prosperity log/json payload.");
  }

  const activity = parseActivitiesLog(payload.activitiesLog);
  const logStates = parseLogStates(payload.logs || []);
  const truePricesByTimestamp = buildTruePriceLookup(logStates);
  const ownTrades = parseOwnTrades(payload.tradeHistory || []);
  const marketTrades = parseAnonymousMarketTrades(logStates);
  const metaTrades = buildMetaTrades(marketTrades, activity.snapshotMap);
  const allTrades = classifyTrades(
    ownTrades,
    metaTrades,
    activity.snapshotMap,
    activity.rowsByProduct,
    truePricesByTimestamp,
  );

  window.truePrices = truePricesByTimestamp;

  return {
    sourceName,
    products: activity.products,
    rowsByProduct: activity.rowsByProduct,
    snapshotMap: activity.snapshotMap,
    allTrades,
    truePricesByTimestamp,
  };
}

function parseActivitiesLog(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  const headers = lines[0].split(";");
  const rowsByProduct = new Map();
  const snapshotMap = new Map();

  for (let index = 1; index < lines.length; index += 1) {
    const parts = lines[index].split(";");
    if (!parts.length || parts.length < 3) {
      continue;
    }

    const record = Object.fromEntries(headers.map((header, i) => [header, parts[i] || ""]));
    const product = record.product;
    const bidPrices = [1, 2, 3].map((level) => parseMaybeNumber(record[`bid_price_${level}`]));
    const bidVolumes = [1, 2, 3].map((level) => parseMaybeNumber(record[`bid_volume_${level}`]));
    const askPrices = [1, 2, 3].map((level) => parseMaybeNumber(record[`ask_price_${level}`]));
    const askVolumes = [1, 2, 3].map((level) => parseMaybeNumber(record[`ask_volume_${level}`]));
    const bestBid = bidPrices[0];
    const bestAsk = askPrices[0];
    let midPrice = parseMaybeNumber(record.mid_price);

    if (bestBid !== null && bestAsk !== null) {
      // Prefer reconstructing the touch mid from the live top of book.
      midPrice = (bestBid + bestAsk) / 2;
    } else if (midPrice !== null && midPrice <= 0) {
      // Some logs use 0 as a placeholder when the book is empty.
      midPrice = null;
    }

    const row = {
      product,
      timestamp: Number(record.timestamp),
      bidPrices,
      bidVolumes,
      askPrices,
      askVolumes,
      midPrice,
      wallMid: computeWallMid(bidPrices, bidVolumes, askPrices, askVolumes),
      pnl: parseMaybeNumber(record.profit_and_loss),
    };

    if (!rowsByProduct.has(product)) {
      rowsByProduct.set(product, []);
    }
    rowsByProduct.get(product).push(row);
    snapshotMap.set(makeSnapshotKey(product, row.timestamp), row);
  }

  for (const rows of rowsByProduct.values()) {
    rows.sort((a, b) => a.timestamp - b.timestamp);
  }

  return {
    products: [...rowsByProduct.keys()].sort(),
    rowsByProduct,
    snapshotMap,
  };
}

function parseLogStates(logs) {
  return logs.map((entry) => {
    let lambda = null;

    try {
      lambda = JSON.parse(entry.lambdaLog);
    } catch (error) {
      console.warn("Skipping malformed lambdaLog entry", entry.timestamp, error);
    }

    return {
      timestamp: Number(entry.timestamp),
      state: lambda?.[0] || [],
      orders: lambda?.[1] || [],
      customMetrics: extractCustomMetrics(entry, lambda),
    };
  });
}

function parseOwnTrades(tradeHistory) {
  return tradeHistory
    .map((trade) => {
      const isBuy = trade.buyer === "SUBMISSION";
      const isSell = trade.seller === "SUBMISSION";
      if (!isBuy && !isSell) {
        return null;
      }

      return {
        product: trade.symbol,
        timestamp: Number(trade.timestamp),
        price: Number(trade.price),
        quantity: Number(trade.quantity),
        side: isBuy ? "buy" : "sell",
        group: "ours",
        source: "own",
        buyer: trade.buyer,
        seller: trade.seller,
        label: GROUP_META.ours.label,
      };
    })
    .filter(Boolean);
}

function parseAnonymousMarketTrades(logStates) {
  const seen = new Set();
  const trades = [];

  for (const logState of logStates) {
    const marketTrades = logState.state?.[5] || [];
    for (const trade of marketTrades) {
      const tradeKey = JSON.stringify(trade);
      if (seen.has(tradeKey)) {
        continue;
      }
      seen.add(tradeKey);

      trades.push({
        product: trade[0],
        price: Number(trade[1]),
        quantity: Number(trade[2]),
        buyer: trade[3] || "",
        seller: trade[4] || "",
        timestamp: Number(trade[5]),
        source: "market",
      });
    }
  }

  return trades;
}

function buildMetaTrades(marketTrades, snapshotMap) {
  const grouped = new Map();
  const isolatedMakerTrades = [];

  for (const trade of marketTrades) {
    const snapshot = snapshotMap.get(makeSnapshotKey(trade.product, trade.timestamp));
    const side = inferAnonymousTradeSide(trade, snapshot);
    const insideSpread = isInsideDisplayedSpread(trade.price, snapshot);
    const absQuantity = Math.abs(trade.quantity);

    // Keep passive inside-spread prints out of the aggressive meta-trade bucket.
    if (insideSpread) {
      isolatedMakerTrades.push({
        ...trade,
        side,
        source: "market",
        quantity: absQuantity,
        weightedNotional: trade.price * absQuantity,
        rawTradeCount: 1,
        insideSpread: true,
        bestPrice: trade.price,
        worstPrice: trade.price,
        price: trade.price,
      });
      continue;
    }

    const groupKey = `${trade.product}|${trade.timestamp}|${side}`;

    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        product: trade.product,
        timestamp: trade.timestamp,
        side,
        source: "market",
        quantity: 0,
        weightedNotional: 0,
        bestPrice: trade.price,
        worstPrice: trade.price,
        rawTradeCount: 0,
        insideSpread: false,
      });
    }

    const meta = grouped.get(groupKey);

    meta.quantity += absQuantity;
    meta.weightedNotional += trade.price * absQuantity;
    meta.rawTradeCount += 1;

    if (meta.side === "buy") {
      meta.bestPrice = Math.min(meta.bestPrice, trade.price);
      meta.worstPrice = Math.max(meta.worstPrice, trade.price);
    } else if (meta.side === "sell") {
      meta.bestPrice = Math.max(meta.bestPrice, trade.price);
      meta.worstPrice = Math.min(meta.worstPrice, trade.price);
    } else {
      meta.bestPrice = Math.min(meta.bestPrice, trade.price);
      meta.worstPrice = Math.max(meta.worstPrice, trade.price);
    }
  }

  const aggregatedTrades = [...grouped.values()]
    .map((meta) => ({
      ...meta,
      price: meta.quantity > 0 ? meta.weightedNotional / meta.quantity : meta.bestPrice,
    }))

  return [...isolatedMakerTrades, ...aggregatedTrades]
    .sort((a, b) => a.timestamp - b.timestamp);
}

function classifyTrades(ownTrades, metaTrades, snapshotMap, rowsByProduct, truePricesByTimestamp) {
  const classifiedMetaTrades = metaTrades.map((trade) => {
    const snapshot = snapshotMap.get(makeSnapshotKey(trade.product, trade.timestamp));
    const rowSeries = rowsByProduct.get(trade.product) || [];
    const truePrice = lookupTruePrice(truePricesByTimestamp, trade.product, trade.timestamp);
    const referencePrice = computeReferencePrice(snapshot);
    const futureReferencePrice = computeTrailingReferencePrice(rowSeries, trade.timestamp);
    const currentWallMid = snapshot?.wallMid ?? null;
    const trailingWallMid = computeTrailingWallMid(rowSeries, trade.timestamp);
    const reachedLevel = computeReachedBookLevel(trade, snapshot);
    const aggression = reachedLevel >= 2 ? "high" : "low";
    const signedWallMidShift =
      currentWallMid !== null && trailingWallMid !== null
        ? signedDistance(currentWallMid, trailingWallMid, trade.side)
        : 0;
    const wallMidFlat =
      currentWallMid !== null &&
      trailingWallMid !== null &&
      Math.abs(trailingWallMid - currentWallMid) < EPSILON;
    const movesTowardTruePrice = didMoveTowardTruePrice(
      referencePrice,
      futureReferencePrice,
      truePrice,
    );
    const movesAwayFromTruePrice = didMoveAwayFromTruePrice(
      referencePrice,
      futureReferencePrice,
      truePrice,
    );
    const highImpact =
      movesTowardTruePrice || signedWallMidShift >= WALL_MID_SHIFT_THRESHOLD;

    let group = "noiseTrader";
    if (trade.insideSpread) {
      group = "makerLike";
    } else if (aggression === "high" && highImpact) {
      group = "toxicWhale";
    } else if (aggression === "low" && highImpact) {
      group = "stealthInformed";
    } else if (aggression === "high" && !highImpact) {
      group = "inventoryDumper";
    }

    return {
      ...trade,
      group,
      label: GROUP_META[group].label,
      truePrice,
      referencePrice,
      futureReferencePrice,
      currentWallMid,
      trailingWallMid,
      signedWallMidShift,
      wallMidFlat,
      reachedLevel,
      aggression,
      impact: highImpact ? "high" : "low",
      highImpact,
      movesTowardTruePrice,
      movesAwayFromTruePrice,
    };
  });

  return [...ownTrades, ...classifiedMetaTrades];
}

function extractCustomMetrics(entry, lambda) {
  const candidates = [];

  const returnedTraderData = lambda?.[3];
  if (typeof returnedTraderData === "string" && returnedTraderData.trim()) {
    candidates.push(...extractJsonObjectsFromText(returnedTraderData));
  }

  if (typeof entry.sandboxLog === "string" && entry.sandboxLog.trim()) {
    candidates.push(...extractJsonObjectsFromText(entry.sandboxLog));
  }

  const traderData = lambda?.[0]?.[1];
  if (typeof traderData === "string" && traderData.trim()) {
    candidates.push(...extractJsonObjectsFromText(traderData));
  }

  const customLogs = lambda?.[4];
  if (typeof customLogs === "string" && customLogs.trim()) {
    candidates.push(...extractJsonObjectsFromText(customLogs));
  }

  for (const candidate of candidates) {
    const fairValues = normalizeFairValues(candidate);
    if (fairValues) {
      return fairValues;
    }
  }

  return null;
}

function extractJsonObjectsFromText(text) {
  const results = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return results;
  }

  const wholeObject = tryParseJsonObject(trimmed);
  if (wholeObject) {
    results.push(wholeObject);
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const maybeObject = tryParseJsonObject(line.trim());
    if (maybeObject) {
      results.push(maybeObject);
    }
  }

  return results;
}

function tryParseJsonObject(text) {
  if (!text || !text.startsWith("{") || !text.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeFairValues(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const fairValueSource = TRUE_PRICE_FIELDS
    .map((field) => candidate[field])
    .find((value) => value && typeof value === "object" && !Array.isArray(value));

  if (!fairValueSource) {
    return null;
  }

  const normalized = {};

  for (const [product, rawValue] of Object.entries(fairValueSource)) {
    let parsedValue = parseMaybeNumber(rawValue);

    if (parsedValue === null && rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      parsedValue = parseMaybeNumber(
        rawValue.true_price ??
        rawValue.fair_value ??
        rawValue.fairValue ??
        rawValue.value,
      );
    }

    if (parsedValue !== null) {
      normalized[product] = parsedValue;
    }
  }

  return Object.keys(normalized).length ? normalized : null;
}

function buildTruePriceLookup(logStates) {
  return logStates.reduce((acc, logState) => {
    if (logState.customMetrics) {
      acc[logState.timestamp] = logState.customMetrics;
    }
    return acc;
  }, {});
}

function lookupTruePrice(truePricesByTimestamp, product, timestamp) {
  return parseMaybeNumber(truePricesByTimestamp?.[timestamp]?.[product]);
}

function inferAnonymousTradeSide(trade, snapshot) {
  if (!snapshot) {
    return "unknown";
  }

  const bestBid = snapshot.bidPrices[0];
  const bestAsk = snapshot.askPrices[0];
  const mid = snapshot.midPrice;

  if (bestAsk !== null && trade.price >= bestAsk) {
    return "buy";
  }
  if (bestBid !== null && trade.price <= bestBid) {
    return "sell";
  }
  if (mid !== null && trade.price > mid) {
    return "buy";
  }
  if (mid !== null && trade.price < mid) {
    return "sell";
  }
  return "unknown";
}

function isInsideDisplayedSpread(price, snapshot) {
  if (!snapshot) {
    return false;
  }

  const bestBid = snapshot.bidPrices[0];
  const bestAsk = snapshot.askPrices[0];
  return bestBid !== null && bestAsk !== null && price > bestBid && price < bestAsk;
}

function computeReferencePrice(snapshot) {
  if (!snapshot) {
    return null;
  }
  return snapshot.wallMid ?? snapshot.midPrice ?? null;
}

function computeTrailingReferencePrice(rows, timestamp) {
  const futureRows = getLookaheadRows(rows, timestamp);
  const references = futureRows
    .map((row) => computeReferencePrice(row))
    .filter((value) => value !== null);

  return references.length ? references[references.length - 1] : null;
}

function computeTrailingWallMid(rows, timestamp) {
  const futureRows = getLookaheadRows(rows, timestamp);
  const wallMids = futureRows
    .map((row) => row.wallMid)
    .filter((value) => value !== null);

  return wallMids.length ? median(wallMids) : null;
}

function getLookaheadRows(rows, timestamp) {
  const currentIndex = rows.findIndex((row) => row.timestamp === timestamp);
  if (currentIndex === -1) {
    return [];
  }

  return rows.slice(currentIndex + 1, currentIndex + 1 + WALL_MID_LOOKAHEAD);
}

function didMoveTowardTruePrice(currentPrice, futurePrice, truePrice) {
  if (currentPrice === null || futurePrice === null || truePrice === null) {
    return false;
  }

  return Math.abs(futurePrice - truePrice) + EPSILON < Math.abs(currentPrice - truePrice);
}

function didMoveAwayFromTruePrice(currentPrice, futurePrice, truePrice) {
  if (currentPrice === null || futurePrice === null || truePrice === null) {
    return false;
  }

  return Math.abs(futurePrice - truePrice) > Math.abs(currentPrice - truePrice) + EPSILON;
}

function signedDistance(currentPrice, futurePrice, side) {
  const direction = side === "buy" ? 1 : side === "sell" ? -1 : 0;
  return direction * (futurePrice - currentPrice);
}

function computeReachedBookLevel(metaTrade, snapshot) {
  if (!snapshot) {
    return 0;
  }

  if (metaTrade.side === "buy") {
    const asks = snapshot.askPrices;
    if (asks[2] !== null && metaTrade.worstPrice >= asks[2]) {
      return 3;
    }
    if (asks[1] !== null && metaTrade.worstPrice >= asks[1]) {
      return 2;
    }
    if (asks[0] !== null && metaTrade.worstPrice >= asks[0]) {
      return 1;
    }
    return 0;
  }

  if (metaTrade.side === "sell") {
    const bids = snapshot.bidPrices;
    if (bids[2] !== null && metaTrade.worstPrice <= bids[2]) {
      return 3;
    }
    if (bids[1] !== null && metaTrade.worstPrice <= bids[1]) {
      return 2;
    }
    if (bids[0] !== null && metaTrade.worstPrice <= bids[0]) {
      return 1;
    }
  }

  return 0;
}

function computeWallMid(bidPrices, bidVolumes, askPrices, askVolumes) {
  const heavyBid = firstHeavyLevelPrice(bidPrices, bidVolumes);
  const heavyAsk = firstHeavyLevelPrice(askPrices, askVolumes);

  if (heavyBid === null || heavyAsk === null) {
    return null;
  }

  return (heavyBid + heavyAsk) / 2;
}

function firstHeavyLevelPrice(prices, volumes) {
  for (let level = 0; level < prices.length; level += 1) {
    if (
      prices[level] !== null &&
      volumes[level] !== null &&
      Math.abs(volumes[level]) >= WALL_VOLUME_THRESHOLD
    ) {
      return prices[level];
    }
  }

  return null;
}

function renderToggleControls() {
  dom.groupToggles.innerHTML = "";

  for (const [groupKey, meta] of Object.entries(GROUP_META)) {
    const wrapper = document.createElement("div");
    wrapper.className = "toggle-card";

    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = appState.visibleGroups.has(groupKey);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        appState.visibleGroups.add(groupKey);
      } else {
        appState.visibleGroups.delete(groupKey);
      }
      render();
    });

    const pill = document.createElement("span");
    pill.className = "toggle-pill";

    const preview = document.createElement("span");
    preview.className = "symbol-preview";
    preview.style.background = meta.color;

    const text = document.createElement("span");
    text.textContent = meta.label;

    pill.append(preview, text);
    label.append(checkbox, pill);

    const description = document.createElement("small");
    description.textContent = meta.description;

    wrapper.append(label, description);
    dom.groupToggles.append(wrapper);
  }
}

function populateProductSelect(products) {
  dom.productSelect.innerHTML = "";
  for (const product of products) {
    const option = document.createElement("option");
    option.value = product;
    option.textContent = product;
    dom.productSelect.append(option);
  }
  dom.productSelect.disabled = products.length === 0;
  dom.productSelect.value = appState.activeProduct;
}

function updateStatsAfterLoad(parsed) {
  dom.loadedFileStat.textContent = parsed.sourceName;
  dom.productCountStat.textContent = String(parsed.products.length);
  updateStatus(`Loaded ${parsed.sourceName}`);
}

function updateStatus(message) {
  dom.statusStat.textContent = message;
}

function render() {
  if (!appState.parsed || !appState.activeProduct) {
    return;
  }

  const { rowsByProduct, allTrades, truePricesByTimestamp } = appState.parsed;
  const rows = rowsByProduct.get(appState.activeProduct) || [];
  const filteredTrades = allTrades.filter(
    (trade) =>
      trade.product === appState.activeProduct &&
      appState.visibleGroups.has(trade.group),
  );

  const traces = [];
  if (dom.showDepthToggle.checked) {
    traces.push(...buildDepthTraces(rows));
  }
  if (dom.showMidToggle.checked) {
    traces.push(buildMidTrace(rows));
  }
  if (dom.showFairToggle.checked) {
    const fairValueTrace = buildFairValueTrace(
      rows,
      truePricesByTimestamp,
      appState.activeProduct,
    );
    if (fairValueTrace) {
      traces.push(fairValueTrace);
    }
  }
  traces.push(...buildTradeMarkerTraces(filteredTrades));

  const layout = buildLayout(appState.activeProduct);
  Plotly.react(dom.chart, traces, layout, {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });

  dom.tradeCountStat.textContent = String(filteredTrades.length);
  dom.toggleSummary.textContent = summarizeVisibleGroups(filteredTrades);
  updateStatus(`Rendering ${appState.activeProduct}`);
}

function buildDepthTraces(rows) {
  const traces = [];

  for (let level = 0; level < 3; level += 1) {
    const bidPointCount = rows.reduce(
      (count, row) => count + (row.bidPrices[level] !== null ? 1 : 0),
      0,
    );
    const askPointCount = rows.reduce(
      (count, row) => count + (row.askPrices[level] !== null ? 1 : 0),
      0,
    );

    if (bidPointCount >= MIN_DEPTH_POINTS_TO_RENDER) {
      traces.push({
        x: rows.map((row) => row.timestamp),
        y: rows.map((row) => row.bidPrices[level]),
        type: "scatter",
        mode: "lines",
        name: `Bid ${level + 1}`,
        line: {
          color: DEPTH_COLORS.bid[level],
          width: level === 0 ? 2.2 : 1.4,
          shape: "hv",
        },
        hovertemplate: `Bid ${level + 1}<br>Timestamp %{x}<br>Price %{y}<extra></extra>`,
        connectgaps: false,
      });
    }

    if (askPointCount >= MIN_DEPTH_POINTS_TO_RENDER) {
      traces.push({
        x: rows.map((row) => row.timestamp),
        y: rows.map((row) => row.askPrices[level]),
        type: "scatter",
        mode: "lines",
        name: `Ask ${level + 1}`,
        line: {
          color: DEPTH_COLORS.ask[level],
          width: level === 0 ? 2.2 : 1.4,
          shape: "hv",
        },
        hovertemplate: `Ask ${level + 1}<br>Timestamp %{x}<br>Price %{y}<extra></extra>`,
        connectgaps: false,
      });
    }
  }

  return traces;
}

function buildMidTrace(rows) {
  return {
    x: rows.map((row) => row.timestamp),
    y: rows.map((row) => row.midPrice),
    type: "scatter",
    mode: "lines",
    name: "Mid Price",
    line: {
      color: DEPTH_COLORS.mid,
      width: 1.6,
      dash: "dot",
    },
    hovertemplate: "Mid Price<br>Timestamp %{x}<br>Price %{y}<extra></extra>",
    connectgaps: false,
  };
}

function buildFairValueTrace(rows, truePricesByTimestamp, product) {
  const fairValues = rows.map((row) =>
    lookupTruePrice(truePricesByTimestamp, product, row.timestamp),
  );
  const visibleCount = fairValues.reduce(
    (count, value) => count + (value !== null ? 1 : 0),
    0,
  );

  if (visibleCount === 0) {
    return null;
  }

  return {
    x: rows.map((row) => row.timestamp),
    y: fairValues,
    type: "scatter",
    mode: "lines",
    name: "Fair Value",
    line: {
      color: DEPTH_COLORS.fair,
      width: 2.4,
      dash: "dash",
    },
    hovertemplate: "Fair Value<br>Timestamp %{x}<br>Price %{y:.2f}<extra></extra>",
    connectgaps: false,
  };
}

function buildTradeMarkerTraces(trades) {
  const traces = [];
  const grouped = new Map();

  for (const trade of trades) {
    const traceKey = `${trade.group}|${trade.side}`;
    if (!grouped.has(traceKey)) {
      grouped.set(traceKey, []);
    }
    grouped.get(traceKey).push(trade);
  }

  for (const [traceKey, traceTrades] of grouped.entries()) {
    const [group, side] = traceKey.split("|");
    const meta = GROUP_META[group];
    const symbol = markerSymbolFor(group, side);

    traces.push({
      x: traceTrades.map((trade) => trade.timestamp),
      y: traceTrades.map((trade) => trade.price),
      text: traceTrades.map((trade) => buildTradeHoverText(trade)),
      type: "scatter",
      mode: "markers",
      name: `${meta.label}${side && side !== "unknown" ? ` (${side})` : ""}`,
      marker: {
        symbol,
        size: markerSizeForGroup(group),
        color: meta.color,
        line: {
          width: 1,
          color: "#0f141c",
        },
        opacity: 0.92,
      },
      hovertemplate: "%{text}<extra></extra>",
    });
  }

  return traces;
}

function buildTradeHoverText(trade) {
  const lines = [
    `<strong>${GROUP_META[trade.group].label}</strong>`,
    `Product: ${trade.product}`,
    `Timestamp: ${trade.timestamp}`,
    `Side: ${trade.side || "unknown"}`,
    `Price: ${formatMaybeNumber(trade.price)}`,
    `Quantity: ${trade.quantity}`,
  ];

  if (trade.source === "market") {
    lines.push(
      `Meta-trade count: ${trade.rawTradeCount}`,
      `Execution range: ${formatMaybeRange(trade.bestPrice, trade.worstPrice)}`,
      `Aggression: ${capitalize(trade.aggression)}${trade.reachedLevel ? ` (L${trade.reachedLevel})` : ""}`,
      `Impact: ${capitalize(trade.impact)}`,
      `True Price: ${formatMaybeNumber(trade.truePrice)}`,
      `Market Ref: ${formatMaybeNumber(trade.referencePrice)}`,
      `Future Ref: ${formatMaybeNumber(trade.futureReferencePrice)}`,
      `Wall Mid: ${formatMaybeNumber(trade.currentWallMid)}`,
      `Future Wall Mid: ${formatMaybeNumber(trade.trailingWallMid)}`,
      `Signed Wall Shift: ${formatMaybeNumber(trade.signedWallMidShift)}`,
      `Toward True Price: ${trade.movesTowardTruePrice ? "yes" : "no"}`,
      `Away From True Price: ${trade.movesAwayFromTruePrice ? "yes" : "no"}`,
    );
  }

  return lines.join("<br>");
}

function summarizeVisibleGroups(trades) {
  if (!trades.length) {
    return "No trades visible for current filters.";
  }

  const counts = trades.reduce((acc, trade) => {
    acc[trade.group] = (acc[trade.group] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([group, count]) => `${GROUP_META[group].label}: ${count}`)
    .join(" | ");
}

function buildLayout(title) {
  return {
    title: {
      text: title,
      x: 0.02,
      xanchor: "left",
      font: {
        color: "#edf2f7",
        size: 20,
      },
    },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "#0f141c",
    margin: { l: 70, r: 24, t: 64, b: 60 },
    hovermode: "closest",
    legend: {
      orientation: "h",
      yanchor: "bottom",
      y: 1.02,
      xanchor: "left",
      x: 0,
      font: { color: "#cbd5e1" },
    },
    xaxis: {
      title: "Timestamp",
      gridcolor: "rgba(148, 163, 184, 0.12)",
      zerolinecolor: "rgba(148, 163, 184, 0.15)",
      color: "#cbd5e1",
    },
    yaxis: {
      title: "Price",
      gridcolor: "rgba(148, 163, 184, 0.12)",
      zerolinecolor: "rgba(148, 163, 184, 0.15)",
      color: "#cbd5e1",
      tickformat: ",",
    },
  };
}

function markerSymbolFor(group, side) {
  if (group === "ours") {
    return side === "sell" ? "x-open" : "x";
  }
  if (group === "makerLike") {
    return side === "sell" ? "square-open" : "square";
  }
  if (group === "toxicWhale") {
    return side === "sell" ? "diamond-open" : "diamond";
  }
  if (group === "stealthInformed") {
    return side === "sell" ? "cross-open" : "cross";
  }
  if (group === "inventoryDumper") {
    return side === "sell" ? "triangle-down-open" : "triangle-up-open";
  }
  return side === "sell" ? "circle-open" : "circle";
}

function markerSizeForGroup(group) {
  if (group === "toxicWhale") {
    return 13;
  }
  if (group === "inventoryDumper") {
    return 12;
  }
  if (group === "ours" || group === "stealthInformed") {
    return 11;
  }
  return 10;
}

function makeSnapshotKey(product, timestamp) {
  return `${product}|${timestamp}`;
}

function parseMaybeNumber(value) {
  if (value === "" || value === undefined || value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function capitalize(value) {
  if (!value) {
    return "n/a";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatMaybeNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toFixed(2);
}

function formatMaybeRange(bestPrice, worstPrice) {
  if (bestPrice === null || bestPrice === undefined || worstPrice === null || worstPrice === undefined) {
    return "n/a";
  }
  if (Math.abs(bestPrice - worstPrice) < EPSILON) {
    return formatMaybeNumber(bestPrice);
  }
  return `${formatMaybeNumber(bestPrice)} -> ${formatMaybeNumber(worstPrice)}`;
}
