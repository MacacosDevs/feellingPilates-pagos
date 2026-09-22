import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { ErrorPago, NoAutorizadoError, RecursoNoEncontradoError, ValidacionError } from "../errores.js";
import { prisma } from "../lib/prisma.js";
import { stripe } from "../lib/stripe.js";

type EstadoCompra = "pendiente" | "pagada" | "fallida" | "cancelada" | "reembolsada" | "en_disputa";

export interface CrearPagoResponse {
  compraIds: string[];
  clientSecret: string | null;
  publishableKey: string;
}

export interface CompraResponse {
  id: string;
  paqueteNombre: string;
  categoria: string;
  montoCentavos: number;
  estado: string;
  creadoEn: Date;
  fechaExpiracion: Date | null;
  tarjetaMarca: string | null;
  tarjetaUltimosDigitos: string | null;
  reciboUrl: string | null;
  montoComisionCentavos: number | null;
  montoNetoCentavos: number | null;
  ultimoErrorMensaje: string | null;
}

export interface EstadoEnVivoResponse {
  compraId: string;
  estadoLocal: string;
  estadoStripe: string;
  ultimoError: { codigo: string | null; mensaje: string | null } | null;
}

export interface PayoutResponse {
  id: string;
  montoCentavos: number;
  moneda: string;
  estado: string;
  metodo: string;
  fechaLlegada: Date;
  creadoEn: Date;
  descripcion: string | null;
}

export interface PaqueteActivoResponse {
  categoria: string;
  nombre: string;
  fechaInicio: Date;
  fechaExpiracion: Date;
}

export interface ReembolsoResponse {
  compraId: string;
  estado: string;
  montoReembolsadoCentavos: number;
}

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Valida el formato ANTES de que el id llegue a una columna @db.Uuid de
// Prisma. Sin este chequeo, un id con formato invalido hace que Prisma lance
// PrismaClientKnownRequestError (P2023) con el detalle interno de la query
// (archivo, linea, stack) en el mensaje -- manejadorErrores ya no reenvia
// ese detalle al cliente, pero aqui se prefiere devolver un 400 claro en vez
// de depender solo del 500 generico de respaldo.
function validarUuid(id: string, campo: string): void {
  if (!REGEX_UUID.test(id)) {
    throw new ValidacionError(`${campo} invalido`);
  }
}

// Un carrito genera una Compra por paquete elegido; todas comparten
// idempotencyKey y, mas abajo, el mismo PaymentIntent. Espejo de
// PagoService.crearIntentoPago en el backend Java.
export async function crearIntentoPago(
  usuarioId: string,
  paqueteIds: string[],
  idempotencyKey: string | null,
): Promise<CrearPagoResponse> {
  if (!paqueteIds || paqueteIds.length === 0) {
    throw new ValidacionError("Debes seleccionar al menos un paquete");
  }
  for (const paqueteId of paqueteIds) {
    validarUuid(paqueteId, "paqueteId");
  }

  if (idempotencyKey) {
    const existente = await reusarSiExiste(idempotencyKey);
    if (existente) {
      return existente;
    }
  }

  const paquetes = await prisma.paquete.findMany({
    where: { id: { in: paqueteIds }, activo: true },
  });
  if (paquetes.length !== new Set(paqueteIds).size) {
    throw new RecursoNoEncontradoError("Paquete no encontrado");
  }
  const paquetePorId = new Map(paquetes.map((p) => [p.id, p]));

  const compras = await prisma.$transaction(
    paqueteIds.map((paqueteId) => {
      const paquete = paquetePorId.get(paqueteId)!;
      return prisma.compra.create({
        data: {
          usuarioId,
          paqueteId,
          montoCentavos: paquete.precioCentavos,
          idempotencyKey,
        },
      });
    }),
  );

  const totalCentavos = compras.reduce((suma, c) => suma + c.montoCentavos, 0);
  const moneda = compras[0].moneda;

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: totalCentavos,
        currency: moneda,
        metadata: { compraIds: compras.map((c) => c.id).join(",") },
        automatic_payment_methods: {
          enabled: true,
          // Sin return_url no podemos completar metodos que redirigen fuera
          // de la app; el PaymentSheet aqui solo se usa para tarjeta, se
          // desactivan en vez de manejar ese redirect.
          allow_redirects: "never",
        },
      },
      // Doble seguro: si dos requests casi simultaneos esquivan la
      // comprobacion de arriba, la idempotencia de Stripe evita un segundo
      // PaymentIntent real con la misma clave dentro de sus 24h de vigencia.
      idempotencyKey ? { idempotencyKey } : undefined,
    );

    await prisma.compra.updateMany({
      where: { id: { in: compras.map((c) => c.id) } },
      data: { stripePaymentIntentId: intent.id },
    });

    return {
      compraIds: compras.map((c) => c.id),
      clientSecret: intent.client_secret,
      publishableKey: env.stripePublishableKey,
    };
  } catch (e) {
    throw traducirErrorStripe(e, "crear el PaymentIntent");
  }
}

