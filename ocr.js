// ocr.js — folio/fecha/total/mesero (con preprocesado, Tesseract e IA opcional)

const DBG = { lines: [], notes: [] };
function dbgNote(s) { try { DBG.notes.push(String(s)); } catch {} }
function dbgDump() {
  const el = document.getElementById("ocrDebug");
  if (!el) return;
  el.textContent =
    "[NOTAS]\n" + DBG.notes.join("\n") +
    "\n\n[LINEAS]\n" + DBG.lines.map((s, i) => `${String(i).padStart(2, "0")}: ${s}`).join("\n");
}

// Opción A (directo): coloca tu API key aquí si NO usarás proxy
const OPENAI_API_KEY = ""; // ej. "sk-proj-xxxx"
// Opción B (proxy en Cloud Run/Functions) — recomendado en cliente web
const OPENAI_PROXY_ENDPOINT = window.OPENAI_PROXY_ENDPOINT || "";

/* ====== UI helpers ====== */
function setIABadge(state, msg) {
  const el = document.getElementById('iaBadge');
  if (!el) return;
  if (state === 'ok')      { el.style.background = '#2e7d32'; el.textContent = `IA: OK ${msg||''}`; }
  else if (state === 'err'){ el.style.background = '#c62828'; el.textContent = `IA: ERROR ${msg||''}`; }
  else                     { el.style.background = '#444';    el.textContent = `IA: ${msg||'esperando…'}`; }
}

/* ====== Utils num/fecha/folio/total ====== */
function fixOcrDigits(s) {
  return s
    .replace(/(?<=\d)[Oo](?=\d)/g, "0")
    .replace(/(?<=\d)S(?=\d)/g, "5")
    .replace(/(?<=\d)[lI](?=\d)/g, "1");
}
function splitLines(text) {
  const arr = String(text || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((s) => fixOcrDigits(s.replace(/\s{2,}/g, " ").trim()))
    .filter(Boolean);
  DBG.lines = arr.slice();
  return arr;
}
function normalizeNum(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s) return null;

  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(".") > s.lastIndexOf(",")) s = s.replace(/,/g, "");
    else s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    const m = s.match(/,\d{2}$/);
    s = m ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? +n.toFixed(2) : null;
}
function extractDateISO(text) {
  const m = String(text || "").match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/);
  if (!m) return "";
  let d = +m[1], mo = +m[2], y = +m[3];
  if (d <= 12 && mo > 12) [d, mo] = [mo, d];
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  dbgNote(`Fecha detectada: ${iso}`);
  return iso;
}

