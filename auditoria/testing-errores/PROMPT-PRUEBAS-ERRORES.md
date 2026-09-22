# Prompt — Pruebas de errores del microservicio de pagos

**Servicio:** `feellingPilates-pagos` (Express + TypeScript + Prisma + Stripe)
**Propósito:** cobertura sistemática de todos los caminos de error del servicio de pagos, con un control de evidencia parecido en espíritu al que ya se usa en `feellingPilates` (`auditoria/orquestacion/`): severidad clasificada, resultados escritos en el repo (no solo en el chat), y nadie da por resuelto su propio hallazgo sin volver a correr la prueba. No replica el orquestador multiagente completo del backend (EXECUTOR/AUDITOR/CORRECTOR/roles con gates) porque ese protocolo es para intervenciones de arquitectura con publicación; aquí el objetivo es más chico: pruebas de error con trazabilidad.

Este archivo es el prompt en sí — pégalo completo en una sesión nueva (o pásalo tal cual a un agente) cuando quieras correr o ampliar esta ronda de pruebas.

---

## 0. Contexto que hay que leer antes de escribir una sola prueba

Lee estos archivos, en este orden, antes de generar código de prueba:

1. `src/errores.ts` — la taxonomía completa de errores del servicio (`ValidacionError`, `RecursoNoEncontradoError`, `NoAutorizadoError`, `ErrorPago` con su `origen`).
2. `src/middleware/errores.ts` — cómo se traduce cada error a una respuesta HTTP.
3. `src/services/pagoService.ts` — toda la lógica de negocio: crear intento de pago, idempotencia, webhook, reconciliación, reembolso, disputas.
4. `src/routes/pagos.ts` — qué middleware (`requireAuth`, `requierePermiso`) protege cada endpoint.
5. `src/middleware/auth.ts` — cómo se valida el JWT (mismo secreto HS256 que el backend Java).
6. `src/jobs/reconciliacion.ts` y `prisma/schema.prisma` — el cron de reconciliación y el modelo de datos (`Compra`, `Paquete`).

No asumas comportamiento por el nombre de una función: confirma leyendo el código, porque este servicio es el resultado de partir el módulo de pagos del backend Java a un microservicio propio (ver nota de contexto: la migración está validada pero el cutover del lado Java sigue pendiente, así que ambos sistemas coexisten).

## 1. Punto de partida: no existe test runner todavía

`package.json` no tiene `vitest`, `jest`, `supertest` ni nada de testing. Antes de escribir pruebas:

1. Instalar `vitest` + `supertest` + `@types/supertest` como devDependencies.
2. Añadir script `"test": "vitest run"` y `"test:watch": "vitest"`.
3. Decidir cómo aislar Stripe: **no llamar a la API real de Stripe en los tests**, ni siquiera en modo test — mockear el módulo `src/lib/stripe.ts` (p. ej. con `vi.mock`) para controlar determinísticamente cada respuesta (éxito, `StripeConnectionError`, error 5xx, decline 4xx).
4. Decidir cómo aislar Prisma: o bien un Postgres de prueba real vía Testcontainers (más fiel, más lento) o un mock/stub del `PrismaClient` para los tests unitarios de `pagoService`. Si se usa Testcontainers, documentarlo como requisito de entorno (igual que el backend Java, que ya depende de Testcontainers — ver `TestcontainersConfiguration.java`).
5. Nunca usar claves `sk_live_` en ningún test, fixture o log. Solo `sk_test_...` o el mock.

## 2. Matriz de escenarios de error a cubrir

Por endpoint, con el error esperado y su origen en el código:

### `POST /paquetes/intento` (crear intento de pago)
- Sin `Authorization` → 401 (`middleware/auth.ts`, no llega a `manejadorErrores`).
- Token expirado / inválido / firmado con otro secreto → 401.
- `paqueteIds` vacío o ausente → 400 `ValidacionError`.
- `paqueteIds` con un id que no existe o de un paquete `activo=false` → 404 `RecursoNoEncontradoError`.
- `paqueteIds` con duplicados (mismo id dos veces) → confirmar qué hace la comparación `paquetes.length !== new Set(paqueteIds).size`.
- Reintento con el mismo `idempotencyKey` → debe reusar el `PaymentIntent` existente, no crear uno nuevo (`reusarSiExiste`).
- Dos requests simultáneos con la misma `idempotencyKey` (doble tap / reintento por timeout) → confirmar que la idempotencia de Stripe (pasada como `idempotencyKey` a `stripe.paymentIntents.create`) evita duplicar el cargo aunque ambos pasen la comprobación en BD antes de que la primera escriba.
- `stripe.paymentIntents.create` lanza `StripeConnectionError` → 502 `origen=stripe_network_error`.
- `stripe.paymentIntents.create` lanza error con `statusCode >= 500` → 502 `origen=stripe_server_error`.
- `stripe.paymentIntents.create` lanza decline / error 4xx → 502 `origen=stripe_decline`.
- `reusarSiExiste` encuentra compras con `idempotencyKey` pero `stripe.paymentIntents.retrieve` falla → debe traducirse igual con `traducirErrorStripe`.

### `GET /mis-paquetes`, `GET /mis-compras`
- Sin auth → 401.
- Usuario sin compras → array vacío, no error.
- Un combo (`categoria: "combo"`) debe contar como activo para `pilates` y `bacu_fit` a la vez — confirmar con datos de prueba.

### `GET /compras/:compraId/estado-en-vivo`
- `compraId` inexistente → 404.
- `compraId` de otro usuario → 403 `NoAutorizadoError` (no 404 — confirmar que no hay fuga de información sobre existencia vía status code distinto).
- Compra sin `stripePaymentIntentId` (nunca se creó intento) → responde `estadoStripe: "sin_intento"`, no debe intentar llamar a Stripe.
- `stripe.paymentIntents.retrieve` falla (red, 5xx, id inválido) → 502 con `origen` correspondiente.

### `POST /compras/:compraId/reembolso` (requiere permiso `pagos.reembolsar`)
- Sin el permiso → 403, aunque el usuario esté autenticado.
- `compraId` inexistente → 404.
- Compra en estado distinto de `pagada` (`pendiente`, `fallida`, `cancelada`, ya `reembolsada`, `en_disputa`) → 400 `ValidacionError`.
- Grupo de compras que comparten `stripePaymentIntentId` pero no todas están `pagada` → 400 ("estado inconsistente para reembolsar").
- `stripe.refunds.create` falla → 502 con `origen` correcto; confirmar que **no** se actualiza el estado en BD si Stripe rechaza el refund (debe fallar antes del `updateMany`).
- Reembolso ya hecho en Stripe (doble refund) → confirmar comportamiento del catch.
- Refund concurrente de la misma compra desde dos requests → no debe dejar el grupo en un estado mixto.

### `GET /admin/payouts` (requiere permiso `pagos.ver_finanzas`)
- Sin el permiso → 403.
- `stripe.payouts.list` falla (red / 5xx) → 502 con `origen` correcto.

### `POST /webhook`
- Sin header `Stripe-Signature` → 400 explícito antes de tocar `pagoService`.
- Firma inválida o payload alterado → 400 `ValidacionError` ("Firma de webhook de Stripe invalida") vía `construirEventoWebhook`.
- Tipo de evento no manejado (`default: break`) → debe responder 200 sin error, no debe reventar.
- `payment_intent.succeeded` para un `intent.id` que no corresponde a ninguna `Compra` → no debe lanzar (`compras.length === 0 → return`).
- `payment_intent.succeeded` recibido dos veces (reentrega de Stripe) → `aplicarPagada` debe ser idempotente (`if (estadoActual === "pagada") return`), no debe reaplicar ni duplicar campos.
- `charge.retrieve` con `balance_transaction` expandido falla dentro de `marcarComoPagada` → el `.catch` debe dejar `charge = null` y continuar marcando pagada igualmente (sin comisión/monto neto), **no** debe tumbar el webhook completo.
- `payment_intent.payment_failed` → confirmar que guarda `ultimoErrorCodigo` / `ultimoErrorMensaje` y no lanza si no había compra previa con ese intent.
- `charge.refunded` para un `payment_intent` sin compras asociadas, o ya `reembolsada` → no debe fallar ni reescribir.
- `charge.dispute.created` sin `payment_intent` asociado (`dispute.payment_intent` null) → debe retornar sin error.
- `charge.dispute.closed` con `status: "won"` → vuelve a `pagada`; con cualquier otro status → `reembolsada`; solo afecta compras que estén en `en_disputa` (confirmar el `where` no toca otros estados).

