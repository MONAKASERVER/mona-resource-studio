import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; username: string; systemRole: "admin" | "user" };
    user: { sub: string; username: string; systemRole: "admin" | "user" };
  }
}