// Si ya existe un grupo de Compra con esta clave (reintento tras timeout,
// doble tap), se reutiliza su PaymentIntent en vez de crear uno nuevo.
async function reusarSiExiste(idempotencyKey: string): Promise<CrearPagoResponse | null> {
  const existentes = await prisma.compra.findMany({ where: { idempotencyKey } });
  if (existentes.length === 0) {
    return null;
  }
  try {
    const intent = await stripe.paymentIntents.retrieve(existentes[0].stripePaymentIntentId!);
    return {
      compraIds: existentes.map((c) => c.id),
      clientSecret: intent.client_secret,
      publishableKey: env.stripePublishableKey,
    };
  } catch (e) {
    throw traducirErrorStripe(e, "recuperar el PaymentIntent existente");
  }
}

// No existe todavia un sistema de reservas que descuente clases usadas de una
// compra, asi que "paquete activo" es solo el mas reciente vigente (pagado y
// sin expirar) por categoria; un combo cuenta como activo para ambas.
export async function obtenerPaquetesActivos(usuarioId: string): Promise<PaqueteActivoResponse[]> {
  const ahora = new Date();
  const vigentes = await prisma.compra.findMany({
    where: { usuarioId, estado: "pagada", fechaExpiracion: { gt: ahora } },
    orderBy: { fechaExpiracion: "desc" },
    include: { paquete: true },
  });

  const resultado: PaqueteActivoResponse[] = [];
  for (const categoria of ["pilates", "bacu_fit"] as const) {
    const compra = vigentes.find((c) => c.paquete.categoria === categoria || c.paquete.categoria === "combo");
    if (compra) {
      resultado.push({
        categoria,
        nombre: compra.paquete.nombre,
        fechaInicio: new Date(compra.fechaExpiracion!.getTime() - compra.paquete.vigenciaDias * 86_400_000),
        fechaExpiracion: compra.fechaExpiracion!,
      });
    }
  }
  return resultado;
}

export async function obtenerHistorialCompras(usuarioId: string): Promise<CompraResponse[]> {
  const compras = await prisma.compra.findMany({
    where: { usuarioId },
    orderBy: { creadoEn: "desc" },
    include: { paquete: true },
  });
  return compras.map((c) => ({
    id: c.id,
    paqueteNombre: c.paquete.nombre,
    categoria: c.paquete.categoria,
    montoCentavos: c.montoCentavos,
    estado: c.estado,
    creadoEn: c.creadoEn,
    fechaExpiracion: c.fechaExpiracion,
    tarjetaMarca: c.tarjetaMarca,
    tarjetaUltimosDigitos: c.tarjetaUltimosDigitos,
    reciboUrl: c.reciboUrl,
    montoComisionCentavos: c.montoComisionCentavos,
    montoNetoCentavos: c.montoNetoCentavos,
    ultimoErrorMensaje: c.ultimoErrorMensaje,
  }));
}

