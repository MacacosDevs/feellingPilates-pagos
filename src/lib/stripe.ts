import Stripe from "stripe";
import { env } from "../config/env.js";
import { ServicioNoConfiguradoError } from "../errores.js";

// Sin clave, `new Stripe("")` lanza al importar este modulo y tumba el
// proceso completo (le paso al desplegar QA sin claves de Stripe). En su
// lugar se exporta un sustituto que lanza ServicioNoConfiguradoError al
// primer uso: el servicio arranca y solo fallan, con un 503 claro, las
// operaciones que de verdad necesitan Stripe.
function stripeNoConfigurado(): Stripe {
  return new Proxy({} as Stripe, {
    get() {
      throw new ServicioNoConfiguradoError("Stripe no esta configurado en este ambiente (falta STRIPE_SECRET_KEY)");
    },
  });
}

export const stripe: Stripe = env.stripeSecretKey ? new Stripe(env.stripeSecretKey) : stripeNoConfigurado();
