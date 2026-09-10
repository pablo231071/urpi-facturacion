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

function datosQuincena(clave) {
  const [ano, mes, tipo] = clave.split('_').map(Number);
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();

  if (tipo === 1) {
    return {
      fin: `${ano}-${String(mes).padStart(2, '0')}-15`,
      siguiente: `${ano}_${mes}_2`
    };
  }

  const siguienteMes = mes === 12 ? 1 : mes + 1;
  const siguienteAno = mes === 12 ? ano + 1 : ano;

  return {
    fin: `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`,
    siguiente: `${siguienteAno}_${siguienteMes}_1`
  };
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

    // Una quincena de URPI está muy por debajo de este límite. Mantener toda
    // la operación en una sola transacción evita que un guardado manual pueda
    // sobrescribir un FIN registrado por la automatización entre lectura/escritura.
    if (datosValidos.length + eliminarIds.length > 400) {
      return res.status(400).json({
        ok: false,
        error: 'Demasiados registros para guardar de forma segura en una sola operación'
      });
    }

    const col = db.collection('huespedes');
    const periodo = datosQuincena(quincenaLimpia);
    const limpiarSalida = new Set(permitirLimpiarSalidaIds.map(String));
    const idsAEliminar = new Set(eliminarIds.map(String));

    const resultado = await db.runTransaction(async (transaction) => {
      // Todas las lecturas se hacen dentro de la misma transacción. Si
      // Activepieces modifica alguno de estos documentos mientras se guarda,
      // Firestore reintenta la operación con el estado más reciente.
      const snap = await transaction.get(
        col.where('quincena', '==', quincenaLimpia)
      );

      const siguienteSnap = await transaction.get(
        col.where('quincena', '==', periodo.siguiente)
      );

      const existentesPorId = new Map(
        snap.docs.map((doc) => [doc.id, doc.data()])
      );

      const datosFinales = datosValidos.map((h) => {
        const actual = { ...h };
        const anterior = existentesPorId.get(actual.id);

        actual.estancia_id =
          actual.estancia_id || anterior?.estancia_id || actual.id || crypto.randomUUID();

        // Protección principal: una pantalla que se cargó antes de recibir un
        // correo FIN nunca puede borrar esa salida, salvo que el usuario haya
        // pedido expresamente limpiarla desde la interfaz.
        if (
          anterior?.fecha_salida &&
          !actual.fecha_salida &&
          !limpiarSalida.has(actual.id)
        ) {
          actual.fecha_salida = anterior.fecha_salida;
        }

        return actual;
      });

      const salidasDelPeriodo = new Set(
        datosFinales
          .filter((h) => h.fecha_salida && h.fecha_salida <= periodo.fin)
          .map((h) =>
            h.estancia_id || `${normalizarNombre(h.nombre)}|${h.hostal}`
          )
      );

      let eliminados = 0;
      let copiasRetiradas = 0;

      snap.docs.forEach((doc) => {
        if (
          idsAEliminar.has(doc.id) ||
          (reemplazar && !idsActuales.has(doc.id))
        ) {
          transaction.delete(doc.ref);
          eliminados++;
        }
      });

      siguienteSnap.docs.forEach((doc) => {
        const h = doc.data();
        const clave =
          h.estancia_id || `${normalizarNombre(h.nombre)}|${h.hostal || ''}`;

        if (
          h.origen_cierre === quincenaLimpia &&
          salidasDelPeriodo.has(clave)
        ) {
          transaction.delete(doc.ref);
          copiasRetiradas++;
        }
      });

      datosFinales.forEach((h) => {
        transaction.set(col.doc(h.id), h);
      });

      return {
        guardados: datosFinales.length,
        eliminados,
        copiasRetiradas
      };
    });

    return res.status(200).json({
      ok: true,
      guardados: resultado.guardados,
      eliminados: resultado.eliminados,
      copiasRetiradas: resultado.copiasRetiradas
    });
  } catch (error) {
    console.error('Error al guardar huéspedes:', error);

    return res.status(500).json({
      ok: false,
      error: 'No se pudieron guardar los huéspedes'
    });
  }
};
