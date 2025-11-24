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

// разбор одного поста: СБОР ВСЕГО ТЕКСТА ПОСТА ИЗ НЕСКОЛЬКИХ SPAN
async function scrapeThread(page, keyword, url) {
  console.log("  Открываю пост:", url);

  const normalizedUrl = url.replace("https://www.threads.com", "https://www.threads.net");

  await page.goto(normalizedUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  // ---------- ТЕКСТ ГОЛОВНОГО ПОСТА ЦЕЛИКОМ ----------

  const postText = await page.evaluate(() => {
    // 1) Ищем ВСЕ контейнеры постов/комментов
    const blocks = Array.from(document.querySelectorAll("div.x1a6qonq"));

    const candidates = [];

    for (const block of blocks) {
      // внутри контейнера собираем span[dir="auto"]
      const spans = Array.from(block.querySelectorAll('span[dir="auto"]'));
      const texts = spans
        .map(el => (el.innerText || "").trim())
        .filter(t => t.length > 0)
        .filter(t => {
          if (/^Translate$/i.test(t)) return false;
          if (/^Пустая строка$/i.test(t)) return false;
          if (/^\d+\s*\/\s*\d+$/.test(t)) return false; // 1/2, 2/3
          return true;
        });

      if (!texts.length) continue;

      const full = texts.join("\n");
      candidates.push(full);
    }

    if (!candidates.length) {
      return "";
    }

    // отдаём приоритет блоку с кириллицей и максимальной длиной
    const withCyrillic = candidates.filter(t => /[А-Яа-яЁё]/.test(t));
    if (withCyrillic.length) {
      return withCyrillic.sort((a, b) => b.length - a.length)[0];
    }

    // если почему-то нет кириллицы — берём просто самый длинный блок
    return candidates.sort((a, b) => b.length - a.length)[0];
  });

  console.log("    Текст поста (обрезан):", (postText || "").slice(0, 150), "...");

  const rowPost = {
    keyword,
    status: "пост",
    url: normalizedUrl,
    author: "",
    text: postText || "",
    views: null,
    comments: null
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
