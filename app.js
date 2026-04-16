const GROUP_META = {
  ours: {
    label: "OURS",
    description: "Exact fills by SUBMISSION.",
    color: "#facc15",
    defaultEnabled: true,
  },
  makerLike: {
    label: "MAKER-LIKE",
    description: "Anonymous trades executed inside the displayed spread.",
    color: "#a78bfa",
    defaultEnabled: true,
  },
  smallTaker: {
    label: "SMALL TAKER",
    description: "Marketable anonymous trades below the product big-size cutoff.",
    color: "#fb923c",
    defaultEnabled: true,
  },
  bigTaker: {
    label: "BIG TAKER",
    description: "Marketable anonymous trades at or above the product big-size cutoff.",
    color: "#ff6b6b",
    defaultEnabled: true,
  },
  informedLike: {
    label: "INFORMED-LIKE",
    description: "Anonymous trades followed by same-direction price continuation.",
    color: "#34d399",
    defaultEnabled: true,
  },
  otherMarket: {
    label: "OTHER MARKET",
    description: "Anonymous trades not strongly matched by current rules.",
    color: "#e5e7eb",
    defaultEnabled: false,
  },
};

const DEPTH_COLORS = {
  bid: ["#60a5fa", "#3b82f6", "#1d4ed8"],
  ask: ["#fda4af", "#fb7185", "#e11d48"],
  mid: "#cbd5e1",
};

const MIN_DEPTH_POINTS_TO_RENDER = 25;

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
  showDepthToggle: document.getElementById("show-depth-toggle"),
  groupToggles: document.getElementById("group-toggles"),
  toggleSummary: document.getElementById("toggle-summary"),
  loadedFileStat: document.getElementById("loaded-file-stat"),
  productCountStat: document.getElementById("product-count-stat"),
  tradeCountStat: document.getElementById("trade-count-stat"),
  statusStat: document.getElementById("status-stat"),
  chart: document.getElementById("chart"),
};

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
  const ownTrades = parseOwnTrades(payload.tradeHistory || []);
  const marketTrades = parseAnonymousMarketTrades(logStates);
  const allTrades = classifyTrades(
    ownTrades,
    marketTrades,
    activity.snapshotMap,
    activity.rowsByProduct,
  );

  return {
    sourceName,
    products: activity.products,
    rowsByProduct: activity.rowsByProduct,
    snapshotMap: activity.snapshotMap,
    allTrades,
    thresholdsByProduct: Object.fromEntries(
      activity.products.map((product) => {
        const thresholdTrade = allTrades.find(
          (trade) => trade.product === product && trade.source === "market" && trade.bigThreshold,
        );
        return [product, thresholdTrade?.bigThreshold || null];
      }),
    ),
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
    const askPrices = [1, 2, 3].map((level) => parseMaybeNumber(record[`ask_price_${level}`]));
    const bestBid = bidPrices[0];
    const bestAsk = askPrices[0];
    let midPrice = parseMaybeNumber(record.mid_price);

    if (bestBid !== null && bestAsk !== null) {
      // Prefer reconstructing the mid from the top of book when both sides are present.
      midPrice = (bestBid + bestAsk) / 2;
    } else if (midPrice !== null && midPrice <= 0) {
      // Some log rows use 0 as a placeholder when the book is empty.
      midPrice = null;
    }

    const row = {
      product,
      timestamp: Number(record.timestamp),
      bidPrices,
      askPrices,
      midPrice,
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
    try {
      const lambda = JSON.parse(entry.lambdaLog);
      return {
        timestamp: entry.timestamp,
        state: lambda[0] || [],
        orders: lambda[1] || [],
      };
    } catch (error) {
      console.warn("Skipping malformed lambdaLog entry", entry.timestamp, error);
      return null;
    }
  }).filter(Boolean);
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

