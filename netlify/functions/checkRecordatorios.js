const admin = require("firebase-admin");
const { schedule } = require("@netlify/functions");

if (!admin.apps.length) {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_B64 || "").replace(/\s/g, "");
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(Buffer.from(raw, "base64").toString("utf8"))
    ),
  });
}
const db = admin.firestore();

// ── Hora actual en Argentina (UTC-3, sin horario de verano) ──
function ahoraArgentina() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc - 3 * 3600000);
}
function fechaYMD(d) {
  return d.toISOString().slice(0, 10); // ojo: como ya restamos el offset arriba, esto da la fecha de Argentina
}

async function enviarATokens(tokens, title, body) {
  if (!tokens || !tokens.length) return [];
  const tokensValidos = [];
  for (const token of tokens) {
    try {
      await admin.messaging().send({ token, notification: { title, body } });
      tokensValidos.push(token);
    } catch (e) {
      console.error("Token inválido, se descarta:", token, e.code);
      // No lo agregamos a tokensValidos → se limpia solo de la lista
    }
  }
  return tokensValidos;
}

exports.handler = schedule("*/15 * * * *", async () => {
  const ahora = ahoraArgentina();
  const hoyStr = fechaYMD(ahora);
  const mananaStr = fechaYMD(new Date(ahora.getTime() + 86400000));
  const horaActual = ahora.getHours();
  const minutoActual = ahora.getMinutes();

  let avisosMed = 0, avisosTurnoAntes = 0, avisosTurnoHoy = 0;

  try {
    const perfilesSnap = await db.collection("perfiles").get();

    for (const perfilDoc of perfilesSnap.docs) {
      const perfil = perfilDoc.data();
      const tokens = perfil.fcmTokens || [];
      if (!tokens.length) continue;

      // ── MEDICAMENTOS: avisar si un horario cae dentro de los próximos 15 min ──
      const medsSnap = await db.collection("perfiles").doc(perfilDoc.id).collection("medicamentos").get();
      for (const medDoc of medsSnap.docs) {
        const med = medDoc.data();
        if (!med.horarios) continue;
        const horarios = med.horarios.split(",").map(h => h.trim()).filter(Boolean);
        for (const h of horarios) {
          const [hh, mm] = h.split(":").map(Number);
          if (isNaN(hh) || isNaN(mm)) continue;
          const minutosHorario = hh * 60 + mm;
          const minutosAhora = horaActual * 60 + minutoActual;
          const diff = minutosHorario - minutosAhora;
          if (diff >= 0 && diff < 15) {
            const tokensValidos = await enviarATokens(tokens, "💊 Hora de tu medicación", `${med.nombre}${med.dosis ? " — " + med.dosis : ""} (${h}hs)`);
            if (tokensValidos.length !== tokens.length) {
              await perfilDoc.ref.update({ fcmTokens: tokensValidos });
            }
            avisosMed++;
          }
        }
      }

      // ── TURNOS: día anterior + mismo día a la mañana ──
      const turnosSnap = await db.collection("perfiles").doc(perfilDoc.id).collection("turnos").get();
      for (const turnoDoc of turnosSnap.docs) {
        const turno = turnoDoc.data();
        if (!turno.fecha) continue;

        // Día anterior (una sola vez, no importa la hora del día en que corra)
        if (turno.fecha === mananaStr && !turno.avisoDiaAntes) {
          await enviarATokens(tokens, "📅 Turno mañana", `${turno.especialidad || "Turno médico"}${turno.medico ? " con " + turno.medico : ""} a las ${turno.hora || ""}hs`);
          await turnoDoc.ref.update({ avisoDiaAntes: true });
          avisosTurnoAntes++;
        }

        // Mismo día a la mañana (entre 8:00 y 8:59, una sola vez)
        if (turno.fecha === hoyStr && horaActual === 8 && !turno.avisoMismoDia) {
          await enviarATokens(tokens, "📅 Turno hoy", `${turno.especialidad || "Turno médico"}${turno.medico ? " con " + turno.medico : ""} a las ${turno.hora || ""}hs`);
          await turnoDoc.ref.update({ avisoMismoDia: true });
          avisosTurnoHoy++;
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, avisosMed, avisosTurnoAntes, avisosTurnoHoy, corrida: ahora.toISOString() }),
    };
  } catch (e) {
    console.error("Error en checkRecordatorios:", e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
});
