const admin = require('firebase-admin');

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT');
  }

  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function normalizarNombre(valor) {
  return String(valor || '')
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

    const col = db.collection('huespedes');

    const snap = await col
      .where('quincena', '==', quincenaLimpia)
      .get();

    const existentesPorId = new Map(
      snap.docs.map((doc) => [doc.id, doc.data()])
    );
    const limpiarSalida = new Set(permitirLimpiarSalidaIds.map(String));

    // Una pantalla antigua no debe borrar una salida que la
    // automatización haya registrado entretanto.
    datosValidos.forEach((h) => {
      const anterior = existentesPorId.get(h.id);
      if (
        anterior?.fecha_salida &&
        !h.fecha_salida &&
        !limpiarSalida.has(h.id)
      ) {
        h.fecha_salida = anterior.fecha_salida;
      }
    });

    // Si se registra una salida después de haber cerrado la quincena,
    // retirar la copia que el cierre creó en la quincena siguiente.
    const periodo = datosQuincena(quincenaLimpia);
    const siguienteSnap = await col
      .where('quincena', '==', periodo.siguiente)
      .get();

    const salidasDelPeriodo = new Set(
      datosValidos
        .filter((h) => h.fecha_salida && h.fecha_salida <= periodo.fin)
        .map((h) => `${normalizarNombre(h.nombre)}|${h.hostal}`)
    );

    const operaciones = [];

    const idsAEliminar = new Set(eliminarIds.map(String));

    snap.docs.forEach((doc) => {
      if (
        idsAEliminar.has(doc.id) ||
        (reemplazar && !idsActuales.has(doc.id))
      ) {
        operaciones.push({
          tipo: 'delete',
          ref: doc.ref
        });
      }
    });

    siguienteSnap.docs.forEach((doc) => {
      const h = doc.data();
      const clave = `${normalizarNombre(h.nombre)}|${h.hostal || ''}`;

      if (
        h.origen_cierre === quincenaLimpia &&
        salidasDelPeriodo.has(clave)
      ) {
        operaciones.push({
          tipo: 'delete',
          ref: doc.ref
        });
      }
    });

    datosValidos.forEach((h) => {
      operaciones.push({
        tipo: 'set',
        ref: col.doc(h.id),
        datos: h
      });
    });

    // Firestore admite un máximo de 500 operaciones por batch.
    const BATCH_SIZE = 450;

    for (let i = 0; i < operaciones.length; i += BATCH_SIZE) {
      const batch = db.batch();

      operaciones.slice(i, i + BATCH_SIZE).forEach((operacion) => {
        if (operacion.tipo === 'delete') {
          batch.delete(operacion.ref);
        } else {
          batch.set(operacion.ref, operacion.datos);
        }
      });

      await batch.commit();
    }

    return res.status(200).json({
      ok: true,
      guardados: datosValidos.length
    });
  } catch (error) {
    console.error('Error al guardar huéspedes:', error);

    return res.status(500).json({
      ok: false,
      error: 'No se pudieron guardar los huéspedes'
    });
  }
};
