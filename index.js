const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATOS = path.join(__dirname, 'productos.json');
const CATALOGO_API = 'https://script.google.com/macros/s/AKfycbzV_CxuKYu5uEjWOswbSZZLatlc8i5TvjT-Ldt_Ihre0RS-18eZy4AaOKvFmpfY-ikp/exec?accion=catalogo';

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  const ruta = decodeURIComponent(req.url.split('?')[0]);

  if (ruta === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  // Fuente persistente: hoja Catálogo del Apps Script. Si falla, NO mostrar
  // el JSON viejo: ocultaría productos nuevos o mostraría precios obsoletos.
  if (ruta === '/api/productos') {
    fetch(CATALOGO_API, { signal: AbortSignal.timeout(12000) })
      .then(async (r) => {
        if (!r.ok) throw new Error('Catálogo no disponible');
        const j = await r.json();
        if (!Array.isArray(j.productos)) throw new Error('Respuesta inválida');
        res.writeHead(200, { 'Content-Type': TIPOS['.json'], 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ productos: j.productos }));
      })
      .catch(() => {
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
