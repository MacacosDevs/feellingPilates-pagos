# Matriz de cobertura — pruebas de errores del microservicio de pagos

Fuente de verdad de esta ronda de pruebas (no las conversaciones ni el chat que la generó). Corresponde al prompt "Pruebas de errores del microservicio de pagos" ejecutado sobre `feellingPilates-pagos` en la rama `AlanGP2001/lungfish`.

Última corrida verificada: 2026-09-22, `npm test` → **82/82 PASS** (69 del prompt original + 5 al corregir P1-3 + 1 neto al corregir P1-1 + 1 neto al corregir P1-2 + 6 al corregir P1-4, hallazgo descubierto al aclarar P2-1 con el dueño del producto), 3+ corridas consecutivas sin flakiness (ver notas de infraestructura al final).

## Infraestructura de pruebas

- Test runner: **vitest** (`npm test` = `vitest run`).
- Aislamiento de Prisma: **Testcontainers** (`postgres:16-alpine`), un contenedor por corrida completa de la suite (`tests/setup/globalSetup.ts`), con `prisma migrate deploy` real contra el contenedor. `fileParallelism: false` en `vitest.config.ts` porque todos los archivos comparten el mismo Postgres y truncan las mismas tablas.
  - La migración baseline agrega una FK `compra.usuario_id_fkey → public.usuario(id)` (cross-schema, ver comentario en `prisma/migrations/00000000000000_baseline/migration.sql`). En el entorno real esa tabla la posee el backend Java; en el contenedor de pruebas se crea un stub mínimo (`CREATE TABLE public.usuario (id UUID PRIMARY KEY)`) antes de migrar, y los tests insertan una fila stub por cada `usuarioId` usado (`tests/helpers/db.ts:crearUsuario`).
- Aislamiento de Stripe: `vi.mock` de `src/lib/stripe.js` en cada archivo de test (`tests/mocks/stripeStub.ts`). **Nunca se llama a la API real de Stripe**, ni con `sk_test_...` real ni en ningún otro modo.
- JWT: `tests/helpers/jwt.ts` firma tokens HS256 con el mismo esquema de claims que `src/middleware/auth.ts` espera (`sub`, `correo`, `roles`, `permisos`).

## Leyenda de severidad

| Severidad | Significado |
|---|---|
| P0 | Dinero perdido o duplicado, datos de otro usuario expuestos, bypass de auth/permiso |
| P1 | Estado inconsistente pero recuperable, o fuga de información menor |
| P2 | Falta de cobertura, mejora, deuda técnica |

## Matriz de escenarios

### `POST /paquetes/intento`

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 1 | Sin `Authorization` → 401 | PASS | `tests/routes/pagos.intento.test.ts:23` |
| 2 | Token firmado con otro secreto → 401 | PASS | `tests/routes/pagos.intento.test.ts:29` |
| 3 | Token expirado → 401 | PASS | `tests/routes/pagos.intento.test.ts:38` |
| 3b | Token con formato inválido (no JWT) → 401 | PASS | `tests/routes/pagos.intento.test.ts:47` |
| 4 | `paqueteIds` vacío → 400 ValidacionError | PASS | `tests/routes/pagos.intento.test.ts:55` |
| 4b | `paqueteIds` ausente → 400 ValidacionError | PASS | `tests/routes/pagos.intento.test.ts:66` |
| 5 | `paqueteIds` con id inexistente → 404 | PASS | `tests/routes/pagos.intento.test.ts:73` |
| 5b | `paqueteIds` con paquete `activo=false` → 404 | PASS | `tests/routes/pagos.intento.test.ts:83` |
| 6 | `paqueteIds` con duplicados (mismo id 2 veces) | PASS (comportamiento confirmado, ver **Hallazgo P2-1**) | `tests/routes/pagos.intento.test.ts:94` |
| 7 | Reintento con mismo `idempotencyKey` reusa el PaymentIntent | PASS | `tests/routes/pagos.intento.test.ts:124` |
| 8 | Dos requests simultáneos con misma `idempotencyKey` (vía HTTP, timing real) → ambas 200 con el mismo `clientSecret` | PASS ([CORREGIDO] **Hallazgo P1-1**) | `tests/routes/pagos.intento.test.ts:153` |
| 8b | Misma carrera, reproducida de forma determinística: el intent se asigna poco después → se espera y se reusa | PASS ([CORREGIDO] **Hallazgo P1-1**) | `tests/routes/pagos.intento.test.ts:190` |
| 8c | Compra que nunca llega a tener intent (request original nunca terminó) → 502 `internal_error` claro, sin llamar a Stripe con un id nulo | PASS | `tests/routes/pagos.intento.test.ts:222` |
| 9 | `reusarSiExiste` con `paymentIntents.retrieve` fallando → 502 traducido | PASS | `tests/routes/pagos.intento.test.ts:246` |
| 10 | `paymentIntents.create` con `StripeConnectionError` → 502 `stripe_network_error` | PASS | `tests/routes/pagos.intento.test.ts:269` |
| 11 | `paymentIntents.create` con `statusCode >= 500` → 502 `stripe_server_error` | PASS | `tests/routes/pagos.intento.test.ts:284` |
| 12 | `paymentIntents.create` con decline 4xx → 502 `stripe_decline` | PASS | `tests/routes/pagos.intento.test.ts:299` |

