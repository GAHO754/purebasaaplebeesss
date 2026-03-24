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
  const m = String(text || "").match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](202\d)/);
  if (!m) return "";
  
  let d = +m[1], mo = +m[2], y = +m[3];
  // Si el formato es DD/MM/YYYY y el OCR los voltea:
  if (mo > 12) [d, mo] = [mo, d];

  const fechaDetectada = new Date(y, mo - 1, d);
  const hoy = new Date();

  // Si la fecha detectada es mayor a hoy, probablemente el OCR leyó mal el año
  if (fechaDetectada > hoy) {
    dbgNote("Fecha futura detectada, usando fecha actual.");
    return hoy.toISOString().split('T')[0];
  }

  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function extractFolio(lines) {
  const isDate = (s) => /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})/.test(s);
  const isTime = (s) => /(\d{1,2}):(\d{2})\s*(am|pm)?/i.test(s);
  
  // 1. Buscamos específicamente el índice de la HORA (Anclaje crítico)
  const iT = lines.findIndex(isTime);
  const iD = lines.findIndex(isDate);
  
  // 🛡️ FILTRO DE SEGURIDAD PARA LÍNEAS PROHIBIDAS
  const pickFolioSafe = (s) => {
    const text = String(s).toLowerCase();
    // Si la línea tiene estas palabras, NO es el folio, lo ignoramos.
    if (/mesa|clientes|reimpresion|cp|tel|teléfono|articulos|orden|mesero/i.test(text)) return null;
    
    // Buscamos un bloque numérico de 4, 5 o 6 dígitos (como el 20002)
    const m = text.match(/\b(\d{4,6})\b/g);
    return m ? m[m.length - 1] : null; 
  };

  // 2. INTENTO 1: Búsqueda por Anclaje (Debajo de la Hora o Fecha)
  // En tu ticket, el folio está máximo 2 líneas después de la hora
  if (iT >= 0 || iD >= 0) {
    const anchor = Math.max(iT, iD);
    const startSearch = anchor;
    const endSearch = Math.min(lines.length - 1, anchor + 3);

    for (let i = startSearch; i <= endSearch; i++) {
      const c = pickFolioSafe(lines[i]);
      if (c) { 
        dbgNote(`Folio anclado hallado @${i}: ${c}`); 
        return c; 
      }
    }
  }

  // 3. INTENTO 2: Búsqueda Inteligente (Rango amplio cerca del encabezado)
  const from = iT >= 0 ? iT : 0;
  const to = Math.min(lines.length - 1, from + 10);

  for (let i = from; i <= to; i++) {
    const c = pickFolioSafe(lines[i]);
    if (c) { 
      dbgNote(`Folio por proximidad hallado @${i}: ${c}`); 
      return c; 
    }
  }

  // 4. INTENTO 3: Búsqueda de Emergencia (Si todo lo anterior falló)
  for (let i = 0; i < Math.min(25, lines.length); i++) {
    const m = pickFolioSafe(lines[i]);
    if (m) { 
      dbgNote(`Folio por búsqueda general @${i}: ${m}`); 
      return m; 
    }
  }

  dbgNote("Folio no encontrado tras filtros de seguridad");
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
    // --- Helpers internos ---
    const isCard = (s) => /\b(visa|master|amex|tarjeta|card)\b/i.test(s);
    
    const norm = (s) => String(s || "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const grabLastMoney = (s) => {
        const mm = String(s).match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2}))/g);
        if (!mm || !mm.length) return null;
        return normalizeNum(mm[mm.length - 1]);
    };

    let subtotal = null;
    let iva = null;
    let propina = 0;
    
    // Regex para identificar las partes del ticket
    const RX_SUB = /\b(sub\s*[- ]?\s*total|subtotal)\b/i;
    const RX_IVA = /\biva\b|\bimpuesto\b/i;
    const RX_TIP = /\b(propina|tip|gratuit|servicio)\b/i;
    
    // Lista negra para no confundir el TOTAL real con pagos o cambio
    const BAD = /\b(cambio|efectivo|pago|cash|visa|master|amex)\b/i;

    // --- PASO 1: Escaneo Contable (Buscando la "Verdad" del ticket) ---
    for (let i = 0; i < lines.length; i++) {
        const l0 = lines[i];
        if (isCard(l0)) continue;

        // 1. Capturar Subtotal
        if (subtotal === null && RX_SUB.test(l0)) {
            subtotal = grabLastMoney(l0) ?? grabLastMoney(lines[i + 1] || "");
        }

        // 2. Capturar IVA
        if (iva === null && RX_IVA.test(l0) && !/total/i.test(l0)) {
            iva = grabLastMoney(l0) ?? grabLastMoney(lines[i + 1] || "");
        }

        // 3. Capturar Propina (para saber si hay que restarla del total final)
        if (RX_TIP.test(l0)) {
            const mTip = grabLastMoney(l0) ?? grabLastMoney(lines[i + 1] || 0);
            if (mTip) propina = mTip;
        }
    }

    // --- PASO 2: Reconstrucción Matemática (Subtotal + IVA) ---
    const sumaContable = (subtotal !== null && iva !== null) ? Number((subtotal + iva).toFixed(2)) : null;
    
    if (sumaContable) {
        dbgNote(`🛡️ Matemática: Subtotal(${subtotal}) + IVA(${iva}) = ${sumaContable}`);
    }

    // --- PASO 3: Buscar etiqueta TOTAL y validar contra Propina ---
    const cands = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const n = norm(raw);

        // Si la línea contiene "TOTAL" pero no es "SUBTOTAL" ni palabra de lista negra
        if (/\btotal\b/i.test(raw) && !RX_SUB.test(raw) && !BAD.test(n)) {
            let v = grabLastMoney(raw);
            
            // Si el número está en la línea de abajo
            if (v === null) {
                const nextLine = lines[i + 1] || "";
                if (!BAD.test(norm(nextLine)) && !RX_TIP.test(nextLine)) {
                    v = grabLastMoney(nextLine);
                }
            }

            if (Number.isFinite(v) && v > 0) {
                let finalValue = v;
                let score = 100;

                // ⚖️ LÓGICA ANTI-PROPINA: 
                // Si el total que leyó el OCR es igual a la (SumaContable + Propina)
                if (propina > 0 && sumaContable > 0) {
                    const totalInflado = Number((sumaReal + propina).toFixed(2));
                    // Si el error es menor a $1 peso, confirmamos que trae propina
                    if (Math.abs(v - totalInflado) < 1.0) {
                        finalValue = sumaContable; // "Limpiamos" el total quitando la propina
                        score += 1000;
                        dbgNote(`🎯 Propina detectada en Total. Limpiando a monto base: ${finalValue}`);
                    }
                }

                // Si coincide con nuestra suma matemática exactamente, le damos mucha confianza
                if (sumaContable && Math.abs(finalValue - sumaContable) < 1.0) {
                    finalValue = sumaContable; // Preferimos el valor exacto de la suma
                    score += 500;
                }
                
                if (/^total\s*(mxn|m\.n\.)?$/i.test(n)) score += 50;

                cands.push({ v: finalValue, score });
            }
        }
    }

    // --- PASO 4: Decisión Final ---
    if (cands.length > 0) {
        cands.sort((a, b) => b.score - a.score);
        return cands[0].v;
    }

    // Si no encontró etiquetas de TOTAL, pero la suma matemática es sólida, devolvemos esa.
    if (sumaContable && sumaContable > 0) {
        dbgNote("⚠️ No se halló etiqueta TOTAL, usando Reconstrucción Matemática.");
        return sumaContable;
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

 const sysPrompt = `Actúa como Auditor Contable de Applebee's.
Tu misión es extraer datos de tickets con CERO margen de error.

REGLAS DE RAZONAMIENTO:
1. El TOTAL PAGADO es siempre la suma de (Subtotal + IVA). 
2. Si el ticket muestra un "Efectivo" o "Pago", ese suele ser el Total, pero confírmalo sumando los productos.
3. El FOLIO es un número de 5 o 6 dígitos (ej. 20002), no lo confundas con la Mesa o el Mesero.
4. Si el texto es ilegible o los números están cortados, responde: {"error": "low_quality"}.

FORMATO DE SALIDA (JSON ESTRICTO):
{
  "folio": "solo números",
  "fecha": "YYYY-MM-DD",
  "total": 0.00,
  "subtotal": 0.00,
  "iva": 0.00,
  "mesero": "nombre",
  "error": null
}`;

  const userPrompt = `Analiza este texto de ticket y extrae los datos. 
  REVISA BIEN: No confundas el IVA (${rawText.match(/78/g) ? 'como el 78.07' : 'impuestos'}) con el TOTAL: \n\n${rawText}`;

  const started = performance.now();
  setIABadge(null, 'IA Auditando…');

  try {
    let response;
    
    if (OPENAI_PROXY_ENDPOINT) {
      response = await fetch(OPENAI_PROXY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText, sys: sysPrompt })
      });
    } else {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini", // O "gpt-4o" para máxima potencia de visión
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.0, // 0.0 para que sea lo más estricto y menos creativo posible
          response_format: { type: "json_object" }
        })
      });
    }

    if (!response.ok) throw new Error(`Error IA: ${response.status}`);

    const data = await response.json();
    const took = Math.round(performance.now() - started);
    setIABadge('ok', `${took}ms`);
    
    const content = OPENAI_PROXY_ENDPOINT ? data : JSON.parse(data.choices[0].message.content);
    
    // 🛡️ FILTRO POST-IA: Si la IA detectó mala calidad, avisamos al sistema
    if (content.error === "low_quality") {
        dbgNote("⚠️ IA reporta baja calidad: No se confía en los números.");
        return { ...content, total: 0, folio: "" }; 
    }

    dbgNote(`🤖 IA Auditó: Total=${content.total}, Folio=${content.folio}`);
    return content;

  } catch (e) {
    setIABadge('err', 'fallo');
    console.error("Error en callOpenAI:", e);
    return null;
  }
}

