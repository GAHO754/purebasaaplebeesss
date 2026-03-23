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

  // 1. Limpieza inicial: quitar $, letras y espacios raros, pero mantener el signo menos y separadores
  let s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s) return null;

  // 2. Manejo de separadores (Puntos y Comas)
  // Si hay ambos (ej: 1,250.50 o 1.250,50)
  if (s.includes(",") && s.includes(".")) {
    // Si el punto está al final, es el decimal (formato US: 1,250.50)
    if (s.lastIndexOf(".") > s.lastIndexOf(",")) {
      s = s.replace(/,/g, ""); // Quitamos la coma de miles
    } else {
      // Si la coma está al final, es el decimal (formato EU: 1.250,50)
      s = s.replace(/\./g, "").replace(",", ".");
    }
  } 
  // 3. Si solo hay COMAS (ej: 566,00)
  else if (s.includes(",")) {
    // Si hay exactamente 2 dígitos tras la coma, es decimal
    const m = s.match(/,(\d{2})$/);
    if (m) {
      s = s.replace(",", ".");
    } else {
      // Si no, era un separador de miles erróneo
      s = s.replace(/,/g, "");
    }
  }

  // 4. Conversión final
  const n = parseFloat(s);
  
  // Verificamos que sea un número real y no un NaN
  if (!Number.isFinite(n)) return null;

  // Retornamos con máximo 2 decimales (importante para el dinero)
  return Math.round((n + Number.EPSILON) * 100) / 100;
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

// ✅ SUCURSAL AUTOMÁTICA
function extractStore(rawText) {
  const upper = String(rawText || "").toUpperCase();
  if (upper.includes("TORRES")) return { id: "Torres", name: "Applebee's Torres" };
  if (upper.includes("TECNOLOGICO")) return { id: "Tecnologico", name: "Applebee's Tecnológico" };
  if (upper.includes("TRIUNFO")) return { id: "Paseo Triunfo", name: "Applebee's Paseo Triunfo" };
  return { id: "APB_PASEO", name: "Applebee’s Paseo Central" };
}

/* ============================================================
   ✅ TOTAL INTELIGENTE (Estructura Final Blindada)
   Prioridad 1: Subtotal + IVA (Blindaje contra propinas)
   Prioridad 2: Etiqueta "TOTAL" (Limpia de palabras prohibidas)
   ============================================================ */
