// registrar.js — RTDB + Cámara + OCR AUTO + Bloqueo total + Mesero + resumen claro (Saldo)
(() => {
  console.log("[registrar.js] cargado");

  const $ = id => document.getElementById(id);

  // ===== Firebase =====
  const auth = firebase.auth();
  const db   = firebase.database();

  // 👇 AQUÍ ES DONDE DEBES PEGAR LAS LÍNEAS NUEVAS:
  let scanAttempts = 0;   // ✅ Contador de intentos globales
  const MAX_ATTEMPTS = 3; // ✅ Límite permitido

  // 🛡️ Estado temporal para datos detectados por el OCR
  let lastScanData = { 
    storeId: "APB_PASEO", 
    storeName: "Applebee’s Paseo Central",
    auditOk: true,
    sumaAuditoria: 0
  };
  // ================= LIVE EVENTS (MÓDULO 1) =================
  async function pushLiveEvent(payload){
    try{
      const user = auth.currentUser;
      console.log("USER ACTUAL:", user);

      const eventRef = db.ref("liveEvents").push();
      const eventId = eventRef.key;

      const now = Date.now();
      const d = new Date(now);
      const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;

      const base = {
        createdAt: now,
        uid: user?.uid || "",
        userEmail: user?.email || "",
        meta: {
          source: "registrar",
          page: location.pathname || "",
          ua: navigator.userAgent || ""
        }
      };

      await eventRef.set({ ...base, ...payload });

      // índice por día (consulta/limpieza rápida)
      await db.ref(`liveEventsByDay/${ymd}/${eventId}`).set(true);

      return eventId;
    }catch(e){
      console.warn("pushLiveEvent error:", e);
      return "";
    }
  }
  // ===== UI =====
  const fileInput    = $('ticketFile');
  const dropzone     = $('dropzone');
  const btnPickFile  = $('btnSeleccionarArchivo');
  const btnCam       = $('btnAbrirCamara');
  const modal        = $('cameraModal');
  const btnClose     = $('btnCerrarCamara');
  const video        = $('cameraVideo');
  const btnShot      = $('btnCapturar');
  const ocrStatus    = $('ocrStatus');

  const iNum    = $('inputTicketNumero');
  const iFecha  = $('inputTicketFecha');
  const iMesero = $('inputTicketMesero');
  const iTotal  = $('inputTicketTotal');

  const btnRegistrar = $('btnRegistrarTicket');
  const msgTicket    = $('ticketValidacion');
  const greetEl      = $('userGreeting');

  const elDisp   = $('ptsDisponibles');
  const elResv   = $('ptsReservados');
  const elTot    = $('ptsTotales');
  const tbody    = $('tbodyTickets');
  const toast    = $('awardToast');

  // Botón Regresar
  const btnBack  = $('btnLogout');

  // ===== Parámetros de negocio =====
  const VENCE_DIAS   = 180;  // vencimiento de monedero por ticket (para mostrar “Vence”)
  const DAY_LIMIT    = 2;    // máximo tickets por día (por createdAt)
  const REGISTER_DAYS_LIMIT = 3; // ✅ SOLO 3 días para registrar a partir de la fecha del ticket
  const PERCENT_BACK = 0.05; // ✅ 5% monedero

  let liveStream = null;
  let currentPreviewURL = null;
  let unsub = [];

  // Estado para el resumen (internamente sigue llamándose pts)
  const ptsState = {
    totalEarned: 0,
    reserved:    0,
    redeemed:    0
  };

  function round2(n){
    const v = Number(n || 0);
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  function fmtMoney(n){
    const v = Number(n||0);
    return `$${v.toFixed(2)}`;
  }

  /* ===== Helpers UI ===== */
  function setStatus(msg, type='') {
    if (!ocrStatus) return;
    ocrStatus.className = 'validacion-msg';
    if (type) ocrStatus.classList.add(type);
    ocrStatus.textContent = msg || '';
  }

  // ✅ Bloqueo REAL: readonly + disabled + blur + bloquea focus
  function lockInputs(){
    // ✅ SOLO bloqueamos folio/fecha/total (mesero NO)
    [iNum, iFecha, iTotal].forEach(x => {
      if(!x) return;
      x.readOnly = true;
      x.disabled = true;
      x.setAttribute("tabindex","-1");
      x.style.pointerEvents = "none";
      x.blur?.();
    });

    // ✅ Mesero manual: queda editable
    if (iMesero){
      iMesero.disabled = false;
      iMesero.readOnly = false;
      iMesero.style.pointerEvents = "auto";
      iMesero.removeAttribute("tabindex");
    }
  }

  function unlockInputs(){
    // (si un día quieres edición manual, aquí la reactivas)
    [iNum,iFecha,iMesero,iTotal].forEach(x=>{
      if(!x) return;
      x.disabled = false;
      x.readOnly = true; // 👈 lo mantenemos readonly SIEMPRE (no teclado) (tu lógica original)
      x.setAttribute("tabindex","-1");
      x.style.pointerEvents = "none";
      x.blur?.();
    });
  }

  function setPreview(file) {
    if (currentPreviewURL) URL.revokeObjectURL(currentPreviewURL);
    const url = URL.createObjectURL(file);
    currentPreviewURL = url;
    dropzone?.querySelectorAll('img.preview').forEach(n => n.remove());
    if (dropzone) {
      const img = document.createElement('img');
      img.className = 'preview';
      img.alt = 'Vista previa ticket';
      img.src = url;
      dropzone.appendChild(img);
    }
  }

  function dataURLtoBlob(dataURL) {
    const [meta, b64] = dataURL.split(',');
    const mime = meta.split(':')[1].split(';')[0];
    const bin = atob(b64);
    const ab = new ArrayBuffer(bin.length);
    const ia = new Uint8Array(ab);
    for (let i=0;i<bin.length;i++) ia[i] = bin.charCodeAt(i);
    return new Blob([ab], { type: mime });
  }

  function setFileInputFromBlob(blob, name='ticket.jpg') {
    const file = new File([blob], name, { type: blob.type||'image/jpeg', lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (fileInput) fileInput.files = dt.files;
    setPreview(file);
    return file;
  }

  // ✅ NUEVO: Monedero = 5% del total pagado
  function computeMonederoFromTotal(total){
    if (!Number.isFinite(total) || total <= 0) return 0;
    return round2(total * PERCENT_BACK);
  }

  function updatePointsSummary() {
    const available = Math.max(0, ptsState.totalEarned - ptsState.reserved - ptsState.redeemed);

    if (elDisp) elDisp.textContent = fmtMoney(available);
    if (elResv) elResv.textContent = fmtMoney(ptsState.reserved);
    if (elTot)  elTot.textContent  = fmtMoney(ptsState.totalEarned);
  }

  /* ===== Puente con ocr.js ===== */
  async function waitForOCR(tries = 30, delayMs = 100) {
    for (let i = 0; i < tries; i++) {
      if (typeof window.processTicketWithIA === "function") return true;
      await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
  }

  function sanitizeMesero(m){
    const s = String(m||"").trim();
    if(!s) return "";
    // solo letras/espacios y MAYÚSCULAS
    return s.replace(/[^A-ZÁÉÍÓÚÑ\s]/gi,"").replace(/\s+/g," ").trim().toUpperCase();
  }

  // ✅ NUEVO: Función para subir la imagen a Firebase Storage
async function uploadTicketImage(file, folio) {
  try {
    const user = auth.currentUser;
    if (!user) throw new Error("Usuario no autenticado");

    // Crear una referencia: ticketsImages/ID_USUARIO/FOLIO_TIMESTAMP.jpg
    const storageRef = firebase.storage().ref();
    const safeFolio = folio || "no_folio";
    const fileName = `${safeFolio}_${Date.now()}.jpg`;
    const path = `ticketsImages/${user.uid}/${fileName}`;

    const snapshot = await storageRef.child(path).put(file);
    const url = await snapshot.ref.getDownloadURL();

    console.log("✅ Imagen subida con éxito:", url);
    return url;
  } catch (err) {
    console.error("❌ Error subiendo imagen:", err);
    return ""; // Si falla, devolvemos vacío para no trabar el registro
  }
}
 
async function autoProcessCurrentFile() {
    const file = fileInput?.files?.[0];
    if (!file) {
        setStatus("Sube o toma la foto del ticket primero.", "err");
        return;
    }

    const ready = await waitForOCR();
    if (!ready) {
        setStatus("No se pudo iniciar el OCR.", "err");
        return;
    }

    try {
        setStatus(`🕐 Analizando ticket (Intento ${scanAttempts + 1} de ${MAX_ATTEMPTS})…`);
        lockInputs();
        if (btnRegistrar) btnRegistrar.disabled = true;

        // 1. Llamada al OCR y Auditoría de IA
        const ret = await window.processTicketWithIA(file);

        // 🛡️ FILTRO DE CALIDAD CRÍTICA (RECHAZO DE GEMINI)
        if (ret.error === "low_quality") {
            setStatus("❌ Foto borrosa o ilegible.", "err");
            msgTicket.className = 'validacion-msg err';
            msgTicket.textContent = "La IA no puede asegurar los montos. Intenta con más luz y un ángulo recto.";
            unlockInputs(); 
            return; 
        }

        // 2. REGLA DE ORO: ¿Se leyó TODO bien (Folio, Fecha, Total y Auditoría)?
        const dataComplete = (ret.folio && ret.fecha && ret.total > 0 && ret.auditOk);

        if (!dataComplete) {
            scanAttempts++;
            
            if (scanAttempts >= MAX_ATTEMPTS) {
                setStatus("⛔ ESCANEO INVALIDADO", "err");
                msgTicket.className = 'validacion-msg err';
                msgTicket.innerHTML = `<strong>Ticket Inválido:</strong> Has fallado ${MAX_ATTEMPTS} veces. Por seguridad, este ticket se ha bloqueado.`;
                
                if (btnRegistrar) btnRegistrar.disabled = true;
                if (btnCam) btnCam.disabled = true;
                if (btnPickFile) btnPickFile.disabled = true;

                await pushLiveEvent({
                    type: "ticket_blocked_bad_quality",
                    status: "err",
                    reason: "max_attempts_exceeded",
                    ticket: { folio: ret.folio || "unknown" }
                });
                return;
            } else {
                setStatus(`❌ Intento ${scanAttempts} fallido. Datos incompletos o erróneos.`, "err");
                unlockInputs(); 
                return;
            }
        }

        // 🛡️ NUEVO: ALERTA DE MONTO SOSPECHOSAMENTE BAJO (EJ. EL IVA)
        // Si el total es menor a $100 pero mayor a 0, avisamos al usuario para que verifique
        if (ret.total < 100 && ret.total > 0) {
            setStatus("⚠️ Monto detectado muy bajo ($" + ret.total.toFixed(2) + "). ¿Es correcto?", "warn");
            // No bloqueamos el proceso, pero forzamos un mensaje visual de advertencia
            msgTicket.className = 'validacion-msg warn';
            msgTicket.textContent = "Revisa si el total es correcto. Si detectó el IVA en lugar del Total, intenta otra foto.";
        } else {
            setStatus(`✓ Ticket verificado en ${ret.storeName || 'Applebee’s'}`, "ok");
            msgTicket.className = 'validacion-msg ok';
            msgTicket.textContent = "Datos listos para registrar.";
        }

        // 3. ÉXITO: Los datos pasaron los filtros
        scanAttempts = 0; 
        
        lastScanData.storeId = ret?.storeId || "APB_PASEO";
        lastScanData.storeName = ret?.storeName || "Applebee’s Paseo Central";
        window.lastDetectedTotal = ret.total; // 🛡️ Caja fuerte para comparar en el registro final
        
        window.lastTicketImage = await uploadTicketImage(file, ret.folio);

        // Llenar campos visuales
        if (iNum)   iNum.value = ret.folio;
        if (iFecha) iFecha.value = ret.fecha;
        if (iMesero) iMesero.value = (ret.mesero || "").toUpperCase();
        if (iTotal) iTotal.value = ret.total.toFixed(2);

        await pushLiveEvent({
            type: "ticket_scan_success",
            status: "ok",
            storeId: lastScanData.storeId,
            ticket: { folio: ret.folio, total: ret.total }
        });

        if (btnRegistrar) btnRegistrar.disabled = false;

    } catch (e) {
        console.error("Error OCR:", e);
        setStatus("Error al procesar. Intenta una foto más clara.", "err");
        unlockInputs();
    }
}

  // ===== Cámara =====
  async function openCamera() {
    console.log("[registrar.js] openCamera click");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Tu navegador no soporta cámara. Usa Adjuntar foto.", "err"); return;
      }
      video.muted = true;
      video.setAttribute('playsinline','true');
      video.setAttribute('muted','true');

      const tries = [
        { video:{ facingMode:{exact:"environment"}, width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:{ facingMode:{ideal:"environment"},  width:{ideal:1920}, height:{ideal:1080} }, audio:false },
        { video:true, audio:false }
      ];
      let stream=null,lastErr=null;
      for (const c of tries){ try{ stream=await navigator.mediaDevices.getUserMedia(c); break; } catch(e){ lastErr=e; } }
      if (!stream) throw lastErr||new Error("No se pudo abrir la cámara");

      liveStream=stream; video.srcObject=stream;
      modal.style.display='flex'; modal.setAttribute('aria-hidden','false');
      await video.play().catch(()=>{});
      setStatus('');
    } catch(e){
      console.error("getUserMedia:",e);
      let msg="No se pudo acceder a la cámara. Revisa permisos del navegador.";
      if ((!window.isSecureContext && location.hostname!=='localhost') || (location.protocol!=='https:' && location.hostname!=='localhost')){
        msg+=" (En móviles abre el sitio con HTTPS).";
      }
      setStatus(msg,"err");
      fileInput?.click();
    }
  }

  function stopCamera(){
    if (liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream=null; }
    modal.style.display='none'; modal.setAttribute('aria-hidden','true');
  }

 async function captureFrame() {
    const w = video.videoWidth;
    const h = video.videoHeight;
    
    // 💡 Esto nos dirá en la consola qué resolución está detectando tu móvil
    console.log(`[Cámara] Resolución detectada: ${w}x${h}`);

    // ✅ Bajamos el umbral a 720p (HD estándar) para ser más flexibles
    // Antes pedíamos 1280x720, ahora permitimos un poco menos por si el sensor recorta bordes
    if (w < 960 || h < 540) { 
        setStatus(`❌ Calidad insuficiente (${w}x${h}). Enfoca mejor el ticket.`, "err");
        // No cerramos la cámara automáticamente para que el usuario pueda reintentar sin reabrir
        return;
    }

    if (!w || !h) { 
        setStatus("Cámara aún no lista. Intenta de nuevo.", "err"); 
        return; 
    }
    
    const c = document.createElement('canvas'); 
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    
    // Aplicamos un poco de nitidez
    ctx.filter = "contrast(1.15) brightness(1.02)";
    ctx.drawImage(video, 0, 0, w, h);
    
    // Detenemos la cámara hasta después de capturar
    stopCamera();
    
    const dataURL = c.toDataURL("image/jpeg", 0.92);
    const blob = dataURLtoBlob(dataURL);
    setFileInputFromBlob(blob, `ticket_${Date.now()}.jpg`);
    
    setStatus("📎 Foto capturada. Analizando...", "ok");
    await autoProcessCurrentFile();
}
  btnCam?.addEventListener('click', openCamera);
  btnClose?.addEventListener('click', stopCamera);
  btnShot?.addEventListener('click', captureFrame);

  // ===== Subir archivo =====
  btnPickFile?.addEventListener('click', ()=> fileInput?.click());
  fileInput?.addEventListener('change', async e=>{
    const f=e.target.files && e.target.files[0];
    if (f){
      setPreview(f);
      setStatus("📎 Imagen cargada. Procesando OCR…","ok");
      await autoProcessCurrentFile();
    }
  });

  if (dropzone) {
    dropzone.addEventListener('click', ()=> fileInput?.click());
    dropzone.addEventListener('dragover', e => {
      e.preventDefault(); dropzone.classList.add('drag');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', async e => {
      e.preventDefault(); dropzone.classList.remove('drag');
      if (e.dataTransfer.files?.length) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        fileInput.files = dt.files;
        setPreview(e.dataTransfer.files[0]);
        setStatus("📎 Imagen cargada. Procesando OCR…","ok");
        await autoProcessCurrentFile();
      }
    });
  }

  function fmtDate(ms){
    if(!ms) return '';
    try{
      return new Date(ms).toLocaleDateString('es-MX',{year:'numeric',month:'2-digit',day:'2-digit'});
    }catch{ return '' }
  }

  function renderTickets(list){
    if (!tbody) return;
    if (!list.length){
      tbody.innerHTML = `<tr><td colspan="5" class="muted">No hay tickets aún.</td></tr>`;
      return;
    }
    tbody.innerHTML = list.map(t=>`
      <tr>
        <td>${t.fecha || ''}</td>
        <td>${t.folio || ''}</td>
        <td>$${(t.total||0).toFixed(2)}</td>
        <td><b>${fmtMoney(t.puntos||0)}</b></td>
        <td>${fmtDate(t.vence)||''}</td>
      </tr>
    `).join('');
  }

  function attachUserStreams(uid){
    if (!uid) return;
    unsub.forEach(fn=>{ try{fn();}catch{} });
    unsub = [];

    const tRef = db.ref(`users/${uid}/tickets`);
    tRef.on('value', snap=>{
      const val = snap.val()||{};
      const arr = Object.values(val).map(v=>({
        folio: v.folio,
        fecha: v.fecha,
        total: Number(v.total||0),
        puntos: Number(v.points||v.puntosTotal||0),
        vence: Number(v.vencePuntos||0),
        createdAt: Number(v.createdAt||0)
      }));
      arr.sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
      renderTickets(arr.slice(0,12));
      ptsState.totalEarned = arr.reduce((a,x)=> a + (Number(x.puntos)||0), 0);
      updatePointsSummary();
    });
    unsub.push(()=> tRef.off());

    const rRef = db.ref(`users/${uid}/redemptions`);
    rRef.on('value', snap=>{
      const reds = snap.val()||{};
      let reserved = 0;
      let redeemed = 0;
      const now = Date.now();

      Object.values(reds).forEach(r=>{
        const cost = Number(r.cost||0);
        const st   = String(r.status||'').toLowerCase();
        const expOk = !r.expiresAt || Number(r.expiresAt)>now;

        if (st === 'pendiente' && expOk) reserved += cost;
        else if (st === 'canjeado' || st === 'consumido' || st === 'usado') redeemed += cost;
      });

      ptsState.reserved = reserved;
      ptsState.redeemed = redeemed;
      updatePointsSummary();
    });
    unsub.push(()=> rRef.off());
  }

  function addDays(date, days){
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  function addMonths(date, months){
    const d=new Date(date.getTime());
    d.setMonth(d.getMonth()+months);
    return d;
  }

  function startEndOfToday(){
    const s=new Date(); s.setHours(0,0,0,0);
    const e=new Date(); e.setHours(23,59,59,999);
    return {start:s.getTime(), end:e.getTime()};
  }

  function ymdFromISO(iso){
    return String(iso||'').replace(/-/g,'');
  }

  function buildTicketKeys(fechaStr, folio, totalNum){
    const ymd = ymdFromISO(fechaStr);
    const totalCents = Math.round(totalNum * 100);
    const indexKey = `${folio}_${totalCents}`;
    const ticketId = `${ymd}_${folio}`;
    return { ymd, totalCents, indexKey, ticketId };
  }

  // ✅ Regla: ticket solo se registra dentro de 3 días desde la fecha del ticket
  function isTicketExpiredByDate(fechaStr){
    // fechaStr: YYYY-MM-DD
    const ticketDate = new Date(`${fechaStr}T00:00:00`);
    if (Number.isNaN(ticketDate.getTime())) return false;

    // Expira al final del día (fecha + 3 días)
    const exp = addDays(ticketDate, REGISTER_DAYS_LIMIT);
    exp.setHours(23,59,59,999);

    return Date.now() > exp.getTime();
  }

async function registrarTicketRTDB() {
  const user = auth.currentUser;

  // 1. Verificación inicial de sesión
  if (!user || !user.uid) {
    msgTicket.className = 'validacion-msg err';
    msgTicket.textContent = "Sesión no lista. Intenta de nuevo.";
    return;
  }

  // 2. Captura y Limpieza de datos
  const folio = (iNum?.value || '').trim().toUpperCase();
  const fechaStr = (iFecha?.value || '').trim();
  const totalNum = parseFloat(iTotal?.value || "0") || 0;
  const mesero = (iMesero?.value || '').trim().toUpperCase();

  // 🛡️ DOBLE VERIFICACIÓN DE SEGURIDAD (Blindaje contra edición manual)
  // Comparamos lo que el usuario quiere registrar contra lo que el OCR leyó
  const totalOriginalOCR = window.lastDetectedTotal || 0;
  if (totalOriginalOCR > 0 && totalNum > (totalOriginalOCR + 1.00)) {
    msgTicket.className = 'validacion-msg err';
    msgTicket.textContent = "🚨 El total ingresado no coincide con la imagen. Registro bloqueado.";
    
    await pushLiveEvent({
      type: "fraud_warning",
      status: "warn",
      reason: "manual_total_inflation",
      ticket: { folio, totalUsuario: totalNum, totalRealOCR: totalOriginalOCR }
    });
    return;
  }

  // 3. Validaciones de Formato y Reglas de Negocio
  if (!/^\d{4,10}$/.test(folio) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaStr) || totalNum <= 0) {
    msgTicket.className = 'validacion-msg err';
    msgTicket.textContent = "Faltan datos válidos. Toma otra foto clara donde se vea el FOLIO y el TOTAL.";
    return;
  }

  if (isTicketExpiredByDate(fechaStr)) {
    msgTicket.className = 'validacion-msg err';
    msgTicket.textContent = `⛔ Ticket vencido. Límite de registro: ${REGISTER_DAYS_LIMIT} días.`;
    return;
  }

  // 4. Verificación de Límite Diario
  try {
    const { start, end } = startEndOfToday();
    const snap = await db.ref(`users/${user.uid}/tickets`)
      .orderByChild('createdAt')
      .startAt(start)
      .endAt(end)
      .once('value');
    
    const countToday = snap.exists() ? Object.keys(snap.val()).length : 0;
    if (countToday >= DAY_LIMIT) {
      msgTicket.className = 'validacion-msg err';
      msgTicket.textContent = `⚠️ Límite alcanzado: solo ${DAY_LIMIT} tickets por día.`;
      return;
    }
  } catch (err) {
    console.warn('Error verificando límites:', err);
  }

  // 5. Preparación de Keys y Monedero
  const { ymd, totalCents, indexKey, ticketId } = buildTicketKeys(fechaStr, folio, totalNum);
  const monedero = computeMonederoFromTotal(totalNum);
  const fechaObj = new Date(`${fechaStr}T00:00:00`);
  const vencePuntos = addMonths(fechaObj, Math.round(VENCE_DIAS / 30));

  const userRef = db.ref(`users/${user.uid}`);
  const ticketRef = userRef.child(`tickets/${ticketId}`);
  const pointsRef = userRef.child('points');
  const indexRef = db.ref(`ticketsIndex/${ymd}/${indexKey}`);

  try {
    // A. TRANSACCIÓN DE ÍNDICE (Evita que dos personas registren el mismo ticket)
    const idxTx = await indexRef.transaction(curr => {
      if (curr) return; // Ya existe
      return { uid: user.uid, folio, total: totalNum, createdAt: Date.now() };
    });

    if (!idxTx.committed) {
      msgTicket.className = 'validacion-msg err';
      msgTicket.textContent = "❌ Este ticket ya fue registrado anteriormente.";
      await pushLiveEvent({
        type: "fraud_attempt",
        status: "err",
        reason: "duplicate_ticket",
        ticket: { folio, fecha: fechaStr, total: totalNum }
      });
      return;
    }

    // B. TRANSACCIÓN DE TICKET (Guarda el registro en el perfil del usuario)
    const res = await ticketRef.transaction(current => {
      if (current) return;
      return {
        id: ticketId,
        folio,
        fecha: fechaStr,
        total: totalNum,
        mesero: mesero || "NO DETECTADO",
        imagen: window.lastTicketImage || "",
        sucursalId: lastScanData.storeId || "DESCONOCIDA",
        sucursalName: lastScanData.storeName || "Applebee's",
        puntosTotal: monedero,
        points: monedero,
        vencePuntos: vencePuntos.getTime(),
        createdAt: Date.now()
      };
    });

    if (!res.committed) {
      msgTicket.className = 'validacion-msg err';
      msgTicket.textContent = "❌ Error al guardar el ticket. Reintenta.";
      return;
    }

    // C. ACTUALIZACIÓN DE SALDO (Abono al monedero)
    await pointsRef.transaction(curr => round2(Number(curr || 0) + monedero));

    // D. EVENTO EN VIVO FINAL
    await pushLiveEvent({
      type: "ticket_registered",
      brand: "Applebee's",
      storeId: lastScanData.storeId,
      storeName: lastScanData.storeName,
      status: "ok",
      ticket: { folio, fecha: fechaStr, total: totalNum, mesero, abono: monedero }
    });

    // E. ÉXITO Y REDIRECCIÓN
    msgTicket.className = 'validacion-msg ok';
    msgTicket.textContent = `✅ ¡Éxito! Abonamos ${fmtMoney(monedero)} a tu cuenta.`;
    
    setTimeout(() => { window.location.href = 'panel.html'; }, 1500);

  } catch (e) {
    console.error("🔥 Error crítico:", e);
    msgTicket.className = 'validacion-msg err';
    msgTicket.textContent = "Error de conexión. El ticket no se registró.";
  }
}

  auth.onAuthStateChanged(user=>{
    unsub.forEach(fn=>{ try{fn();}catch{} });
    unsub = [];

    if (!user){
      window.location.href = 'index.html';
      return;
    }
    if (greetEl) greetEl.textContent = `Registro de ticket — ${user.email}`;
    attachUserStreams(user.uid);
  });

  btnRegistrar?.addEventListener('click', registrarTicketRTDB);

  if (btnBack) {
    btnBack.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const m = document.getElementById("cameraModal");
      if (m) {
        m.style.display = "none";
        m.setAttribute("aria-hidden", "true");
      }

      try {
        if (liveStream) {
          liveStream.getTracks().forEach(t => t.stop());
          liveStream = null;
        }
      } catch {}

      window.location.assign("panel.html");
    }, { capture: true });
  }

  // ✅ Siempre bloqueado (sin teclado)
  lockInputs();
  btnRegistrar && (btnRegistrar.disabled = true);

  window.addEventListener("error", (e) => {
    console.error("[window error]", e.error || e.message || e);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[promise rejection]", e.reason || e);
  });
})();