// Consulta el estado directo contra Stripe (no el guardado en la base), util
// para un frontend que acaba de confirmar el pago y quiere saber el resultado
// ya mismo, sin esperar a que llegue el webhook o al proximo ciclo de
// reconciliacion.
export async function obtenerEstadoEnVivo(compraId: string, usuarioId: string): Promise<EstadoEnVivoResponse> {
  validarUuid(compraId, "compraId");
  const compra = await prisma.compra.findUnique({ where: { id: compraId } });
  if (!compra) {
    throw new RecursoNoEncontradoError("Compra no encontrada");
  }
  // Solo el dueno de la compra puede consultar su estado (mismo criterio de
  // acceso que mis-compras / mis-paquetes).
  if (compra.usuarioId !== usuarioId) {
    throw new NoAutorizadoError("Esta compra no te pertenece");
  }
  if (!compra.stripePaymentIntentId) {
    return { compraId, estadoLocal: compra.estado, estadoStripe: "sin_intento", ultimoError: null };
  }

  try {
    const intent = await stripe.paymentIntents.retrieve(compra.stripePaymentIntentId);
    return {
      compraId,
      estadoLocal: compra.estado,
      estadoStripe: intent.status,
      ultimoError: intent.last_payment_error
        ? { codigo: intent.last_payment_error.code ?? null, mensaje: intent.last_payment_error.message ?? null }
        : null,
    };
  } catch (e) {
    throw traducirErrorStripe(e, "consultar el estado en vivo del pago");
  }
}

// Payouts = cuando Stripe deposita el dinero acumulado a la cuenta bancaria
// del negocio. A diferencia de todo lo demas en este archivo, esto es
// informacion de la cuenta completa, no de una Compra individual -- por eso
// no recibe compraId ni se guarda en la tabla compra. Solo lectura, sin
// side-effects, por eso no participa del webhook ni de la reconciliacion.
export async function obtenerPayouts(): Promise<PayoutResponse[]> {
  try {
    const payouts = await stripe.payouts.list({ limit: 20 });
    return payouts.data.map((p) => ({
      id: p.id,
      montoCentavos: p.amount,
      moneda: p.currency,
      estado: p.status,
      metodo: p.method,
      fechaLlegada: new Date(p.arrival_date * 1000),
      creadoEn: new Date(p.created * 1000),
      descripcion: p.description,
    }));
  } catch (e) {
    throw traducirErrorStripe(e, "consultar los payouts");
  }
}

// Verifica la firma y despacha por tipo de evento. Igual que
// PagoService.procesarWebhook: es la fuente de verdad, nunca se confia solo
// en la respuesta sincrona de crearIntentoPago para saber si un pago se
// completo.
export function construirEventoWebhook(payload: Buffer, firmaStripe: string): Stripe.Event {
  try {
    return stripe.webhooks.constructEvent(payload, firmaStripe, env.stripeWebhookSecret);
  } catch {
    throw new ValidacionError("Firma de webhook de Stripe invalida");
  }
}

export async function procesarWebhook(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "payment_intent.succeeded":
      await marcarComoPagada(event.data.object as Stripe.PaymentIntent);
      break;
    case "payment_intent.payment_failed":
      await marcarComoFallida(event.data.object as Stripe.PaymentIntent);
      break;
    // Cubre un reembolso hecho fuera de nuestro endpoint (ej. directo desde
    // el Dashboard de Stripe por el personal), no solo el que iniciamos nosotros.
    case "charge.refunded":
      await marcarComoReembolsada(event.data.object as Stripe.Charge);
      break;
    // El cliente le reclamo el cargo a su banco directamente (contracargo).
    // Se marca aparte de "reembolsada" porque, a diferencia de un reembolso
    // que nosotros iniciamos, esto es una disputa que puede resolverse en
    // cualquier sentido.
    case "charge.dispute.created":
      await marcarComoEnDisputa(event.data.object as Stripe.Dispute);
      break;
    case "charge.dispute.closed":
      await resolverDisputa(event.data.object as Stripe.Dispute);
      break;
    default:
      break;
  }
}