function extractFolio(lines) {
  const isDate = (s) => /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/.test(s);
  const isTime = (s) => /(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(s);
  const iD = lines.findIndex(isDate);
  const iT = lines.findIndex(isTime);
  const iM = lines.findIndex((s) => /\bmesero\b|\bmesa\b|\bclientes?\b/i.test(s));
  const anchor = (iD >= 0 || iT >= 0) ? Math.max(iD, iT) : -1;
  const from = Math.max(iM >= 0 ? iM : 0, anchor >= 0 ? anchor : 0);
  const to = Math.min(lines.length - 1, from + 6);

  const pick5 = (s) => {
    if (/cp\s*\d{5}/i.test(s)) return null;
    const m = s.match(/\b(\d{5})\b/g);
    return m ? m[m.length - 1] : null;
  };

  for (let i = from; i <= to; i++) {
    const c = pick5(lines[i]);
    if (c) { dbgNote(`Folio 5d detectado @${i}: ${c}`); return c; }
  }

  for (let i = 0; i < Math.min(15, lines.length); i++) {
    const m = lines[i].match(/\b(\d{3,7})\b/);
    if (m) { dbgNote(`Folio alterno @${i}: ${m[1]}`); return m[1]; }
  }
  dbgNote("Folio no encontrado");
  return "";
}

/* ============================================================
   ✅ TOTAL MEJORADO (prioridad absoluta a la línea "Total 566.00")
   - NO toma Sub-total, IVA, Impt.Total, Propina, Tip, etc.
   - Si no encuentra un Total válido, NO inventa.
   ============================================================ */
function detectGrandTotal(lines) {
  const isCard = (s) => /\b(visa|master|amex|tarjeta|card)\b/i.test(s);

  // Normalización para comparar etiquetas (tolerante a OCR)
  const norm = (s) => String(s || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Extrae el ÚLTIMO número con centavos de una línea
  const grabLastMoney = (s) => {
    const mm = String(s).match(/(\$?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\$?\s*\d+(?:[.,]\d{2}))/g);
    if (!mm || !mm.length) return null;
    return normalizeNum(mm[mm.length - 1]);
  };

  // ========= 1) Detectar SUBTOTAL e IVA para calcular "esperado" =========
  let subtotal = null;
  let iva = null;

  const RX_SUB = /\b(sub\s*[- ]?\s*total|subtotal)\b/i;
  const RX_IVA = /\biva\b|\bimpuesto\b/i;

  for (let i = 0; i < lines.length; i++) {
    const l0 = String(lines[i] || "");
    const l = norm(l0);
    if (isCard(l)) continue;

    // Subtotal
    if (subtotal == null && RX_SUB.test(l0)) {
      const v = grabLastMoney(l0) ?? grabLastMoney(lines[i + 1] || "");
      if (Number.isFinite(v)) {
        subtotal = v;
        dbgNote(`Subtotal detectado: ${subtotal} @${i}`);
      }
      continue;
    }

    // IVA (evita confundir con "Impt.Total" si viene aparte)
    if (iva == null && RX_IVA.test(l0) && !/\bimpt\.?\s*total\b|\bimp\.?\s*total\b/i.test(l0)) {
      const v = grabLastMoney(l0) ?? grabLastMoney(lines[i + 1] || "");
      if (Number.isFinite(v)) {
        iva = v;
        dbgNote(`IVA detectado: ${iva} @${i}`);
      }
      continue;
    }
  }

  const expected = (Number.isFinite(subtotal) && Number.isFinite(iva))
    ? +((subtotal + iva).toFixed(2))
    : null;

  if (expected != null) dbgNote(`Expected (subtotal+iva): ${expected}`);

  // ========= 2) Buscar candidatos SOLO en líneas que digan "Total" =========
  // Reglas para ignorar totales NO deseados
  const BAD = /\b(sub\s*[- ]?\s*total|subtotal|iva|impuesto|impt\.?\s*total|imp\.?\s*total|propina|tip|cambio|efectivo|pago)\b/i;

  // "Total" bueno: contiene total pero NO contiene BAD
  const isGoodTotalLabel = (line) => {
    if (!/\btotal\b/i.test(line)) return false;
    if (BAD.test(line)) return false;
    return true;
  };

  // Candidatos con score
  const cands = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i] || "");
    if (isCard(raw)) continue;

    if (isGoodTotalLabel(raw)) {
      // Caso A: Total + monto en la misma línea
      let v = grabLastMoney(raw);

      // Caso B: Total en una línea y monto en la siguiente
      if (v == null) {
        const next = String(lines[i + 1] || "");
        if (next && !BAD.test(next)) v = grabLastMoney(next);
      }

      if (Number.isFinite(v)) {
        let score = 100;

        // Preferir si coincide con expected
        if (expected != null) {
          const diff = Math.abs(v - expected);
          // mientras más cerca, mejor
          score += Math.max(0, 50 - diff * 20); // diff 0 => +50, diff 1 => +30, diff 2 => +10
        }

        // Bonus si la línea es exactamente "total" (muy común en tu foto)
        const n = norm(raw);
        if (n === "total" || n.startsWith("total ")) score += 10;

        cands.push({ v, i, score, raw });
        dbgNote(`Cand TOTAL: ${v} score=${score} @${i} (${raw})`);
      }
    }
  }

  // ========= 3) Si hay expected, usarlo para escoger el mejor candidato =========
  if (cands.length) {
    cands.sort((a, b) => b.score - a.score);
    const pick = cands[0];

    // Si hay expected, y el mejor candidato se aleja muchísimo, preferimos expected
    if (expected != null) {
      const diff = Math.abs(pick.v - expected);

      // tolerancia (tickets reales tienen 1-2 centavos a veces por OCR)
      if (diff <= 1.00) {
        dbgNote(`Total elegido (cand cercano a expected): ${pick.v} diff=${diff}`);
        return pick.v;
      }

      // Si el OCR leyó mal el total pero sí leyó bien subtotal+iva, usar expected
      // (esto evita “inventos” en cuentas altas)
      dbgNote(`Total cand lejos (diff=${diff}). Uso expected=${expected}`);
      return expected;
    }

    dbgNote(`Total elegido (sin expected): ${pick.v}`);
    return pick.v;
  }

  // ========= 4) Si NO encontramos TOTAL por etiqueta, pero sí tenemos expected, usarlo =========
  if (expected != null) {
    dbgNote(`No hallé etiqueta TOTAL. Uso expected subtotal+iva: ${expected}`);
    return expected;
  }

  // ========= 5) Sin total: regresar null (NO inventar) =========
  dbgNote("Total no encontrado (sin inventar)");
  return null;
}


