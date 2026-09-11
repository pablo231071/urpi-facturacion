const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT');
  }

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function normalizarNombre(valor) {
  return String(valor || '')
    .replace(/\s*\(\s*\d+\s*a[ñn]os?\s*\)\s*$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Método no permitido'
    });
  }

  try {
    const {
      huespedes,
      quincena,
      reemplazar = false,
      eliminarIds = [],
      permitirLimpiarSalidaIds = []
    } = req.body || {};

    const quincenaLimpia = String(quincena || '').trim();

    if (!/^\d{4}_(?:[1-9]|1[0-2])_[12]$/.test(quincenaLimpia)) {
      return res.status(400).json({
        ok: false,
        error: 'Quincena no válida'
      });
    }

    if (!Array.isArray(huespedes)) {
      return res.status(400).json({
        ok: false,
        error: 'La lista de huéspedes no es válida'
      });
    }

    if (!Array.isArray(eliminarIds) || !Array.isArray(permitirLimpiarSalidaIds)) {
      return res.status(400).json({
        ok: false,
        error: 'La operación de guardado no es válida'
      });
    }

    const datosValidos = huespedes.map((h, orden) => {
      const id = String(h.id || '').trim();
      const nombre = String(h.nombre || '').trim();
      const hostal = String(h.hostal || '').trim();

      if (!id || id.includes('/') || id.length > 200) {
        throw new Error('Uno de los huéspedes tiene un identificador no válido');
      }

      if (!nombre) {
        throw new Error('Uno de los huéspedes no tiene nombre');
      }

      if (!hostal) {
        throw new Error(`Falta el hostal de ${nombre}`);
      }

      return {
        id,
        nombre: nombre.slice(0, 200),
        nombre_normalizado: normalizarNombre(nombre),
        fnac: String(h.fnac || ''),
        hostal: hostal.slice(0, 100),
        fecha_entrada: String(h.fechaEntrada || ''),
        fecha_salida: String(h.fechaSalida || ''),
        cabeza: Boolean(h.cabeza),
        picnic: Boolean(h.picnic),
        min_dias: Math.max(0, Number(h.minDias) || 0),
        snack_dias: Math.max(0, Number(h.snackDias) || 0),
        importado: Boolean(h.importado),
        orden,
        tipo_manual: String(h.tipoManual || ''),
        sin_snack: Boolean(h.sinSnack),
        origen_cierre: String(h.origenCierre || ''),
        estancia_id: String(h.estanciaId || ''),
        quincena: quincenaLimpia
      };
    });

    const idsActuales = new Set(datosValidos.map((h) => h.id));

    if (idsActuales.size !== datosValidos.length) {
      return res.status(400).json({
        ok: false,
        error: 'Hay identificadores de huéspedes duplicados'
      });
    }

    if (datosValidos.length + eliminarIds.length > 400) {
      return res.status(400).json({
        ok: false,
        error: 'Demasiados registros para guardar de forma segura en una sola operación'
      });
    }

    const col = db.collection('huespedes');
    const limpiarSalida = new Set(permitirLimpiarSalidaIds.map(String));
    const idsAEliminar = new Set(eliminarIds.map(String));

    const resultado = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(
        col.where('quincena', '==', quincenaLimpia)
      );

      const existentesPorId = new Map(
        snap.docs.map((doc) => [doc.id, doc.data()])
      );

      const datosFinales = datosValidos.map((h) => {
        const actual = { ...h };
        const anterior = existentesPorId.get(actual.id);

        actual.estancia_id =
          actual.estancia_id || anterior?.estancia_id || actual.id || crypto.randomUUID();

        // Una pantalla antigua nunca puede borrar una fecha de salida ya
        // registrada por la automatización, salvo petición manual explícita.
        if (
          anterior?.fecha_salida &&
          !actual.fecha_salida &&
          !limpiarSalida.has(actual.id)
        ) {
          actual.fecha_salida = anterior.fecha_salida;
        }

        return actual;
      });

      let eliminados = 0;

      // Regla de seguridad: este guardado solo puede eliminar documentos de
      // la MISMA quincena que se está editando. Nunca toca la anterior ni la
      // siguiente. Así un cierre, un FIN retroactivo o una pantalla desfasada
      // no puede hacer desaparecer huéspedes de otro periodo.
      snap.docs.forEach((doc) => {
        if (
          idsAEliminar.has(doc.id) ||
          (reemplazar && !idsActuales.has(doc.id))
        ) {
          transaction.delete(doc.ref);
          eliminados++;
        }
      });

      datosFinales.forEach((h) => {
        transaction.set(col.doc(h.id), h);
      });

      return {
        guardados: datosFinales.length,
        eliminados,
        copiasRetiradas: 0
      };
    });

    return res.status(200).json({
      ok: true,
      guardados: resultado.guardados,
      eliminados: resultado.eliminados,
      copiasRetiradas: 0
    });
  } catch (error) {
    console.error('Error al guardar huéspedes:', error);

    return res.status(500).json({
      ok: false,
      error: 'No se pudieron guardar los huéspedes'
    });
  }
};
