// 從 Notion「❤️❤️基金」抓收支與持股，算好後用密碼加密成 data.enc.json。
// 交易頁面內文裡的圖片也會下載、壓縮、加密成 img/*.enc，登入後才看得到。
// 需要環境變數：NOTION_TOKEN、BANK_PASSWORD。Node 20+；有裝 sharp 才會壓縮圖片（沒裝就原檔加密）。
import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";

const DS = {
  income:  "1e68718e-66c1-817e-bf85-000b90872144",
  expense: "1e68718e-66c1-81b7-81d0-000b62860e67",
  stocks:  "32b8718e-66c1-8038-8ebb-000beee610f8",
  perks:   "64325c42-b28e-4247-89c9-542c33350347", // 🎁 權益清單
  anniv:   "7edd66d2-8aa9-4d39-b81f-638339995a49", // 💞 紀念日
};
const TEMPLATE_ROWS = new Set(["Acme Inc. Salary", "Emca Inc. Salary", "Dividents"]);
const OUT = new URL("../data.enc.json", import.meta.url);
const IMG_DIR = new URL("../img/", import.meta.url);
const MAX_IMGS_PER_TXN = 6;
const CARD_PAGE = "3f58718e-66c1-8156-9f94-eef280927351";  // Notion「💳 卡片背景」：第一張是首頁信用卡的背景
const PHOTO_PAGE = "3f38718e-66c1-813c-8485-fbe4bded33c3"; // Notion「📷 網銀照片」：第一張是開卡畫面的合照

const { NOTION_TOKEN, BANK_PASSWORD } = process.env;
if (!NOTION_TOKEN || !BANK_PASSWORD) throw new Error("缺少 NOTION_TOKEN 或 BANK_PASSWORD");
const NOTION_HEADERS = { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };

async function queryAll(dsId) {
  const rows = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${dsId}/query`, {
      method: "POST", headers: NOTION_HEADERS,
      body: JSON.stringify({ page_size: 100, ...(cursor && { start_cursor: cursor }) }),
    });
    if (!res.ok) throw new Error(`Notion ${dsId} ${res.status}: ${await res.text()}`);
    const j = await res.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return rows;
}

// 頁面內文第一層的圖片區塊（不含收合區塊、欄位裡的）
async function pageImages(pageId) {
  const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers: NOTION_HEADERS });
  if (!res.ok) return [];
  const j = await res.json();
  return j.results.filter(b => b.type === "image").slice(0, MAX_IMGS_PER_TXN).map(b => ({
    id: b.id, edited: b.last_edited_time,
    url: b.image.type === "file" ? b.image.file.url : b.image.external?.url,
  })).filter(b => b.url);
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
  .filter(({ properties: p }) => num(p.Amount) != null && !TEMPLATE_ROWS.has(text(p.Source)))
  .map(({ id, properties: p }) => ({ id, date: date(p.Date), title: text(p.Source), tag: tag(p.Tags), amount: num(p.Amount) }));
const expense = expenseRaw
  .filter(({ properties: p }) => num(p.Amount) != null)
  .map(({ id, properties: p }) => ({ id, date: date(p["日期"], p.Date), title: text(p.Source), tag: tag(p.Tags), amount: -num(p.Amount) }));

const sum = a => a.reduce((s, t) => s + t.amount, 0);
const cash = { income: sum(income), expense: -sum(expense) };
cash.balance = cash.income - cash.expense;

const stocks = stockRaw
  .map(({ properties: p }) => {
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

// 愛情小屋：支出裡「房貸」分類的累計與本月（台灣時間）
const thisYm = `${tw.getUTCFullYear()}-${String(tw.getUTCMonth() + 1).padStart(2, "0")}`;
const mortgageRows = expense.filter(t => t.tag === "房貸");
const mortgage = {
  paid: -sum(mortgageRows),
  thisMonth: -sum(mortgageRows.filter(t => t.date?.startsWith(thisYm))),
  monthLabel: thisYm.replace("-", "/"),
  count: mortgageRows.length,
  last: mortgageRows.map(t => t.date).filter(Boolean).sort().at(-1) ?? null,
};

const recent = [...income, ...expense].filter(t => t.date)
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
// 「開帳」是一次性的期初資金，算月平均收入時要扣掉（跟記帳網站同一套規則）
for (const t of income) {
  if (!t.date || t.title !== "開帳") continue;
  const m = byMonth[t.date.slice(0, 7)], k = t.tag || "未分類";
  m.opening = (m.opening ?? 0) + t.amount;
  (m.openingByTag ??= {})[k] = (m.openingByTag[k] ?? 0) + t.amount;
}

// ===== 加密金鑰：PBKDF2(SHA-256, 250k) → AES-GCM。salt 沿用舊檔，讓手機記住的金鑰持續有效 =====
const { subtle } = globalThis.crypto;
const b64 = u8 => Buffer.from(u8).toString("base64");
let prevEnc = null;
try { prevEnc = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const salt = prevEnc ? Buffer.from(prevEnc.salt, "base64") : crypto.getRandomValues(new Uint8Array(16));
const base = await subtle.importKey("raw", new TextEncoder().encode(BANK_PASSWORD), "PBKDF2", false, ["deriveKey"]);
const key = await subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const encrypt = async bytes => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes)) };
};

// 上一版的圖片清單（在加密資料裡）：密碼沒換就沿用，避免每天重新上傳同一張圖
let prevImages = {};
if (prevEnc) {
  try {
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(prevEnc.iv, "base64") }, key, Buffer.from(prevEnc.ct, "base64"));
    prevImages = JSON.parse(new TextDecoder().decode(pt)).imageIndex ?? {};
  } catch {} // 密碼換了 → 解不開 → 全部重新加密
}

let sharp = null, heicConvert = null;
try { sharp = (await import("sharp")).default; } catch {}
try { heicConvert = (await import("heic-convert")).default; } catch {}
// iPhone 的 HEIC/HEIF 瀏覽器看不懂（sharp 預設也讀不了），先轉成 JPEG
const isHeic = buf => /^ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(buf.subarray(4, 12).toString("latin1"));
async function shrink(buf) {
  if (isHeic(buf) && heicConvert) {
    try { buf = Buffer.from(await heicConvert({ buffer: buf, format: "JPEG", quality: 0.85 })); } catch {}
  }
  if (!sharp) return buf;
  try { return await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); }
  catch { return buf; }
}

// ===== 交易圖片：只處理畫面上看得到的最近 30 筆 =====
await mkdir(IMG_DIR, { recursive: true });
const imageIndex = {};   // `${blockId}@${edited}` → 檔名（存在加密資料裡，公開 repo 看不出對應哪筆）
let imgCount = 0;
async function encryptImages(pageId, withId = false) {
  const files = [];
  for (const b of await pageImages(pageId)) {
    const k = `${b.id}@${b.edited}@v2`; // v2：加入 HEIC 轉檔，舊的圖片全部重新處理一次
    let name = prevImages[k];
    if (!name) {
      const res = await fetch(b.url);
      if (!res.ok) continue;
      const { iv, ct } = await encrypt(await shrink(Buffer.from(await res.arrayBuffer())));
      name = `${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}.enc`;
      await writeFile(new URL(name, IMG_DIR), Buffer.concat([Buffer.from(iv), Buffer.from(ct)]));
    }
    imageIndex[k] = name;
    files.push(withId ? { id: b.id, img: `img/${name}` } : `img/${name}`);
    imgCount++;
  }
  return files;
}
for (const t of recent) {
  const files = await encryptImages(t.id);
  if (files.length) t.imgs = files;
}
const photos = await encryptImages(PHOTO_PAGE);
const cardImgs = await encryptImages(CARD_PAGE, true);   // 卡片背景可以放好幾張，網銀裡點卡片挑
const cardImg = cardImgs[0]?.img ?? null;

// 權益清單：上架的才放進網銀，每個權益頁面裡的第一張圖是卡牌插圖
const perks = [];
for (const { id, properties: p } of (await queryAll(DS.perks))
  .filter(r => r.properties["上架"]?.checkbox && text(r.properties["名稱"]) && num(r.properties["點數"]) > 0)
  .sort((a, b) => (num(a.properties["排序"]) ?? 999) - (num(b.properties["排序"]) ?? 999))) {
  perks.push({
    id, title: text(p["名稱"]), cost: num(p["點數"]), em: text(p["圖示"]) || "🎁", desc: text(p["說明"]),
    img: (await encryptImages(id))[0] ?? null,
  });
}
// 不再使用的圖片刪掉
const keep = new Set(Object.values(imageIndex));
for (const f of await readdir(IMG_DIR)) if (f.endsWith(".enc") && !keep.has(f)) await unlink(new URL(f, IMG_DIR));

// 紀念日：首頁「在一起第幾天」與倒數
const anniversaries = (await queryAll(DS.anniv)).map(({ properties: p }) => ({
  title: text(p["名稱"]), date: date(p["日期"]), em: text(p["圖示"]),
  together: !!p["在一起"]?.checkbox, yearly: !!p["每年"]?.checkbox,
})).filter(a => a.title && a.date);

const txns = recent.map(({ id, ...t }) => t);
const data = {
  updatedAt: new Date().toISOString(), fundName: "❤️❤️基金",
  cash, month, stocks, stockValue, total: cash.balance + stockValue, txns,
  stats: { byMonth }, imageIndex, photos, cardImg, cardImgs, perks, mortgage, anniversaries,
};

const { iv, ct } = await encrypt(new TextEncoder().encode(JSON.stringify(data)));
await writeFile(OUT, JSON.stringify({ v: 1, iter: 250000, salt: b64(salt), iv: b64(iv), ct: b64(ct) }) + "\n");

// repo 是公開的，執行紀錄任何人都看得到：只印筆數，絕不印金額
console.log(`同步完成：${income.length + expense.length} 筆收支、${stocks.length} 檔股票、${imgCount} 張圖片${sharp ? "" : "（未壓縮）"}`);