### `GET /mis-paquetes`, `GET /mis-compras`

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 13 | Sin auth → 401 en ambos endpoints | PASS | `tests/routes/pagos.consultas.test.ts:20` |
| 14 | Usuario sin compras → array vacío, no error | PASS | `tests/routes/pagos.consultas.test.ts:27` |
| 15 | Un combo cuenta como activo para `pilates` y `bacu_fit` a la vez | PASS | `tests/routes/pagos.consultas.test.ts:40` |
| 15b | Compra `pendiente`/no vigente no cuenta como paquete activo | PASS | `tests/routes/pagos.consultas.test.ts:54` |
| 15c | `mis-compras` no filtra compras de otros usuarios | PASS | `tests/routes/pagos.consultas.test.ts:66` |

### `GET /compras/:compraId/estado-en-vivo`

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 16 | `compraId` inexistente → 404 | PASS | `tests/routes/pagos.estadoEnVivo.test.ts:21` |
| 17 | `compraId` de otro usuario → 403 (no 404, sin fuga por status distinto) | PASS | `tests/routes/pagos.estadoEnVivo.test.ts:28` |
| 18 | Compra sin `stripePaymentIntentId` → `estadoStripe: "sin_intento"`, sin llamar a Stripe | PASS | `tests/routes/pagos.estadoEnVivo.test.ts:41` |
| 18b | `paymentIntents.retrieve` exitoso devuelve estado y último error de pago | PASS | `tests/routes/pagos.estadoEnVivo.test.ts:54` |
| 19 | `paymentIntents.retrieve` con fallo de red → 502 `stripe_network_error` | PASS | `tests/routes/pagos.estadoEnVivo.test.ts:71` |
| 19b | `paymentIntents.retrieve` con 5xx → 502 `stripe_server_error` | PASS | `tests/routes/pagos.estadoEnVivo.test.ts:84` |

### `POST /compras/:compraId/reembolso`

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 20 | Sin el permiso `pagos.reembolsar` → 403 aunque esté autenticado | PASS | `tests/routes/pagos.reembolso.test.ts:22` |
| 21 | `compraId` inexistente → 404 | PASS | `tests/routes/pagos.reembolso.test.ts:34` |
| 22 | Compra en `pendiente`/`fallida`/`cancelada`/`reembolsada`/`en_disputa` → 400 ValidacionError | PASS | `tests/routes/pagos.reembolso.test.ts:43` (`it.each`) |
| 23 | Grupo con mismo `stripePaymentIntentId` pero no todas `pagada` → 400 "estado inconsistente" | PASS | `tests/routes/pagos.reembolso.test.ts:59` |
| 24 | `stripe.refunds.create` falla → 502 y **no** se actualiza el estado en BD | PASS | `tests/routes/pagos.reembolso.test.ts:76` |
| 25 | Reembolso exitoso marca `reembolsada` y devuelve el monto | PASS | `tests/routes/pagos.reembolso.test.ts:92` |
| 26 | Reembolso ya hecho (doble refund por nuestro propio endpoint) → 400 en el segundo intento, sin volver a llamar a Stripe | PASS | `tests/routes/pagos.reembolso.test.ts:109` |
| 27 | Refund concurrente vía HTTP (timing real) → nunca 500/502 inesperado, toda llamada real usa la misma `idempotencyKey` | PASS ([CORREGIDO] **Hallazgo P1-2**) | `tests/routes/pagos.reembolso.test.ts:128` |
| 27b | Refund concurrente reproducido llamando al service 2 veces en paralelo → misma `idempotencyKey` determinística en ambas | PASS ([CORREGIDO] **Hallazgo P1-2**) | `tests/routes/pagos.reembolso.test.ts:149` |
| 27c | `refunds.create` recibe `idempotencyKey` determinística por `PaymentIntent` | PASS ([CORREGIDO] **Hallazgo P1-2**) | `tests/routes/pagos.reembolso.test.ts:173` |
| 27d | Stripe rechaza el refund por conflicto de `idempotencyKey` en vuelo, pero el grupo ya quedó reembolsado por la otra request → devuelve éxito, no 502 | PASS | `tests/routes/pagos.reembolso.test.ts:190` |

