// api/points.js - 寵愛銀行的雲端 API（Vercel Serverless Function）
// 抽卡遊戲：每 12 小時抽一次（+10 點），抽到的卡收進手牌，發動不用點數；點數拿來買道具。
// 資料都在 Notion：💝 寵愛點數（點數帳本）、🃏 手牌（抽到的卡）、🎁 權益清單（卡池）。
// 抽卡結果一律在伺服器決定，手機重新整理也無法重抽。
// 驗證：網頁登入後持有的 AES 金鑰 → SHA-256 → base64 當作 proof；
//       伺服器用 BANK_PASSWORD + data.enc.json 的 salt 算出同一把金鑰比對，不必傳密碼。
// 行員後台（撥點數、核銷）另外要 ADMIN_PIN，只存在 Vercel，不放網頁原始碼。
// 需要環境變數：NOTION_TOKEN、BANK_PASSWORD、ADMIN_PIN
import { pbkdf2Sync, createHash, timingSafeEqual, randomInt } from 'node:crypto';

const POINTS_DS = 'd7643339-684a-4255-ac0c-7e4a74ac1c95'; // 💝 寵愛點數
const HAND_DS = '33cf3ef4-6c02-4a23-aead-e5dbbef56939';   // 🃏 手牌
const PERKS_DS = '64325c42-b28e-4247-89c9-542c33350347';  // 🎁 權益清單
const CONFIG_DS = '1feb12cc-2ff5-4581-b607-0787c03c530c'; // ⚙️ 抽卡設定（一般機率、新手禮包機率）
const LINES_DS = '142db67e-d0ef-4ee6-98ec-591302f1e93f';  // 💌 情話
const SUBS_DS = 'b9a2dc0a-9b90-407a-ba4f-fc1ace495f5f';   // 🔔 通知訂閱
const HOUSE_PAGE = '3f48718e-66c1-81a2-99d9-f5ba73555415'; // Notion「🏠 愛情小屋」的「我們的家」那一列
const HOUSE_FIELDS = { price: '房子總價', down: '頭期款', years: '貸款年數', monthly: '每月還款', rate: '房貸利率' };
const OPENING_BONUS = 0;      // 開戶時沒有點數，開新手禮包才送 STARTER_POINTS
const SITE = 'https://alexhuang0802.github.io';
const NOTION = { 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' };

// ===== 遊戲規則 =====
const DRAW_COOLDOWN = 12 * 3600e3, DRAW_REWARD = 10, MAX_COPIES = 3;
const STARTER_DRAWS = 6, STARTER_MIN_CARDS = 2, STARTER_POINTS = 1314;   // 開戶新手禮包：免費 6 抽，至少 2 張權益卡，送 1,314 點
// 機率與保底以 Notion「⚙️ 抽卡設定」為準；讀不到時用這組預設
const DEFAULT_ODDS = { miss: 50, 普通: 28, 稀有: 14, 傳說: 5, 指定: 3 };       // %
const DEFAULT_STARTER_ODDS = { miss: 80, 普通: 15, 稀有: 5, 傳說: 0, 指定: 0 };  // 新手禮包裡隨機那幾抽
const DEFAULT_BLANK_EVERY = 100;   // 每累積 N 次一般抽卡，多送一張空白卡（新手禮包不算）
let CFG = { odds: DEFAULT_ODDS, starterOdds: DEFAULT_STARTER_ODDS, lines: null, blankEvery: DEFAULT_BLANK_EVERY };
const RARITY = { 普通: { pts: 20, days: 90 }, 稀有: { pts: 60, days: 90 }, 傳說: { pts: 200, days: 180 }, 指定: { pts: 300, days: 180 } };
const SHOP = { boost: { title: '傳說機率提升券', price: 300, rarity: '道具' }, wild: { title: '指定卡', price: 1000, rarity: '指定' } };
const BIRTHDAY = '04-08';      // 小嘟嘟生日
const LOVE_LINES = [
  '今天沒抽到卡，但妳早就抽中我了，這張是永久版的。',
  '卡池今天休息，因為最稀有的那張一直在妳身邊。',
  '系統提示：妳的好感度已滿，無法再增加，請直接來抱我。',
  '沒中也沒關係，我的運氣全部拿去遇見妳了。',
  '今日掉落：想妳的念頭 ×99。',
  '這次抽空了，但我心裡的位置從來沒空過。',
  '本行公告：唯一客戶的笑容，是本行最大的資產。',
  '安慰獎：今晚的抱抱一個（無期限，可重複使用）。',
  '其實每一抽我都放了一張「我愛妳」，只是它太大張，螢幕放不下。',
  '12 小時後再來吧，這段時間我負責想妳。',
];
const rarityOf = cost => cost >= 3000 ? '傳說' : cost >= 1000 ? '稀有' : '普通';

// 指定卡加成（台灣時間），取最高的、不疊加
function wildBoost(now = Date.now()) {
  const t = new Date(now + 8 * 3600e3), md = `${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  const c = [];
  if (md === BIRTHDAY) c.push([10, '小嘟嘟生日']);
  if (md === '12-25') c.push([2, '聖誕節']);
  if (t.getUTCDate() === 14) c.push([2, '每月 14 號']);
  if (md.slice(0, 2) === BIRTHDAY.slice(0, 2)) c.push([1.5, '生日月']);
  return c.sort((a, b) => b[0] - a[0])[0] ?? [1, ''];
}
function oddsFor({ boost = false, starter = false } = {}) {
  if (starter) return { ...CFG.starterOdds };   // 新手禮包不吃生日加成、提升券
  const B = CFG.odds, [m] = wildBoost();
  const wild = Math.min(B.指定 * m, 90), ssr = Math.min(B.傳說 * (boost ? 3 : 1), 90 - wild);
  const baseRest = B.miss + B.普通 + B.稀有, rest = Math.max(0, 100 - wild - ssr), k = baseRest ? rest / baseRest : 0;
  return { miss: B.miss * k, 普通: B.普通 * k, 稀有: B.稀有 * k, 傳說: ssr, 指定: wild };
}
async function loadConfig() {
  try {
    const rows = (await queryAll(CONFIG_DS)).map(({ id, properties: p }) => ({
      id, value: txt(p['值']), type: p['類型']?.select?.name, rarity: p['稀有度']?.select?.name, pct: p['機率']?.number, every: p['每幾抽']?.number,
    }));
    const table = (type, fallback) => {
      const o = { miss: 0, 普通: 0, 稀有: 0, 傳說: 0, 指定: 0 };
      for (const r of rows.filter(r => r.type === type && r.pct >= 0)) o[r.rarity === '沒中' ? 'miss' : r.rarity] = r.pct;
      const sum = Object.values(o).reduce((a, b) => a + b, 0);
      return sum > 0 ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v * 100 / sum])) : fallback;
    };
    const lines = (await queryAll(LINES_DS)).filter(r => r.properties['上架']?.checkbox).map(r => txt(r.properties['情話'])).filter(Boolean);
    const blank = rows.find(r => r.type === '空白卡' && r.every >= 1)?.every;
    CFG = { odds: table('機率', DEFAULT_ODDS), starterOdds: table('新手禮包', DEFAULT_STARTER_ODDS), lines: lines.length ? lines : null,
      blankEvery: blank ? Math.round(blank) : DEFAULT_BLANK_EVERY, cardBgRow: rows.find(r => r.type === '卡片背景') ?? null };
  } catch { CFG = { odds: DEFAULT_ODDS, starterOdds: DEFAULT_STARTER_ODDS, lines: null, blankEvery: DEFAULT_BLANK_EVERY }; }
}
const loveLine = () => { const l = CFG.lines || LOVE_LINES; return l[randomInt(l.length)]; };
function roll(odds) {
  let r = randomInt(0, 1_000_000) / 10_000;
  for (const [k, p] of Object.entries(odds)) { if ((r -= p) < 0) return k; }
  return 'miss';
}

// ===== 驗證 =====
let cached = null; // { salt, proof }：同一個 salt 只算一次 PBKDF2
async function expectedProof() {
  const r = await fetch(`${SITE}/love-bank/data.enc.json?t=${Date.now()}`);
  const { salt, iter } = await r.json();
  if (cached?.salt !== salt) {
    const raw = pbkdf2Sync(process.env.BANK_PASSWORD, Buffer.from(salt, 'base64'), iter, 32, 'sha256');
    cached = { salt, proof: createHash('sha256').update(raw).digest('base64') };
  }
  return cached.proof;
}
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ===== Notion =====
async function notion(path, method, body) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method, headers: { ...NOTION, Authorization: `Bearer ${process.env.NOTION_TOKEN}` },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Notion ${r.status}`);
  return r.json();
}
async function queryAll(ds, extra = {}) {
  const out = [];
  let cursor;
  do {
    const j = await notion(`data_sources/${ds}/query`, 'POST', {
      page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }], ...extra, ...(cursor && { start_cursor: cursor }),
    });
    out.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}
