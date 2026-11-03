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
const QUINCENA = '2026_10_2';

function normalizarNombre(valor) {
  return String(valor || '')
    .replace(/\s*\(\s*\d+\s*a[ñn]os?\s*\)\s*$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const ORDEN = {
  'La Hostería': [
    'MAMADOU KHONTE', 'BAKARY FOFANA', 'SAMBA KEITA',
    'MAME ABDOU SARR', 'FUNMIBI ADUNNI OYEWOLE',
    'KEHINDE OLAMIDE OYEWOLE', 'TAIWO AYOMIDE OYEWOLE',
    'VIKTORIIA SVENTUKH', 'IHOR SVENTUKH', 'TETIANA ZHURENKO',
    'OLEKSANDR ZHURENKO', 'LIUDMYLA ULIANOVA',
    'VOLODYMIR ULIANOV', 'STANISLAV ULIANOV', 'MYLANA ULIANOVA',
    'VALERIIA ULIANOVA', 'CHEIKNE TOURE',
    'NELCY YUDITH ORTEGA DE IBAÑEZ',
    'MARIA FERNANDA IBAÑEZ ORTEGA',
    'JUAN PABLO IBAÑEZ ORTEGA', 'KARYNA PLAKHTII',
    'SABINA PLAKHTII', 'LIUDMYLA PLAKHTII', 'BAKARY SOUMARE',
    'SAMOU SIDIBE', 'MOUSSA SISSOKO', 'NAMA CISSOKO'
  ],
  Milema: [
    'ROSA MARINA SANCHEZ DE GUANIPA', 'ORLANDO RAMON GUANIPA',
    'ANARWILL ELIZABETH FORTI CASTILLO',
    'THIAGO DE JESUS FORTI CASTILLO', 'YANELIS ROSAURA GONZALEZ',
    'YULIIA SUSHKOVA', 'PAVLO TATENKO',
    'MILEIDY MARGARITA FERRER RINCON',
    'JOSE ALBERTO PINEDA HERNANDEZ',
    'MARIANA ISABELLA PINEDA FERRER', 'ANNA CHYRKOVA',
    'ARTEM CHYRKOV', 'VOLODYMYR CHYRKOV', 'LEV CHYRKOV',
    'LIIA TARLETSKA', 'ANASTASIIA TARLETSKA',
    'ULIANOVA PASHKOVSKA', 'MYKOLAI PASHKOVSKA',
    'ANNA PASHKOVSKA', 'OLENA ZAROSINSKA', 'ANDRII BEZPALYI',
    'YANINA HOLOTA', 'SELIM HOLOTA', 'IVAN NEBYKOV',
    'YELYZAVETA ZHURAVLOVA', 'ANASTASIIA KACHURINA'
  ],
  Mencey: [
    'ASYANA JOSEFINA MARTINEZ RODRIGUEZ',
    'JEANNA MARGARITA PEREZ RODRIGUEZ', 'ROBERT RAFAEL ROJAS PORTE',
    'MARK BOHOSVIETOV', 'ANNA HUNCHENKO', 'ALBERT YEROKHIN',
    'WILLIAM OSVALDO AREVALO BASTIDAS', 'PAVEL OSTAPENKO',
    'HECTOR RODRIGUEZ BARRIOS', 'LEONID SHYDLOVSKYI', 'MYKYTA BOIKO',
    'ANTON BOIKO', 'FRANCISCO JOSE GONZALEZ CAPOTE', 'VIOLETTA HIRSH',
    'MAKSYM LYSENKO', 'ANDRII DVURECHENSKYI', 'IVAN BILOKUR',
    'VOLODYMYR KARACHENKO', 'STANISLAV YUKHA', 'KYRYLO VASYLCHENKO',
    'YEVHENII ZHURAVSKYI', 'HANNA DADASHEVA', 'SAMIR DADASHEV',
    'TYMUR DADASHEV', 'KAMILA DADASHEVA', 'VALERIIA DADASHEVA',
    'IGOR MAKAROV', 'SALIMOU COULIBALY', 'LASSANA KONATE',
    'SIAKA TRAORE', 'BAKARY DIARRA', 'BREHIMA DIARRA', 'LASSINE DIAKITE',
    'SAMOU SIDIBE', 'BANDJOUGOU TOURE', 'HAMET DIAWARA',
    'SOULEYMANE DEMBELE', 'SEKOU TRAORE', 'PIERREWITIN DIARRA',
    'VALENTYN SEMCHUK'
  ]
};

const NOMBRES_CORRECTOS = new Map([
  ['La Hostería|VIKTORIA SVENTUKH', 'VIKTORIIA SVENTUKH'],
  ['La Hostería|IHORSVENTUKH', 'IHOR SVENTUKH'],
  ['Mencey|MYKITA BOIKO', 'MYKYTA BOIKO'],
  ['Mencey|PIERRE WITIN DIARRA', 'PIERREWITIN DIARRA'],
  ['Mencey|JEANNA MARGARITA PEREZ RODRIGUEZ',
    'JEANNA MARGARITA PEREZ RODRIGUEZ (13 años)'],
  ['Milema|THIAGO DE JESUS FORTI CASTILLO',
    'THIAGO DE JESUS FORTI CASTILLO (6 años)'],
  ['Milema|PAVLO TATENKO', 'PAVLO TATENKO (12 años)'],
  ['Milema|MARIANA ISABELLA PINEDA FERRER',
    'MARIANA ISABELLA PINEDA FERRER (11 años)'],
  ['Mencey|VALERIIA DADASHEVA', 'VALERIIA DADASHEVA (1 año)']
]);

function cambiosPara(documento, posicionPorHostal) {
  const h = documento.data();
  const nombreBase = normalizarNombre(h.nombre);
  const clave = `${h.hostal}|${nombreBase}`;
  const cambios = {};
  const nombreCorrecto = NOMBRES_CORRECTOS.get(clave);

  if (nombreCorrecto && h.nombre !== nombreCorrecto) {
    cambios.nombre = nombreCorrecto;
    cambios.nombre_normalizado = normalizarNombre(nombreCorrecto);
  }

  const claveOrden = `${h.hostal}|${normalizarNombre(
    nombreCorrecto || h.nombre
  )}`;
  const orden = posicionPorHostal.get(claveOrden);
  if (Number.isFinite(orden) && Number(h.orden) !== orden) {
    cambios.orden = orden;
  }

  if (
    h.hostal === 'La Hostería' &&
    nombreBase === 'SAMOU SIDIBE' &&
    String(h.fnac || '') === '2003-04-23' &&
    h.fecha_salida
  ) {
    cambios.fecha_salida = '';
  }

  if (
    h.hostal === 'Mencey' &&
    nombreBase === 'ANDRII DVURECHENSKYI' &&
    h.fecha_salida
  ) {
    cambios.fecha_salida = '';
  }

  if (
    h.hostal === 'Milema' &&
    ['IVAN NEBYKOV', 'SELIM HOLOTA'].includes(nombreBase) &&
    h.sin_snack
  ) {
    cambios.sin_snack = false;
  }

  if (Object.keys(cambios).length > 0) {
    cambios.actualizado_en =
      admin.firestore.FieldValue.serverTimestamp();
  }

  return cambios;
}

function escapar(valor) {
  return String(valor || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).send('Método no permitido');
  }

  const secreto = process.env.AUTOMATION_SECRET;
  if (!estaAutorizada(req, secreto)) {
    return res.status(401).send('No autorizado');
  }

  const posicionPorHostal = new Map();
  for (const [hostal, nombres] of Object.entries(ORDEN)) {
    nombres.forEach((nombre, posicion) => {
      posicionPorHostal.set(
        `${hostal}|${normalizarNombre(nombre)}`,
        posicion
      );
    });
  }

  const snap = await db.collection('huespedes')
    .where('quincena', '==', QUINCENA)
    .get();
  const pendientes = snap.docs
    .map((documento) => ({
      documento,
      cambios: cambiosPara(documento, posicionPorHostal)
    }))
    .filter((item) => Object.keys(item.cambios).length > 0);

  if (req.method === 'POST') {
    const batch = db.batch();
    pendientes.forEach(({ documento, cambios }) => {
      batch.update(documento.ref, cambios);
    });
    await batch.commit();

    return res.status(200).send(
      `<h1>Corrección completada</h1>` +
      `<p>Registros actualizados: ${pendientes.length}</p>`
    );
  }

  const filas = pendientes.map(({ documento, cambios }) => {
    const h = documento.data();
    const resumen = Object.entries(cambios)
      .filter(([campo]) => campo !== 'actualizado_en')
      .map(([campo, valor]) => `${campo}: ${valor === '' ? '(vacío)' : valor}`)
      .join(', ');
    return `<li><strong>${escapar(h.nombre)}</strong> (${escapar(h.hostal)}): ` +
      `${escapar(resumen)}</li>`;
  }).join('');

  return res.status(200).send(`<!doctype html><meta charset="utf-8">
    <h1>Corrección de facturas de octubre</h1>
    <p>Se actualizarán ${pendientes.length} registros sin eliminar ninguno.</p>
    <ul>${filas}</ul>
    <form method="post"><button type="submit">Aplicar correcciones</button></form>`);
};
