# AHORA Connect — guía para agentes de IA

Instrucciones para que un asistente de IA genere código que consuma **AHORA Connect**, la API REST de AHORA ERP (construida sobre Flexygo).
Ejemplo completo y funcional: `tienda/server.mjs`. Todas las llamadas de ejemplo: `requests/ahora-connect.http`.

**La especificación completa de cada instalación** (Swagger 2.0, JSON) se descarga sin autenticación desde `GET {BASE}/webapi`. Es la fuente de verdad: trae los objetos, los campos de cada objeto y los procesos disponibles, con sus parámetros. Si tienes acceso a ella, léela antes de generar código.

## Reglas obligatorias

1. **Nunca llames a AHORA Connect desde el navegador.** Las credenciales y el token viven en el backend del integrador. El front habla con ese backend.
2. **No inventes objetos, campos ni procesos.** Usa solo los que aparecen en este fichero o en la especificación de `{BASE}/webapi`. Si falta algo, pregunta al usuario.
3. **Los valores de configuración** (IdEmpresa, SeriePedido, IdMoneda, IdAlmacen, IdIva, IdImpuestoIndirecto) dependen de cada instalación. Ponlos en variables de entorno, nunca en el código.
4. **El parámetro `filter` es una cláusula WHERE de SQL**, no OData. Hay que URL-encodearlo y escapar las comillas simples de los valores (`'` → `''`).
   - **Cualifica siempre las columnas con la vista del objeto.** Flexygo añade JOINs para los campos `*_flxtext`, y una columna sin cualificar falla con "El nombre de columna 'X' es ambiguo".
   - Ejemplos: `VACO_Articulos.Estado=0`, `VACO_Clientes_Contactos.IdCliente='00001'`, `VACO_Facturas_Venta_Cliente.IdCliente='00001'`.
   - El nombre de la vista aparece en el mensaje de error (`From [VACO_...]`).
