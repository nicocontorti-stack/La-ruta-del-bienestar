const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
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
  '.svg': 'image/svg+xml'
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

http.createServer((req, res) => {
  const ruta = decodeURIComponent(req.url.split('?')[0]);

  if (ruta === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
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


