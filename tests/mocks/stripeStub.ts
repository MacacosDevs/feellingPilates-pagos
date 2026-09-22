import { vi } from "vitest";

// Stub del modulo src/lib/stripe.ts. Nunca se llama a la API real de Stripe
// en la suite: cada test configura el retorno/rechazo de estos vi.fn segun
// el escenario (exito, StripeConnectionError, 5xx, decline 4xx, etc.).
export const stripeStub = {
  paymentIntents: {
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  refunds: {
    create: vi.fn(),
  },
  payouts: {
    list: vi.fn(),
  },
  charges: {
    retrieve: vi.fn(),
  },
  webhooks: {
    constructEvent: vi.fn(),
  },
};

export function resetStripeStub(): void {
  for (const group of Object.values(stripeStub)) {
    for (const fn of Object.values(group)) {
      fn.mockReset();
    }
  }
}

// Helpers para construir los errores tal como los lanza el SDK de Stripe,
// para ejercitar traducirErrorStripe() en pagoService.ts.
export function errorConexionStripe(mensaje = "conexion fallida"): Error & { type: string } {
  return Object.assign(new Error(mensaje), { type: "StripeConnectionError" });
}

export function errorServidorStripe(statusCode = 500, mensaje = "server error"): Error & { statusCode: number } {
  return Object.assign(new Error(mensaje), { statusCode, type: "StripeAPIError" });
}

export function errorDeclineStripe(statusCode = 402, mensaje = "Your card was declined."): Error & { statusCode: number } {
  return Object.assign(new Error(mensaje), { statusCode, type: "StripeCardError" });
}
