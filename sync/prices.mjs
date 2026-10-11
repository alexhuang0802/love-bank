// 股票資產自動更新：每次同步先抓最新收盤價寫回 Notion「股價」，美股順便更新「匯率」
// 台股：證交所 OpenAPI（股票名稱填代號或中文名都可以，例如 0050、川湖）
// 美股：Yahoo Finance；匯率：台灣銀行即期買入，抓不到就用 Yahoo 的 USD/TWD
const UA = { "User-Agent": "Mozilla/5.0 (love-bank sync)" };

async function twsePrices() {
  const r = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", { headers: UA });
  if (!r.ok) throw new Error(`TWSE ${r.status}`);
  const m = new Map();
  for (const x of await r.json()) {
    const p = Number(x.ClosingPrice);
    if (p > 0) { m.set(x.Code, p); m.set(x.Name, p); }
  }
  return m;
}
async function yahooPrice(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, { headers: UA });
  if (!r.ok) throw new Error(`Yahoo ${symbol} ${r.status}`);
  const p = (await r.json()).chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!(p > 0)) throw new Error(`Yahoo ${symbol} 沒有價格`);
  return p;
}
async function usdRate() {
  try {   // 台銀 CSV：USD,本行買入,現金,即期,...
    const r = await fetch("https://rate.bot.com.tw/xrt/flcsv/0/day", { headers: UA });
    const row = (await r.text()).split("\n").find(l => l.startsWith("USD"));
    const spot = Number(row?.split(",")[3]);
    if (spot > 20 && spot < 50) return { rate: spot, src: "台銀即期買入" };
  } catch {}
  return { rate: await yahooPrice("TWD=X"), src: "Yahoo" };
}

export async function updatePrices(rows, headers) {
  const txt = p => (p?.title ?? []).map(t => t.plain_text).join("").trim();
  const stocks = rows.map(r => ({ id: r.id, name: txt(r.properties["股票名稱"]), market: (r.properties["市場"]?.rich_text ?? []).map(t => t.plain_text).join("") }))
    .filter(s => s.name);
  let tw = null, fx = null, updated = 0;
  for (const s of stocks) {
    try {
      const props = {};
      if (s.market.includes("美")) {
        props["股價"] = { number: await yahooPrice(s.name) };
        fx ??= await usdRate();
        props["匯率"] = { number: fx.rate };
      } else {
        tw ??= await twsePrices();
        const p = tw.get(s.name);
        if (!p) { console.log(`找不到台股價格：${s.name}`); continue; }
        props["股價"] = { number: p };
      }
      const r = await fetch(`https://api.notion.com/v1/pages/${s.id}`, { method: "PATCH", headers, body: JSON.stringify({ properties: props }) });
      if (r.ok) updated++; else console.log(`更新失敗：${s.name} ${r.status}`);
    } catch (e) { console.log(`抓價失敗：${s.name}（${e.message}）`); }
  }
  console.log(`股價更新：${updated}/${stocks.length} 檔${fx ? `，匯率來源 ${fx.src}` : ""}`);
}