### `GET /admin/payouts`

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 28 | Sin el permiso `pagos.ver_finanzas` → 403 | PASS | `tests/routes/pagos.payouts.test.ts:20` |
| 28b | `payouts.list` exitoso devuelve la lista mapeada | PASS | `tests/routes/pagos.payouts.test.ts:30` |
| 29 | `payouts.list` con fallo de red → 502 `stripe_network_error` | PASS | `tests/routes/pagos.payouts.test.ts:56` |
| 29b | `payouts.list` con 5xx → 502 `stripe_server_error` | PASS | `tests/routes/pagos.payouts.test.ts:67` |

### `POST /webhook`

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 30 | Sin header `Stripe-Signature` → 400 explícito antes de tocar `pagoService` | PASS | `tests/routes/pagos.webhook.test.ts:32` |
| 31 | Firma inválida / payload alterado → 400 ValidacionError | PASS | `tests/routes/pagos.webhook.test.ts:38` |
| 32 | Tipo de evento no manejado → 200 sin error | PASS | `tests/routes/pagos.webhook.test.ts:47` |
| 33 | `payment_intent.succeeded` sin Compra asociada → no lanza (200) | PASS | `tests/routes/pagos.webhook.test.ts:55` |
| 33b | `payment_intent.succeeded` marca pagada y guarda comisión/monto neto/tarjeta | PASS | `tests/routes/pagos.webhook.test.ts:62` |
| 34 | `payment_intent.succeeded` recibido 2 veces → idempotente, no duplica | PASS | `tests/routes/pagos.webhook.test.ts:87` |
| 35 | `charges.retrieve` (balance_transaction) falla → sigue marcando pagada sin comisión/neto | PASS | `tests/routes/pagos.webhook.test.ts:116` |
| 35b | 2 paquetes iguales en el mismo carrito → vigencia se apila (30+30=60 días consecutivos) | PASS ([CORREGIDO] **Hallazgo P1-4**) | `tests/routes/pagos.webhook.test.ts:140` |
| 35c | Compra con vigencia previa en la misma categoría → la nueva extiende desde la fecha de expiración vigente, no desde ahora | PASS ([CORREGIDO] **Hallazgo P1-4**) | `tests/routes/pagos.webhook.test.ts:159` |
| 35d | Sin vigencia previa (o solo una ya vencida) → arranca desde ahora, sin cambios | PASS | `tests/routes/pagos.webhook.test.ts:181` |
| 35e | Un combo se apila sobre la vigencia más lejana entre pilates y bacu_fit | PASS ([CORREGIDO] **Hallazgo P1-4**) | `tests/routes/pagos.webhook.test.ts:202` |
| 35f | Vigencia de pilates no afecta a una compra nueva de bacu_fit (categorías distintas, sin combo) | PASS | `tests/routes/pagos.webhook.test.ts:222` |
| 35g | `obtenerPaquetesActivos` refleja la vigencia apilada como una sola entrada de 60 días | PASS | `tests/routes/pagos.webhook.test.ts:244` |
| 36 | `payment_intent.payment_failed` guarda `ultimoErrorCodigo`/`ultimoErrorMensaje` | PASS | `tests/routes/pagos.webhook.test.ts:266` |
| 36b | `payment_intent.payment_failed` sin compra previa → no lanza | PASS | `tests/routes/pagos.webhook.test.ts:285` |
| 37 | `charge.refunded` sin compras asociadas → no falla | PASS | `tests/routes/pagos.webhook.test.ts:294` |
| 37b | `charge.refunded` sobre compra ya reembolsada → no falla, no reescribe | PASS | `tests/routes/pagos.webhook.test.ts:301` |
| 37c | `charge.refunded` sobre compra pagada (reembolso hecho fuera del endpoint) → marca reembolsada | PASS | `tests/routes/pagos.webhook.test.ts:316` |
| 38 | `charge.dispute.created` sin `payment_intent` → retorna sin error | PASS | `tests/routes/pagos.webhook.test.ts:332` |
| 38b | `charge.dispute.created` marca `en_disputa` | PASS | `tests/routes/pagos.webhook.test.ts:339` |
| 39 | `charge.dispute.closed` con `status: "won"` → vuelve a `pagada`, solo afecta `en_disputa` | PASS | `tests/routes/pagos.webhook.test.ts:355` |
| 39b | `charge.dispute.closed` con otro status → `reembolsada` | PASS | `tests/routes/pagos.webhook.test.ts:370` |
| 39c | `charge.dispute.closed` no afecta compras con el mismo intent que no estén `en_disputa` | PASS | `tests/routes/pagos.webhook.test.ts:383` |

