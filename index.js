const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Subida de audiolibros desde el celu. Si algo falla al cargarlo, el sitio sigue andando igual.
let audioApi = null;
try { audioApi = require('./audiolibros-api.js'); } catch (e) { console.error('audiolibros-api no se pudo cargar:', e); }
const PUBLIC = path.join(__dirname, 'public');
const CATALOGO_API = 'https://script.google.com/macros/s/AKfycbzV_CxuKYu5uEjWOswbSZZLatlc8i5TvjT-Ldt_Ihre0RS-18eZy4AaOKvFmpfY-ikp/exec?accion=catalogo';

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg'
};

// Conservamos sólo una respuesta comprobada y durante pocos minutos. Nunca usamos
// productos.json, que puede contener precios y productos viejos.
let catalogoCache = null;
let catalogoActualizado = 0;
let catalogoEnVuelo = null;
const CACHE_FRESCA_MS = 30000;
const CACHE_MAX_MS = 5 * 60 * 1000;
const ESPERA_SCRIPT_MS = 35000;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function obtenerCatalogo() {
  if (catalogoEnVuelo) return catalogoEnVuelo;
  catalogoEnVuelo = (async () => {
    for (let intento = 0; intento < 2; intento++) {
      try {
        const r = await fetch(CATALOGO_API, { signal: AbortSignal.timeout(ESPERA_SCRIPT_MS) });
        if (!r.ok) throw new Error('Apps Script respondió HTTP ' + r.status);
        const j = await r.json();
        if (!Array.isArray(j.productos)) throw new Error('Respuesta inválida del catálogo');
        catalogoCache = JSON.stringify({ productos: j.productos, preciosMenor: j.preciosMenor || null });
        catalogoActualizado = Date.now();
        return catalogoCache;
      } catch (e) {
        console.error('Catálogo, intento ' + (intento + 1) + ':', e);
        if (intento === 0) await esperar(500);
      }
    }
    throw new Error('No se pudo actualizar el catálogo');
  })().finally(() => { catalogoEnVuelo = null; });
  return catalogoEnVuelo;
}

function responderCatalogo(res, contenido, anterior) {
  res.writeHead(200, {
    'Content-Type': TIPOS['.json'],
    'Cache-Control': 'no-store',
    ...(anterior ? { 'X-Catalogo-Desactualizado': '1' } : {})
  });
  res.end(contenido);
}

http.createServer(async (req, res) => {
  let ruta;
  try { ruta = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }

  if (ruta === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  if (audioApi) {
    try { if (await audioApi.manejar(req, res, ruta)) return; }
    catch (e) { console.error('audioApi:', e); if (!res.headersSent) { res.writeHead(500); } return res.end(); }
  }

  // Fuente persistente: hoja Catálogo. La primera carga espera al script;
  // las siguientes usan la última respuesta válida y la actualizan en segundo plano.
  if (ruta === '/api/productos') {
    const edad = Date.now() - catalogoActualizado;
    const vigente = catalogoCache && edad < CACHE_MAX_MS;
    const forzar = req.headers['cache-control']?.includes('no-store') ||
      new URL(req.url, 'http://localhost').searchParams.has('fresh');
    if (vigente && !forzar) {
      responderCatalogo(res, catalogoCache, edad >= CACHE_FRESCA_MS);
      if (edad >= CACHE_FRESCA_MS) obtenerCatalogo().catch(() => {});
      return;
    }
    obtenerCatalogo()
      .then((contenido) => responderCatalogo(res, contenido, false))
      .catch(() => {
        // Sólo se puede servir una copia reciente; si nunca cargó o ya venció,
        // es más seguro avisar que mostrar precios viejos.
        if (catalogoCache && Date.now() - catalogoActualizado < CACHE_MAX_MS) {
          responderCatalogo(res, catalogoCache, true);
          return;
        }
        res.writeHead(503, { 'Content-Type': TIPOS['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'El catálogo no está disponible. Probá de nuevo en unos minutos.' }));
      });
    return;
  }

  let archivo = path.join(PUBLIC, ruta === '/' ? 'index.html' : ruta);
  if (!archivo.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }

  // Si index.html quedó al lado de index.js (sin carpeta public), lo usa igual
  if (ruta === '/' && !fs.existsSync(archivo)) {
    archivo = path.join(__dirname, 'index.html');
  }

  // Audio: se sirve en pedazos (Range) para que el celular pueda adelantar,
  // retroceder y retomar donde quedó sin bajar todo el archivo.
  if (path.extname(archivo) === '.mp3') {
    fs.stat(archivo, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('No encontrado');
      }
      const base = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] !== '' || m[2] !== '')) {
        let ini = m[1] === '' ? st.size - parseInt(m[2], 10) : parseInt(m[1], 10);
        let fin = m[1] === '' || m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
        if (ini < 0) ini = 0;
        if (fin >= st.size) fin = st.size - 1;
        if (ini > fin || ini >= st.size) {
          res.writeHead(416, { ...base, 'Content-Range': 'bytes */' + st.size });
          return res.end();
        }
        res.writeHead(206, { ...base, 'Content-Range': 'bytes ' + ini + '-' + fin + '/' + st.size, 'Content-Length': fin - ini + 1 });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(archivo, { start: ini, end: fin }).pipe(res);
      }
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(archivo).pipe(res);
    });
    return;
  }

  fs.readFile(archivo, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encontró index.html. Buscado en: ' + archivo);
    }
    const tipo = TIPOS[path.extname(archivo)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': tipo });
    res.end(data);
  });
}).listen(PORT, () => console.log('La ruta del bienestar en puerto ' + PORT));



