/*
 * quiz2gift.js — ядро конвертера iSpring .quiz → GIFT (Teachbase).
 * Используется и в браузере (вместе с index.html), и в Node.js для тестов.
 * Зависит от глобала JSZip (CDN) в браузере; в Node требует npm-пакет jszip.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("jszip"));
  } else {
    root.Quiz2Gift = factory(root.JSZip);
  }
})(typeof self !== "undefined" ? self : this, function (JSZip) {
  "use strict";

  const NON_QUESTION_TYPES = new Set(["IntroSlide", "ResultSlide", "BlankSlide", "InfoSlide"]);
  const UNSUPPORTED_TYPES = {
    Hotspot: "вопрос «укажи область на картинке» в GIFT не поддерживается",
    WordBank: "вопрос «банк слов» в GIFT не поддерживается",
    DragAndDrop: "вопрос «перетаскивание» в GIFT не поддерживается",
    LikertScale: "шкала Ликерта (опрос) в GIFT не поддерживается",
  };
  const TRUE_WORDS = new Set(["верно", "true", "да", "правда", "истина", "yes", "т"]);
  const FALSE_WORDS = new Set(["неверно", "false", "нет", "ложь", "no", "нправда", "f"]);

  // --- извлечение текста -------------------------------------------------

  let ASSETS = {};

  function textOf(rich, images) {
    if (!rich || typeof rich !== "object") return "";
    const lines = [];
    for (const para of rich.d || []) {
      if (!para || typeof para !== "object") continue;
      let s = "";
      for (const run of para.c || []) {
        const tp = run.tp || "text";
        if (tp === "text") {
          s += run.t || "";
        } else if (tp === "image") {
          let src = run.src;
          if (!src && run.I && ASSETS.image && ASSETS.image[String(run.I)]) {
            src = ASSETS.image[String(run.I)].src;
          }
          if (src) images.push(src);
        }
      }
      lines.push(s);
    }
    return lines.join("\n").replace(/^\n+|\n+$/g, "");
  }

  const resolveStorage = (src) =>
    src.startsWith("storage://") ? src.slice("storage://".length) : src;

  // --- экранирование GIFT ------------------------------------------------

  function escQuestion(text) {
    text = text.trim()
      .replace(/\{/g, "\\{").replace(/\}/g, "\\}");
    text = text.replace(/^([\[\$])/gm, " $1");
    text = text.replace(/\n{3,}/g, "\n\n").replace(/\n[ \t]*\n+/g, "\n");
    return text;
  }

  function escAnswer(text) {
    for (const ch of ["=", "~", "#", "{", "}"]) {
      text = text.split(ch).join("\\" + ch);
    }
    return text.trim();
  }

  const sanitizeFilename = (name) =>
    name.replace(/ё/g, "е").replace(/Ё/g, "Е")
      .replace(/[^0-9A-Za-zА-Яа-я_\- .()?!]/g, "_")
      .replace(/_+/g, "_");

  // --- конвертеры типов --------------------------------------------------

  function choicesOf(q) {
    return (q.C && q.C.chs || []).map((ch) => {
      const images = [];
      const txt = textOf(ch.t, images).trim();
      return { txt, ok: !!ch.c };
    });
  }

  function giftChoice(builder, q, multiple) {
    let choices = choicesOf(q);
    if (!choices.length) {
      builder.warn(`вопрос ${q.i || "?"}: нет вариантов ответа — пропущен`);
      return null;
    }
    const nCorrect = choices.filter((c) => c.ok).length;
    if (!nCorrect) {
      builder.warn(`вопрос ${q.i || "?"}: нет ни одного правильного ответа, первый вариант помечен правильным`);
      choices = [{ txt: choices[0].txt, ok: true }].concat(choices.slice(1));
    } else if (!multiple && nCorrect > 1) {
      builder.warn(`вопрос ${q.i || "?"}: у вопроса с одним ответом помечено несколько правильных — правильным оставлен первый`);
      let seen = false;
      choices = choices.map((c) => {
        if (c.ok && !seen) { seen = true; return c; }
        return { txt: c.txt, ok: false };
      });
    } else if (nCorrect === choices.length) {
      builder.warn(`вопрос ${q.i || "?"}: все варианты правильные — Teachbase превратил бы вопрос в свободный ввод, последний вариант сделан неверным`);
      choices = choices.slice(0, -1).concat([{ txt: choices[choices.length - 1].txt, ok: false }]);
    }
    const body = choices.map((c) => `${c.ok ? "=" : "~"}${escAnswer(c.txt)}`).join("\n");
    return "{\n" + body + "\n}";
  }

  function giftTrueFalse(q) {
    for (const { txt, ok } of choicesOf(q)) {
      const word = txt.trim().toLowerCase().replace(/[.!]+$/, "");
      if (ok) {
        if (TRUE_WORDS.has(word)) return "{T}";
        if (FALSE_WORDS.has(word)) return "{F}";
      }
    }
    return null;
  }

  function giftShortAnswer(builder, q) {
    const answers = choicesOf(q).filter((c) => c.ok && c.txt).map((c) => c.txt);
    if (!answers.length) {
      builder.warn(`вопрос ${q.i || "?"}: свободный ответ без допустимых вариантов — пропущен`);
      return null;
    }
    return "{" + answers.map((a) => "=" + escAnswer(a)).join(" ") + "}";
  }

  function giftNumeric(builder, q) {
    const vals = [];
    for (const { txt, ok } of choicesOf(q)) {
      if (!ok || !txt) continue;
      const m = txt.replace(",", ".").match(/^\s*(-?[\d.]+)\s*$/);
      if (m) vals.push(m[1]);
      else {
        builder.warn(`числовой вопрос ${q.i || "?"}: не числовой ответ «${txt}» преобразован как есть`);
        vals.push(txt);
      }
    }
    if (!vals.length) {
      builder.warn(`числовой вопрос ${q.i || "?"}: нет ответов — пропущен`);
      return null;
    }
    return "{#" + escAnswer(vals[0]) + "}";
  }

  function giftMatching(builder, q) {
    const pairs = [];
    for (const ch of q.C && q.C.chs || []) {
      const images = [];
      const left = textOf(ch.t, images).trim();
      let right = null;
      for (const key of ["r", "mt", "match", "right"]) {
        if (ch[key] != null) {
          right = typeof ch[key] === "object" ? textOf(ch[key], images) : String(ch[key]);
          break;
        }
      }
      if (left && right && right.trim()) pairs.push([left, right.trim()]);
    }
    if (pairs.length < 2) return null;
    const seen = new Set();
    const body = pairs.map(([l, r]) => {
      let left = l;
      if (seen.has(left)) left += " "; // одинаковые левые части в GIFT схлопываются
      seen.add(left);
      return `=${escAnswer(left)} -> ${escAnswer(r)}`;
    });
    return "{\n" + body.join("\n") + "\n}";
  }

  function giftSequence(builder, q) {
    const items = [];
    (q.C && q.C.chs || []).forEach((ch, i) => {
      const images = [];
      const txt = textOf(ch.t, images).trim();
      let pos = null;
      for (const key of ["o", "order", "pos", "p"]) {
        if (typeof ch[key] === "number" || typeof ch[key] === "string") {
          pos = parseInt(ch[key], 10);
          if (!isNaN(pos)) break;
          pos = null;
        }
      }
      if (pos == null) pos = i + 1;
      if (txt) items.push([pos, txt]);
    });
    if (items.length < 2) return null;
    const width = Math.max(2, String(items.length).length);
    const body = items.sort((a, b) => a[0] - b[0])
      .map(([pos, txt]) => `=${escAnswer(txt)} <- ${String(pos).padStart(width, "0")}`);
    return "{\n" + body.join("\n") + "\n}";
  }

  function convertQuestion(builder, q) {
    const tp = q.tp || "";
    const imgRefs = [];
    let qtext = escQuestion(textOf(q.D, imgRefs));
    if (!qtext) {
      builder.warn(`вопрос типа ${tp} (${q.i || "?"}): пустой текст — пропущен, иначе импорт всего файла упадёт`);
      return;
    }
    let block = null;
    if (tp === "MultipleChoice") block = giftChoice(builder, q, false);
    else if (tp === "MultipleResponse") block = giftChoice(builder, q, true);
    else if (tp === "TrueFalse") {
      block = giftTrueFalse(q);
      if (!block) builder.warn(`TrueFalse ${q.i || "?"}: не удалось определить правильный ответ — пропущен`);
    } else if (tp === "FillInTheBlank" || tp === "ShortAnswer") block = giftShortAnswer(builder, q);
    else if (tp === "Numeric") block = giftNumeric(builder, q);
    else if (tp === "Matching") {
      block = giftMatching(builder, q);
      if (!block) builder.warn(`Matching ${q.i || "?"}: не найдены пары — пропущен`);
    } else if (tp === "Sequence") {
      block = giftSequence(builder, q);
      if (!block) builder.warn(`Sequence ${q.i || "?"}: не найден порядок — пропущен`);
    } else if (tp === "Essay") block = "{}";
    else if (UNSUPPORTED_TYPES[tp]) {
      builder.warn(`тип «${tp}» (${q.i || "?"}): ${UNSUPPORTED_TYPES[tp]} — пропущен`);
      builder.stats["пропущено (не поддерживается)"] = (builder.stats["пропущено (не поддерживается)"] || 0) + 1;
      return;
    } else {
      builder.warn(`неизвестный тип «${tp}» (${q.i || "?"}) — пропущен`);
      builder.stats["пропущено (неизвестный тип)"] = (builder.stats["пропущено (неизвестный тип)"] || 0) + 1;
      return;
    }
    if (!block) return;
    builder.stats[tp] = (builder.stats[tp] || 0) + 1;

    const fileLines = [];
    for (const ref of imgRefs) {
      const inner = resolveStorage(ref);
      const arcPath = "images/" + sanitizeFilename(inner.split("/").pop());
      builder.images[arcPath] = inner;
      fileLines.push("/" + arcPath);
    }
    const parts = [qtext];
    if (fileLines.length) parts.push("[files]\n" + fileLines.join("\n"));
    parts.push(block);
    builder.blocks.push(parts.join("\n"));
  }

  // --- публичный API -----------------------------------------------------

  /**
   * Конвертирует один .quiz-архив (ArrayBuffer/Buffer).
   * Возвращает { filename, blob|buffer (zip или текст), isZip, giftText, warnings, stats }.
   */
  async function convert(quizData, quizName, forceZip) {
    const builder = { blocks: [], images: {}, warnings: [], stats: {} };
    builder.warn = (m) => builder.warnings.push(m);

    const zip = await JSZip.loadAsync(quizData);
    const docFile = zip.file("document.json");
    if (!docFile) throw new Error("В архиве нет document.json — это не тест iSpring QuizMaker");
    const doc = JSON.parse(await docFile.async("string"));
    ASSETS = doc.A || {};
    const quizTitle = doc.T || quizName.replace(/\.quiz$/i, "");

    let sections = [];
    for (const grp of (doc.sl && doc.sl.g) || []) {
      const cat = (grp.T || "").trim();
      const before = builder.blocks.length;
      for (const q of grp.S || []) {
        if (NON_QUESTION_TYPES.has(q.tp)) continue;
        convertQuestion(builder, q);
      }
      sections.push([cat, builder.blocks.slice(before)]);
    }

    // Одна группа в тесте — не повод для $CATEGORY: служебное название
    // («Импортированные вопросы») пользы не даёт, а файл с $CATEGORY обязан
    // начинаться с неё первой строкой. Категории пишем, только если групп
    // несколько — тогда разбивка переносится осмысленно.
    if (sections.length === 1) sections = [[null, sections[0][1]]];

    const chunks = [];
    for (const [cat, blocks] of sections) {
      if (cat) chunks.push("$CATEGORY: " + cat);
      chunks.push(...blocks);
    }
    // Служебные комментарии в файл не пишем: Teachbase игнорирует строки //,
    // но пустые строки вокруг них ломают импорт — и в начале, и в конце файла.
    const giftText = chunks.filter((c) => c).join("\n\n") + "\n";

    const hasImages = Object.keys(builder.images).length > 0;
    let filename, payload, isZip;
    const base = quizName.replace(/\.quiz$/i, "");
    const inBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";
    if (hasImages || forceZip) {
      const out = new JSZip();
      out.file("gift.txt", giftText);
      for (const [arcPath, inner] of Object.entries(builder.images)) {
        const f = zip.file(inner);
        if (f) out.file(arcPath, await f.async(inBrowser ? "blob" : "nodebuffer"));
        else builder.warnings.push(`файл ${inner} не найден в архиве — пропущен`);
      }
      filename = base + "_gift.zip";
      payload = await out.generateAsync({
        type: inBrowser ? "blob" : "nodebuffer",
        compression: "DEFLATE",
      });
      isZip = true;
    } else {
      filename = base + "_gift.txt";
      payload = typeof Buffer !== "undefined" ? Buffer.from(giftText, "utf-8") : giftText;
      isZip = false;
    }
    return { filename, payload, isZip, giftText, warnings: builder.warnings, stats: builder.stats };
  }

  return { convert };
});