5. **No hay transacciones entre llamadas.** Diseña los flujos para que se puedan reintentar paso a paso.
6. **Valida los obligatorios antes de enviar, con `GET /schema/{Objeto}`.** Los campos obligatorios dependen de la configuración de cada instalación, no solo del código. Mira la sección [Campos obligatorios](#campos-obligatorios).

## Autenticación

OAuth2 *password grant*. La URL base de la instalación es `{BASE}`, sin `/webapi`.

```http
POST {BASE}/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&username={USER}&password={PASSWORD}
```

Respuesta: `{ "access_token": "...", "expires_in": <segundos>, ... }`. Reutiliza el token hasta poco antes de que caduque.
Todas las demás llamadas llevan los headers `Authorization: Bearer {access_token}` y **`Accept: application/json`**. Sin `Accept: application/json` la API puede responder en XML, y el serializador XML falla con un HTTP 500 en cuanto hay valores NULL.

## Endpoints

Todos cuelgan de `{BASE}/webapi`.

| Operación | Método y ruta | Body | Respuesta |
|---|---|---|---|
| Listar | `GET /list/{Objeto}?filter={where}&orderBy={campo}&page=0&pageSize=N` | — | Array de registros planos: `[{Campo: valor, Campo_flxtext: "descripción"}]` |
| Listar con una vista alternativa | `GET /list/{Objeto}/{Vista}` | — | Array |
| Esquema de un objeto | `GET /schema/{Objeto}` | — | Campos y tipos |
| Leer uno | `GET /object/{Objeto}/{id}` o `GET /object/{Objeto}?filter={where}` | — | `{ "Properties": { "Campo": { "Value": ... } } }` |
| Crear | `POST /object/{Objeto}` | JSON plano `{Campo: valor}` | Igual que leer uno. Las claves que genera el ERP (IdCliente, IdPedido...) vienen en `Properties` |
| Modificar | `PUT /object/{Objeto}/{id}` o `PUT /object/{Objeto}?filter={where}` | JSON con **todos** los campos | Igual que leer uno |
| Borrar | `DELETE /object/{Objeto}/{id}` o `DELETE /object/{Objeto}?filter={where}` | — | 200 |
| Proceso de negocio | `POST /exec/{Proceso}/{Objeto}/{id}` o `POST /exec/{Proceso}/{Objeto}?filter={where}` | JSON con los parámetros del proceso; **obligatorio, aunque sea `{}`** (sin body: HTTP 411) | `{ "Success": true, ... }` |

**¿`/{id}` o `?filter=`?**
- **Objetos con clave simple: usa `/{id}`.** Son ACO_Albaran_Cliente, ACO_Almacen, ACO_Articulo, ACO_Articulo_Familia, ACO_Articulo_Propiedad, ACO_Cliente, ACO_Contacto_Facturacion(_Prov), ACO_Delegacion, ACO_Departamento, ACO_Ejercicio, ACO_Empleado, ACO_Empresa, ACO_Factura_Acreedor, ACO_Factura_Deudor, ACO_Factura_Venta_Cliente, ACO_IVA, ACO_Impuesto, ACO_Moneda, ACO_Pais, ACO_Pedido_Cliente, ACO_Proveedor, ACO_Retencion y las ACO_Serie*.
- **Objetos con clave compuesta: usa `?filter=` con todos los campos de la clave.** Por ejemplo, para ACO_Pedido_Cliente_Linea: `IdPedido=123 and IdLinea=2`. Son las líneas, desgloses y efectos de los documentos, ACO_Oferta_Cliente (`IdOferta` y `Revision`), ACO_Provincia, ACO_Poblacion, ACO_Cliente_Domiciliacion, las facturas rectificadas y ACO_Empresa_OSS, IOSS y RECC.

Para leer un campo de la respuesta de `/object`: `respuesta.Properties.IdPedido.Value`. Cada propiedad trae `{ Value, Text, Label }`, donde `Text` es el valor legible: por ejemplo, el nombre de la empresa en vez de su Id.

En `list`, los campos que son claves foráneas vienen acompañados de un campo `{Campo}_flxtext` con su descripción, por ejemplo `IdCliente_flxtext: "CONTADO TPV"`.

**Registro inexistente:** `GET /object/{Objeto}/{id}` devuelve **HTTP 200** con todos los `Value` a `null`. Para saber si existe, comprueba que la clave no es `null`.

## Campos obligatorios

`GET /webapi/schema/{Objeto}` devuelve `{ TableName, KeyFields, Properties }`. Para cada propiedad trae, entre otros:
- `IsRequired`: si el campo es obligatorio.
- `DefaultValue`: el valor que se aplica si no se envía el campo. Puede ser literal (`0`, `ES`) o un token (`{{CurrentDate}}`).
- `IsRequiredMessage`: el mensaje que se muestra cuando falta.

**Regla:** todo campo con `IsRequired: true` **y sin `DefaultValue`** tiene que ir en el JSON. Si la clave no está, la WebAPI rechaza la llamada con `"{Objeto} missing required fields: CampoA,CampoB"` antes de ejecutar el SP. Basta con que la clave esté presente, aunque sea con `null`, cuando el valor lo asigna el ERP.

Esa configuración **varía entre instalaciones**. Ejemplo real: en una instalación, `ACO_Pedido_Cliente` exige `IdContactoA` (contacto de albarán) e `IdContactoF` (contacto de factura), y `ACO_Cliente` exige `IdContactoF`. En otra versión de la configuración no eran obligatorios. Por eso:
1. Al arrancar tu integración, lee `/schema` de los objetos que vas a escribir y guárdalo en caché.
2. Antes de cada POST o PUT, comprueba que llevas todos los obligatorios sin valor por defecto, y avisa con `IsRequiredMessage` si falta alguno.
3. No te fíes de listas de obligatorios escritas a mano, incluida la de este fichero: la fuente de verdad es `/schema`.

Además de esa validación de la WebAPI, el SP de cada objeto tiene sus propias validaciones de negocio, que llegan como HTTP 500 con el mensaje (ver [Errores](#errores)).

## Errores

- **HTTP 500:** el body es un texto o un JSON de excepción de este tipo: `{ "ClassName": "...", "Message": "...", "InnerException": { "Message": "..." } }`.
  - Las validaciones de negocio del ERP (por ejemplo `El cliente indicado no existe` o `Debe informar del NIF del cliente`) vienen en el texto o en `Message`/`InnerException.Message`. Muéstralas o regístralas.
  - Si reintentas sin cambiar los datos, volverán a fallar.
  - Un `filter` con un campo que no existe también da 500, con el SQL generado en el mensaje. No reenvíes ese mensaje al usuario final.
- **HTTP 401:** el token ha caducado o no es válido. Pide uno nuevo y reintenta una sola vez.
- **`No credentials to run {proceso} process`:** este mensaje **es engañoso**. Flexygo lo devuelve en dos casos:
  1. **El registro no está en estado de ejecutar ese proceso** (es el caso más habitual). Cada proceso tiene un `SQLEnabled` que comprueba el estado; si devuelve 0, sale este mensaje. Ejemplo real: facturar un pedido con las líneas en estado 3 (albarán) o 5 (albarán actualizado) sin haberlas marcado para facturar (estado 6). Revisa el estado de las líneas y el orden de los procesos.
  2. **El usuario de la API no tiene permiso** para ejecutar ese proceso. Los permisos de cada proceso se configuran por usuario o rol en la WebAPI de la instalación. No es un error de datos: pide al administrador de AHORA Connect que conceda ese proceso al usuario de la integración.
  - Detalle: Flexygo comprueba la seguridad de procesos **por objeto + proceso**, para el rol, el usuario o la facultad (`pNet_LoadObjectProcessSecurity`). Si existe una regla explícita que no lo permite, el proceso se rechaza, aunque esté publicado en la WebAPI.
  - Antes de la puesta en marcha, prueba con el usuario real de la integración todos los procesos que vayas a usar.
- **"{Objeto} missing required fields: ...":** falta en el JSON algún campo obligatorio sin valor por defecto. Mira [Campos obligatorios](#campos-obligatorios).
- **Comportamientos peligrosos:** un `PUT` sobre un registro que no existe puede **crearlo**, y un `DELETE` sobre un registro que no existe devuelve **200**. Comprueba con un GET que el registro existe antes de modificarlo o borrarlo.

## Flujo de una tienda online (de referencia)

1. **Catálogo:** `GET /list/ACO_Articulo?filter=VACO_Articulos.Estado=0 and VACO_Articulos.IdFamilia<>'0' and VACO_Articulos.Lotes=0 and VACO_Articulos.NSeries=0`. Si un artículo tiene `IdDefProd`, consulta sus propiedades (ver más abajo). Las familias, en `ACO_Articulo_Familia`.
2. **Cliente:** si no lo tienes ya, `POST /object/ACO_Cliente` y lee `Properties.IdCliente.Value`. Guarda la relación entre tu cliente web y ese IdCliente.
3. **Contacto:** `GET /list/ACO_Contacto_Facturacion?filter=VACO_Clientes_Contactos.IdCliente='X'`. El pedido necesita un contacto. Según la instalación, el alta de cliente **puede crear un contacto automáticamente** (por un trigger del ERP) **o no**. Consulta siempre primero; si no hay ninguno, créalo con `POST /object/ACO_Contacto_Facturacion` (`IdCliente`, `Nombre`, `NIF`, `IdPaisContacto`) y lee `Properties.IdContacto.Value`.
4. **Pedido:** `POST /object/ACO_Pedido_Cliente` con `IdContacto`, `IdContactoA` e `IdContactoF` (pueden ser el mismo contacto), y lee `Properties.IdPedido.Value`. Guarda tu número de pedido web en `IdPedidoCli`; sirve para detectar duplicados al reintentar.
5. **Líneas:** un `POST /object/ACO_Pedido_Cliente_Linea` por cada línea.
6. **Albarán:** `POST /exec/pACO_Pedidos_Cliente_Albaranear/ACO_Pedido_Cliente/{IdPedido}` con body `{}`. Las líneas pasan a estado 3 (Albarán).
7. **Actualizar el albarán:** `POST /exec/pACO_Pedidos_Cliente_Albaranes_Actualizar/ACO_Pedido_Cliente/{IdPedido}` con body `{}`. Las líneas pasan a estado 5 (Albarán actualizado).
8. **Marcar las líneas para facturar:** una llamada por línea, `POST /exec/pACO_Pedidos_Cliente_Lineas_MarcarFactura/ACO_Pedido_Cliente_Linea?filter=VACO_Pedidos_Cliente_Lineas.IdPedido=N and VACO_Pedidos_Cliente_Lineas.IdLinea=M` con body `{}`. Las líneas pasan a estado 6. El `IdLinea` viene en la respuesta del POST de cada línea.
9. **Factura:** `POST /exec/pACO_Pedidos_Cliente_Facturar/ACO_Pedido_Cliente/{IdPedido}` con body `{}`. Solo factura líneas en estado 2, 4 o 6; las líneas pasan a 7 (Factura). La factura queda "no actualizada": para contabilizarla, `pACO_Pedidos_Cliente_Facturas_Actualizar`.

**Estados de línea de pedido verificados:** 0 pendiente · 3 Albarán · 5 Albarán actualizado · 6 marcada para facturar · 7 Factura · 8 Factura actualizada (contabilizada). `Lineas_MarcarFactura` admite líneas en 0, 1, 3 o 5. Ver el estado de una línea: `IdEstado` / `IdEstado_flxtext` en `ACO_Pedido_Cliente_Linea`.

10. **Consulta para "Mi cuenta":** `GET /list/ACO_Factura_Venta_Cliente?filter=VACO_Facturas_Venta_Cliente.IdCliente='X'`; los cobros, en `ACO_Factura_Cliente_Efecto`.

## Artículos con propiedades (talla, color...)

Un artículo con `IdDefProd` informado tiene **definición de producto**. Su línea de pedido debe llevar los valores de propiedad en `P1..P10`; si no los lleva, falla con "El artículo indicado tiene definición de producto y no se han especificado".

1. `GET /list/ACO_Articulo_DefinicionProd?filter=VACO_Articulos_DefinicionProd.IdDefProd='{IdDefProd}'&orderBy=VACO_Articulos_DefinicionProd.Orden`. Cada fila es una propiedad: `Etiqueta` es lo que se muestra al usuario (por ejemplo "Talla") y `PropiedadStock` el campo donde va el valor (por ejemplo `P2`).
2. `GET /list/ACO_Articulo_Propiedad?filter=VACO_Articulos_Propiedades.IdArticulo='{IdArticulo}'&pageSize=1000`: combinaciones válidas para ese artículo (columnas `P1..P10`).
3. Deja elegir al usuario solo entre esas combinaciones y envía sus `P1..P10` en `ACO_Pedido_Cliente_Linea`.

Los artículos con **lotes** (`Lotes`) o **números de serie** (`NSeries`) exigen en la línea un `Lote` o un `NSerie` existente y disponible. AHORA Connect no expone el stock por lote ni por serie, así que una tienda online no puede elegirlos. Exclúyelos del catálogo o resuélvelo con AHORA.

**Catálogo de venta:** la familia `'0'` ("(Sin definir)") suele agrupar artículos de respaldo funcional (servicios, conceptos internos), no de venta. Filtra con `VACO_Articulos.IdFamilia<>'0'`.

## Payloads

Los campos que no se indican se pueden enviar como `null`.

**ACO_Cliente (POST)** — campos aceptados:
`IdEmpresa, IdCliente (null: lo asigna el ERP), RazonSocial, Cliente, Nif, Nif2, IdTipoNIF, IdTipo, Direccion, IdPais, IdPoblacion, IdProvincia, CodPostal, NumTelefono, E_Mail, Web, Cliente_Contado, MiCod, IdDelegacion, FechaAlta, Bloqueado, IdEmpleadoBloqueo, IdMotivoBloqueo, Categoria, IdImpuestoIndirecto, IdIva, RecEquivalencia`
- Obligatorios: `Nif`, `IdPais` (ISO de 2 letras), `IdTipo` (0 nacional, 1 comunitario, 2 extranjero), `IdImpuestoIndirecto`, `IdIva`.
- Si `IdPais` no es `'ES'`, también hace falta `IdTipoNIF`.
- Envía `IdDelegacion: -1` (primera delegación de la empresa). Con `null`, el alta falla.
- Envía `IdContactoF: null` si `/schema` lo marca como obligatorio: el contacto aún no existe en el momento del alta.
- El alta puede crear o no un contacto según la instalación. Consúltalo después con `ACO_Contacto_Facturacion`.

**ACO_Pedido_Cliente (POST)** — campos aceptados:
`IdEmpresa, SeriePedido, Fecha, IdCliente, IdContacto, DescripcionPed, IdEmpleado, IdMoneda, Descuento, ProntoPago, CambioEuros, IdTipoCli, Bloqueado, FormaPago, RecEquivalencia, IdContactoA, IdContactoF, Observaciones, IdPedidoCli, IdMotivoBloqueo, IdEstado`
- Obligatorios: `IdEmpresa`, `SeriePedido`, `IdCliente` (tiene que existir), `IdContacto` (tiene que pertenecer al cliente), `IdMoneda` y, según la instalación, `IdContactoA` e `IdContactoF`. Compruébalo en `/schema`.
- Si `Bloqueado` es `true`, también hace falta `IdMotivoBloqueo`. `CambioEuros` no puede ser 0.

**ACO_Pedido_Cliente_Linea (POST)** — campos aceptados:
`IdPedido, IdArticulo, IdAlmacen, Cantidad, Precio_EURO, PrecioMoneda, Descuento, IdIva, IdMotivoIVAExento, Descrip, Observaciones, IdOpServicios, EsSujetoPasivo, Lote, NSerie, P1..P10, IdEstado, IdRetencion`
- Obligatorios: `IdPedido` (tiene que existir), `IdArticulo` (tiene que existir y no estar anulado), `IdAlmacen`, `IdIva` y `Cantidad`.
- Si el artículo tiene definición de producto, hay que informar al menos una de `P1..P10`. Si lleva lotes, hay que informar `Lote`; si lleva números de serie, `NSerie`.
- `IdLinea` lo calcula el ERP.

Para cualquier otro objeto, consulta `GET {BASE}/webapi` o `GET {BASE}/webapi/schema/{Objeto}`.

## Objetos disponibles

- **Maestros:** `ACO_Pais`, `ACO_Provincia`, `ACO_Poblacion`, `ACO_Moneda`, `ACO_IVA`, `ACO_Impuesto`, `ACO_Retencion`, `ACO_Empresa`, `ACO_Delegacion`, `ACO_Departamento`, `ACO_Ejercicio`, `ACO_Empleado`, `ACO_Almacen`, `ACO_Serie`, `ACO_Serie_Rectificativa`
- **Artículos:** `ACO_Articulo`, `ACO_Articulo_Familia`, `ACO_Articulo_Propiedad`, `ACO_Articulo_DefinicionProd`, `ACO_Articulo_DefinicionPropiedad`
- **Clientes:** `ACO_Cliente`, `ACO_Contacto_Facturacion`, `ACO_Cliente_Domiciliacion`
- **Ventas:** `ACO_Oferta_Cliente`, `ACO_Oferta_Cliente_Linea`, `ACO_Pedido_Cliente`, `ACO_Pedido_Cliente_Linea`, `ACO_Albaran_Cliente`, `ACO_Factura_Venta_Cliente`, `ACO_Factura_Cliente_Efecto`, `ACO_Factura_Rectificada`, `ACO_Factura_Deudor` (+ `_Linea`, `_Desglose`)
- **Compras:** `ACO_Proveedor`, `ACO_Contacto_Facturacion_Prov`, `ACO_Factura_Acreedor` (+ `_Linea`, `_Desglose`), `ACO_Factura_Rectificada_Proveedor`, `ACO_Serie_Prov`, `ACO_Serie_Rectificativa_Prov`
- **Fiscal:** `ACO_Empresa_OSS`, `ACO_Empresa_IOSS`, `ACO_Empresa_RECC`

La lista exacta depende de la instalación y de los permisos del usuario de la API. La de cada instalación está en `GET {BASE}/webapi`.

## Procesos de negocio de ventas

El registro sobre el que actúa el proceso se indica con `/{id}` o con `?filter=`, según la clave del objeto (ver arriba). El body lleva los parámetros del proceso, o `{}` si no hay.

| Llamada | Body | Qué hace |
|---|---|---|
| `POST /exec/pACO_Pedidos_Cliente_Albaranear/ACO_Pedido_Cliente/{IdPedido}` | `{}` | Genera el albarán del pedido |
| `POST /exec/pACO_Pedidos_Cliente_Albaranes_Actualizar/ACO_Pedido_Cliente/{IdPedido}` | `{}` | Actualiza los albaranes del pedido (líneas 3 → 5) |
| `POST /exec/pACO_Pedidos_Cliente_Lineas_MarcarFactura/ACO_Pedido_Cliente_Linea?filter=…IdPedido=N and …IdLinea=M` | `{}` | Marca una línea para facturar (0/1/3/5 → 6) |
| `POST /exec/pACO_Pedidos_Cliente_Facturar/ACO_Pedido_Cliente/{IdPedido}` | `{}` o `{"FechaFact":"2026-10-08"}` | Factura el pedido (líneas en estado 2, 4 o 6) |
| `POST /exec/pACO_Albaranes_Cliente_Facturar/ACO_Albaran_Cliente/{IdAlbaran}` | `{}` o `{"FechaFact":...}` | Factura el albarán |
| `POST /exec/pACO_Ofertas_Cliente_GenerarPed/ACO_Oferta_Cliente?filter=IdOferta=N and Revision=N` | `{"IdOferta":N,"Revision":N}` | Convierte la oferta en pedido |
| `POST /exec/pACO_Factura_Cliente_Efecto_Cobrar/ACO_Factura_Cliente_Efecto?filter=IdFactura=N and IdEfecto=N` | `IdFactura, IdEfecto, IdDomiciliacion, ImporteCobro, FechaCobro, CobrarAlVencimiento, CuentaAjuste, ImporteCobroGastos, CuentaGastos, GastosCambioEuros` | Cobra el efecto |
| `POST /exec/pLineaPedido_Anular/ACO_Pedido_Cliente_Linea?filter=IdPedido=N and IdLinea=N` | `{}` | Anula una línea de pedido (`pLineaPedido_Recuperar` la recupera) |
| `POST /exec/pACO_Facturas_Venta_Actualizar/ACO_Factura_Venta_Cliente/{IdFactura}` | `{"IdFactura":N,"FechaActualizacion":"2026-10-08"}` | Contabiliza (actualiza) la factura y genera sus vencimientos (efectos) según su forma de pago: con `FormaPago` de contado no se genera ninguno. En el pedido, envía `FormaPago` si quieres vencimientos. **`FechaActualizacion` es obligatoria** aunque el Swagger no lo indique: sin ella, "No ha introducido la fecha de actualización" |

Hay más procesos: actualizar o desactualizar, eliminar albarán o factura, marcar líneas... La lista completa está en la especificación, en las rutas que empiezan por `/exec/`.

## Sincronización ERP → web

AHORA Connect **no envía webhooks salientes**. Los "WebHooks" de Flexygo (`sysWebHooks`) son solo **entrantes**: reciben una llamada externa y ejecutan un proceso. Para detectar cambios hay que consultar periódicamente desde el backend (*polling*) con `filter` por fecha o por estado (por ejemplo `FechaFact >= '2026-10-01'`) y guardar la marca de la última sincronización. Los maestros pequeños se pueden recargar enteros cada noche.

## Plantilla mínima (JavaScript, Node 18+)

```js
let token, expira = 0;
async function getToken() {
  if (token && Date.now() < expira) return token;
  const r = await fetch(`${BASE}/token`, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', username: USER, password: PASSWORD }) });
  if (!r.ok) throw new Error(`Login: HTTP ${r.status}`);
  const j = await r.json();
  token = j.access_token; expira = Date.now() + (j.expires_in - 60) * 1000;
  return token;
}
async function connect(method, path, body) {
  const r = await fetch(`${BASE}/webapi${path}`, { method,
    headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) { let e; try { e = JSON.parse(t); } catch { e = t; }   // texto o { Message, InnerException }
    throw new Error(typeof e === 'string' ? e : e?.InnerException?.Message ?? e?.Message ?? `HTTP ${r.status}`); }
  return t ? JSON.parse(t) : null;
}
const filtro = (where) => `filter=${encodeURIComponent(where)}`;
const prop = (o, campo) => o?.Properties?.[campo]?.Value;
```

En otros lenguajes, la lógica es la misma: un POST form-urlencoded para el token, y JSON con el Bearer en todo lo demás.
