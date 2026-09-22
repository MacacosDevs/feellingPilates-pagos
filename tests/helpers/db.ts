import { randomUUID } from "node:crypto";
import { prisma } from "../../src/lib/prisma.js";

export async function limpiarBD(): Promise<void> {
  await prisma.compra.deleteMany();
  await prisma.paquete.deleteMany();
  await prisma.$executeRawUnsafe(`DELETE FROM public.usuario`);
}

export async function crearUsuario(id: string = randomUUID()): Promise<string> {
  await prisma.$executeRawUnsafe(`INSERT INTO public.usuario (id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, id);
  return id;
}

interface PaqueteOverrides {
  categoria?: string;
  nombre?: string;
  precioCentavos?: number;
  vigenciaDias?: number;
  activo?: boolean;
  orden?: number;
}

export async function crearPaquete(overrides: PaqueteOverrides = {}) {
  return prisma.paquete.create({
    data: {
      categoria: overrides.categoria ?? "pilates",
      nombre: overrides.nombre ?? "Paquete de prueba",
      precioCentavos: overrides.precioCentavos ?? 10_000,
      vigenciaDias: overrides.vigenciaDias ?? 30,
      activo: overrides.activo ?? true,
      orden: overrides.orden ?? 0,
    },
  });
}

interface CompraOverrides {
  usuarioId: string;
  paqueteId: string;
  montoCentavos?: number;
  estado?: string;
  stripePaymentIntentId?: string | null;
  idempotencyKey?: string | null;
  fechaExpiracion?: Date | null;
  moneda?: string;
}

export async function crearCompra(overrides: CompraOverrides) {
  return prisma.compra.create({
    data: {
      usuarioId: overrides.usuarioId,
      paqueteId: overrides.paqueteId,
      montoCentavos: overrides.montoCentavos ?? 10_000,
      estado: overrides.estado ?? "pendiente",
      stripePaymentIntentId: overrides.stripePaymentIntentId ?? null,
      idempotencyKey: overrides.idempotencyKey ?? null,
      fechaExpiracion: overrides.fechaExpiracion ?? null,
      moneda: overrides.moneda ?? "mxn",
    },
  });
}
