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

function esCabecera(nombre) {
  const n = normalizarTexto(nombre).replace(/[.:]/g, '');
  return new Set([
    'FECHA NAC',
    'FECHA NACIMIENTO',
    'FECHA DE NACIMIENTO',
    'NOMBRE',
    'NOMBRES',
    'APELLIDOS',
    'NOMBRE Y APELLIDOS'
  ]).has(n);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Automation-Secret'
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    const secretoConfigurado =
      process.env.AUTOMATION_SECRET;

    const secretoRecibido =
      req.headers['x-automation-secret'];

    if (
      !secretoConfigurado ||
      secretoRecibido !== secretoConfigurado
    ) {
      return res.status(401).json({
        ok: false,
        error: 'No autorizado'
      });
    }

    const quincena = String(req.query.quincena || '').trim();

    if (!/^\d{4}_(?:[1-9]|1[0-2])_[12]$/.test(quincena)) {
      return res.status(400).json({ ok: false, error: 'Quincena no válida' });
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

    // 1) Misma estancia_id: conservar la copia más completa.
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

    // 2) Copias exactamente iguales aunque tengan estancia_id distinta.
    const porFirmaExacta = new Map();
    for (const h of candidatos) {
      const firma = [
        normalizarTexto(h.nombre),
        normalizarTexto(h.hostal),
        String(h.fechaEntrada || ''),
        String(h.fechaSalida || '')
      ].join('|');
      const anterior = porFirmaExacta.get(firma);
      if (!anterior || puntuacion(h) > puntuacion(anterior)) {
        porFirmaExacta.set(firma, h);
      }
    }

    const consolidados = [...porFirmaExacta.values()];

    // 3) Error histórico del cierre: si existe la misma persona, hostal y
    // fecha de entrada con una salida real, una copia automática de cierre
    // sin salida queda obsoleta y no debe seguir figurando como activa.
    const firmasConSalida = new Set(
      consolidados
        .filter((h) => h.fechaSalida)
        .map((h) => [
          normalizarTexto(h.nombre),
          normalizarTexto(h.hostal),
          String(h.fechaEntrada || '')
        ].join('|'))
    );

    const huespedes = consolidados
      .filter((h) => {
        if (esCabecera(h.nombre)) return false;

        const firmaBase = [
          normalizarTexto(h.nombre),
          normalizarTexto(h.hostal),
          String(h.fechaEntrada || '')
        ].join('|');

        const copiaActivaObsoleta =
          !h.fechaSalida &&
          Boolean(h.origenCierre) &&
          firmasConSalida.has(firmaBase);

        return !copiaActivaObsoleta;
      })
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