/* ============================================================
   ✅ MESERO MEJORADO (tolerante a OCR: MESER0, M E S E R O, etc.)
   - NO inventa: si no lo ve, regresa ""
   ============================================================ */
function extractMesero(rawText, lines) {
  const t = String(rawText || "");

  // Normaliza "M E S E R O" → "MESERO"
  const tNorm = t.replace(/M\s*E\s*S\s*E\s*R\s*O/gi, "MESERO");

  // 1) Regex que captura el nombre junto a MESERO, y se corta antes de fecha/hora/números
  // Soporta: "Mesero: BRAYAN", "MESER0: BRAYAN", "Mesero - BRAYAN 24/09/2025"
  const rx1 = /(?:^|\n)\s*MESER[O0]\s*[:;\-]?\s*([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,}){0,3})/i;
  let m = tNorm.match(rx1);
  if (m && m[1]) {
    let name = String(m[1])
      .replace(/[^A-ZÁÉÍÓÚÑ\s]/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (name) {
      dbgNote(`Mesero (rx1): ${name}`);
      return name.toUpperCase();
    }
  }

  // 2) Por líneas (cuando OCR rompe el texto)
  const arr = Array.isArray(lines) && lines.length ? lines : splitLines(tNorm);

  for (let i = 0; i < arr.length; i++) {
    const line = String(arr[i] || "")
      .replace(/M\s*E\s*S\s*E\s*R\s*O/gi, "MESERO")
      .trim();

    if (!/meser[ო0]/i.test(line) && !/meser/i.test(line)) continue;
    if (/\bmesa\b/i.test(line)) continue;

    const after = line.replace(/.*?meser[o0]\s*[:;\-]?\s*/i, "").trim();
    const after2 = (after + " " + String(arr[i + 1] || "")).trim();

    const tokens = after2.split(/\s+/g);
    const nameParts = [];

    for (const tok0 of tokens) {
      // si viene fecha/hora/número, cortamos
      if (/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]20\d{2}/.test(tok0)) break;
      if (/\b(am|pm)\b/i.test(tok0)) break;
      if (/^\d+$/.test(tok0)) break;

      const tok = tok0.replace(/[^\p{L}]/gu, "").toUpperCase().trim();
      if (!tok) continue;
      if (tok.length < 2) continue;

      nameParts.push(tok);
      if (nameParts.length >= 4) break;
    }

    const name = nameParts.join(" ").trim();
    if (name) {
      dbgNote(`Mesero (lines): ${name}`);
      return name;
    }
  }

  dbgNote("Mesero no encontrado");
  return "";
}

