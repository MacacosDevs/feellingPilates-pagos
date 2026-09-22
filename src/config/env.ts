import "dotenv/config";

function requerido(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  return valor;
}

export const env = {
  port: Number(process.env.PORT ?? 8081),
  databaseUrl: requerido("DATABASE_URL"),
  jwtSecreto: requerido("JWT_SECRETO"),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  compraPendienteExpiraMinutos: Number(process.env.COMPRA_PENDIENTE_EXPIRA_MINUTOS ?? 60),
  corsOrigenesPermitidos: (process.env.CORS_ORIGENES_PERMITIDOS ?? "http://localhost:5173").split(","),
  // Ver reusarSiExiste en pagoService.ts: cuanto esperar (y cuantas veces
  // reintentar) a que otra request con la misma idempotencyKey termine de
  // asignarle un PaymentIntent a su grupo de Compra, antes de darse por
  // vencido. Configurable para poder acortarlo en tests.
  idempotencyEsperaIntervaloMs: Number(process.env.IDEMPOTENCY_ESPERA_INTERVALO_MS ?? 100),
  idempotencyEsperaMaxIntentos: Number(process.env.IDEMPOTENCY_ESPERA_MAX_INTENTOS ?? 20),
};

// Igual que StripeConfig.java: mientras STRIPE_SECRET_KEY este vacio, el
// servicio arranca pero los endpoints de pago fallan de forma controlada en
// vez de llamar a Stripe sin clave.
if (!env.stripeSecretKey) {
  console.warn("[env] STRIPE_SECRET_KEY vacio: los endpoints de pago fallaran hasta configurarlo");
}