async function marcarComoPagada(intent: Stripe.PaymentIntent): Promise<void> {
  const compras = await prisma.compra.findMany({ where: { stripePaymentIntentId: intent.id } });
  if (compras.length === 0) {
    return;
  }
  // Todas las Compra de un carrito comparten el mismo Charge; se pide una sola
  // vez con balance_transaction expandido (trae la comision y el monto neto,
  // que no vienen en el Charge sin expandir).
  const chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
  const charge = chargeId
    ? await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] }).catch((e) => {
        console.warn(`No se pudo obtener el detalle del charge ${chargeId}:`, e);
        return null;
      })
    : null;

  for (const compra of compras) {
    await aplicarPagada(compra.id, compra.estado as EstadoCompra, charge);
  }
}

async function marcarComoFallida(intent: Stripe.PaymentIntent): Promise<void> {
  await prisma.compra.updateMany({
    where: { stripePaymentIntentId: intent.id },
    data: {
      estado: "fallida",
      ultimoErrorCodigo: intent.last_payment_error?.code ?? null,
      ultimoErrorMensaje: intent.last_payment_error?.message ?? null,
    },
  });
}

async function aplicarPagada(compraId: string, estadoActual: EstadoCompra, charge: Stripe.Charge | null): Promise<void> {
  if (estadoActual === "pagada") {
    return;
  }
  const compra = await prisma.compra.findUniqueOrThrow({ where: { id: compraId }, include: { paquete: true } });
  const balanceTx =
    charge?.balance_transaction && typeof charge.balance_transaction !== "string" ? charge.balance_transaction : null;

  await prisma.compra.update({
    where: { id: compraId },
    data: {
      estado: "pagada",
      fechaExpiracion: new Date(Date.now() + compra.paquete.vigenciaDias * 86_400_000),
      tarjetaMarca: charge?.payment_method_details?.card?.brand ?? null,
      tarjetaUltimosDigitos: charge?.payment_method_details?.card?.last4 ?? null,
      reciboUrl: charge?.receipt_url ?? null,
      montoComisionCentavos: balanceTx?.fee ?? null,
      montoNetoCentavos: balanceTx?.net ?? null,
      riesgoNivel: charge?.outcome?.risk_level ?? null,
    },
  });
}

async function marcarComoEnDisputa(dispute: Stripe.Dispute): Promise<void> {
  const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!paymentIntentId) {
    return;
  }
  await prisma.compra.updateMany({
    where: { stripePaymentIntentId: paymentIntentId },
    data: { estado: "en_disputa" },
  });
}

// 'won' = el banco le dio la razon al comercio, se revierte a pagada. 'lost'
// (o cualquier otro cierre) = el dinero se pierde, equivalente a un reembolso
// para efectos de si el paquete sigue vigente.
async function resolverDisputa(dispute: Stripe.Dispute): Promise<void> {
  const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!paymentIntentId) {
    return;
  }
  await prisma.compra.updateMany({
    where: { stripePaymentIntentId: paymentIntentId, estado: "en_disputa" },
    data: { estado: dispute.status === "won" ? "pagada" : "reembolsada" },
  });
}

async function marcarComoReembolsada(charge: Stripe.Charge): Promise<void> {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) {
    return;
  }
  // Coherente con reembolsarCompra: un reembolso siempre es de carrito
  // completo, asi que se marcan todas las Compra que comparten el
  // PaymentIntent, no solo una.
  await prisma.compra.updateMany({
    where: { stripePaymentIntentId: paymentIntentId, estado: { not: "reembolsada" } },
    data: { estado: "reembolsada" },
  });
}