function detectGrandTotal(lines) {
    // Helpers internos
    const isCard = (s) => /\b(visa|master|amex|tarjeta|card)\b/i.test(s);
    
    const norm = (s) => String(s || "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const grabLastMoney = (s) => {
        // Busca el último monto con decimales en la línea
        const mm = String(s).match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (!mm || !mm.length) return null;
        return normalizeNum(mm[mm.length - 1]);
    };

    let subtotal = null;
    let iva = null;
    const RX_SUB = /\b(sub\s*[- ]?\s*total|subtotal)\b/i;
    const RX_IVA = /\biva\b|\bimpuesto\b/i;

    // --- PASO 1: Buscar Subtotal e IVA para cálculo forzado ---
    for (let i = 0; i < lines.length; i++) {
        const l0 = String(lines[i] || "");
        if (isCard(l0)) continue;

        if (subtotal === null && RX_SUB.test(l0)) {
            subtotal = grabLastMoney(l0) ?? grabLastMoney(lines[i + 1] || "");
            if (subtotal) dbgNote(`Subtotal hallado: ${subtotal}`);
        }

        // Buscamos IVA (evitando líneas que ya digan TOTAL)
        if (iva === null && RX_IVA.test(l0) && !/total/i.test(l0)) {
            iva = grabLastMoney(l0) ?? grabLastMoney(lines[i + 1] || "");
            if (iva) dbgNote(`IVA hallado: ${iva}`);
        }
    }

    // REGLA DE ORO: Si tenemos ambos, esta suma manda (ignora propinas automáticamente)
    const expected = (subtotal !== null && iva !== null) ? Number((subtotal + iva).toFixed(2)) : null;
    
    if (expected) {
        dbgNote(`Suma Forzada (Sub+IVA): ${expected}`);
        return expected; // Retorno inmediato: es el dato más seguro
    }

    // --- PASO 2: Si no hay Sub+IVA, buscar etiqueta TOTAL limpia ---
    // Lista negra: Si la línea tiene esto, NO es el total que buscamos
    const BAD = /\b(subtotal|iva|impuesto|propina|tip|gratuit|cambio|efectivo|pago|visa|master)\b/i;

    const cands = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = String(lines[i] || "");
        const n = norm(raw);

        // Si la línea contiene "TOTAL" y no contiene palabras de la lista negra
        if (/\btotal\b/i.test(raw) && !BAD.test(n)) {
            let v = grabLastMoney(raw);
            // Si no hay monto en la misma línea, intentamos en la siguiente
            if (v === null) v = grabLastMoney(lines[i + 1] || "");

            if (Number.isFinite(v) && v > 0) {
                let score = 100;
                
                // Si la línea es SOLO la palabra "total" o "total mxn", sube puntos
                if (n === "total" || n === "total mxn" || n === "total m.n.") score += 20;

                cands.push({ v, score });
                dbgNote(`Candidato Total: ${v} (Score: ${score})`);
            }
        }
    }

    // --- PASO 3: Decisión final ---
    if (cands.length > 0) {
        // Ordenar por score descendente
        cands.sort((a, b) => b.score - a.score);
        return cands[0].v;
    }

    // Si todo falla, intentar buscar el número más grande al final del ticket (Heurística de emergencia)
    dbgNote("Buscando total por valor máximo...");
    const allAmounts = lines.slice(-10).map(l => grabLastMoney(l)).filter(v => v !== null);
    if (allAmounts.length > 0) {
        return Math.max(...allAmounts);
    }

    return 0;
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

  // ✅ Aumentamos el tamaño objetivo a 3500px para que las letras pequeñas del ticket se vean gigantes
  const targetH = 3500;
  const scale = Math.max(1.5, Math.min(4.0, targetH / (rotate ? w : h)));

  const c = document.createElement("canvas");
  if (rotate) { c.width = Math.round(h * scale); c.height = Math.round(w * scale); }
  else { c.width = Math.round(w * scale); c.height = Math.round(h * scale); }

  const ctx = c.getContext("2d");
  
  // ✅ Filtro de "Súper Contraste" para tickets térmicos blancos y negros
  ctx.filter = "grayscale(1) contrast(2.5) brightness(1.10)";
  
  if (rotate) {
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bmp, -w * scale / 2, -h * scale / 2, w * scale, h * scale);
  } else {
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
  }

  // Si tienes OpenCV (cv), el Adaptive Threshold hará el resto
  if (typeof cv !== "undefined" && cv?.Mat) {
    try {
      let src = cv.imread(c);
      let gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      let bw = new cv.Mat();
      // Umbral adaptativo para limpiar sombras de la foto
      cv.adaptiveThreshold(gray, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 45, 7);
      cv.imshow(c, bw);
      src.delete(); gray.delete(); bw.delete();
    } catch (e) { console.warn("OpenCV falló:", e); }
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
    setIABadge('err', '(sin configuración)');
    throw new Error("No hay API KEY ni proxy configurado");
  }

  // ✅ TU PROMPT MAESTRO INTEGRADO
  const sysPrompt = `Actúa como un experto en contabilidad y OCR de tickets de restaurante.
Tu objetivo es extraer el GRAN TOTAL de un ticket de consumo de forma infalible.

REGLAS CRÍTICAS DE NEGOCIO:
1. El TOTAL siempre debe ser mayor o igual al SUBTOTAL.
2. Ignora montos etiquetados como 'SUBTOTAL', 'IMPUESTOS', 'IVA', 'PROPINA', 'TIP' o 'GRATUITY'.
3. Si hay varios montos, el GRAN TOTAL suele ser el número más grande cerca de la parte inferior.
4. "total" debe ser el consumo real + impuestos, PERO SIN LA PROPINA.
5. Devuelve los datos en formato JSON puro.

FORMATO DE SALIDA EXACTO (JSON):
{
  "folio": "string (solo números)",
  "fecha": "YYYY-MM-DD",
  "total": number (ej. 150.50),
  "subtotal": number,
  "mesero": "string (nombre del mesero)"
}`;

  const userPrompt = `Analiza el siguiente texto extraído por OCR del ticket:\n\n${rawText}\n\nExtrae los datos siguiendo tus reglas críticas.`;

  const started = performance.now();
  setIABadge(null, 'IA procesando…');

  try {
    let response;
    
    // Si usas Proxy
    if (OPENAI_PROXY_ENDPOINT) {
      response = await fetch(OPENAI_PROXY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText, sys: sysPrompt })
      });
    } 
    // Si usas API Key directa
    else {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini", // El modelo más rápido y eficiente para esto
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.1, // Baja temperatura = Máxima precisión, cero creatividad
          response_format: { type: "json_object" }
        })
      });
    }

    const took = Math.round(performance.now() - started);
    if (!response.ok) throw new Error(`Error IA: ${response.status}`);

    const data = await response.json();
    setIABadge('ok', `${took}ms`);
    
    // Extraer el contenido según sea Proxy o Directo
    const content = OPENAI_PROXY_ENDPOINT ? data : JSON.parse(data.choices[0].message.content);
    
    dbgNote(`🤖 IA respondió: Total=${content.total}, Folio=${content.folio}`);
    return content;

  } catch (e) {
    setIABadge('err', 'fallo');
    console.error("Error en callOpenAI:", e);
    return null;
  }
}


