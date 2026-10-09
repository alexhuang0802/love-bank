// api/points.js - 寵愛點數的雲端 API（Vercel Serverless Function）
// 點數紀錄存在 Notion「💝 寵愛點數」資料表，兩支手機看到同一份。
// 驗證：網頁登入後持有的 AES 金鑰 → SHA-256 → base64 當作 proof；
//       伺服器用 BANK_PASSWORD + data.enc.json 的 salt 算出同一把金鑰比對，不必傳密碼。
// 需要環境變數：NOTION_TOKEN、BANK_PASSWORD
import { pbkdf2Sync, createHash, timingSafeEqual, randomInt } from 'node:crypto';

const POINTS_DS = 'd7643339-684a-4255-ac0c-7e4a74ac1c95';
const HOUSE_PAGE = '3f48718e-66c1-81a2-99d9-f5ba73555415'; // Notion「🏠 愛情小屋」的「我們的家」那一列
const HOUSE_FIELDS = { price: '房子總價', down: '頭期款', years: '貸款年數', monthly: '每月還款', rate: '房貸利率' };
const OPENING_BONUS = 5201314;   // 跟 index.html 的 CONFIG.openingBonus 一致
const SITE = 'https://alexhuang0802.github.io';
const NOTION = { 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' };

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

async function notion(path, method, body) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method, headers: { ...NOTION, Authorization: `Bearer ${process.env.NOTION_TOKEN}` },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Notion ${r.status}`);
  return r.json();
}
const txt = p => (p?.title ?? p?.rich_text ?? []).map(t => t.plain_text).join('');
const rt = s => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 500) } }] : [] });

async function listRows() {
  const rows = [];
  let cursor;
  do {
    const j = await notion(`data_sources/${POINTS_DS}/query`, 'POST', {
      page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }], ...(cursor && { start_cursor: cursor }),
    });
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return rows.map(({ id, created_time, properties: p }) => ({
    id, at: created_time, type: p['類型']?.select?.name ?? '', title: txt(p['項目']),
    amount: p['點數']?.number ?? 0, code: txt(p['憑證碼']), perkId: txt(p['權益']),
    used: !!p['已使用']?.checkbox, note: txt(p['備註']),
  }));
}
const balanceOf = rows => OPENING_BONUS + rows.reduce((s, r) => s + r.amount, 0);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

async function addRow({ type, title, amount, code = '', perkId = '', note = '' }) {
  return notion('pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: POINTS_DS },
    properties: {
      '項目': { title: [{ text: { content: String(title).slice(0, 200) } }] },
      '類型': { select: { name: type } }, '點數': { number: amount },
      '憑證碼': rt(code), '權益': rt(perkId), '備註': rt(note),
    },
  });
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
  try {
    if (!same(body.proof, await expectedProof())) {
      await new Promise(r => setTimeout(r, 600));
      return res.status(401).json({ error: 'unauthorized' });
    }
    // 愛情小屋：房貸設定（總價、頭期款、年數、每月還款）
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

    const rows = await listRows();

    if (body.action === 'redeem') {
      const cost = Math.round(Number(body.cost));
      if (!(cost > 0) || !body.title) return res.status(400).json({ error: 'bad_request' });
      if (balanceOf(rows) < cost) return res.status(409).json({ error: 'insufficient' });
      const code = newCode();
      const page = await addRow({ type: '兌換', title: body.title, amount: -cost, code, perkId: body.perkId });
      return res.status(200).json({ voucher: { id: page.id, title: body.title, code, at: page.created_time, used: false } });
    }
    if (body.action === 'grant') {
      const amount = Math.round(Number(body.amount));
      if (!amount) return res.status(400).json({ error: 'bad_request' });
      await addRow({ type: amount > 0 ? '撥入' : '調整', title: amount > 0 ? '行員撥入' : '行員調整', amount, note: body.note });
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'use') {
      if (!rows.some(r => r.id === body.id && r.type === '兌換')) return res.status(404).json({ error: 'not_found' });
      await notion(`pages/${body.id}`, 'PATCH', { properties: { '已使用': { checkbox: true } } });
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ opening: OPENING_BONUS, balance: balanceOf(rows), rows });
  } catch (e) {
    return res.status(502).json({ error: 'upstream' });
  }
}