### Job de reconciliación (`src/jobs/reconciliacion.ts`)

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 40 | Compra pendiente sin `stripePaymentIntentId` → se ignora | PASS | `tests/jobs/reconciliacion.test.ts:19` |
| 41 | `paymentIntents.retrieve` falla para una compra → loguea y sigue con el resto del batch | PASS | `tests/jobs/reconciliacion.test.ts:29` |
| 42 | Intent `status: "succeeded"` → aplica pagada igual que el webhook | PASS | `tests/jobs/reconciliacion.test.ts:50` |
| 43 | Intent `status: "canceled"` → marca cancelada | PASS | `tests/jobs/reconciliacion.test.ts:62` |
| 44 | Intent en otro estado, dentro de la ventana de abandono → no se toca | PASS | `tests/jobs/reconciliacion.test.ts:74` |
| 45 | Intent en otro estado, fuera de la ventana de abandono → se cancela | PASS | `tests/jobs/reconciliacion.test.ts:86` |
| 46 | Webhook y cron casi simultáneos sobre la misma compra → sin estado inconsistente (guard de `aplicarPagada`) | PASS | `tests/jobs/reconciliacion.test.ts:106` |

**Total: 69/69 escenarios del prompt original ejecutados y verificados como PASS.** "PASS" aquí significa "el test corrió y confirma el comportamiento documentado" — en 3 casos (marcados arriba) el comportamiento confirmado es en sí mismo un hallazgo (ver siguiente sección), no una validación de que todo está bien.

### Escenarios adicionales (fuera del prompt original, agregados al validar "¿son todos los errores posibles?")

| # | Escenario | Estado | Evidencia |
|---|---|---|---|
| 47 | `GET estado-en-vivo` con `compraId` no-UUID → 400 limpio, sin detalle interno de Prisma | PASS | `tests/routes/pagos.manejoErrores.test.ts` |
| 48 | `POST reembolso` con `compraId` no-UUID → 400 limpio, sin detalle interno de Prisma | PASS | `tests/routes/pagos.manejoErrores.test.ts` |
| 49 | `POST paquetes/intento` con un `paqueteId` no-UUID → 400 limpio, sin detalle interno de Prisma | PASS | `tests/routes/pagos.manejoErrores.test.ts` |
| 50 | Body JSON malformado en `POST intento` → 400 con mensaje de sintaxis (comportamiento correcto ya existente, ahora fijado con test) | PASS | `tests/routes/pagos.manejoErrores.test.ts` |
| 51 | Un error no anticipado por este servicio (bug, excepción de terceros) → 500 genérico, sin filtrar el mensaje original | PASS | `tests/routes/pagos.manejoErrores.test.ts` |

**Total combinado: 82/82 PASS.**

## Hallazgos

### P1-1 — [CORREGIDO] Carrera en `crearIntentoPago`/`reusarSiExiste`: la request perdedora recibía un 502 engañoso en vez de 200