/* ============================================================
   ✅ AUDITORÍA DE PRODUCTOS (Suma de consumo)
   ============================================================ */
function auditProductSum(lines) {
  let runningSum = 0;
  const productRegex = /(?:^|\s)(\d+)?\s+[A-ZÁÉÍÓÚÑ\s]{3,}\s+(\d+[.,]\d{2})(?:\s|$)/i;

  lines.forEach(line => {
    if (/\b(total|sub|iva|impuesto|propina|tip|pago|cambio)\b/i.test(line.toLowerCase())) return;

    const match = line.match(productRegex);
    if (match) {
      const price = normalizeNum(match[2]);
      if (price && price > 0) {
        runningSum += price;
        dbgNote(`Producto detectado: ${line} -> +${price}`);
      }
    }
  });

  return Math.round((runningSum + Number.EPSILON) * 100) / 100;
}
/* ============================================================
   ✅ FUNCIÓN PRINCIPAL (la que usa registrar.js)
   ============================================================ */
window.processTicketWithIA = async function processTicketWithIA(file) {
  DBG.lines = [];
  DBG.notes = [];
  dbgNote("processTicketWithIA: inicio");

  // 1) Preprocesado y OCR
  const canvas = await preprocessImage(file);
  const rawText = await runTesseract(canvas);
  const lines = splitLines(rawText);

  if (!isLikelyTicket(rawText, lines)) {
    dbgNote("No parece ticket (isLikelyTicket=false)");
    return { folio: "", fecha: "", total: 0, mesero: "", auditOk: false };
  }

  // 2) Extracción Base (Heurística Local)
  let folio = extractFolio(lines);
  let fecha = extractDateISO(rawText);
  let total = detectGrandTotal(lines);
  let mesero = extractMesero(rawText, lines);
  let store = extractStore(rawText);
  let sumaProductos = auditProductSum(lines);

  // 🛡️ REGLA DE SANIDAD LOCAL: ¿El total es un falso positivo?
  const totalEsDudoso = (total > 0 && total === Number(folio)) || (total >= 2024 && total <= 2026);

  if (totalEsDudoso) {
    dbgNote(`⚠️ Total sospechoso descartado (${total}). Coincidía con Folio o Año.`);
    total = 0; 
  }


  // ============================================================
  // 👇 AQUÍ VA EL CÓDIGO QUE ME PASASTE (PASO 3)
  // ============================================================
  try {
    if (OPENAI_API_KEY || OPENAI_PROXY_ENDPOINT) {
      const totalLocal = total; // Guardamos el total detectado localmente

      if (total <= 0 || totalEsDudoso || !folio || !fecha) {
        dbgNote("🤖 Llamando a refuerzo de IA (Verificación de montos)...");
        
        const j = await callOpenAI(rawText); 

        if (j && typeof j === "object") {
          if (!folio && j.folio) folio = String(j.folio).trim();
          if (!fecha && j.fecha) fecha = String(j.fecha).trim();
          if (!mesero && j.mesero) mesero = String(j.mesero).trim();

          const iaTotal = Number(j.total || 0);
          const iaSubtotal = Number(j.subtotal || 0);

          if (iaTotal > 0) {
            if (iaTotal > iaSubtotal) {
              total = iaTotal;
              dbgNote(`🤖 IA Validada: Total $${iaTotal} > Subtotal $${iaSubtotal}`);
            } 
            else if (iaTotal === iaSubtotal && iaTotal > 0) {
              dbgNote("⚠️ IA dio Total igual a Subtotal. Verificando contra local...");
              if (sumaProductos > iaTotal) {
                  total = sumaProductos;
                  dbgNote(`🛡️ Auditoría rescató el total ($${total}) porque IA se quedó en Subtotal.`);
              } else {
                  total = iaTotal;
              }
            }
            else {
              dbgNote(`❌ IA descartada: Monto ilógico (T:$${iaTotal} S:$${iaSubtotal})`);
              total = totalLocal > 0 ? totalLocal : sumaProductos;
            }
          }
        }
      }
    }
  } catch (e) {
    dbgNote("❌ Error en el refuerzo de IA");
  }
  // 3) Refuerzo con IA (Usando el Prompt Maestro)
  try {
    if (OPENAI_API_KEY || OPENAI_PROXY_ENDPOINT) {
      // Llamamos a la IA si el total es 0, es dudoso, o faltan datos clave
      if (total <= 0 || !folio || !fecha) {
        dbgNote("🤖 Llamando a refuerzo de IA con Prompt Maestro...");
        
        const j = await callOpenAI(rawText); // Aquí ya vive tu Prompt Maestro
        
        if (j && typeof j === "object") {
          // Completar Folio, Fecha y Mesero si la heurística falló
          if (!folio && j.folio) folio = String(j.folio).trim();
          if (!fecha && j.fecha) fecha = String(j.fecha).trim();
          if (!mesero && j.mesero) mesero = String(j.mesero).trim();
          
          // 🛡️ VALIDACIÓN CONTABLE: ¿Total >= Subtotal?
          // Solo aceptamos el total de la IA si es lógico contablemente
          const iaTotal = Number(j.total || 0);
          const iaSubtotal = Number(j.subtotal || 0);

          if (iaTotal > 0) {
            if (iaTotal >= iaSubtotal) {
              total = iaTotal;
              dbgNote(`🤖 IA Validada: Total $${total} (Subtotal $${iaSubtotal})`);
            } else {
              dbgNote(`⚠️ IA ignorada: Total ($${iaTotal}) menor al Subtotal ($${iaSubtotal})`);
            }
          }
        }
      }
    }
  } catch (e) {
    dbgNote("❌ Error en refuerzo de IA");
  }

  // 4) Limpieza y Normalización Final
  if (!/^\d{3,10}$/.test(String(folio || ""))) {
    folio = String(folio || "").match(/\b\d{3,10}\b/)?.[0] || "";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ""))) fecha = "";
  
  total = Number(total || 0);
  mesero = mesero ? mesero.trim().toUpperCase() : "";

  // 5) 🛡️ Blindaje de Auditoría (Cruce Final de Montos)
  let isAuditOk = true;
  if (sumaProductos > 0 && total > 0) {
    const diferencia = Math.abs(total - sumaProductos);
    // Tolerancia de 2 pesos por errores de redondeo de centavos
    if (diferencia > 2.00) {
      isAuditOk = false;
      dbgNote(`❌ Auditoría fallida: Total=${total} vs SumaPlatos=${sumaProductos}`);
    } else {
      dbgNote("✅ Auditoría exitosa: Los montos coinciden.");
    }
  }

  dbgDump();

  return {
    folio,
    fecha,
    total,
    mesero,
    storeId: store.id,
    storeName: store.name,
    sumaAuditoria: sumaProductos,
    auditOk: isAuditOk,
    // El ticket es válido solo si tiene folio, total y pasó la auditoría o la IA lo validó
    isValid: (folio.length >= 3 && total > 0 && isAuditOk)
  };
};
