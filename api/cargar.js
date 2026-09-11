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

function normalizarTexto(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function puntuacion(h) {
  return (
    (h.fechaSalida ? 8 : 0) +
    (h.fechaEntrada ? 4 : 0) +
    (h.fnac ? 2 : 0) +
    (h.cabeza ? 1 : 0) +
    (h.sinSnack ? 1 : 0) +
    (h.minDias ? 1 : 0) +
    (h.snackDias ? 1 : 0)
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      error: 'Método no permitido'
    });
  }

  try {
    const quincena = String(req.query.quincena || '').trim();

    if (!/^\d{4}_(?:[1-9]|1[0-2])_[12]$/.test(quincena)) {
      return res.status(400).json({
        ok: false,
        error: 'Quincena no válida'
      });
    }

    const snap = await db
      .collection('huespedes')
      .where('quincena', '==', quincena)
      .get();

    const todos = snap.docs.map((doc) => {
      const f = doc.data();

      return {
        id: doc.id,
        nombre: f.nombre || '',
        fnac: f.fnac || '',
        hostal: f.hostal || '',
        fechaEntrada: f.fecha_entrada || '',
        fechaSalida: f.fecha_salida || '',
        cabeza: Boolean(f.cabeza),
        picnic: Boolean(f.picnic),
        minDias: Number(f.min_dias) || 0,
        snackDias: Number(f.snack_dias) || 0,
        importado: Boolean(f.importado),
        tipoManual: f.tipo_manual || '',
        sinSnack: Boolean(f.sin_snack),
        origenCierre: f.origen_cierre || '',
        estanciaId: f.estancia_id || '',
        orden: Number(f.orden) || 0,
        quincena: f.quincena || ''
      };
    });

    // Primera capa: consolidar documentos con la misma estancia_id.
    const porEstancia = new Map();
    const candidatos = [];

    for (const h of todos) {
      const claveEstancia = String(h.estanciaId || '').trim();

      if (!claveEstancia) {
        candidatos.push(h);
        continue;
      }

      const anterior = porEstancia.get(claveEstancia);

      if (!anterior || puntuacion(h) > puntuacion(anterior)) {
        porEstancia.set(claveEstancia, h);
      }
    }

    candidatos.push(...porEstancia.values());

    // Segunda capa: algunos cierres antiguos generaron IDs de estancia nuevos
    // para la misma persona. Consolidamos solo copias operativamente exactas:
    // mismo nombre normalizado, mismo hostal, misma entrada y misma salida.
    // No se elimina nada de Firestore; únicamente se evita mostrar dos veces
    // la misma estancia aparente en la interfaz.
    const porFirma = new Map();

    for (const h of candidatos) {
      const firma = [
        normalizarTexto(h.nombre),
        normalizarTexto(h.hostal),
        String(h.fechaEntrada || ''),
        String(h.fechaSalida || '')
      ].join('|');

      const anterior = porFirma.get(firma);

      if (!anterior || puntuacion(h) > puntuacion(anterior)) {
        porFirma.set(firma, h);
      }
    }

    const huespedes = [...porFirma.values()]
      .sort((a, b) => a.orden - b.orden);

    return res.status(200).json({
      ok: true,
      huespedes,
      totalDocumentos: todos.length,
      duplicadosOcultos: todos.length - huespedes.length
    });
  } catch (error) {
    console.error('Error al cargar huéspedes:', error);

    return res.status(500).json({
      ok: false,
      error: 'No se pudieron cargar los huéspedes'
    });
  }
};
