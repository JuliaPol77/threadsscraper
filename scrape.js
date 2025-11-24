import { chromium } from "@playwright/test";

// >>> ВСТАВЬ СЮДА СВОЙ ID ТАБЛИЦЫ
const SPREADSHEET_ID = "1jl9gmFElhLw3i-eEPg2tdf6XYNL9xKWyDJuAiaRG-I0";

// >>> ВСТАВЬ СЮДА СВОЙ WEBHOOK ИЗ APPS SCRIPT
const APP_SCRIPT_WEBHOOK = "https://script.google.com/macros/s/AKfycbzJ6_YlOThPmeD9rRT6mhr_zWiHzokQLr5AaQ9Uxw_XwBz0VY8YUBFTKY-3SegLquIP/exec";

const KEY_SHEET_NAME = "ключи";
const MAX_POSTS_PER_KEYWORD = 5;

const KEY_CSV_URL =
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(KEY_SHEET_NAME)}`;

// читаем ключевые слова
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

// отправка строки в Google Sheets
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

// разбор одного поста: пост + подряд комменты автора + просмотры
async function scrapeThread(page, keyword, url) {
  console.log("  Открываю пост:", url);

  const normalizedUrl = url.replace("https://www.threads.com", "https://www.threads.net");
  await page.goto(normalizedUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(4000);

  // ---------- ПРОСМОТРЫ (тупо, но надёжно) ----------
  const { viewsCount } = await page.evaluate(() => {
    let views: number | null = null;

    const spans = Array.from(document.querySelectorAll("span"));
    const texts = spans
      .map(el => (el.innerText || "").trim())
      .filter(t => t.length > 0);

    const candidates = texts.filter(t =>
      /просмотр/i.test(t) || /views?/i.test(t)
    );

    for (const t of candidates) {
      const digits = t.replace(/[^\d]/g, "");
      if (!digits) continue;
      const num = parseInt(digits, 10);
      if (!Number.isNaN(num)) {
        if (views === null || num > views) {
          views = num;
        }
      }
    }

    return { viewsCount: views };
  });

  console.log("    Просмотры:", viewsCount);

  // ---------- АВТОР И ТЕКСТЫ (как в рабочем варианте) ----------

  // автор из URL: https://www.threads.net/@alekseybobyr/post/... -> alekseybobyr
  const m = normalizedUrl.match(/\/@([^/]+)/);
  const authorHandle = m ? m[1] : "";
  const authorField = authorHandle ? `@${authorHandle}` : "";

  const { postText, comments } = await page.evaluate((authorHandle) => {
    function getBlockText(block: Element): string {
      const spans = Array.from(block.querySelectorAll('span[dir="auto"]'));
      const texts = spans
        .map(el => (el as HTMLElement).innerText.trim())
        .filter(t => t.length > 0)
        .filter(t => {
          if (/^Translate$/i.test(t)) return false;
          if (/^Пустая строка$/i.test(t)) return false;
          if (/^\d+\s*\/\s*\d+$/.test(t)) return false; // 1/2, 2/3
          return true;
        });

      if (!texts.length) return "";
      return texts.join("\n");
    }

    // ищем ссылку на автора ТОЛЬКО В БЛИЖАЙШИХ ПРЕДКАХ
    function isBlockByAuthor(block: Element, handle: string): boolean {
      if (!handle) return false;
      const needle = `/@${handle}`;

      let node: Element | null = block;
      for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
        const links = Array.from(node.querySelectorAll('a[href^="/@"]'));
        for (const a of links) {
          const href = (a.getAttribute("href") || "");
          if (href.includes(needle)) {
            return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    }

    const rawBlocks = Array.from(document.querySelectorAll("div.x1a6qonq"));
    const items = rawBlocks.map(block => {
      const full = getBlockText(block);
      const hasCyr = /[А-Яа-яЁё]/.test(full);
      const isAuthor = isBlockByAuthor(block, authorHandle);
      return { full, hasCyr, isAuthor };
    }).filter(it => it.full && it.hasCyr);

    if (!items.length) {
      return { postText: "", comments: [] as string[] };
    }

    // пост = первый кириллический блок автора, иначе первый кириллический
    let postIndex = items.findIndex(it => it.isAuthor);
    if (postIndex === -1) postIndex = 0;

    const postText = items[postIndex].full;
    const comments: string[] = [];

    // после поста: берём ТОЛЬКО подряд идущие блоки автора
    for (let i = postIndex + 1; i < items.length; i++) {
      const it = items[i];
      if (it.isAuthor) {
        comments.push(it.full);
      } else {
        break;
      }
    }

    return { postText, comments };
  }, authorHandle);

  console.log("    Автор:", authorField || "(не найден)");
  console.log("    Текст поста (обрезан):", (postText || "").slice(0, 150), "...");
  console.log("    Комментов автора найдено:", comments.length);

  // ---- запись поста ----
  const rowPost = {
    keyword,
    status: "пост",
    url: normalizedUrl,
    author: authorField,
    text: postText || "",
    views: viewsCount ?? null,
    comments: null
  };
  await sendRow(rowPost);

  // ---- запись ТОЛЬКО авторских комментов ----
  for (const cText of comments) {
    const rowComment = {
      keyword,
      status: "комментарий",
      url: normalizedUrl,
      author: authorField,
      text: cText,
      views: viewsCount ?? null,
      comments: null
    };
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
