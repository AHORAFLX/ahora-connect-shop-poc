// Mini-tienda de ejemplo que integra con AHORA ERP a través de AHORA Connect.
//
// Patrón: el navegador NUNCA habla con AHORA Connect. Habla con tu backend,
// y tu backend (que guarda las credenciales) habla con AHORA Connect.
//
// Node 20+ sin dependencias:   node --env-file=.env server.mjs
// Luego abre http://localhost:3000

import http from 'node:http';
import { readFile } from 'node:fs/promises';

let {
  CONNECT_URL,            // p.ej. https://connect.miempresa.com  (sin /webapi). Vacío = modo demo
  CONNECT_USER,
  CONNECT_PASSWORD,
  ID_EMPRESA = '1',       // valores de ejemplo: ajústalos a tu instalación de AHORA
  SERIE_PEDIDO = '1',
  ID_MONEDA = '1',
  ID_ALMACEN = '0',
  ID_IVA = '1',
  ID_IMPUESTO = '1',
  FORMA_PAGO,             // opcional: sin él el pedido va al contado y la factura no genera vencimientos
  PORT = '3000',
} = process.env;

// Sin CONNECT_URL arranca un AHORA Connect simulado, para ver la demo sin ERP
const DEMO = !CONNECT_URL;
if (DEMO) CONNECT_URL = await (await import('./demo-erp.mjs')).start();

// ---------------------------------------------------------------------------
// Cliente AHORA Connect (lo único que necesitas copiar a tu proyecto)
// ---------------------------------------------------------------------------

let token = null, tokenExpira = 0;

// OAuth2 password grant. El token se reutiliza hasta que caduca.
async function getToken() {
  if (token && Date.now() < tokenExpira) return token;
  const res = await fetch(`${CONNECT_URL}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', username: CONNECT_USER, password: CONNECT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login AHORA Connect: HTTP ${res.status}`);
  const json = await res.json();
  token = json.access_token;
  tokenExpira = Date.now() + (json.expires_in - 60) * 1000;
  return token;
}

