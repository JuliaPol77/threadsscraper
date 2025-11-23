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

// разбор одного поста: метрики + текст поста
async function scrapeThread(page, keyword, url) {
  console.log("  Открываю пост:", url);

  const normalizedUrl = url.replace("https://www.threads.com", "https://www.threads.net");

  await page.goto(normalizedUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  // ---------- МЕТРИКИ ЧЕРЕЗ page.evaluate (без Playwright-селекторов) ----------

  const { viewsCount, commentsCount } = await page.evaluate(() => {
    let views = null;
    let comments = null;

    // Просмотры: ищем текст вида "8 925 просмотров" или "8,925 views"
    const spans = Array.from(document.querySelectorAll("span"));
    for (const el of spans) {
      const t = (el.textContent || "").trim();
      if (!t) continue;

      const m = t.match(/(\d[\d\s\u00A0]*)(?=\s*(просмотров|views))/i);
      if (m) {
        const raw = m[1].replace(/[^\d]/g, ""); // убираем пробелы и nbsp
        const num = parseInt(raw, 10);
        if (!Number.isNaN(num)) {
          views = num;
          break; // берём первый нормальный матч
        }
      }
    }

    // Комментарии: от svg[aria-label="Ответ"/"Reply"] к ближайшему span с числом
    const replyIcon = document.querySelector('svg[aria-label="Ответ"], svg[aria-label="Reply"]');
    if (replyIcon) {
      const root = replyIcon.parentElement; // <div ...><svg ...><span ...>...
      if (root) {
        const numSpan = root.querySelector("span span, span");
        if (numSpan) {
          const t = (numSpan.textContent || "").trim();
          const m2 = t.match(/\d[\d\s\u00A0]*/);
          if (m2) {
            const raw2 = m2[0].replace(/[^\d]/g, "");
            const num2 = parseInt(raw2, 10);
            if (!Number.isNaN(num2)) {
              comments = num2;
            }
          }
        }
      }
    }

    return { viewsCount: views, commentsCount: comments };
  });

  console.log("    Метрики:", { viewsCount, commentsCount });

  // ---------- ТЕКСТ ГОЛОВНОГО ПОСТА ----------

  let postText = "";

  try {
    // Берём все осмысленные текстовые куски из span[dir="auto"]
    const textCandidates = await page.$$eval('span[dir="auto"]', els =>
      els
        .map(el => (el.innerText || "").trim())
        .filter(t => t.length > 0)
        .filter(t =>
          !/^Translate$/i.test(t) &&
          !/^Пустая строка$/i.test(t) &&
          !/^\d+\s*\/\s*\d+$/.test(t)     // 1/2, 2/3 и т.п.
        )
    );

    console.log("    text candidates (шт.):", textCandidates.length);

    if (textCandidates.length) {
      // берём самый длинный текст как главный пост
      postText = textCandidates.sort((a, b) => b.length - a.length)[0];
    }
  } catch (e) {
    console.log("    Ошибка при парсе текста поста:", e.message);
  }

  console.log("    Текст поста (обрезан):", postText.slice(0, 100), "...");

  // ---------- ЗАПИСЬ В ТАБЛИЦУ: ТОЛЬКО ПОСТ ----------

  const rowPost = {
    keyword,
    status: "пост",
    url: normalizedUrl,
    author: "",           // при желании потом можно добить селектором ника
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