function classifyTrades(ownTrades, marketTrades, snapshotMap, rowsByProduct) {
  const sizesByProduct = groupSizesByProduct(marketTrades);
  const bigThresholdByProduct = Object.fromEntries(
    Object.entries(sizesByProduct).map(([product, sizes]) => [
      product,
      Math.max(4, Math.round(percentile(sizes, 0.75))),
    ]),
  );

  const classifiedMarketTrades = marketTrades.map((trade) => {
    const snapshot = snapshotMap.get(makeSnapshotKey(trade.product, trade.timestamp));
    const rowSeries = rowsByProduct.get(trade.product) || [];
    const side = inferAnonymousTradeSide(trade, snapshot);
    const spread = computeSpread(snapshot);
    const insideSpread = isInsideDisplayedSpread(trade.price, snapshot);
    const marketable = isMarketableTrade(trade.price, snapshot);
    const futureImpact = computeFutureImpact(rowSeries, trade.timestamp, side);
    const bigThreshold = bigThresholdByProduct[trade.product] || 4;

    let group = "otherMarket";
    if (insideSpread) {
      group = "makerLike";
    } else if (marketable && futureImpact > Math.max(2, spread * 0.2 || 0)) {
      group = "informedLike";
    } else if (marketable && trade.quantity >= bigThreshold) {
      group = "bigTaker";
    } else if (marketable) {
      group = "smallTaker";
    }

    return {
      ...trade,
      side,
      spread,
      insideSpread,
      marketable,
      futureImpact,
      group,
      label: GROUP_META[group].label,
      bigThreshold,
    };
  });

  return [...ownTrades, ...classifiedMarketTrades];
}

function groupSizesByProduct(marketTrades) {
  return marketTrades.reduce((acc, trade) => {
    if (!acc[trade.product]) {
      acc[trade.product] = [];
    }
    acc[trade.product].push(Math.abs(trade.quantity));
    return acc;
  }, {});
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

function computeFutureImpact(rows, timestamp, side) {
  const currentIndex = rows.findIndex((row) => row.timestamp === timestamp);
  if (currentIndex === -1) {
    return 0;
  }

  const currentMid = rows[currentIndex].midPrice;
  if (currentMid === null) {
    return 0;
  }

  const lookahead = rows[Math.min(rows.length - 1, currentIndex + 5)];
  const futureMid = lookahead?.midPrice;
  if (futureMid === null || futureMid === undefined) {
    return 0;
  }

  const direction = side === "buy" ? 1 : side === "sell" ? -1 : 0;
  return direction * (futureMid - currentMid);
}

function isInsideDisplayedSpread(price, snapshot) {
  if (!snapshot) {
    return false;
  }

  const bestBid = snapshot.bidPrices[0];
  const bestAsk = snapshot.askPrices[0];
  return bestBid !== null && bestAsk !== null && price > bestBid && price < bestAsk;
}

function isMarketableTrade(price, snapshot) {
  if (!snapshot) {
    return false;
  }
  const bestBid = snapshot.bidPrices[0];
  const bestAsk = snapshot.askPrices[0];
  return (
    (bestAsk !== null && price >= bestAsk) ||
    (bestBid !== null && price <= bestBid)
  );
}

function computeSpread(snapshot) {
  if (!snapshot) {
    return 0;
  }
  const bestBid = snapshot.bidPrices[0];
  const bestAsk = snapshot.askPrices[0];
  if (bestBid === null || bestAsk === null) {
    return 0;
  }
  return bestAsk - bestBid;
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

  const { rowsByProduct, allTrades } = appState.parsed;
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
  const side = trade.side || "unknown";
  const extra =
    trade.source === "market"
      ? `<br>Future impact: ${formatMaybeNumber(trade.futureImpact)}`
      : "";
  return [
    `<strong>${GROUP_META[trade.group].label}</strong>`,
    `Product: ${trade.product}`,
    `Timestamp: ${trade.timestamp}`,
    `Side: ${side}`,
    `Price: ${trade.price}`,
    `Quantity: ${trade.quantity}`,
    extra,
  ].join("<br>");
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
  if (group === "smallTaker") {
    return side === "sell" ? "triangle-down" : "triangle-up";
  }
  if (group === "bigTaker") {
    return side === "sell" ? "triangle-down-open" : "triangle-up-open";
  }
  if (group === "informedLike") {
    return side === "sell" ? "diamond-open" : "diamond";
  }
  return side === "sell" ? "circle-open" : "circle";
}

function markerSizeForGroup(group) {
  if (group === "bigTaker" || group === "informedLike") {
    return 12;
  }
  if (group === "ours") {
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

function percentile(values, q) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function formatMaybeNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toFixed(2);
}
