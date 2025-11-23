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

// парсер числа: собираем ВСЕ группы цифр (чтобы 142 356 → 142356)
function parseIntSafe(str) {
  if (!str) return null;
  const allDigits = (str.match(/\d+/g) || []).join(""); // все группы цифр подряд
  return allDigits ? parseInt(allDigits, 10) : null;
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

  // ---------- VIEWS: <span>8 925 просмотров</span> или "8,925 views" ----------
  try {
    const viewsLocator = page
      .locator('span:has-text("просмотров"), span:has-text("views")')
      .first();

    if (await viewsLocator.count()) {
      const txt = await viewsLocator.innerText();
      console.log("    RAW views text:", txt);
      viewsCount = parseIntSafe(txt);
    }
  } catch (e) {
    console.log("    Не смог прочитать просмотры:", e.message);
  }

  // ---------- COMMENTS: svg[aria-label="Ответ" | "Reply"] + span span ----------
  try {
    const replyIcon = page
      .locator('svg[aria-label="Ответ"], svg[aria-label="Reply"]')
      .first();

    if (await replyIcon.count()) {
      const countSpan = replyIcon
        .locator('xpath=following-sibling::span//span')
        .first();

      if (await countSpan.count()) {
        const txt = await countSpan.innerText();
        console.log("    RAW comments text:", txt);
        commentsCount = parseIntSafe(txt);
      }
    }
  } catch (e) {
    console.log("    Не смог прочитать комментарии:", e.message);
  }

  console.log("    Метрики:", { viewsCount, commentsCount });

  // ---------- ТЕКСТЫ: пост и комментарии автора ----------

  // Текст головного поста: div.x1a6qonq.xmgb6t1 span span (первый внутренний span)
  let postText = "";
  try {
    const postTextEl = await page.$('div.x1a6qonq.xmgb6t1 span span');
    if (postTextEl) {
      postText = (await postTextEl.innerText()).trim();
    }
  } catch (e) {
    console.log("    Не смог прочитать текст поста:", e.message);
  }

  // Тексты комментариев: div.x1a6qonq:not(.xmgb6t1) span span
  let commentsTexts = [];
  try {
    const commentTextEls = await page.$$('div.x1a6qonq:not(.xmgb6t1) span span');
    for (const el of commentTextEls) {
      const txt = (await el.innerText()).trim();
      if (txt) commentsTexts.push(txt);
    }
  } catch (e) {
    console.log("    Не смог прочитать тексты комментариев:", e.message);
  }

  // ---------- ЗАПИСЬ В ТАБЛИЦУ ----------

  // строка для головного поста
  if (postText) {
    const rowPost = {
      keyword,
      status: "пост",
      url: normalizedUrl,
      author: "",           // можно добить позже, если найдём надёжный селектор
      text: postText,
      views: viewsCount,
      comments: commentsCount
    };
    console.log("    Строка поста:", postText.slice(0, 60), "...");
    await sendRow(rowPost);
  } else {
    // если текст поста не нашли — всё равно запишем метрики
    const rowFallback = {
      keyword,
      status: "пост",
      url: normalizedUrl,
      author: "",
      text: "",
      views: viewsCount,
      comments: commentsCount
    };
    console.log("    Пост без текста, записываю только метрики");
    await sendRow(rowFallback);
  }

  // строки для комментариев
  for (const cText of commentsTexts) {
    const rowComment = {
      keyword,
      status: "комментарий",
      url: normalizedUrl,
      author: "",          // тоже можно будет подобрать селектор позже
      text: cText,
      views: viewsCount,
      comments: commentsCount
    };
    console.log("    Строка комментария:", cText.slice(0, 60), "...");
    await sendRow(rowComment);
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