// Solo se puede reembolsar una compra que de verdad se cobro; el permiso
// 'pagos.reembolsar' (solo ADMIN, verificado en la ruta) evita que un
// cliente se autoreembolse.
//
// El reembolso es siempre de carrito completo: como varias Compra pueden
// compartir un mismo PaymentIntent, reembolsar solo la linea pedida dejaria
// cobrado el resto del carrito en Stripe pero sin forma confiable de
// correlacionar, desde el webhook charge.refunded, que linea corresponde a
// que reembolso parcial. Se prefiere reembolsar y marcar todo el grupo junto.
export async function reembolsarCompra(compraId: string): Promise<ReembolsoResponse> {
  validarUuid(compraId, "compraId");
  const compra = await prisma.compra.findUnique({ where: { id: compraId } });
  if (!compra) {
    throw new RecursoNoEncontradoError("Compra no encontrada");
  }
  if (compra.estado !== "pagada") {
    throw new ValidacionError("Solo se puede reembolsar una compra pagada");
  }

  const grupo = await prisma.compra.findMany({ where: { stripePaymentIntentId: compra.stripePaymentIntentId } });
  if (!grupo.every((c) => c.estado === "pagada")) {
    throw new ValidacionError("El carrito tiene compras en un estado inconsistente para reembolsar");
  }

  try {
    const refund = await stripe.refunds.create({ payment_intent: compra.stripePaymentIntentId! });
    await prisma.compra.updateMany({
      where: { id: { in: grupo.map((c) => c.id) } },
      data: { estado: "reembolsada" },
    });
    return { compraId: compra.id, estado: "reembolsada", montoReembolsadoCentavos: refund.amount };
  } catch (e) {
    throw traducirErrorStripe(e, `reembolsar la compra ${compraId}`);
  }
}

// Red de seguridad para cuando el webhook nunca llega (se cae la conexion,
// Stripe no logra entregarlo, etc.): en vez de confiar ciegamente en que el
// webhook aviso, cada compra "pendiente" se verifica directo contra la API
// de Stripe. Solo si Stripe tambien dice que sigue sin resolverse y ya paso
// el tiempo limite, se marca como abandonada (cancelada). Se llama desde el
// cron job en src/jobs/reconciliacion.ts.
export async function reconciliarComprasPendientes(): Promise<void> {
  const limiteAbandono = new Date(Date.now() - env.compraPendienteExpiraMinutos * 60_000);
  const pendientes = await prisma.compra.findMany({ where: { estado: "pendiente" } });
  for (const compra of pendientes) {
    await reconciliarUnaCompra(compra.id, compra.stripePaymentIntentId, compra.creadoEn, limiteAbandono);
  }
}

async function reconciliarUnaCompra(
  compraId: string,
  stripePaymentIntentId: string | null,
  creadoEn: Date,
  limiteAbandono: Date,
): Promise<void> {
  if (!stripePaymentIntentId) {
    return;
  }
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.retrieve(stripePaymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  } catch (e) {
    console.warn(`No se pudo reconciliar la compra ${compraId} contra Stripe:`, e);
    return;
  }

  if (intent.status === "succeeded") {
    const charge = typeof intent.latest_charge !== "string" ? (intent.latest_charge ?? null) : null;
    await aplicarPagada(compraId, "pendiente", charge);
  } else if (intent.status === "canceled") {
    await prisma.compra.update({ where: { id: compraId }, data: { estado: "cancelada" } });
  } else if (creadoEn < limiteAbandono) {
    console.info(`Compra ${compraId} sigue sin resolverse en Stripe (status=${intent.status}), se cancela`);
    await prisma.compra.update({ where: { id: compraId }, data: { estado: "cancelada" } });
  }
}

// Clasifica cualquier fallo de Stripe segun las categorias documentadas
// (content error 4xx, network error, server error 5xx / indeterminado) para
// que el backend principal reciba un origen claro en vez de un 500 generico.
function traducirErrorStripe(e: unknown, accion: string): ErrorPago {
  const err = e as { type?: string; statusCode?: number; message?: string };
  console.error(`Stripe fallo al ${accion}:`, err);

  if (err.type === "StripeConnectionError") {
    return new ErrorPago(`No se pudo ${accion}: problema de red con Stripe`, "stripe_network_error");
  }
  if (typeof err.statusCode === "number" && err.statusCode >= 500) {
    // Segun la doc de Stripe, un 500 es indeterminado: puede haberse
    // completado del lado de Stripe aunque esta llamada haya fallado. No se
    // marca la Compra como fallida aqui; se deja pendiente para que la
    // reconciliacion (o un webhook tardio de Stripe) resuelva el estado real.
    return new ErrorPago(`No se pudo ${accion}: error del lado de Stripe`, "stripe_server_error");
  }
  return new ErrorPago(`No se pudo ${accion}: ${err.message ?? "motivo desconocido"}`, "stripe_decline");
}

export function generarIdempotencyKey(): string {
  return randomUUID();
}
