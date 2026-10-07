// 從 Notion「❤️❤️基金」抓收支與持股，算好後用密碼加密成 data.enc.json。
// 需要環境變數：NOTION_TOKEN、BANK_PASSWORD。Node 20+，不需要安裝任何套件。
import { readFile, writeFile } from "node:fs/promises";

const DS = {
  income:  "1e68718e-66c1-817e-bf85-000b90872144",
  expense: "1e68718e-66c1-81b7-81d0-000b62860e67",
  stocks:  "32b8718e-66c1-8038-8ebb-000beee610f8",
};
const TEMPLATE_ROWS = new Set(["Acme Inc. Salary", "Emca Inc. Salary", "Dividents"]);
const OUT = new URL("../data.enc.json", import.meta.url);

const { NOTION_TOKEN, BANK_PASSWORD } = process.env;
if (!NOTION_TOKEN || !BANK_PASSWORD) throw new Error("缺少 NOTION_TOKEN 或 BANK_PASSWORD");

async function queryAll(dsId) {
  const rows = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, ...(cursor && { start_cursor: cursor }) }),
    });
    if (!res.ok) throw new Error(`Notion ${dsId} ${res.status}: ${await res.text()}`);
    const j = await res.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return rows.map(r => r.properties);
}

// Notion property → 純值
const text = p => (p?.title ?? p?.rich_text ?? []).map(t => t.plain_text).join("").trim();
const num = p => p?.type === "number" ? p.number
  : p?.type === "rollup" ? (p.rollup.number ?? null)
  : p?.type === "formula" ? (p.formula.number ?? null) : null;
const date = (...ps) => ps.map(p => p?.date?.start).find(Boolean)?.slice(0, 10) ?? null;
const tag = p => p?.select?.name ?? "";

const [incomeRaw, expenseRaw, stockRaw] = await Promise.all([queryAll(DS.income), queryAll(DS.expense), queryAll(DS.stocks)]);

const income = incomeRaw
  .filter(p => num(p.Amount) != null && !TEMPLATE_ROWS.has(text(p.Source)))
  .map(p => ({ date: date(p.Date), title: text(p.Source), tag: tag(p.Tags), amount: num(p.Amount) }));
const expense = expenseRaw
  .filter(p => num(p.Amount) != null)
  .map(p => ({ date: date(p["日期"], p.Date), title: text(p.Source), tag: tag(p.Tags), amount: -num(p.Amount) }));

const sum = a => a.reduce((s, t) => s + t.amount, 0);
const cash = { income: sum(income), expense: -sum(expense) };
cash.balance = cash.income - cash.expense;

const stocks = stockRaw
  .map(p => {
    const shares = num(p["持有股數"]) ?? 0, price = num(p["股價"]) ?? 0, fx = num(p["匯率"]) || 1;
    return { name: text(p["股票名稱"]), market: text(p["市場"]), shares, price, fx,
      value: Math.round(shares * price * fx), cost: Math.round(num(p["💸 總成本"]) ?? 0) };
  })
  .filter(s => s.name && s.shares > 0)
  .sort((a, b) => b.value - a.value);
const stockValue = stocks.reduce((s, x) => s + x.value, 0);

// 上一個完整月份
const tw = new Date(Date.now() + 8 * 3600e3);
const prev = new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth() - 1, 1));
const ym = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
const inMonth = a => a.filter(t => t.date?.startsWith(ym));
const month = { label: ym.replace("-", "/"), income: sum(inMonth(income)), expense: -sum(inMonth(expense)) };

const txns = [...income, ...expense].filter(t => t.date)
  .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);

// 分類統計：每月 × 每個分類的金額（正數），給「收支分析」頁用
const byMonth = {};
for (const [kind, rows] of [["income", income], ["expense", expense]]) {
  for (const t of rows) {
    if (!t.date) continue;
    const m = (byMonth[t.date.slice(0, 7)] ??= { income: {}, expense: {} })[kind];
    const k = t.tag || "未分類";
    m[k] = (m[k] ?? 0) + Math.abs(t.amount);
  }
}

const data = {
  updatedAt: new Date().toISOString(), fundName: "❤️❤️基金",
  cash, month, stocks, stockValue, total: cash.balance + stockValue, txns,
  stats: { byMonth },
};

// 加密：PBKDF2(SHA-256, 250k) → AES-GCM。salt 沿用舊檔，讓手機記住的金鑰持續有效。
const { subtle } = globalThis.crypto;
const b64 = u8 => Buffer.from(u8).toString("base64");
let salt;
try { salt = Buffer.from(JSON.parse(await readFile(OUT, "utf8")).salt, "base64"); } catch { salt = crypto.getRandomValues(new Uint8Array(16)); }
const base = await subtle.importKey("raw", new TextEncoder().encode(BANK_PASSWORD), "PBKDF2", false, ["deriveKey"]);
const key = await subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))));
await writeFile(OUT, JSON.stringify({ v: 1, iter: 250000, salt: b64(salt), iv: b64(iv), ct: b64(ct) }) + "\n");

console.log(`總資產 ${data.total.toLocaleString()}｜現金 ${cash.balance.toLocaleString()}｜股票 ${stockValue.toLocaleString()}｜${txns.length} 筆明細`);
