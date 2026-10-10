// 「可以抽卡囉」手機推播：GitHub Actions 每 15 分鐘跑一次。
// 抽卡冷卻（上一次抽卡 + 12 小時）結束、而且這一輪還沒通知過，就推播到 Notion「🔔 通知訂閱」裡的每支手機。
// 需要環境變數：NOTION_TOKEN、VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY；需要套件 web-push。
import webpush from "web-push";

const POINTS_DS = "d7643339-684a-4255-ac0c-7e4a74ac1c95"; // 💝 寵愛點數（抽卡紀錄）
const SUBS_DS = "b9a2dc0a-9b90-407a-ba4f-fc1ace495f5f";   // 🔔 通知訂閱
const DRAW_COOLDOWN = 12 * 3600e3;
const SITE = "https://alexhuang0802.github.io/love-bank/";

const { NOTION_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
if (!NOTION_TOKEN || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.log("還沒設定推播金鑰，跳過");
  process.exit(0);
}
webpush.setVapidDetails(SITE, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const H = { Authorization: `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" };
async function notion(path, method, body) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, { method, headers: H, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error(`Notion ${r.status}`);
  return r.json();
}
const txt = p => (p?.title ?? p?.rich_text ?? []).map(t => t.plain_text).join("");

// 上一次抽卡時間
const lastDraw = (await notion(`data_sources/${POINTS_DS}/query`, "POST", {
  page_size: 1,
  filter: { property: "類型", select: { equals: "抽卡" } },
  sorts: [{ timestamp: "created_time", direction: "descending" }],
})).results[0];
const readyAt = lastDraw ? Date.parse(lastDraw.created_time) + DRAW_COOLDOWN : 0;   // 從沒抽過 = 隨時可抽
if (readyAt > Date.now()) {
  console.log("還在冷卻中，不用通知");
  process.exit(0);
}

const subs = (await notion(`data_sources/${SUBS_DS}/query`, "POST", { page_size: 100 })).results;
let sent = 0;
for (const s of subs) {
  const last = s.properties["上次通知"]?.date?.start;
  if (last && Date.parse(last) >= readyAt) continue;   // 這一輪已經通知過
  let sub;
  try { sub = JSON.parse(txt(s.properties["訂閱"])); } catch { continue; }
  try {
    await webpush.sendNotification(sub, JSON.stringify({
      title: "✦ 可以抽卡囉", body: "嘟嘟，新的一抽準備好了，快來看看今天手氣如何 💌", url: SITE,
    }));
    await notion(`pages/${s.id}`, "PATCH", { properties: { "上次通知": { date: { start: new Date().toISOString() } } } });
    sent++;
  } catch (e) {
    // 手機取消訂閱或換手機：訂閱失效就移到垃圾桶
    if (e.statusCode === 404 || e.statusCode === 410) await notion(`pages/${s.id}`, "PATCH", { in_trash: true });
    else console.log("推播失敗", e.statusCode ?? e.message);
  }
}
console.log(`推播完成：${sent} 支手機`);