// Llamada genérica. `traza` acumula cada request/response para enseñarla en la demo.
async function connect(method, path, body, traza) {
  const res = await fetch(`${CONNECT_URL}/webapi${path}`, {
    method,
    // Accept JSON obligatorio: con XML (lo que pide un navegador) la API falla al serializar NULLs
    headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    // Los procesos (/exec) exigen body aunque esté vacío (si no: HTTP 411)
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  traza?.push({ method, path, body, status: res.status, response: data });
  // Errores: HTTP 500 con un texto o con { Message, InnerException: { Message, ... } }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : data?.InnerException?.Message ?? data?.Message ?? `HTTP ${res.status}`);
  return data;
}

// El filtro es una cláusula WHERE SQL, no OData: va URL-encoded.
// Cualifica las columnas con la vista del objeto (VACO_...): Flexygo añade JOINs para los
// campos *_flxtext y una columna sin cualificar da "El nombre de columna 'X' es ambiguo".
const filtro = (where) => `filter=${encodeURIComponent(where)}`;

// GET/POST/PUT de /object devuelven { Properties: { Campo: { Value, Text, Label } } }
// (Text = descripción legible, p.ej. el nombre de la empresa en vez de su Id)
const prop = (obj, campo) => obj?.Properties?.[campo]?.Value;

// ---------------------------------------------------------------------------
// Casos de uso de la tienda
// ---------------------------------------------------------------------------

const sql = (s) => String(s).replaceAll("'", "''");   // escapar valores dentro del filtro

// ERP -> web: catálogo de venta.
//  - Familia '0' = "(Sin definir)": artículos de respaldo funcional, no de venta.
//  - Sin lotes ni series: la línea exigiría un lote/serie disponible, y Connect no expone ese stock.
//  - Los artículos con propiedades (talla, color...) sí entran: ver variantes().
const listarArticulos = () => connect('GET', `/list/ACO_Articulo?pageSize=200&orderBy=${encodeURIComponent('VACO_Articulos.IdFamilia')}&${filtro(
  "VACO_Articulos.Estado=0 and VACO_Articulos.IdFamilia<>'0' and VACO_Articulos.Lotes=0 and VACO_Articulos.NSeries=0")}`);

// ERP -> web: propiedades de un artículo con definición de producto (IdDefProd).
//  - ACO_Articulo_DefinicionProd: qué propiedades usa y en qué campo P1..P10 va cada una (PropiedadStock).
//  - ACO_Articulo_Propiedad: combinaciones válidas para ese artículo.
// La línea de pedido debe llevar los P1..P10 de una combinación válida.
async function variantes(idArticulo, idDefProd) {
  const def = await connect('GET', `/list/ACO_Articulo_DefinicionProd?orderBy=${encodeURIComponent('VACO_Articulos_DefinicionProd.Orden')}&${filtro(
    `VACO_Articulos_DefinicionProd.IdDefProd='${sql(idDefProd)}'`)}`);
  const combos = await connect('GET', `/list/ACO_Articulo_Propiedad?pageSize=1000&${filtro(
    `VACO_Articulos_Propiedades.IdArticulo='${sql(idArticulo)}'`)}`);
  const campos = def.map((d) => ({ campo: d.PropiedadStock, etiqueta: d.Etiqueta }));
  return { campos, combinaciones: combos.map((c) => Object.fromEntries(campos.map(({ campo }) => [campo, c[campo]]))) };
}

// Solo P1..P10 pasan del navegador al ERP
const soloPropiedades = (p = {}) => Object.fromEntries(Object.entries(p).filter(([k]) => /^P([1-9]|10)$/.test(k)));

// web -> ERP: alta de cliente (el ERP asigna el IdCliente)
async function crearCliente(c, traza) {
  const nuevo = await connect('POST', '/object/ACO_Cliente', {
    IdEmpresa: +ID_EMPRESA,
    IdCliente: null,
    Cliente: c.nombre,
    RazonSocial: c.nombre,
    Nif: c.nif,
    IdTipo: 0,                    // 0 nacional, 1 comunitario, 2 extranjero
    IdPais: 'ES',
    Direccion: c.direccion,
    CodPostal: c.cp,
    E_Mail: c.email,
    NumTelefono: c.telefono,
    IdImpuestoIndirecto: +ID_IMPUESTO,
    IdIva: +ID_IVA,
    Cliente_Contado: false,
    Bloqueado: false,
    IdDelegacion: -1,             // -1 = primera delegación de la empresa (NULL hace fallar el alta)
    IdContactoF: null,            // la WebAPI exige la clave; el contacto se crea después
  }, traza);
  return prop(nuevo, 'IdCliente');
}

// web -> ERP: contacto de facturación. El alta de cliente no crea ninguno y el pedido lo necesita
async function crearContacto(idCliente, c, traza) {
  const nuevo = await connect('POST', '/object/ACO_Contacto_Facturacion', {
    IdContacto: null,
    IdCliente: idCliente,
    Nombre: c.nombre,
    NIF: c.nif,
    IdPaisContacto: 'ES',
    Direccion: c.direccion,
    CodPostal: c.cp,
    E_Mail: c.email,
    TelefonoTrabajo: c.telefono,
  }, traza);
  return prop(nuevo, 'IdContacto');
}

// web -> ERP: pedido + líneas, y después albarán y factura con procesos de negocio
// alPaso(llamada) se invoca en cuanto termina cada llamada, para enseñar el progreso en directo
async function checkout({ cliente, lineas }, alPaso = () => {}) {
  const traza = [];
  traza.push = (t) => { alPaso(t); return Array.prototype.push.call(traza, t); };
  let idCliente, idPedido;
  try {
    idCliente = cliente.idCliente || await crearCliente(cliente, traza);

    // Un pedido necesita un contacto del cliente
    const [contacto] = await connect('GET',
      `/list/ACO_Contacto_Facturacion?pageSize=1&${filtro(`VACO_Clientes_Contactos.IdCliente='${idCliente.replaceAll("'", "''")}'`)}`, undefined, traza);
    const idContacto = contacto?.IdContacto ?? await crearContacto(idCliente, cliente, traza);

    const pedido = await connect('POST', '/object/ACO_Pedido_Cliente', {
      IdEmpresa: +ID_EMPRESA,
      SeriePedido: +SERIE_PEDIDO,
      Fecha: new Date().toISOString().slice(0, 10),
      IdCliente: idCliente,
      IdContacto: idContacto,
      IdContactoA: idContacto,     // contacto de albarán   } obligatorios en la WebAPI
      IdContactoF: idContacto,     // contacto de factura   }
      IdMoneda: +ID_MONEDA,
      DescripcionPed: 'Pedido tienda online',
      IdPedidoCli: `WEB-${Date.now()}`,   // tu nº de pedido web, para cruzarlo después
      ...(FORMA_PAGO && { FormaPago: +FORMA_PAGO }),
      Bloqueado: false,
    }, traza);
    idPedido = prop(pedido, 'IdPedido');

    const idLineas = [];
    for (const l of lineas) {
      const linea = await connect('POST', '/object/ACO_Pedido_Cliente_Linea', {
        IdPedido: idPedido,
        IdArticulo: l.idArticulo,
        IdAlmacen: +ID_ALMACEN,
        Cantidad: l.cantidad,
        Precio_EURO: l.precio,
        IdIva: +ID_IVA,             // obligatorio en la línea
        ...soloPropiedades(l.propiedades),   // talla, color... si el artículo tiene definición de producto
      }, traza);
      idLineas.push(prop(linea, 'IdLinea'));
    }

    // Procesos de negocio: POST /exec/{proceso}/{objeto}/{id}  (clave compuesta: ?filter=)
    // Estados de línea: 0 pendiente -> Albaranear -> 3 albarán -> Actualizar -> 5 albarán actualizado
    //                   -> MarcarFactura (por línea) -> 6 marcada para facturar -> Facturar -> 7 factura
    await connect('POST', `/exec/pACO_Pedidos_Cliente_Albaranear/ACO_Pedido_Cliente/${idPedido}`, {}, traza);
    await connect('POST', `/exec/pACO_Pedidos_Cliente_Albaranes_Actualizar/ACO_Pedido_Cliente/${idPedido}`, {}, traza);
    for (const idLinea of idLineas)   // la línea tiene clave compuesta: se identifica con ?filter=
      await connect('POST', `/exec/pACO_Pedidos_Cliente_Lineas_MarcarFactura/ACO_Pedido_Cliente_Linea?${filtro(
        `VACO_Pedidos_Cliente_Lineas.IdPedido=${+idPedido} and VACO_Pedidos_Cliente_Lineas.IdLinea=${+idLinea}`)}`, {}, traza);
    await connect('POST', `/exec/pACO_Pedidos_Cliente_Facturar/ACO_Pedido_Cliente/${idPedido}`, {}, traza);

    return { ok: true, idCliente, idPedido, traza };
  } catch (e) {
    // Sin transacción entre llamadas: lo ya creado queda en el ERP (idPedido indica hasta dónde se llegó)
    return { ok: false, error: e.message, idCliente, idPedido, traza };
  }
}

// ERP -> web: clientes no bloqueados para el selector de la demo.
// Solo código y nombre: no envíes al navegador NIF ni datos de contacto.
// (En una tienda real el cliente inicia sesión; no se muestra una lista de clientes.)
const listarClientes = async () =>
  (await connect('GET', `/list/ACO_Cliente?pageSize=500&orderBy=${encodeURIComponent('VACO_Clientes_Datos.Cliente')}&${filtro('VACO_Clientes_Datos.Bloqueado=0')}`))
    .map((c) => ({ IdCliente: c.IdCliente, Cliente: c.Cliente ?? c.RazonSocial }));

// ERP -> web: facturas del cliente (para su "Mi cuenta")
const facturasCliente = (idCliente) =>
  connect('GET', `/list/ACO_Factura_Venta_Cliente?pageSize=20&${filtro(`VACO_Facturas_Venta_Cliente.IdCliente='${idCliente.replaceAll("'", "''")}'`)}`);

// ---------------------------------------------------------------------------
// Back-office (/gestion): el navegador pide operaciones concretas y el backend las reenvía
// ---------------------------------------------------------------------------

// Proxy con lista blanca: el navegador solo puede tocar objetos ACO_* y sus procesos.
// ponytail: sin usuarios ni permisos propios; por eso el servidor escucha solo en localhost.
const RUTA_PERMITIDA = /^\/(list|object|schema)\/ACO_\w+(\/[^/?]+)?(\?.*)?$|^\/exec\/p\w+\/ACO_\w+(\/[^/?]+)?(\?.*)?$/;
async function proxy({ method, path, body }) {
  const puntos = /\/(\.|%2e){1,2}(\/|\?|$)/i;   // la normalización de URL resolvería '..' (también '%2e%2e')
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || !RUTA_PERMITIDA.test(path) || puntos.test(path)) return { status: 400, data: 'Operación no permitida' };
  const traza = [], t0 = Date.now();
  try { await connect(method, path, body, traza); } catch { /* el estado y el error ya están en la traza */ }
  const t = traza[0] ?? { status: 502, response: 'Sin respuesta de AHORA Connect' };
  return { status: t.status, data: t.response, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Servidor HTTP mínimo
// ---------------------------------------------------------------------------

const json = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const leerBody = async (req) => {
  let s = '';
  for await (const chunk of req) s += chunk;
  return JSON.parse(s || '{}');
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const estaticos = { '/': ['index.html', 'text/html'], '/gestion': ['gestion.html', 'text/html'], '/estilos.css': ['estilos.css', 'text/css'] };
    if (req.method === 'GET' && estaticos[url.pathname]) {
      const [fichero, tipo] = estaticos[url.pathname];
      res.writeHead(200, { 'Content-Type': `${tipo}; charset=utf-8` });
      return res.end(await readFile(new URL(`./public/${fichero}`, import.meta.url)));
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') return json(res, 200, await proxy(await leerBody(req)));
    if (req.method === 'GET' && url.pathname === '/api/info') return json(res, 200, { demo: DEMO, erp: DEMO ? 'AHORA Connect simulado' : CONNECT_URL,
      config: { idEmpresa: +ID_EMPRESA, idIva: +ID_IVA, idImpuesto: +ID_IMPUESTO, serie: +SERIE_PEDIDO, moneda: +ID_MONEDA, almacen: +ID_ALMACEN } });
    if (req.method === 'GET' && url.pathname === '/api/articulos') return json(res, 200, await listarArticulos());
    if (req.method === 'GET' && url.pathname === '/api/clientes') return json(res, 200, await listarClientes());
    if (req.method === 'GET' && url.pathname === '/api/variantes')
      return json(res, 200, await variantes(url.searchParams.get('articulo') ?? '', url.searchParams.get('def') ?? ''));
    if (req.method === 'POST' && url.pathname === '/api/checkout') {
      // NDJSON: una línea por llamada al ERP en cuanto termina, y una última con el resultado
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      const { traza, ...fin } = await checkout(await leerBody(req), (paso) => res.write(JSON.stringify({ paso }) + '\n'));
      return res.end(JSON.stringify({ fin }) + '\n');
    }
    if (req.method === 'GET' && url.pathname === '/api/facturas') return json(res, 200, await facturasCliente(url.searchParams.get('cliente') ?? ''));
    json(res, 404, { error: 'No encontrado' });
  } catch (e) {
    json(res, 502, { error: e.message });
  }
}).listen(+PORT, '127.0.0.1', () => console.log(`Tienda demo en http://localhost:${PORT}${DEMO ? '  (modo demo: ERP simulado)' : ''}`));
