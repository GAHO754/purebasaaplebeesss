// registrar.js — RTDB + Cámara + OCR AUTO + Bloqueo total + Mesero + resumen claro (Saldo)
(() => {
  console.log("[registrar.js] cargado");

  const $ = id => document.getElementById(id);

  // ===== Firebase =====
  const auth = firebase.auth();
  const db   = firebase.database();

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
  // ===========================================================

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
        console.warn("[autoProcess] OCR no listo");
        setStatus("No se pudo iniciar el OCR. Revisa la consola.", "err");
        return;
    }

    try {
        setStatus("🕐 Escaneando ticket…");
        lockInputs();
        if (btnRegistrar) btnRegistrar.disabled = true;

        // 1. Llamada al OCR (trae auditoría y sucursal)
        const ret = await window.processTicketWithIA(file);

        const folio         = (ret?.folio || "").toString().trim();
        const fecha         = (ret?.fecha || "").toString().trim();
        const total         = Number(ret?.total || 0);
        const auditOk       = ret?.auditOk;       // ✅ Recibimos validación de platos
        const sumaAuditoria = ret?.sumaAuditoria; // ✅ Recibimos suma de platos
        const mesero        = sanitizeMesero(iMesero?.value || ret?.mesero);

        // 2. 🛡️ BLINDAJE DE AUDITORÍA (Total vs Productos)
        if (total > 0 && !auditOk) {
            setStatus(`⚠️ Error: El Total es $${total.toFixed(2)} pero los productos suman $${sumaAuditoria.toFixed(2)}. Verifica la foto.`, "err");
            msgTicket.className = 'validacion-msg err';
            msgTicket.textContent = "Los montos no coinciden. Intenta una foto más clara.";
            lockInputs();
            return; // ❌ BLOQUEO: Detenemos aquí si no cuadra la suma
        }

        // 3. Guardar datos de sucursal detectada y subir imagen
        lastScanData.storeId = ret?.storeId || "APB_PASEO";
        lastScanData.storeName = ret?.storeName || "Applebee’s Paseo Central";

        if (total > 0) {
            window.lastTicketImage = await uploadTicketImage(file, folio);
        }

        // 4. Asignar valores a los inputs (Visualización)
        if (iNum)   iNum.value = folio;
        if (iFecha) iFecha.value = fecha;
        if (iMesero) iMesero.value = mesero;
        if (iTotal) iTotal.value = (total > 0) ? total.toFixed(2) : "0.00";

        // 5. Validación de formato de campos
        const okFolio = /^\d{3,10}$/.test(folio);
        const okFecha = /^\d{4}-\d{2}-\d{2}$/.test(fecha);
        const okTotal = total > 0;

        if (!okTotal) {
            setStatus("❌ No se detectó el TOTAL. Toma otra foto clara del área de total.", "err");
            msgTicket.className = 'validacion-msg err';
            msgTicket.textContent = "No se puede registrar sin TOTAL válido.";
            return;
        }

        // 6. ÉXITO: Ticket verificado y cuadrado
        const meseroTxt = mesero ? ` · Mesero: ${mesero}` : "";
        setStatus(`✓ Ticket verificado en ${lastScanData.storeName}${meseroTxt}`, "ok");
        msgTicket.className = 'validacion-msg ok';
        msgTicket.textContent = "Ticket verificado correctamente.";

        // 7. EVENTO EN VIVO (Con la sucursal real detectada)
        try {
            await pushLiveEvent({
                type: "ticket_scan",
                status: "ok",
                storeId: lastScanData.storeId,
                storeName: lastScanData.storeName,
                ticket: { folio, fecha, total, mesero }
            });
        } catch {}

        lockInputs();

        // 8. Activar botón solo si todo es perfecto
        if (okFolio && okFecha && okTotal && auditOk) {
            if (btnRegistrar) btnRegistrar.disabled = false;
        }

    } catch (e) {
        console.error("[autoProcess] Error:", e);
        setStatus("Falló el OCR. Intenta de nuevo.", "err");
        if (btnRegistrar) btnRegistrar.disabled = true;
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

  async function captureFrame(){
    const w=video.videoWidth, h=video.videoHeight;
    if (!w||!h){ setStatus("Cámara aún no lista. Intenta de nuevo.","err"); return; }
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx = c.getContext('2d');
    ctx.filter = "contrast(1.15) brightness(1.05) saturate(1.05)";
    ctx.drawImage(video,0,0,w,h);
    stopCamera();
    const dataURL=c.toDataURL("image/jpeg",.95);
    const blob=dataURLtoBlob(dataURL);
    setFileInputFromBlob(blob,`ticket_${Date.now()}.jpg`);
    setStatus("📎 Foto capturada. Procesando OCR…","ok");
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

  async function registrarTicketRTDB(){
      const user = auth.currentUser;

    if (!user || !user.uid){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent="Sesión no lista. Intenta de nuevo.";
      return;
    }

    const folio=(iNum?.value||'').trim().toUpperCase();
    const fechaStr=(iFecha?.value||'').trim();
    const totalNum=parseFloat(iTotal?.value||"0")||0;
    const mesero=(iMesero?.value||'').trim().toUpperCase();

    // ✅ Bloqueo fuerte: NO registrar si no hay TOTAL válido real
    if (!/^\d{5,7}$/.test(folio) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaStr) || !(totalNum>0)){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent="Faltan datos válidos (folio/fecha/total). Toma otra foto clara del TOTAL.";
      return;
    }

    // ✅ Nuevo: validar vencimiento de registro (3 días)
    if (isTicketExpiredByDate(fechaStr)){
      msgTicket.className='validacion-msg err';
      msgTicket.textContent=`⛔ Ticket vencido. Solo puedes registrar tu consumo dentro de ${REGISTER_DAYS_LIMIT} días a partir de la fecha del ticket.`;
      return;
    }

    // Límite por día
    if (DAY_LIMIT>0){
      try{
        const {start,end}=startEndOfToday();
        const qs=db.ref(`users/${user.uid}/tickets`).orderByChild('createdAt').startAt(start).endAt(end);
        const snap=await qs.once('value');
        const countToday=snap.exists()?Object.keys(snap.val()).length:0;
        if (countToday>=DAY_LIMIT){
          msgTicket.className='validacion-msg err';
          msgTicket.textContent=`⚠️ Ya registraste ${DAY_LIMIT} tickets hoy.`;

          try {
            await pushLiveEvent({
              type: "ticket_registered",
              brand: "Applebees",
              storeId: lastScanData.storeId,     // Usa la sucursal detectada
              storeName: lastScanData.storeName, // Usa el nombre detectado
              status: "ok",
              ticket: { 
                folio, 
                fecha: fechaStr, 
                total: totalNum, 
                mesero,
                monederoAbonado: monedero // Añadimos cuánto ganó para el monitor
              }
            });
          } catch {}

          return;
        }
      }catch(err){ console.warn('No pude verificar límite diario:',err); }
    }

    const { ymd, totalCents, indexKey, ticketId } = buildTicketKeys(fechaStr, folio, totalNum);

    // ✅ Nuevo: monedero 5%
    const monedero = computeMonederoFromTotal(totalNum); // decimal

    const fecha=new Date(`${fechaStr}T00:00:00`);
    const vencePuntos=addMonths(fecha, Math.round(VENCE_DIAS/30)); // mismo comportamiento (aprox 6 meses)

   

    const userRef   = db.ref(`users/${user.uid}`);
    const ticketRef = userRef.child(`tickets/${ticketId}`);
    const pointsRef = userRef.child('points');
    const indexRef  = db.ref(`ticketsIndex/${ymd}/${indexKey}`);

    console.log("📦 DATA A GUARDAR:", {
    folio,
    fecha: fechaStr,
    total: totalNum,
    mesero,
    monedero
  });


    try{
      const idxTx = await indexRef.transaction(curr=>{
        if (curr) return;
        return { uid:user.uid, folio, fecha:fechaStr, total:totalNum, totalCents, createdAt:Date.now() };
      });
      if (!idxTx.committed) {
      msgTicket.className = 'validacion-msg err';
      msgTicket.textContent = "❌ Este ticket ya fue registrado.";
      
      // ✅ ENVIAR ALERTA AL MONITOR EN VIVO
      await pushLiveEvent({
        type: "fraud_attempt",
        status: "err",
        reason: "duplicate_ticket",
        ticket: { folio, fecha: fechaStr, total: totalNum }
      });
      return;
    }

      const res = await ticketRef.transaction(current=>{
      if (current) return;

      const dataToSave = {
        id: ticketId,
        folio,
        fecha: fechaStr,
        total: totalNum,
        mesero: mesero || "",
        imagen: window.lastTicketImage || "",
        sucursalId: lastScanData.storeId,     // ✅ Guarda la detectada por OCR
        sucursalName: lastScanData.storeName, // ✅ Guarda la detectada por OCR
        // ... puntos y lo demás sigue igual

        productos: {
          "0": {
            nombre: "Consumo",
            cantidad: 1,
            puntos_unitarios: Math.min(15, Math.max(1, Math.round(monedero)))
          }
        },

        puntos: {
          total: monedero,
          detalle: {
            "0": {
              producto: "Consumo",
              cantidad: 1,
              puntos_unitarios: Math.min(15, Math.max(1, Math.round(monedero))),
              puntos_subtotal: Math.min(15, Math.max(1, Math.round(monedero)))
            }
          }
        },

        puntosTotal: monedero,
        points: monedero,

        vencePuntos: vencePuntos.getTime(),
        createdAt: Date.now()
      };

      console.log("🚀 INTENTANDO GUARDAR:", dataToSave);

      return dataToSave;

      });
      if (!res.committed){
        msgTicket.className='validacion-msg err';
        msgTicket.textContent="❌ Ya tienes un registro con ese folio y fecha.";
        return;
      }

      // ✅ Sumar monedero al saldo del usuario (con 2 decimales)
      await pointsRef.transaction(curr => {
        const next = round2(Number(curr||0) + monedero);
        return next;
      });

      // ✅ LIVE EVENT: ticket registrado OK
      try{
        await pushLiveEvent({
          type: "ticket_registered",
          brand: "Applebees",
          storeId: "APB_PASEO",
          storeName: "Applebee’s Paseo Central",
          status: "ok",
          ticket: { folio, fecha: fechaStr, total: totalNum, mesero }
        });
      }catch{}

      msgTicket.className='validacion-msg ok';
      msgTicket.textContent=`✅ Ticket registrado con éxito. Se abonó ${fmtMoney(monedero)} (5%) a tu monedero electrónico.`;
      setTimeout(()=>{ window.location.href='panel.html'; }, 900);
      }catch(e){
      console.error("🔥 ERROR COMPLETO:", e.code, e.message, e);

      msgTicket.className='validacion-msg err';

      if (e.code === "PERMISSION_DENIED" || String(e).includes('Permission denied')){
        msgTicket.textContent="Permiso denegado por Realtime Database. Revisa las reglas.";
      }else{
        msgTicket.textContent="No se pudo registrar el ticket. Revisa tu conexión e inténtalo de nuevo.";
      }
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
