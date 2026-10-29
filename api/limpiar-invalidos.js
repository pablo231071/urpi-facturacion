const admin = require('firebase-admin');
const { estaAutorizada } = require('./_sesion');

if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('Falta la variable FIREBASE_SERVICE_ACCOUNT');
  }

  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
}

const db = admin.firestore();

const PALABRAS_DE_PROSA = new Set([
  'HOSTAL', 'HABITACION', 'HABITACIONES', 'ALMUERZO', 'CENA',
  'MANANA', 'LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES',
  'SABADO', 'DOMINGO', 'ACCEDERA', 'ENTRARA', 'ENTRARAN', 'LLEGARA',
  'LLEGARAN', 'HABLAMOS', 'TELEFONO', 'ESCRIBIO', 'CHICO', 'CHICA',
  'MUJER', 'MUJERES', 'MENOR', 'MENORES', 'UCRANIANO', 'UCRANIANA',
  'UCRANIANOS', 'UCRANIANAS', 'DESPUES', 'ANTES', 'UNIDAD', 'FAMILIAR',
  'FAMILIA', 'PADRE', 'MADRE', 'HIJO', 'HIJA', 'PERSONA', 'PERSONAS',
  'COMO', 'POR', 'PARA', 'HOY', 'DIA', 'DIAS'
]);

function normalizar(valor) {
  return String(valor || '')
    .replace(/\s*\(\s*\d+\s*a[ñn]os?\s*\)\s*$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function esCabecera(nombre) {
  const n = normalizar(nombre).replace(/[.:]/g, '');
  return new Set([
    'FECHA NAC',
    'FECHA NACIMIENTO',
    'FECHA DE NACIMIENTO',
    'NOMBRE',
    'NOMBRES',
    'APELLIDO',
    'APELLIDOS',
    'NOMBRE Y APELLIDO',
    'NOMBRE Y APELLIDOS'
  ]).has(n);
}

function pareceNombrePersona(nombre) {
  const limpio = String(nombre || '')
    .replace(/\s*\(\s*\d+\s*a[ñn]os?\s*\)\s*$/i, '')
    .replace(/\s*\*\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    limpio.length < 2 ||
    limpio.length > 100 ||
    /[0-9@<>_=+\\/\[\]{}:;,.!?]/.test(limpio)
  ) {
    return false;
  }

  const palabras = normalizar(limpio).split(' ').filter(Boolean);

  if (palabras.length === 0 || palabras.length > 8) return false;
  if (palabras.some((p) => PALABRAS_DE_PROSA.has(p))) return false;

  return palabras.every((p) =>
    /^[A-ZÑª]+(?:['’\-][A-ZÑª]+)*$/.test(p)
  );
}

async function localizarInvalidos(quincena) {
  const snap = await db
    .collection('huespedes')
    .where('quincena', '==', quincena)
    .get();

  return snap.docs
    .map((doc) => ({
      ref: doc.ref,
      id: doc.id,
      nombre: String(doc.data().nombre || ''),
      hostal: String(doc.data().hostal || ''),
      fechaEntrada: String(doc.data().fecha_entrada || ''),
      fechaSalida: String(doc.data().fecha_salida || '')
    }))
    .filter((h) => esCabecera(h.nombre) || !pareceNombrePersona(h.nombre));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Automation-Secret');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Método no permitido' });
  }

  try {
    if (!estaAutorizada(req, process.env.AUTOMATION_SECRET)) {
      return res.status(401).json({ ok: false, error: 'No autorizado' });
    }

    const quincena = String(
      req.method === 'GET' ? req.query.quincena : req.body?.quincena
    ).trim();

    if (!/^\d{4}_(?:[1-9]|1[0-2])_[12]$/.test(quincena)) {
      return res.status(400).json({ ok: false, error: 'Quincena no válida' });
    }

    const invalidos = await localizarInvalidos(quincena);
    const detalle = invalidos.map(({ id, nombre, hostal, fechaEntrada, fechaSalida }) => ({
      id,
      nombre,
      hostal,
      fechaEntrada,
      fechaSalida
    }));

    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        quincena,
        total: detalle.length,
        invalidos: detalle
      });
    }

    const esperado = Number(req.body?.esperado);

    if (!Number.isInteger(esperado) || esperado !== invalidos.length) {
      return res.status(409).json({
        ok: false,
        error: 'La cantidad encontrada no coincide con la confirmada; no se borró nada',
        encontrados: invalidos.length
      });
    }

    const batch = db.batch();
    invalidos.forEach((h) => batch.delete(h.ref));
    await batch.commit();

    return res.status(200).json({
      ok: true,
      quincena,
      eliminados: detalle.length,
      registros: detalle
    });
  } catch (error) {
    console.error('Error al limpiar registros inválidos:', error);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo completar la limpieza'
    });
  }
};
