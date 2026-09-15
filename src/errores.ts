export class RecursoNoEncontradoError extends Error {
  readonly status = 404;
}

export class ValidacionError extends Error {
  readonly status = 400;
}

export class NoAutorizadoError extends Error {
  readonly status = 403;
}

// Distingue el origen de un fallo para que quede claro, en logs y en la
// respuesta al backend principal, si la culpa es de Stripe (decline, timeout,
// 5xx de su lado) o de este servicio. Ver conversacion sobre separar errores
// de Stripe de errores internos al migrar el modulo de pagos a microservicio.
export type OrigenError = "stripe_decline" | "stripe_network_error" | "stripe_server_error" | "internal_error";

export class ErrorPago extends Error {
  readonly status = 502;
  readonly origen: OrigenError;

  constructor(mensaje: string, origen: OrigenError) {
    super(mensaje);
    this.origen = origen;
  }
}
