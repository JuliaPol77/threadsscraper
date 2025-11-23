import { chromium } from "@playwright/test";

// >>> ВСТАВЬ СЮДА СВОЙ ID ТАБЛИЦЫ
const SPREADSHEET_ID = "1jl9gmFElhLw3i-eEPg2tdf6XYNL9xKWyDJuAiaRG-I0";

// >>> ВСТАВЬ СЮДА СВОЙ WEBHOOK ИЗ APPS SCRIPT
const APP_SCRIPT_WEBHOOK = "https://script.google.com/macros/s/AKfycbzJ6_YlOThPmeD9rRT6mhr_zWiHzokQLr5AaQ9Uxw_XwBz0VY8YUBFTKY-3SegLquIP/exec";

const KEY_SHEET_NAME = "ключи";
const MAX_POSTS_PER_KEYWORD = 5;

// CSV URL для листа "ключи"
const KEY_CSV_URL =
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(KEY_SHEET_NAME)}`;

// Собираем ВСЕ группы цифр (чтобы "142 356" → "142356")
function parseIntSafe(str) {
  if (!str) return null;
  const allDigits = (str.match(/\d+/g) || []).join("");
  return allDigits ? parseInt(allDigits, 10) : null;
}

// читаем ключи
async function readKeywords() {
  const res = await fetch(KEY_CSV_URL);
  const csv = await res.text();
  const lines = csv.trim().split("\n");
  lines.shift(); // заголовок

  return lines
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^"+|"+$/g, ""));
}

// отправка строки в Google Sheets через Apps Script
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

// поиск постов по ключу
async function searchPosts(page, keyword) {
  const searchUrl =
    `https://www.threads.com/search?q=${encodeURIComponent(keyword)}`;
  console.log("Поиск:", searchUrl);

  await page.goto(searchUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

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

// разбор одного поста: метрики + текст поста
async function scrapeThread(page, keyword, url) {
  console.log("  Открываю пост:", url);

  const normalizedUrl = url.replace("https://www.threads.com", "https://www.threads.net");

  await page.goto(normalizedUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  // ---------- МЕТРИКИ ----------

  let viewsCount = null;
  let commentsCount = null;

  try {
    // собираем ВСЕ тексты, где есть "просмотров"/"views"
    const viewsCandidates = await page.$$eval("span", els =>
      els
        .map(el => el.innerText || "")
        .filter(t =>
          /просмотров/i.test(t) ||
          /views/i.test(t)
        )
    );

    console.log("    views candidates:", viewsCandidates);

    const viewsNums = viewsCandidates
      .map(txt => parseIntSafe(txt))
      .filter(n => n !== null);

    if (viewsNums.length) {
      // берём максимальное число
      viewsCount = Math.max(...viewsNums);
    }
  } catch (e) {
    console.log("    Ошибка при парсе просмотров:", e.message);
  }

  try {
    // собираем тексты, где рядом упоминаются "ответ"/"коммент"/"repl"/"repl"
    const commentsCandidates = await page.$$eval("span, div", els =>
      els
        .map(el => el.innerText || "")
        .filter(t =>
          /ответ/i.test(t) ||
          /коммент/i.test(t) ||
          /repl/i.test(t) ||
          /repl(y|ies)/i.test(t)
        )
    );

    console.log("    comments candidates:", commentsCandidates);

    const commentsNums = commentsCandidates
      .map(txt => parseIntSafe(txt))
      .filter(n => n !== null);

    if (commentsNums.length) {
      commentsCount = Math.max(...commentsNums);
    }
  } catch (e) {
    console.log("    Ошибка при парсе комментариев:", e.message);
  }

  console.log("    Метрики:", { viewsCount, commentsCount });

  // ---------- ТЕКСТ ПОСТА (только головной пост) ----------

  let postText = "";

  try {
    // берём все текстовые куски из span[dir="auto"]
    const textCandidates = await page.$$eval('span[dir="auto"]', els =>
      els
        .map(el => (el.innerText || "").trim())
        .filter(t => t.length > 0)
        .filter(t =>
          !/^Translate$/i.test(t) &&         // выкидываем "Translate"
          !/^Пустая строка$/i.test(t) &&     // выкидываем "Пустая строка"
          !/^\d+\s*\/\s*\d+$/.test(t)        // выкидываем "1/2", "2/3" и т.п.
        )
    );

    console.log("    text candidates (счёт):", textCandidates.length);

    if (textCandidates.length) {
      // берём самый длинный текст — это почти всегда сам пост
      postText = textCandidates.sort((a, b) => b.length - a.length)[0];
    }
  } catch (e) {
    console.log("    Ошибка при парсе текста поста:", e.message);
  }

  console.log("    Текст поста (обрезан):", postText.slice(0, 100), "...");

  const rowPost = {
    keyword,
    status: "пост",
    url: normalizedUrl,
    author: "",
    text: postText,
    views: viewsCount,
    comments: commentsCount
  };

  await sendRow(rowPost);
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
