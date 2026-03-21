/* auth.js — versión RTDB (login_alias en Realtime Database) */
(function(){
  'use strict';

  // --- Verificación básica de Firebase ---
  if (typeof firebase === 'undefined') {
    console.error('[auth] Firebase no está cargado. Revisa tus <script> de Firebase.');
    return;
  }

  const auth = firebase.auth();
  const rtdb = firebase.database();

  // ---------- Utilidades ----------
  // Normaliza teléfono mexicano: permite 10 dígitos (ej. 6561246587),
  // o con +52, 52, o 521 al inicio. Siempre devuelve +52XXXXXXXXXX
  function normalizeMxPhone(input){
    if (!input) return null;
    let digits = String(input).replace(/\D+/g, ''); // quitar todo menos números

    // Aceptar formatos 521XXXXXXXXXX o 52XXXXXXXXXX (WhatsApp u otros)
    if (digits.startsWith('521')) digits = digits.slice(3);
    else if (digits.startsWith('52')) digits = digits.slice(2);

    // Deben quedar exactamente 10 dígitos
    if (digits.length !== 10) return null;

    return `+52${digits}`;
  }

  // Lee el email desde RTDB: /login_alias/{phoneE164} -> { uid, email, createdAt }
  async function emailFromPhoneRTDB(phoneE164){
    if (!phoneE164) return null;
    const snap = await rtdb.ref('login_alias').child(phoneE164).once('value');
    const val = snap.val();
    return (val && val.email) ? val.email : null;
  }

  // Guarda/actualiza el alias de login en RTDB
  async function upsertLoginAliasRTDB(phoneE164, uid, email){
    await rtdb.ref('login_alias').child(phoneE164).set({
      uid,
      email,
      createdAt: firebase.database.ServerValue.TIMESTAMP
    });
  }

  // Guarda el perfil del usuario en RTDB: /users/{uid}
  async function saveUserProfileRTDB(uid, profile){
    await rtdb.ref('users').child(uid).set({
      uid,
      name: profile.name || '',
      email: profile.email || '',
      phone: profile.phone || '',
      createdAt: firebase.database.ServerValue.TIMESTAMP
    });
  }

  // ---------- Login ----------
  async function login(){
    const inputEl = document.getElementById('emailOrPhone');
    const passEl  = document.getElementById('password');
    const btn     = document.getElementById('btnLogin');

    const input    = (inputEl?.value || '').trim();
    const password = (passEl?.value || '');

    if (!input || !password) {
      alert('⚠️ Ingresa correo/teléfono y contraseña');
      return;
    }

    try {
      if (btn) btn.disabled = true;

      if (input.includes('@')) {
        // Correo + password
        await auth.signInWithEmailAndPassword(input, password);
      } else {
        // Teléfono + password -> resolver email en RTDB
        const phone = normalizeMxPhone(input);
        if (!phone) {
          alert('❌ Teléfono inválido. Usa 10 dígitos (MX) o formato +52XXXXXXXXXX.');
          return;
        }
        const email = await emailFromPhoneRTDB(phone);
        if (!email) {
          alert('❌ No encontramos una cuenta asociada a ese teléfono.');
          return;
        }
        await auth.signInWithEmailAndPassword(email, password);
      }

      alert('✅ Bienvenido');
      window.location.href = 'panel.html';
    } catch (err) {
      console.error(err);
      alert('❌ ' + (err?.message || 'Error al iniciar sesión'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- Registro (TELÉFONO OPCIONAL) ----------
  async function register(){
    const nameEl  = document.getElementById('regName');
    const emailEl = document.getElementById('regEmail');
    const phoneEl = document.getElementById('regPhone');
    const passEl  = document.getElementById('regPassword');
    const btn     = document.getElementById('btnRegister');

    const name     = (nameEl?.value || '').trim();
    const email    = (emailEl?.value || '').trim();
    const phoneRaw = (phoneEl?.value || '').trim();
    const password = (passEl?.value || '');

    if (!name)     return alert('❌ Debes ingresar tu nombre completo.');
    if (!email)    return alert('❌ Debes ingresar un correo.');
    if (!password) return alert('❌ Debes ingresar una contraseña.');
    if (password.length < 6) return alert('❌ La contraseña debe tener al menos 6 caracteres.');

    // Teléfono opcional: si viene vacío, seguimos; si trae algo, validar
    let phoneE164 = '';
    if (phoneRaw) {
      const normalized = normalizeMxPhone(phoneRaw);
      if (!normalized) return alert('❌ Teléfono inválido. Escribe 10 dígitos (ej. 6561246587).');
      phoneE164 = normalized;
    }

    try {
      if (btn) btn.disabled = true;

      // Crea el usuario con email/contraseña
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      const user = cred.user;

      // Nombre visible
      await user.updateProfile({ displayName: name });

      // Guarda perfil en RTDB
      await saveUserProfileRTDB(user.uid, { name, email, phone: phoneE164 });

      // Si capturaron teléfono, crear/actualizar alias en RTDB
      if (phoneE164) {
        await upsertLoginAliasRTDB(phoneE164, user.uid, email);
      }

      alert(`✅ ¡Bienvenido, ${name}! Cuenta creada correctamente.`);
      window.location.href = 'index.html';
    } catch (err) {
      console.error(err);
      // Errores comunes: email ya en uso, contraseña débil, dominio no permitido
      alert('❌ ' + (err?.message || 'Error al registrar'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------- Reset Password (correo o teléfono) ----------
  async function resetPassword(){
    const input = prompt('📧 Ingresa tu correo o teléfono para restablecer la contraseña:');
    if (!input) return;

    try {
      if (input.includes('@')) {
        await auth.sendPasswordResetEmail(input.trim());
        alert('✅ Correo de recuperación enviado');
      } else {
        const phone = normalizeMxPhone(input);
        if (!phone) return alert('❌ Teléfono inválido.');
        const email = await emailFromPhoneRTDB(phone);
        if (!email)  return alert('❌ No encontramos una cuenta para ese teléfono.');
        await auth.sendPasswordResetEmail(email);
        alert('✅ Enviamos el correo de recuperación a la dirección asociada a ese teléfono');
      }
    } catch (err) {
      console.error(err);
      alert('❌ ' + (err?.message || 'Error al restablecer'));
    }
  }

  // ---------- Exponer funciones a la ventana ----------
  window.login = login;
  window.register = register;
  window.resetPassword = resetPassword;

  // ---------- Wiring (auto) ----------
  window.addEventListener('DOMContentLoaded', () => {
    // Login page
    const btnLogin = document.getElementById('btnLogin');
    const lnkReset = document.getElementById('lnkReset');
    if (btnLogin) btnLogin.addEventListener('click', login);
    if (lnkReset) lnkReset.addEventListener('click', (e)=>{ e.preventDefault(); resetPassword(); });
    const emailOrPhone = document.getElementById('emailOrPhone');
    const password = document.getElementById('password');
    [emailOrPhone, password].forEach(el => {
      if (!el) return;
      el.addEventListener('keydown', (ev)=>{
        if (ev.key === 'Enter') login();
      });
    });

    // Register page
    const btnRegister = document.getElementById('btnRegister');
    if (btnRegister) btnRegister.addEventListener('click', register);
  });

  console.log('[auth] listo');
})();