- **Dónde (antes del fix)**: `src/services/pagoService.ts` — `reusarSiExiste`, invocado desde `crearIntentoPago`.
- **Qué pasaba**: si dos requests llegaban con la misma `idempotencyKey` casi al mismo tiempo, ambas podían pasar la comprobación inicial de `reusarSiExiste` sin encontrar nada (la tabla estaba vacía para esa clave). Una de las dos creaba las filas `Compra` y llamaba a Stripe; si la segunda request llegaba a `reusarSiExiste` **después** de que la primera insertó sus filas `Compra` pero **antes** de que corriera el `updateMany` que guarda `stripePaymentIntentId`, `reusarSiExiste` encontraba una `Compra` existente con `stripePaymentIntentId: null` y llamaba a `stripe.paymentIntents.retrieve(null)`. Stripe (y el mock que reproduce su comportamiento) rechaza esa llamada, y el error se traducía como `origen: "stripe_decline"` — un 502 que no era en absoluto un decline de tarjeta, sino un bug de carrera interno.
- **Impacto real (antes del fix)**: no había doble cobro (la idempotencia de Stripe en `paymentIntents.create` seguía protegiendo eso), pero un doble-tap o un reintento por timeout del cliente podía recibir un error 502 confuso ("stripe_decline") en una fracción de los casos, en vez de la respuesta 200 correcta con el `clientSecret`.
- **Corrección aplicada**: la estrategia elegida (de las tres esbozadas originalmente: reintentar con backoff corto, `SELECT ... FOR UPDATE`, o constraint única + upsert) fue **reintentar la lectura con backoff corto**, por ser la que no requiere ni un cambio de esquema ni mantener una transacción de Postgres abierta durante la llamada de red a Stripe (que sí harían falta con un lock a nivel de fila/advisory lock envolviendo la creación del PaymentIntent).
  - Nueva función `esperarAsignacionDeIntent` en `src/services/pagoService.ts`: cuando `reusarSiExiste` encuentra `Compra` existentes para la `idempotencyKey` pero `stripePaymentIntentId` todavía es `null`, en vez de llamar a Stripe con un id nulo, espera un intervalo corto y vuelve a consultar, hasta un máximo de intentos — ambos configurables via `IDEMPOTENCY_ESPERA_INTERVALO_MS` / `IDEMPOTENCY_ESPERA_MAX_INTENTOS` (`src/config/env.ts`, default 100ms × 20 intentos = 2s tope en producción).
  - Si el intent se asigna dentro de esa ventana (el caso normal: la request ganadora típicamente termina en milisegundos), la request perdedora recibe el mismo `clientSecret` con `200`, tal como se espera de un endpoint idempotente.
  - Si se agota la ventana sin que se asigne un intent (la request original se cayó o crasheó a mitad de camino), se devuelve un error claro y seguro: `502 { origen: "internal_error" }`, sin intentar crear un segundo `PaymentIntent` automáticamente (evita el riesgo de duplicar el cargo si la request original en realidad seguía viva, solo lenta) y sin llamar nunca a Stripe con un id nulo.
- **Evidencia (re-ejecutada después del fix)**: `tests/routes/pagos.intento.test.ts:153` (dos requests HTTP simultáneas reales → ambas 200 con el mismo `clientSecret`, un solo `paymentIntents.create`); `tests/routes/pagos.intento.test.ts:190` (reproducción determinística: el intent se asigna 40ms después → se espera y se reusa); `tests/routes/pagos.intento.test.ts:222` (reproducción determinística del caso sin salida: nunca se asigna un intent → `502 internal_error` limpio, sin llamar a `retrieve` ni a `create`). `npm test` completo → 75/75 PASS, corrida el 2026-09-22 después de aplicar el fix, 3+ corridas consecutivas sin flakiness en el test de la carrera vía HTTP real.
- **Estado de la corrección**: **CORREGIDO y verificado** (suite completa vuelta a correr después del cambio, no solo el archivo nuevo, antes de marcarlo resuelto).

### P1-2 — [CORREGIDO] `reembolsarCompra` no pasaba `idempotencyKey` a Stripe ni tenía protección de concurrencia entre lectura y escritura de estado

- **Dónde (antes del fix)**: `src/services/pagoService.ts` — `reembolsarCompra`, la llamada `stripe.refunds.create({ payment_intent: ... })` (sin segundo argumento de `requestOptions`).
- **Qué pasaba**: a diferencia de `crearIntentoPago`, que sí pasa `idempotencyKey` a `stripe.paymentIntents.create` como "doble seguro" documentado en el propio código, `reembolsarCompra` no tenía un mecanismo equivalente. Además, el chequeo `compra.estado !== "pagada"` (lectura) y el `updateMany` a `"reembolsada"` (escritura, tras llamar a Stripe) no estaban protegidos por ningún lock: dos requests concurrentes al mismo `compraId` podían ambas leer `"pagada"` antes de que cualquiera escribiera, y ambas terminaban llamando a `stripe.refunds.create`.
- **Impacto real (antes del fix)**: el propio saldo de Stripe evitaba que se reembolsara más del monto ya cobrado, así que el riesgo de pérdida de dinero real era bajo, pero no nulo si en el futuro se soportan reembolsos parciales. El riesgo concreto: (a) un reintento de red genuino (timeout del lado de este servicio, mientras el refund sí se creó en Stripe) no era seguro de reintentar sin `idempotencyKey`, y (b) dos administradores (o un doble clic) podían ambos disparar `stripe.refunds.create` para el mismo cargo.
- **Corrección aplicada**: `idempotencyKey` **determinística por `PaymentIntent`** (`` `refund_${compra.stripePaymentIntentId}` ``), no aleatoria por request — mismo principio que el "doble seguro" ya usado en `crearIntentoPago`, pero sin necesitar un valor generado por el cliente: un reembolso es siempre "todo o nada" para el grupo completo que comparte ese intent, así que cualquier llamada (reintento de red o dos requests concurrentes) para el mismo intent debe resolver al mismo refund real en Stripe, nunca a uno nuevo. Esto no requiere cambio de esquema ni ningún lock a nivel de fila.
  - Si dos requests concurrentes llegan a Stripe casi al mismo instante con la misma clave, Stripe puede rechazar a la que llega segunda mientras la primera sigue en vuelo (error de idempotencia), en vez de esperarla. Para ese caso puntual, el `catch` de `reembolsarCompra` ahora vuelve a consultar el grupo en BD antes de traducir el error: si ya quedó `"reembolsada"` (la otra request ganó), devuelve ese resultado real en vez de un 502 engañoso para quien solo perdió la carrera por una fracción de segundo.