### Job de reconciliación (`src/jobs/reconciliacion.ts` + `reconciliarComprasPendientes`)
- Compra `pendiente` sin `stripePaymentIntentId` → se ignora (return temprano).
- `stripe.paymentIntents.retrieve` falla para una compra → debe loguear warning y **seguir con las demás compras del batch**, no abortar el job entero.
- Intent `status: "succeeded"` → aplica pagada igual que el webhook (mismo camino, `aplicarPagada`).
- Intent `status: "canceled"` → marca `cancelada`.
- Intent en otro estado (`requires_payment_method`, etc.) pero todavía dentro de la ventana de `compraPendienteExpiraMinutos` → no debe tocarse.
- Intent en otro estado y ya pasó el límite de abandono → se marca `cancelada`.
- Confirmar qué pasa si el webhook y el cron corren casi al mismo tiempo sobre la misma compra (no debería producir un estado inconsistente gracias al chequeo `if (estadoActual === "pagada") return` en `aplicarPagada`).

## 3. Clasificación de severidad para lo que se encuentre

Al documentar un hallazgo (algo que no se comporta como se espera, aunque no sea un "bug" clásico), clasifícalo:

| Severidad | Qué significa aquí | Ejemplos |
| --- | --- | --- |
| **P0** | Dinero perdido o duplicado, datos de otro usuario expuestos, bypass de auth/permiso. | Doble cargo por idempotencia rota; `estado-en-vivo` de otro usuario responde 200 en vez de 403; reembolso sin permiso. |
| **P1** | Estado inconsistente pero recuperable, o fuga de información menor. | Una compra queda `pendiente` para siempre porque la reconciliación no la alcanza; un mensaje de error expone detalle interno de Stripe al cliente. |
| **P2** | Falta de cobertura, mejora, deuda técnica. | Falta test de un escenario, código duplicado en el manejo de errores. |

Un hallazgo no se cierra por asumir que "ya se corrigió": se vuelve a correr la prueba después del fix y se actualiza la matriz. Nadie marca su propio hallazgo como resuelto sin esa re-ejecución.

## 4. Qué registrar y dónde

Actualiza [`MATRIZ-COBERTURA.md`](./MATRIZ-COBERTURA.md) en esta misma carpeta con el resultado de cada escenario de la sección 2 (`PENDING` / `PASS` / `FAIL`), y si hay un `FAIL`, agrega una entrada en la sección de hallazgos de ese mismo archivo con severidad, evidencia (archivo de test + línea, o log) y estado de la corrección.

No dejes el resultado solo en el chat: la matriz en el repo es la fuente de verdad, igual que en `feellingPilates` los canónicos de `auditoria/` son la fuente de verdad y no las conversaciones.

## 5. Qué NO hacer

- No llamar a la API real de Stripe (ni en modo test) desde el suite automatizado — todo mockeado o contra un stub controlado.
- No commitear claves de Stripe, tokens JWT reales ni el `.env` con secretos.
- No tocar `prisma/schema.prisma` ni generar migraciones como parte de "solo pruebas" — si una prueba revela que hace falta un cambio de esquema, es un hallazgo P1/P2 a documentar, no algo para resolver dentro de esta tarea.
- No marcar como `PASS` un escenario que no se ejecutó (evidencia física, no inferencia).

## 6. Entregable esperado

- Suite de pruebas ejecutable con `npm test`, cubriendo los escenarios de la sección 2.
- `MATRIZ-COBERTURA.md` actualizada con el estado real de cada fila.
- Resumen final: cuántos escenarios `PASS`/`FAIL`, lista de hallazgos con severidad y si quedaron corregidos o pendientes de decisión humana.