/* ====== DETECTOR: ¿PARECE UN TICKET? ====== */
function isLikelyTicket(text, lines) {
  const upper = String(text || "").toUpperCase();

  const hasBrand =
    /APPLEBEE'?S/.test(upper) ||
    /WENDY'?S/.test(upper) ||
    /GREAT AMERICAN/.test(upper) ||
    /GA HOSPITALITY/.test(upper);

  const hasTicketWord = /\bTICKET\b|\bCUENTA\b|\bCONSUMO\b/.test(upper);
  const hasMesa    = /\bMESA\b/.test(upper);
  const hasTotalW  = /(TOTAL( A PAGAR)?|IMPORTE TOTAL|TOTAL MXN|TOTAL CON PROPINA|IMPT\.?\s*TOTAL)/i.test(text);
  const hasDate    = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/.test(text);

  const moneyMatches = text.match(/\$?\s*\d{2,3}(?:[.,]\d{3})*[.,]\d{2}/g) || [];

  if (lines.length < 5) return false;

  const rule1 = hasBrand && hasDate && moneyMatches.length >= 1;
  const rule2 = hasTicketWord && hasTotalW && moneyMatches.length >= 1;
  const rule3 = hasTotalW && moneyMatches.length >= 2 && lines.length >= 8;
  const rule4 = hasMesa && hasDate && moneyMatches.length >= 1;

  const ok = rule1 || rule2 || rule3 || rule4;
  dbgNote(`isLikelyTicket: ${ok ? 'SÍ' : 'NO'} (brand=${hasBrand}, totalW=${hasTotalW}, money=${moneyMatches.length}, lines=${lines.length})`);
  return ok;
}

/* ====== PREPROCESADO IMAGEN ====== */
async function preprocessImage(file) {
  const bmp = await createImageBitmap(file);
  let w = bmp.width, h = bmp.height, rotate = false;
  if (w > h * 1.6) rotate = true;

  const targetH = 2800;
  const scale = Math.max(1.4, Math.min(3.2, targetH / (rotate ? w : h)));

  const c = document.createElement("canvas");
  if (rotate) { c.width = Math.round(h * scale); c.height = Math.round(w * scale); }
  else { c.width = Math.round(w * scale); c.height = Math.round(h * scale); }

  const ctx = c.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.35) brightness(1.05)";
  if (rotate) {
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bmp, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
  } else {
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
  }

  if (typeof cv !== "undefined" && cv?.Mat) {
    try {
      let src = cv.imread(c);
      let gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      let bw = new cv.Mat();
      cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 35, 5);
      cv.imshow(c, bw);
      src.delete(); gray.delete(); bw.delete();
    } catch (e) {
      console.warn("OpenCV preprocess falló:", e);
    }
  }
  return c;
}

/* ====== Tesseract ====== */
async function runTesseract(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.97));
  const { data } = await Tesseract.recognize(blob, "spa+eng", {
    tessedit_pageseg_mode: "4",
    preserve_interword_spaces: "1",
    user_defined_dpi: "360",
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:#/$., ",
  });
  return data.text || "";
}

/* ====== IA (folio, fecha, total, mesero) ====== */
async function callOpenAI(rawText) {
  if (!OPENAI_API_KEY && !OPENAI_PROXY_ENDPOINT) {
    setIABadge('err', '(sin clave/proxy)');
    throw new Error("No hay API KEY ni proxy configurado");
  }

  const sys =
`Eres un parser de tickets de restaurante en México.
Debes responder **solo** JSON válido con este shape exacto:
{
  "folio": "string (5-7 dígitos o vacío si no se ve)",
  "fecha": "YYYY-MM-DD (o vacío)",
  "total": number,
  "mesero": "string (nombre del mesero o vacío)"
}
Reglas:
- No inventes datos; si no se ve, deja "" o 0.
- "total" debe ser el TOTAL final del ticket. Si solo ves subtotal/iva/impt.total/propina, pon 0.
- "mesero" normalmente aparece como "Mesero: NOMBRE".
- Responde SOLO el JSON, sin texto adicional.`;

  const user = `Texto OCR sin modificar:\n${rawText}\n\nResponde SOLO el JSON indicado.`;

  const started = performance.now();
  setIABadge(null, 'llamando…');

  try {
    if (OPENAI_PROXY_ENDPOINT) {
      const resp = await fetch(OPENAI_PROXY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText, sys })
      });
      const took = Math.round(performance.now() - started);
      if (!resp.ok) {
        const txt = await resp.text().catch(()=> '');
        setIABadge('err', `HTTP ${resp.status}`);
        dbgNote(`IA(proxy) ERROR ${resp.status} en ${took}ms: ${txt}`);
        throw new Error("Proxy IA respondió error: " + resp.status);
      }
      const j = await resp.json();
      setIABadge('ok', `${took}ms`);
      dbgNote(`IA(proxy) OK en ${took}ms`);
      return j;
    }

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    const took = Math.round(performance.now() - started);
    if (!resp.ok) {
      const txt = await resp.text().catch(()=> '');
      setIABadge('err', `HTTP ${resp.status}`);
      dbgNote(`IA(Direct) ERROR ${resp.status} en ${took}ms: ${txt}`);
      throw new Error("OpenAI error: " + txt);
    }

    const data = await resp.json();
    setIABadge('ok', `${took}ms`);
    dbgNote(`IA(Direct) OK en ${took}ms`);
    const content = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  } catch (e) {
    setIABadge('err', 'excepción');
    throw e;
  }
}

