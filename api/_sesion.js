const crypto = require('crypto');

const COOKIE_NOMBRE = '__Host-urpi_sesion';
const DURACION_SEGUNDOS = 60 * 60 * 24 * 180;

function compararSeguro(a, b) {
  const valorA = Buffer.from(String(a || ''));
  const valorB = Buffer.from(String(b || ''));

  return (
    valorA.length === valorB.length &&
    crypto.timingSafeEqual(valorA, valorB)
  );
}

function firmar(expira, secreto) {
  return crypto
    .createHmac('sha256', secreto)
    .update(`urpi-sesion:${expira}`)
    .digest('base64url');
}

function crearToken(secreto, ahora = Date.now()) {
  const expira = Math.floor(ahora / 1000) + DURACION_SEGUNDOS;
  return `${expira}.${firmar(expira, secreto)}`;
}

function leerCookie(req) {
  const cabecera = String(req.headers?.cookie || '');

  for (const parte of cabecera.split(';')) {
    const [nombre, ...valor] = parte.trim().split('=');
    if (nombre === COOKIE_NOMBRE) {
      return decodeURIComponent(valor.join('='));
    }
  }

  return '';
}

function tokenValido(token, secreto, ahora = Date.now()) {
  const [expiraTexto, firmaRecibida, extra] = String(token || '').split('.');
  const expira = Number(expiraTexto);

  if (
    extra !== undefined ||
    !Number.isInteger(expira) ||
    expira <= Math.floor(ahora / 1000)
  ) {
    return false;
  }

  return compararSeguro(firmaRecibida, firmar(expira, secreto));
}

function estaAutorizada(req, secreto) {
  if (!secreto) return false;

  const cabecera = req.headers?.['x-automation-secret'];
  if (compararSeguro(cabecera, secreto)) return true;

  return tokenValido(leerCookie(req), secreto);
}

function cookieSesion(token) {
  return [
    `${COOKIE_NOMBRE}=${encodeURIComponent(token)}`,
    `Max-Age=${DURACION_SEGUNDOS}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ].join('; ');
}

function cookieCaducada() {
  return [
    `${COOKIE_NOMBRE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ].join('; ');
}

module.exports = {
  compararSeguro,
  crearToken,
  estaAutorizada,
  cookieSesion,
  cookieCaducada
};