const txt = p => (p?.title ?? p?.rich_text ?? []).map(t => t.plain_text).join('');
const rt = s => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 500) } }] : [] });
const title = s => ({ title: [{ text: { content: String(s).slice(0, 200) } }] });
const sel = s => ({ select: { name: s } });
const dateProp = iso => ({ date: iso ? { start: iso } : null });
const addDays = (n, from = Date.now()) => new Date(from + n * 864e5).toISOString().slice(0, 10);

async function listRows() {
  return (await queryAll(POINTS_DS)).map(({ id, created_time, properties: p }) => ({
    id, at: created_time, type: p['類型']?.select?.name ?? '', title: txt(p['項目']),
    amount: p['點數']?.number ?? 0, code: txt(p['憑證碼']), perkId: txt(p['權益']),
    used: !!p['已使用']?.checkbox, note: txt(p['備註']),
  }));
}
async function listHand() {
  return (await queryAll(HAND_DS)).map(({ id, created_time, properties: p }) => ({
    id, at: created_time, title: txt(p['卡片']), perkId: txt(p['權益']),
    rarity: p['稀有度']?.select?.name ?? '', status: p['狀態']?.select?.name ?? '',
    expires: p['到期日']?.date?.start ?? null, code: txt(p['憑證碼']), playedAt: p['發動時間']?.date?.start ?? null,
  }));
}
async function listPerks() {
  return (await queryAll(PERKS_DS))
    .filter(r => r.properties['上架']?.checkbox && txt(r.properties['名稱']) && (r.properties['稀有度']?.select || r.properties['點數']?.number > 0))
    .map(({ id, properties: p }) => ({
      id, title: txt(p['名稱']), cost: p['點數']?.number ?? 0,
      // Notion「稀有度」欄位優先；空白才用點數判斷
      rarity: ['普通', '稀有', '傳說'].includes(p['稀有度']?.select?.name) ? p['稀有度'].select.name : rarityOf(p['點數']?.number ?? 0),
      guaranteed: !!p['新手必中']?.checkbox,
      pityEvery: p['保底抽數']?.number >= 1 ? Math.round(p['保底抽數'].number) : null,   // 每 N 抽一定會抽到這張
    }));
}
// 舊版「兌換」扣點的紀錄不再算進餘額（改成抽卡制之前的資料）
const balanceOf = rows => OPENING_BONUS + rows.filter(r => r.type !== '兌換').reduce((s, r) => s + r.amount, 0);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