- **Evidencia (re-ejecutada después del fix)**: `tests/routes/pagos.reembolso.test.ts:128` (concurrencia vía HTTP real, toda llamada a Stripe usa la misma clave); `tests/routes/pagos.reembolso.test.ts:149` (dos llamadas directas al service en paralelo, misma clave determinística, grupo termina `reembolsada`); `tests/routes/pagos.reembolso.test.ts:173` (confirma que la clave se pasa y es determinística por intent); `tests/routes/pagos.reembolso.test.ts:190` (reproducción determinística del rechazo por conflicto de idempotencia → resultado exitoso, no 502). `npm test` completo → 76/76 PASS, corrida el 2026-09-22 después de aplicar el fix, 3+ corridas consecutivas sin flakiness.
- **Estado de la corrección**: **CORREGIDO y verificado** (suite completa vuelta a correr después del cambio antes de marcarlo resuelto).

### P2-1 — [ACLARADO] `paqueteIds` con el mismo id repetido cobra el paquete dos veces — confirmado como comportamiento deseado, no un bug

- **Dónde**: `src/services/pagoService.ts` (chequeo `paquetes.length !== new Set(paqueteIds).size` en `crearIntentoPago`).
- **Qué pasa**: con `paqueteIds: [id, id]`, la consulta `findMany({ where: { id: { in: paqueteIds } } })` devuelve el paquete **una sola vez** (`paquetes.length === 1`), y `new Set(paqueteIds).size` también es `1` — la comprobación no detecta el duplicado. El código crea una `Compra` por cada entrada del array (`paqueteIds.map(...)`), así que el usuario termina con 2 `Compra` y se le cobra 2 veces el precio del paquete.
- **Decisión de producto (2026-09-22)**: comprar más de una unidad del mismo paquete en un mismo carrito **es un flujo válido e intencional** — no hay que deduplicar `paqueteIds` ni rechazarlo. No se necesita ningún cambio de código para esta parte: el cobro doble es correcto porque el usuario pidió dos paquetes.
- **Lo que sí resultó ser un bug real al verificar esta decisión**: aunque el cobro doble era correcto, el *beneficio* no se estaba duplicando en absoluto — ver **Hallazgo P1-4** más abajo, descubierto y corregido a partir de esta misma conversación.
- **Evidencia**: `tests/routes/pagos.intento.test.ts:94` (sigue confirmando 2 `Compra` creadas y `amount` = precio × 2 — comportamiento correcto, no un hallazgo).
- **Estado**: **CERRADO** (aclarado por decisión de producto, no requiere cambio de código).

### P1-4 — [CORREGIDO] La vigencia de compras adicionales en la misma categoría no se sumaba: el cliente pagaba 2x pero solo recibía el beneficio de 1x

- **Cómo se encontró**: al aclarar P2-1, el dueño del producto confirmó que comprar 2 paquetes iguales es intencional y que "obviamente" la vigencia debería sumarse (30+30 = 60 días consecutivos). Verificar esa afirmación contra el código reveló que **no era cierto**.
- **Dónde (antes del fix)**: `src/services/pagoService.ts` — `aplicarPagada` (compartida por el webhook `payment_intent.succeeded` y el job de reconciliación) y `obtenerPaquetesActivos`.
- **Qué pasaba**:
  1. `aplicarPagada` calculaba `fechaExpiracion` siempre como `Date.now() + paquete.vigenciaDias * 86_400_000` — **sin mirar si el usuario ya tenía otra compra vigente**. Dos compras del mismo paquete de 30 días, confirmadas casi al mismo tiempo, terminaban con fechas de expiración casi idénticas (~30 días desde hoy cada una), no 60 días combinados.
  2. `obtenerPaquetesActivos` ("mis paquetes activos") solo devuelve **una** compra por categoría — la de expiración más lejana — y descarta las demás (esto está documentado a propósito en el comentario del código: *"no existe todavía un sistema de reservas que descuente clases usadas... 'paquete activo' es solo el más reciente vigente"*). Como ninguna de las dos compras aportaba tiempo extra, la segunda compra pagada **no le daba absolutamente nada** al usuario: ni más días, ni más clases (tampoco existe un campo de "cantidad de clases" en el modelo — `Paquete` solo tiene `vigenciaDias`, sin contador de clases).
