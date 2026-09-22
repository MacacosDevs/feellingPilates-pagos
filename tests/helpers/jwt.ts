import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";

export interface TokenOverrides {
  sub?: string;
  correo?: string;
  roles?: string[];
  permisos?: string[];
  secreto?: string;
  expiresIn?: string | number;
}

export function generarToken(overrides: TokenOverrides = {}): string {
  const { secreto, expiresIn, ...claims } = overrides;
  return jwt.sign(
    {
      sub: claims.sub ?? randomUUID(),
      correo: claims.correo ?? "usuario@test.com",
      roles: claims.roles ?? ["ROLE_USUARIO"],
      permisos: claims.permisos ?? [],
    },
    secreto ?? process.env.JWT_SECRETO!,
    { expiresIn: expiresIn ?? "1h", algorithm: "HS256" },
  );
}

export function generarTokenExpirado(overrides: TokenOverrides = {}): string {
  return jwt.sign(
    {
      sub: overrides.sub ?? randomUUID(),
      correo: overrides.correo ?? "usuario@test.com",
      roles: overrides.roles ?? ["ROLE_USUARIO"],
      permisos: overrides.permisos ?? [],
    },
    overrides.secreto ?? process.env.JWT_SECRETO!,
    { expiresIn: -10, algorithm: "HS256" },
  );
}
