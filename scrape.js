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

// читаем ключевые слова из CSV (то, что уже работает)
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

// отправка строки в Apps Script (у тебя уже работает)
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

// разбор одного поста: ТОЛЬКО текст головного поста, БЕЗ метрик и комментов
async function scrapeThread(page, keyword, url) {
  console.log("  Открываю пост:", url);

  const normalizedUrl = url.replace("https://www.threads.com", "https://www.threads.net");

  await page.goto(normalizedUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  // ---------- ТЕКСТ ГОЛОВНОГО ПОСТА ----------

  const postText = await page.evaluate(() => {
    // Берём все span[dir="auto"] — там обычно лежит юзерский текст
    const spans = Array.from(document.querySelectorAll('span[dir="auto"]'));
    const rawTexts = spans
      .map(el => (el.innerText || "").trim())
      .filter(t => t.length > 0);

    // фильтруем мусор: Translate, "Пустая строка", "1/2", короткие надписи
    const cleaned = rawTexts.filter(t => {
      if (/^Translate$/i.test(t)) return false;
      if (/^Пустая строка$/i.test(t)) return false;
      if (/^\d+\s*\/\s*\d+$/.test(t)) return false; // 1/2, 2/3 и т.п.
      if (/^View .* more replies$/i.test(t)) return false;
      if (/^View .* replies$/i.test(t)) return false;
      if (/^Reply$/i.test(t)) return false;
      if (/^Ответ$/i.test(t)) return false;
      return true;
    });

    // отдаём приоритет русскому тексту (с кириллицей)
    const russian = cleaned.filter(t => /[А-Яа-яЁё]/.test(t));

    // если есть русские фразы — берём ПЕРВУЮ достаточно длинную
    for (const t of russian) {
      if (t.length >= 20) return t;
    }
    // иначе берём самый длинный русский
    if (russian.length) {
      return russian.sort((a, b) => b.length - a.length)[0];
    }

    // если вообще нет кириллицы — fallback: любой текст
    for (const t of cleaned) {
      if (t.length >= 20) return t;
    }
    return cleaned[0] || "";
  });

  console.log("    Текст поста (обрезан):", (postText || "").slice(0, 120), "...");

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
