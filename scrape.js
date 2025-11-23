import { chromium } from "@playwright/test";

// >>> ВСТАВЬ СЮДА СВОЙ ID ТАБЛИЦЫ
const SPREADSHEET_ID = "1jl9gmFElhLw3i-eEPg2tdf6XYNL9xKWyDJuAiaRG-I0";

// >>> ВСТАВЬ СЮДА СВОЙ WEBHOOK ИЗ APPS SCRIPT
const APP_SCRIPT_WEBHOOK = "https://script.google.com/macros/s/AKfycbzJ6_YlOThPmeD9rRT6mhr_zWiHzokQLr5AaQ9Uxw_XwBz0VY8YUBFTKY-3SegLquIP/exec";

const KEY_SHEET_NAME = "ключи";           // лист с ключевыми словами
const MAX_POSTS_PER_KEYWORD = 5;          // сколько постов на ключ берём

// CSV URL для листа "ключи"
const KEY_CSV_URL =
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(KEY_SHEET_NAME)}`;

// простейший парсер "1 234", "1,234" → 1234
function parseIntSafe(str) {
  if (!str) return null;
  const digits = str.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

// читаем ключевые слова из CSV
async function readKeywords() {
  const res = await fetch(KEY_CSV_URL);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  lines.shift(); // убираем заголовок "keyword"

  return lines
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^"+|"+$/g, "")); // убираем лишние кавычки по краям
}

// отправка строки в Apps Script
async function sendRow(rowObj) {
  rowObj.ts = new Date().toISOString();

  const res = await fetch(APP_SCRIPT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rowObj)
  });

  const text = await res.text();
  console.log("    Ответ Apps Script:", res.status, text);
}

// поиск постов по ключевому слову на threads.com
async function searchPosts(page, keyword) {
  const searchUrl =
    `https://www.threads.com/search?q=${encodeURIComponent(keyword)}`;
  console.log("Поиск:", searchUrl);

  await page.goto(searchUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  // Берём все <a>, где href содержит "/post/"
  const links = await page.$$eval('a[href*="/post/"]', els =>
    Array.from(new Set(
      els
        .map(el => el.href)
        .filter(href => href.includes("/post/"))
    ))
  );

  const top = links.slice(0, MAX_POSTS_PER_KEYWORD);
  console.log(`  "${keyword}" → найдено ${links.length}, берём ${top.length}`);
  return top;
}

// разбор одного поста + тред автора
async function scrapeThread(page, keyword, url) {
  console.log("  Открываю пост:", url);

  // переписываем домен threads.com → www.threads.net
  const normalizedUrl = url.replace("https://www.threads.com", "https://www.threads.net");

  await page.goto(normalizedUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  let commentsCount = null;
  let viewsCount = null;

  // ---------- VIEWS: <span>8 925 просмотров</span> ----------
  try {
    const viewsLocator = page.locator('span:has-text("просмотров")').first();
    if (await viewsLocator.count()) {
      const txt = await viewsLocator.innerText();
      viewsCount = parseIntSafe(txt);
    }
  } catch (e) {
    console.log("    Не смог прочитать просмотры:", e.message);
  }

  // ---------- COMMENTS: svg[aria-label="Ответ"] + span span (внутренний span с числом) ----------
  try {
    const commentsLocator = page.locator('svg[aria-label="Ответ"] + span span').first();
    if (await commentsLocator.count()) {
      const txt = await commentsLocator.innerText();
      commentsCount = parseIntSafe(txt);
    }
  } catch (e) {
    console.log("    Не смог прочитать комментарии:", e.message);
  }

  console.log("    Метрики:", { viewsCount, commentsCount });

  // ---------- ТРЕД: статьи автора ----------
  const articles = await page.$$("article");

  // Если article не нашли — всё равно запишем одну строку с метриками
  if (!articles.length) {
    console.log("    Не нашёл article на странице, записываю только метрики");
    const row = {
      keyword,
      status: "пост",
      url: normalizedUrl,
      author: "",
      text: "",
      views: viewsCount,
      comments: commentsCount
    };
    await sendRow(row);
    return;
  }

  // Пытаемся достать ник автора из первого article
  const authorLinkEl = await articles[0].$('a[href*="/@"]');
  const authorHandle = authorLinkEl
    ? (await authorLinkEl.innerText()).trim()
    : "";

  console.log("    Автор:", authorHandle);

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];

    // Проверяем, что это пост того же автора
    const handleEl = await article.$('a[href*="/@"]');
    const handle = handleEl ? (await handleEl.innerText()).trim() : "";

    if (authorHandle && handle !== authorHandle) {
      continue; // пропускаем чужие ответы
    }

    const fullText = (await article.innerText()).trim();
    const status = i === 0 ? "пост" : "комментарий";

    const row = {
      keyword,
      status,
      url: normalizedUrl,
      author: authorHandle,
      text: fullText,
      views: viewsCount,
      comments: commentsCount
    };

    console.log("    Строка:", status, fullText.slice(0, 40), "...");
    await sendRow(row);
  }
}

(async () => {
  try {
    const keywords = await readKeywords();
    console.log("Ключи из таблицы:", keywords);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const keyword of keywords) {
      const postUrls = await searchPosts(page, keyword);
      for (const url of postUrls) {
        await scrapeThread(page, keyword, url);
      }
    }

    await browser.close();
    console.log("Готово.");
  } catch (err) {
    console.error("ОШИБКА:", err);
    process.exit(1);
  }
})();