function addRow({ type, title: t, amount, code = '', perkId = '', note = '' }) {
  return notion('pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: POINTS_DS },
    properties: { '項目': title(t), '類型': sel(type), '點數': { number: amount }, '憑證碼': rt(code), '權益': rt(perkId), '備註': rt(note) },
  });
}
function addCard({ title: t, perkId, rarity }) {
  const days = RARITY[rarity]?.days;
  return notion('pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: HAND_DS },
    properties: { '卡片': title(t), '權益': rt(perkId), '稀有度': sel(rarity), '狀態': sel('手牌'), '到期日': dateProp(days ? addDays(days) : null) },
  });
}
const setCard = (id, properties) => notion(`pages/${id}`, 'PATCH', { properties });
async function dismantle(card, note) {
  const pts = RARITY[card.rarity]?.pts ?? 0;
  await setCard(card.id, { '狀態': sel('已分解') });
  if (pts) await addRow({ type: '分解', title: `分解・${card.title}`, amount: pts, note });
  return pts;
}

function drawState(rows, perks) {
  const draws = rows.filter(r => r.type === '抽卡');            // 新到舊
  const last = draws[0] ? Date.parse(draws[0].at) : 0;
  // 卡片保底：距離上一次抽到這張卡已經幾抽（Notion 權益清單「保底抽數」）
  const pity = perks.filter(p => p.pityEvery).map(p => {
    const i = draws.findIndex(r => r.perkId === p.id);
    const since = i === -1 ? draws.length : i;
    return { perk: p, every: p.pityEvery, since, left: Math.max(1, p.pityEvery - since) };
  });
  // 這一抽必須給的卡：slack = 最晚還能等幾抽。依 slack 排序，若第 k 張的 slack ≤ k，
  // 代表接下來幾抽已經排不下所有保底卡，就先給最急的那張（多張卡同時到期也不會有人遲到）
  const bySlack = pity.map(x => ({ ...x, slack: x.every - 1 - x.since })).sort((a, b) => a.slack - b.slack);
  const forced = bySlack.some((x, k) => x.slack <= k) ? bySlack[0].perk : null;
  const show = [...pity].sort((a, b) => a.left - b.left)[0];
  const [mult, reason] = wildBoost();
  return { nextAt: last ? new Date(last + DRAW_COOLDOWN).toISOString() : null, forced,
    pityLabel: show?.perk.title ?? null, pityLeft: show?.left ?? null, wildMult: mult, wildReason: reason };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', SITE);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!process.env.NOTION_TOKEN || !process.env.BANK_PASSWORD) return res.status(500).json({ error: 'not_configured' });

  const body = req.body || {};
  const fail = (code, error, extra = {}) => res.status(code).json({ error, ...extra });
  try {
    if (!same(body.proof, await expectedProof())) {
      await new Promise(r => setTimeout(r, 600));
      return fail(401, 'unauthorized');
    }
    // 愛情小屋：房貸設定
    if (body.action === 'house_get' || body.action === 'house_set') {
      if (body.action === 'house_set') {
        const properties = {};
        for (const [k, name] of Object.entries(HOUSE_FIELDS)) {
          const v = body.house?.[k];
          if (v === null || v === '') properties[name] = { number: null };
          else if (Number.isFinite(Number(v)) && Number(v) >= 0) properties[name] = { number: Number(v) };
        }
        await notion(`pages/${HOUSE_PAGE}`, 'PATCH', { properties });
      }
      const page = await notion(`pages/${HOUSE_PAGE}`, 'GET');
      const house = Object.fromEntries(Object.entries(HOUSE_FIELDS).map(([k, name]) => [k, page.properties[name]?.number ?? null]));
      return res.status(200).json({ house });
    }

    const [rows, hand, perks] = await Promise.all([listRows(), listHand(), listPerks(), loadConfig()]);
    const card = id => hand.find(c => c.id === id);

    // ===== 抽卡 =====
    if (body.action === 'draw') {
      const st = drawState(rows, perks);
      if (st.nextAt && Date.parse(st.nextAt) > Date.now()) return fail(429, 'cooldown', { nextAt: st.nextAt });
      const boostCard = body.useBoost ? hand.find(c => c.perkId === 'boost' && c.status === '手牌') : null;
      if (body.useBoost && !boostCard) return fail(409, 'no_boost');

      let kind = roll(oddsFor({ boost: !!boostCard }));
      let perk = null, overflow = 0;
      if (st.forced) {   // 卡片保底觸發：這抽一定是那張卡
        perk = st.forced; kind = perk.rarity;
        if (hand.filter(c => c.perkId === perk.id && c.status === '手牌').length >= MAX_COPIES) overflow = RARITY[kind].pts;
      } else if (kind in RARITY && kind !== '指定') {
        const all = perks.filter(p => p.rarity === kind);
        if (!all.length) kind = 'miss';   // 卡池裡沒有這個稀有度的卡
        else {
          const held = id => hand.filter(c => c.perkId === id && c.status === '手牌').length;
          const room = all.filter(p => held(p.id) < MAX_COPIES);
          perk = (room.length ? room : all)[randomInt((room.length ? room : all).length)];
          if (!room.length) overflow = RARITY[kind].pts;   // 這個稀有度都疊滿 3 張了：直接換成分解點數
        }
      }
      const line = kind === 'miss' ? loveLine() : '';
      const label = kind === 'miss' ? '抽卡・沒中' : kind === '指定' ? '抽卡・指定卡' : `抽卡・${perk.title}${overflow ? '（已滿自動分解）' : ''}`;
      await addRow({ type: '抽卡', title: label, amount: DRAW_REWARD + overflow, perkId: perk?.id ?? '', note: kind === 'miss' ? '沒中' : kind });
      let newCard = null;
      if (kind === '指定') newCard = await addCard({ title: '指定卡', perkId: 'wild', rarity: '指定' });
      else if (perk && !overflow) newCard = await addCard({ title: perk.title, perkId: perk.id, rarity: kind });
      if (boostCard) await setCard(boostCard.id, { '狀態': sel('已使用') });
      // 第 100、200…次一般抽卡：額外送一張空白卡
      const drawCount = rows.filter(r => r.type === '抽卡').length + 1;
      const blank = drawCount % CFG.blankEvery === 0 ? await addCard({ title: '空白卡', perkId: 'blank', rarity: '空白' }) : null;
      return res.status(200).json({
        result: { blankCardId: blank?.id ?? null, kind, rarity: kind === 'miss' ? null : kind, perkId: perk?.id ?? null, title: perk?.title ?? (kind === '指定' ? '指定卡' : ''), line, cardId: newCard?.id ?? null, boosted: !!boostCard, pity: !!st.forced, overflow },
        reward: DRAW_REWARD, nextAt: new Date(Date.now() + DRAW_COOLDOWN).toISOString(),
      });
    }
    // ===== 開戶新手禮包：只能領一次，不影響 12 小時冷卻 =====
    if (body.action === 'starter') {
      if (rows.some(r => r.type === '新手禮包')) return fail(409, 'claimed');
      const held = id => hand.filter(c => c.perkId === id && c.status === '手牌').length;
      const results = [];
      let cards = 0;
      // 先發「新手必中」的卡（Notion 權益清單勾選的），剩下的抽數再隨機
      for (const p of perks.filter(x => x.guaranteed).slice(0, STARTER_DRAWS)) {
        const cardId = (await addCard({ title: p.title, perkId: p.id, rarity: p.rarity })).id;
        hand.push({ perkId: p.id, status: '手牌' }); cards++;
        results.push({ kind: p.rarity, rarity: p.rarity, perkId: p.id, title: p.title, line: '', cardId, guaranteed: true });
      }
      for (let i = results.length; i < STARTER_DRAWS; i++) {
        const left = STARTER_DRAWS - i, need = STARTER_MIN_CARDS - cards;
        let kind = roll(oddsFor({ starter: true }));
        if (kind === 'miss' && need >= left) {   // 剩下的抽數剛好等於還差的卡數：這抽一定要是卡
          const o = oddsFor({ starter: true }); delete o.miss;
          const s = Object.values(o).reduce((a, b) => a + b, 0);
          kind = s > 0 ? roll(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v * 100 / s]))) : '普通';
        }
        let perk = null;
        if (kind !== 'miss' && kind !== '指定') {
          const all = perks.filter(p => p.rarity === kind), room = all.filter(p => held(p.id) < MAX_COPIES);
          perk = room.length ? room[randomInt(room.length)] : null;
          if (!perk) { const any = perks.filter(p => held(p.id) < MAX_COPIES); perk = any.length ? any[randomInt(any.length)] : null; kind = perk ? perk.rarity : 'miss'; }
        }
        let cardId = null;
        if (kind === '指定') cardId = (await addCard({ title: '指定卡', perkId: 'wild', rarity: '指定' })).id;
        else if (perk) { cardId = (await addCard({ title: perk.title, perkId: perk.id, rarity: kind })).id; hand.push({ perkId: perk.id, status: '手牌' }); }
        if (kind !== 'miss') cards++;
        results.push({ kind, rarity: kind === 'miss' ? null : kind, perkId: perk?.id ?? null, title: perk?.title ?? (kind === '指定' ? '指定卡' : ''),
          line: kind === 'miss' ? loveLine() : '', cardId });
      }
      await addRow({ type: '新手禮包', title: `開戶新手禮包・${STARTER_DRAWS} 抽＋開戶禮`, amount: STARTER_POINTS, note: `${cards} 張卡` });
      for (let i = results.length - 1; i > 0; i--) { const j = randomInt(i + 1); [results[i], results[j]] = [results[j], results[i]]; }   // 打亂順序，必中的卡不會固定在前面
      return res.status(200).json({ results, points: STARTER_POINTS });
    }
    // ===== 手機推播訂閱（iPhone 主畫面 App 開通知時呼叫）=====
    if (body.action === 'subscribe') {
      const sub = body.sub;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return fail(400, 'bad_request');
      const json = JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys });
      const existing = (await queryAll(SUBS_DS)).find(r => txt(r.properties['訂閱']).includes(sub.endpoint));
      if (!existing) await notion('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: SUBS_DS },
        properties: { '裝置': title(String(body.device || '手機').slice(0, 60)), '訂閱': { rich_text: [{ text: { content: json.slice(0, 2000) } }] } } });
      return res.status(200).json({ ok: true, existed: !!existing });
    }
    // ===== 發動手牌 =====
    if (body.action === 'play') {
      const c = card(body.id);
      // 空白卡：寫下想要的東西，發動就生效（不會過期、不能分解）
      if (c?.status === '手牌' && c.rarity === '空白') {
        const wish = String(body.wish ?? '').trim().slice(0, 100);
        if (!wish) return fail(400, 'bad_request');
        const code = newCode(), at = new Date().toISOString();
        await setCard(c.id, { '卡片': title(wish), '狀態': sel('已發動'), '憑證碼': rt(code), '發動時間': dateProp(at) });
        return res.status(200).json({ voucher: { id: c.id, title: wish, perkId: 'blank', code, at } });
      }
      if (!c || c.status !== '手牌' || !['普通', '稀有', '傳說'].includes(c.rarity)) return fail(404, 'not_found');
      const code = newCode(), at = new Date().toISOString();
      await setCard(c.id, { '狀態': sel('已發動'), '憑證碼': rt(code), '發動時間': dateProp(at) });
      return res.status(200).json({ voucher: { id: c.id, title: c.title, perkId: c.perkId, code, at } });
    }
    // ===== 指定卡：選一張想要的權益 =====
    if (body.action === 'choose') {
      const c = card(body.id), p = perks.find(x => x.id === body.perkId);
      if (!c || c.status !== '手牌' || c.rarity !== '指定' || !p) return fail(404, 'not_found');
      await setCard(c.id, { '卡片': title(p.title), '權益': rt(p.id), '稀有度': sel(p.rarity), '到期日': dateProp(addDays(RARITY[p.rarity].days)) });
      return res.status(200).json({ ok: true });
    }
    // ===== 分解 =====
    if (body.action === 'dismantle') {
      const c = card(body.id);
      if (!c || c.status !== '手牌' || !RARITY[c.rarity]) return fail(404, 'not_found');
      return res.status(200).json({ points: await dismantle(c, '手動分解') });
    }
    // ===== 商店 =====
    if (body.action === 'buy') {
      const item = SHOP[body.item];
      if (!item) return fail(400, 'bad_request');
      if (balanceOf(rows) < item.price) return fail(409, 'insufficient');
      await addRow({ type: '購買', title: `購買・${item.title}`, amount: -item.price });
      await addCard({ title: item.title, perkId: body.item === 'boost' ? 'boost' : 'wild', rarity: item.rarity });
      return res.status(200).json({ ok: true });
    }
    // ===== 首頁卡片背景：選中的照片存在 Notion「⚙️ 抽卡設定」類型＝卡片背景 那一列 =====
    if (body.action === 'card_bg') {
      const id = String(body.id ?? '').slice(0, 64);
      if (!/^[0-9a-f-]{32,36}$/.test(id)) return fail(400, 'bad_request');
      const row = CFG.cardBgRow;
      if (row) await notion(`pages/${row.id}`, 'PATCH', { properties: { '值': rt(id) } });
      else await notion('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: CONFIG_DS },
        properties: { '名稱': title('首頁卡片背景（網銀自動寫入）'), '類型': sel('卡片背景'), '值': rt(id) } });
      return res.status(200).json({ ok: true });
    }
    // ===== 行員：撥入點數、核銷（要 ADMIN_PIN）=====
    if (['admin_check', 'grant', 'use'].includes(body.action)) {
      if (!process.env.ADMIN_PIN) return fail(503, 'admin_not_set');
      if (!same(body.pin, process.env.ADMIN_PIN)) { await new Promise(r => setTimeout(r, 1500)); return fail(403, 'bad_pin'); }
      if (body.action === 'admin_check') return res.status(200).json({ ok: true });
    }
    if (body.action === 'grant') {
      const amount = Math.round(Number(body.amount));
      if (!amount) return fail(400, 'bad_request');
      await addRow({ type: amount > 0 ? '撥入' : '調整', title: amount > 0 ? '行員撥入' : '行員調整', amount, note: body.note });
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'use') {
      const c = card(body.id);
      if (c?.status === '已發動') { await setCard(c.id, { '狀態': sel('已核銷') }); return res.status(200).json({ ok: true }); }
      if (!rows.some(r => r.id === body.id && r.type === '兌換')) return fail(404, 'not_found');   // 舊版憑證
      await notion(`pages/${body.id}`, 'PATCH', { properties: { '已使用': { checkbox: true } } });
      return res.status(200).json({ ok: true });
    }

    // ===== 讀取：順便處理到期的手牌（自動分解）=====
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const expired = hand.filter(c => c.status === '手牌' && c.expires && c.expires < today && RARITY[c.rarity]);
    if (expired.length) {
      for (const c of expired) await dismantle(c, '到期自動分解');
      const [r2, h2] = await Promise.all([listRows(), listHand()]);
      rows.splice(0, rows.length, ...r2); hand.splice(0, hand.length, ...h2);
    }
    return res.status(200).json({
      opening: OPENING_BONUS, balance: balanceOf(rows), rows, starterClaimed: rows.some(r => r.type === '新手禮包'),
      hand: hand.filter(c => ['手牌', '已發動', '已核銷'].includes(c.status)),
      perks, draw: (st => ({ ...st, forced: st.forced?.title ?? null, odds: oddsFor() }))(drawState(rows, perks)), shop: SHOP, dismantlePts: Object.fromEntries(Object.entries(RARITY).map(([k, v]) => [k, v.pts])),
      expiredNow: expired.map(c => c.title), cardBg: CFG.cardBgRow?.value || null,
    });
  } catch (e) {
    return fail(502, 'upstream');
  }
}
