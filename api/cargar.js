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

    // Protección contra duplicados creados por cierres anteriores:
    // si dos documentos representan exactamente la misma estancia_id dentro
    // de la misma quincena, solo se muestra una copia. No deduplicamos por
    // nombre para evitar borrar por error a homónimos legítimos.
    const porEstancia = new Map();
    const sinEstancia = [];

    for (const h of todos) {
      const clave = String(h.estanciaId || '').trim();

      if (!clave) {
        sinEstancia.push(h);
        continue;
      }

      const anterior = porEstancia.get(clave);

      if (!anterior) {
        porEstancia.set(clave, h);
        continue;
      }

      // Conservar preferentemente la copia que contenga más información.
      const puntuacion = (x) =>
        (x.fechaSalida ? 8 : 0) +
        (x.fechaEntrada ? 4 : 0) +
        (x.fnac ? 2 : 0) +
        (x.cabeza ? 1 : 0) +
        (x.sinSnack ? 1 : 0) +
        (x.minDias ? 1 : 0) +
        (x.snackDias ? 1 : 0);

      if (puntuacion(h) > puntuacion(anterior)) {
        porEstancia.set(clave, h);
      }
    }

    const huespedes = [
      ...porEstancia.values(),
      ...sinEstancia
    ].sort((a, b) => a.orden - b.orden);

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