function calcularTotalContable(subtotal, iva, propina, totalDetectado) {
  // Paso A: Calcular la verdad matemática
  const sumaReal = Number((subtotal + iva).toFixed(2));
  
  // Paso B: Si el total que leyó el OCR es igual a (Suma + Propina), 
  // significa que el OCR leyó el monto con propina. Lo corregimos.
  if (propina > 0 && totalDetectado > 0) {
    const totalConPropina = Number((sumaReal + propina).toFixed(2));
    
    if (Math.abs(totalDetectado - totalConPropina) < 1.0) {
      console.log("🛡️ Propina detectada en el Total. Extrayendo monto base...");
      return sumaReal;
    }
  }

  // Paso C: Si el total detectado es menor que el subtotal (error común de lectura de IVA)
  if (totalDetectado > 0 && totalDetectado < subtotal) {
    console.log("⚠️ Total detectado es menor al Subtotal. Usando Suma Contable.");
    return sumaReal;
  }

  // Si no hay errores, devolvemos la suma contable como el dato más fiable
  return sumaReal > 0 ? sumaReal : totalDetectado;
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
  // Aquí usamos tus nuevas funciones optimizadas de Folio (Anclaje) y Total (Contable)
  let folio = extractFolio(lines);
  let fecha = extractDateISO(rawText);
  let totalCalculado = detectGrandTotal(lines); // Nuestra lógica de Subtotal + IVA
  let mesero = extractMesero(rawText, lines);
  let store = extractStore(rawText);
  let sumaProductos = auditProductSum(lines);

  let total = totalCalculado;

  // 🛡️ REGLA DE SANIDAD LOCAL: ¿El folio se coló como total?
  const totalEsDudoso = (total > 0 && total === Number(folio)) || (total >= 2024 && total <= 2026);

  if (totalEsDudoso) {
    dbgNote(`⚠️ Total sospechoso descartado (${total}). Coincidía con Folio o Año.`);
    total = 0; 
  }

  // 3) REFUERZO CON IA (Cerebro de Decisión con Doble Blindaje)
  try {
    if (OPENAI_API_KEY || OPENAI_PROXY_ENDPOINT) {
      // Llamamos a la IA si el total es bajo (posible IVA), es 0, o faltan datos
      if (total <= 100 || !folio || !fecha) {
        dbgNote("🤖 Llamando a refuerzo de IA (Auditoría de montos)...");
        
        const j = await callOpenAI(rawText); 

        if (j && typeof j === "object") {
          // Completar datos si la IA los encontró y nosotros no
          if (!folio && j.folio) folio = String(j.folio).trim();
          if (!fecha && j.fecha) fecha = String(j.fecha).trim();
          if (!mesero && j.mesero) mesero = String(j.mesero).trim();

          const iaTotal = Number(j.total || 0);

          // 🛡️ DOBLE BLINDAJE: ¿A quién le creemos?
          if (iaTotal > 0) {
            // Si nuestro cálculo matemático local dio un número sólido, lo mantenemos
            if (totalCalculado > 0) {
              total = totalCalculado;
              dbgNote(`⚖️ Prioridad: Cálculo matemático Local (Sub+IVA): ${total}`);
            } else {
              // Si el local falló, usamos el de la IA
              total = iaTotal;
              dbgNote(`🚀 IA rescató el total: ${iaTotal}`);
            }
          }
        }
      }
    }
  } catch (e) {
    dbgNote("❌ Error en el refuerzo de IA");
  }

  // 4) VALIDACIÓN FINAL: Auditoría de Productos (El "Último Filtro")
  // Si la suma de platos individuales da un total coherente, esa es la verdad absoluta
  if (sumaProductos > 0) {
    const diff = Math.abs(total - sumaProductos);
    if (diff > 2.00) { 
      dbgNote(`⚖️ Ajustando total por suma de productos: ${sumaProductos} (Antes era ${total})`);
      total = sumaProductos;
    }
  }

  // 5) Limpieza y Normalización Final
  if (!/^\d{3,10}$/.test(String(folio || ""))) {
    folio = String(folio || "").match(/\b\d{3,10}\b/)?.[0] || "";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ""))) fecha = "";
  
  total = Number(total || 0);
  mesero = mesero ? mesero.trim().toUpperCase() : "";

  // 6) Blindaje de Auditoría para el Return
  let isAuditOk = true;
  if (sumaProductos > 0 && total > 0) {
    // Si después de todo el proceso el total sigue sin cuadrar con la suma de platos
    if (Math.abs(total - sumaProductos) > 2.00) isAuditOk = false;
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
    isValid: (folio.length >= 3 && total > 0 && isAuditOk)
  };
};