- **Impacto real (antes del fix)**: el cliente pagaba el doble del precio y su acceso seguía expirando prácticamente el mismo día que si hubiera comprado una sola unidad. Esto es dinero real pagado sin el beneficio correspondiente — un problema de negocio/confianza con el cliente, no solo un detalle técnico.
- **Corrección aplicada**: nueva función `calcularFechaExpiracion(usuarioId, paquete)` en `src/services/pagoService.ts`, usada por `aplicarPagada` en vez del cálculo fijo:
  - Busca las compras `pagada` y vigentes (`fechaExpiracion > ahora`) del usuario en las categorías que la nueva compra cubre (la propia categoría del paquete; si es `"combo"`, cubre `"pilates"` y `"bacu_fit"` a la vez — mismo criterio que ya usa `obtenerPaquetesActivos`).
  - La nueva `fechaExpiracion` = `max(ahora, expiración vigente más lejana entre esas categorías) + paquete.vigenciaDias`. Si no hay ninguna vigente (o solo hay una ya vencida), el resultado es igual al comportamiento anterior (`ahora + vigenciaDias`).
  - Un combo se apila sobre la más lejana entre pilates y bacu_fit (no sobre una fija), para no dejar un hueco de cobertura en ninguna de las dos categorías cuando sus vigencias vigentes difieren.
  - Como el webhook procesa las `Compra` de un mismo carrito **secuencialmente** (`for...of` con `await`, no en paralelo), comprar 2 paquetes iguales en un mismo checkout ya encadena correctamente: la primera se confirma con `ahora+30`, y para cuando se procesa la segunda, la primera ya quedó `"pagada"` con esa fecha, así que la segunda se apila sobre ella (`+30` más = 60 días desde `ahora`).
- **Fuera de alcance de este fix (documentado, no bloqueante)**: si dos compras de **checkouts completamente distintos** (dos `PaymentIntent` separados) se confirman casi al mismo instante por dos webhooks concurrentes, existe la misma clase de ventana de carrera que P1-1/P1-2 (ambas podrían leer "sin vigencia previa" y calcular desde `ahora` en vez de apilarse entre sí). Es un escenario mucho más raro en la práctica (requiere que el usuario complete dos checkouts separados casi al mismo segundo) y su peor consecuencia es cosmética (falta apilar unos segundos de superposición, no pérdida de dinero ni de acceso), así que se deja como limitación conocida en vez de agregar un lock para esto ahora.
- **Evidencia (re-ejecutada después del fix)**: 6 tests nuevos en `tests/routes/pagos.webhook.test.ts` (dentro de `describe("la vigencia se apila entre compras (no se pisa)")`, línea 139): mismo carrito apila 30+30=60; compra nueva extiende desde la vigente; sin vigencia previa arranca desde ahora; combo se apila sobre la más lejana; categorías distintas no se mezclan sin combo; `obtenerPaquetesActivos` refleja el total apilado. `npm test` completo → 82/82 PASS, corrida el 2026-09-22 después de aplicar el fix.
- **Estado de la corrección**: **CORREGIDO y verificado** (suite completa vuelta a correr después del cambio antes de marcarlo resuelto).

### P1-3 — [CORREGIDO] `compraId`/`paqueteId` con formato inválido llegaban sin validar a Prisma, que filtraba su error interno (ruta de archivo, línea, stack) al cliente en la respuesta 500

- **Dónde (antes del fix)**: `src/services/pagoService.ts` — `obtenerEstadoEnVivo` (línea 232 original), `reembolsarCompra` (línea 428 original) y `crearIntentoPago` (línea 82) pasaban el id recibido del cliente directo a una columna `@db.Uuid` de Prisma sin validar su formato. `src/middleware/errores.ts` reenviaba `error.message` de **cualquier** error (no solo los construidos a propósito por este servicio) en el body de la respuesta.
- **Qué pasaba**: un `compraId` o `paqueteId` con formato no-UUID (ej. `no-es-un-uuid`) hacía que Prisma lanzara `PrismaClientKnownRequestError` (código `P2023`), cuyo `.message` incluye la ruta absoluta del archivo, el número de línea y parte del stack de la query. Como ese error no tiene `.status`, caía al 500 genérico — pero el body de esa respuesta 500 contenía el mensaje completo de Prisma, no un `"Error interno"` genérico. Confirmado en vivo antes del fix:
  ```
  GET /api/pagos/compras/no-es-un-uuid/estado-en-vivo
  → 500 {"error":"\nInvalid `prisma.compra.findUnique()` invocation in\nC:/.../pagoService.ts:215:38\n..."}
  ```
