import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Espejo de UsuarioAutenticado.java + los claims que emite JwtService.java
// (subject = usuarioId, mas correo/roles/permisos). Mismo secreto HS256 que
// el backend principal, asi que un token emitido alla valida aqui sin tocar
// nada del sistema de auth.
export interface UsuarioAutenticado {
  id: string;
  correo: string;
  roles: string[];
  permisos: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioAutenticado;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Falta el token de autenticacion" });
    return;
  }

  try {
    const payload = jwt.verify(header.slice("Bearer ".length), env.jwtSecreto) as jwt.JwtPayload;
    req.usuario = {
      id: String(payload.sub),
      correo: String(payload.correo ?? ""),
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      permisos: Array.isArray(payload.permisos) ? payload.permisos : [],
    };
    next();
  } catch {
    res.status(401).json({ error: "Token invalido o expirado" });
  }
}

// Equivalente a @PreAuthorize("hasAuthority('...')") en el backend Java.
export function requierePermiso(codigo: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.usuario?.permisos.includes(codigo)) {
      res.status(403).json({ error: "No tienes permiso para esta accion" });
      return;
    }
    next();
  };
}