/* ============================================================
   ✅ FUNCIÓN PRINCIPAL (la que usa registrar.js)
   ============================================================ */
window.processTicketWithIA = async function processTicketWithIA(file) {
  DBG.lines = [];
  DBG.notes = [];
  dbgNote("processTicketWithIA: inicio");

  // 1) Preprocesado
  const canvas = await preprocessImage(file);
  dbgNote(`preprocess: ok (${canvas.width}x${canvas.height})`);

  // 2) OCR
  const rawText = await runTesseract(canvas);
  dbgNote(`tesseract chars: ${rawText.length}`);

  const lines = splitLines(rawText);
  dbgNote(`lines: ${lines.length}`);

  // 3) Validación básica (si no parece ticket)
  if (!isLikelyTicket(rawText, lines)) {
    dbgNote("No parece ticket (isLikelyTicket=false)");
    setIABadge('err', '(no ticket)');
    dbgDump();
    return { folio:"", fecha:"", total:0, mesero:"" };
  }

  // 4) Extracción por heurísticas
  let folio = extractFolio(lines);
  let fecha = extractDateISO(rawText);
  let total = detectGrandTotal(lines);
  let mesero = extractMesero(rawText, lines);

  dbgNote(`heurística -> folio=${folio} fecha=${fecha} total=${total} mesero=${mesero}`);

  // 5) IA opcional (si está configurada)
  // ✅ REGLA: La IA SOLO puede completar lo que falte.
  // ✅ Y NO puede sobre-escribir un TOTAL ya encontrado por heurística.
  try {
    if (OPENAI_API_KEY || OPENAI_PROXY_ENDPOINT) {
      const j = await callOpenAI(rawText);

      if (j && typeof j === "object") {
        if (!folio && j.folio) folio = String(j.folio).trim();
        if (!fecha && j.fecha) fecha = String(j.fecha).trim();

        // 👇 IMPORTANTE: solo usar IA para total si NO encontramos total por heurística
        if ((!total || total === 0) && Number.isFinite(j.total)) total = Number(j.total);

        if (!mesero && j.mesero) mesero = String(j.mesero).trim();

        dbgNote(`IA merge -> folio=${folio} fecha=${fecha} total=${total} mesero=${mesero}`);
      }
    }
  } catch (e) {
    dbgNote("IA falló, se usa heurística");
  }

  // Normalizaciones finales
  if (!/^\d{5,7}$/.test(String(folio||""))) folio = String(folio||"").match(/\b\d{5,7}\b/)?.[0] || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha||""))) fecha = "";
  if (!Number.isFinite(total)) total = 0;

  if (mesero) {
    mesero = String(mesero)
      .replace(/[^A-ZÁÉÍÓÚÑ\s]/gi, "")
      .replace(/\s+/g," ")
      .trim()
      .toUpperCase();
  } else {
    mesero = "";
  }

  dbgDump();

  return {
    folio,
    fecha,
    total,
    mesero
  };
};