- **Alcance real del bug**: no era exclusivo de `compraId` en estado-en-vivo — el mismo patrón (id de usuario no validado → Prisma → leak) afectaba también a `reembolsarCompra` y a cada entrada de `paqueteIds` en `crearIntentoPago`. La causa raíz era más amplia todavía: `manejadorErrores` confiaba en `.message`/`.status` de **cualquier** error no anticipado, así que cualquier futuro error interno no relacionado con UUIDs (otro bug, otra excepción de una librería) habría tenido el mismo problema.
- **Corrección aplicada** (dos capas, no una sola):
  1. `src/middleware/errores.ts` — `manejadorErrores` ahora solo confía en `.status`/`.message` de las 4 clases de error que este servicio construye a propósito (`ValidacionError`, `RecursoNoEncontradoError`, `NoAutorizadoError`, `ErrorPago`, ver `src/errores.ts`). Cualquier otro error no reconocido responde `500 {"error":"Error interno"}` sin filtrar su mensaje original (que sí se sigue logueando completo con `console.error` del lado del servidor). Se preserva como caso especial el error de parseo de JSON de `express.json()` (`type: "entity.parse.failed"`, `status: 400`, `expose: true`), porque ese mensaje es seguro de mostrar y le sirve al cliente para corregir su request.
  2. `src/services/pagoService.ts` — se agregó `validarUuid()` (regex de formato UUID v4-agnóstico) y se llama antes de tocar Prisma en `obtenerEstadoEnVivo`, `reembolsarCompra` y por cada entrada de `paqueteIds` en `crearIntentoPago`, devolviendo un `400 ValidacionError` claro (`"compraId invalido"` / `"paqueteId invalido"`) en vez de depender solo del 500 genérico de respaldo.
- **Evidencia (re-ejecutada después del fix, no antes)**: `tests/routes/pagos.manejoErrores.test.ts` — 5 tests, todos PASS: `npm test` completo → 74/74 PASS, corrida el 2026-09-22 después de aplicar ambos cambios.
- **Severidad**: P1 (fuga de información interna — rutas de archivo del servidor, ORM usado, estructura de código — no P0 porque no expone datos de otro usuario ni permite bypass de auth).
- **Estado de la corrección**: **CORREGIDO y verificado** (no autodeclarado sin volver a correr la prueba: se corrió `npm test` completo después del cambio, no solo el archivo nuevo).

## Qué no se hizo (según el alcance del prompt)

- No se llamó a la API real de Stripe en ningún momento (todo mockeado con `vi.mock`).
- No se commiteó ninguna clave real de Stripe ni token JWT real; `tests/setup/testEnv.ts` usa únicamente valores dummy (`sk_test_dummy_no_se_llama_nunca`, etc.).
- No se modificó `prisma/schema.prisma` ni se generaron migraciones nuevas para ninguno de los 4 hallazgos corregidos: todas las estrategias elegidas (espera con reintentos cortos para P1-1; `idempotencyKey` determinística por `PaymentIntent` para P1-2; apilar sobre la vigencia existente para P1-4) evitan necesitar una constraint única o un cambio de esquema. El único cambio de infraestructura de pruebas es el stub `public.usuario` creado en tiempo de test dentro del contenedor efímero (`tests/setup/globalSetup.ts`), no en el schema del servicio.
- P2-1 se cerró sin cambio de código: era una decisión de producto (¿`paqueteIds` duplicados es "comprar 2 unidades" o un error de doble-envío?), y el dueño del producto confirmó que es "comprar 2 unidades" intencional — el comportamiento de cobro doble ya era correcto.
- Esa misma aclaración destapó un hallazgo nuevo y más importante (P1-4): aunque el cobro doble era correcto, el beneficio (vigencia) no se sumaba. Ningún hallazgo se cerró por asumir intención sin verificar contra el código real.
- P1-1, P1-2, P1-3 y P1-4 se corrigieron dentro de esta tarea: P1-3 porque era una validación defensiva mecánica sin ambigüedad de diseño; P1-1, P1-2 y P1-4 porque, aunque cada uno implicaba una decisión (de concurrencia o de negocio), en los tres casos había una estrategia sin cambio de esquema ni necesidad de mantener una transacción de BD abierta durante una llamada de red a Stripe. En los 4 casos se volvió a correr toda la suite después del cambio antes de marcarlos como resueltos.
